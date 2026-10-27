"use strict";
// Browser-only PUCT. The server supplies static assets and never evaluates a move.
importScripts("config.js", "hn.js", "../vendor/ort.webgpu.min.js");

const side = ANALYSIS_CONFIG.side, grid = 2 * side - 1;
const cells = Array.from({length: grid * grid}, (_, i) => i)
  .filter(i => Math.abs(i % grid - Math.floor(i / grid)) < side);
const count = cells.length, compact = new Map(cells.map((c, i) => [c, i]));
let board, session, metadata, backend, pending = null, running = false, active = null;
let modelBytes, modelReferences, initialized = false;
let root = null, retained = null, serial = 0, created = 0;
let searchRate = null, rateEpoch = 0;
const maxNodes = 100000;
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

function encode(codes, stm) {
  const planes = new Float32Array(16 * count);
  let occupied = 0;
  for (let i = 0; i < count; i++) {
    let code = codes[i];
    occupied += code !== 0;
    if (stm === 2) {
      if (code >= 1 && code <= 6) code += 6;
      else if (code >= 7 && code <= 12) code -= 6;
    }
    planes[code * count + i] = 1;
    planes[14 * count + i] = 1;
  }
  planes.fill(occupied / count, 15 * count);
  return planes;
}

async function predictOnce(codes, stm) {
  const compactInput = metadata.input_format === "cells-stm";
  const inputs = compactInput ? {
    cells: new ort.Tensor("int32", Int32Array.from(codes), [1, count]),
    stm: new ort.Tensor("int32", Int32Array.of(stm), [1]),
  } : {planes: new ort.Tensor("float32", encode(codes, stm), [1, 16, count])};
  let output;
  try {
    output = await session.run(inputs);
    const policy = Float32Array.from(compactInput
      ? output.prediction.data.subarray(0, count) : output.policy.data);
    const own = Float32Array.from(compactInput
      ? output.prediction.data.subarray(count, 2 * count) : output.own.data);
    const epsilon = 2 ** -23;
    if (![...policy, ...own].every(Number.isFinite) || own.some(p => p < -epsilon || p > 1 + epsilon))
      throw new Error("Non-finite network prediction or invalid ownership probability");
    // ONNX sigmoid can overshoot by one FP32 epsilon. Reject larger errors;
    // only normalize that boundary roundoff before it reaches search/maps.
    for (let i = 0; i < own.length; i++) own[i] = Math.max(0, Math.min(1, own[i]));
    return {policy, own};
  } finally {
    Object.values(output || {}).forEach(t => t.dispose());
    Object.values(inputs).forEach(t => t.dispose());
  }
}

async function predict(codes, stm) {
  try {
    return await predictOnce(codes, stm);
  } catch (error) {
    // A WebGPU adapter may pass startup checks and fail on a later position.
    // Retry that same leaf on verified CPU inference without losing the game.
    if (!initialized || backend !== "webgpu") throw error;
    const reason = String(error), previous = session;
    session = null;
    backend = "wasm";
    searchRate = null;
    rateEpoch++; // A GPU throughput estimate must never budget CPU searches.
    postMessage({type: "loading", message: "GPU evaluation failed; switching to browser CPU…"});
    try { await previous.release(); } catch (_) { /* The device may already be lost. */ }
    session = await ort.InferenceSession.create(modelBytes.slice(0), {executionProviders: ["wasm"]});
    const verification = await checkReference(modelReferences);
    postMessage({type: "backend-changed", backend,
      model_label: `${metadata.model_name} · browser CPU`, fallbackReason: reason, verification});
    return await predictOnce(codes, stm);
  }
}

function codes() {
  return cells.map(c => {
    const owner = board._hn_owner(c), height = board._hn_height(c);
    return !owner ? 0 : owner === 3 ? 13 : height + (owner === 2 ? 6 : 0);
  });
}

function play(move) {
  if (move < 0) {
    if (board._hn_can_move()) throw new Error("Search attempted an illegal pass");
    board._hn_pass();
  } else if (!board._hn_play(move)) throw new Error("Search attempted an illegal move");
}

function restore(request) {
  board._hn_init_display(request.red, request.white);
  for (const move of request.moves) play(move);
}

function node(move = -1, prior = 1) {
  created++;
  return {move, prior, visits: 0, sum: 0, moves: null, priors: null, children: null, own: null, square: null,
    value: 0, stm: null, terminal: false, leaf: null};
}

async function expand(current) {
  const stm = board._hn_stm(), sign = stm === 1 ? 1 : -1;
  current.stm = stm;
  const terminal = !!board._hn_score(2);
  const prediction = terminal ? null : await predict(codes(), stm);
  const ownership = new Float32Array(count);
  let margin = 0;
  for (let i = 0; i < count; i++) {
    const territory = board._hn_territory(cells[i]);
    ownership[i] = territory === 1 ? 1 : territory === 2 ? -1
      : terminal ? 0 : sign * (2 * prediction.own[i] - 1);
    margin += ownership[i];
  }
  current.value = margin;
  current.terminal = terminal;
  current.children = [];
  if (terminal) {
    current.leaf = ownership;
    return ownership;
  }
  const legal = cells.filter(c => board._hn_value(c) > 0);
  if (!legal.length) {
    current.moves = Int16Array.of(-1);
    current.priors = Float64Array.of(1);
  }
  else {
    const logits = legal.map(c => prediction.policy[compact.get(c)] / 1.4);
    const maximum = Math.max(...logits), weights = logits.map(x => Math.exp(x - maximum));
    const total = weights.reduce((a, b) => a + b, 0);
    current.moves = Int16Array.from(legal);
    current.priors = Float64Array.from(weights, weight => .98 * weight / total + .02 / legal.length);
  }
  // Legal moves are compact edges. Allocate a full node only when selected;
  // otherwise a wide position spends the entire node budget on unvisited moves.
  current.children = new Array(current.moves.length).fill(null);
  return ownership;
}

function select(current) {
  const sign = board._hn_stm() === 1 ? 1 : -1;
  const scale = .05 * Math.sqrt(Math.max(1, current.visits));
  let best = -1, score = -Infinity;
  for (let i = 0; i < current.moves.length; i++) {
    const child = current.children[i], visits = child?.visits || 0;
    const value = sign * (visits ? child.sum / visits : current.value) / count;
    const candidate = value + scale * current.priors[i] / (1 + visits);
    if (candidate > score) { score = candidate; best = i; }
  }
  if (best < 0) throw new Error("Nonterminal search node has no legal moves");
  if (!current.children[best]) current.children[best] = node(current.moves[best], current.priors[best]);
  return current.children[best];
}

async function simulate(request) {
  restore(request);
  let current = root;
  const path = [root];
  while (current.children && !current.terminal) {
    current = select(current);
    play(current.move);
    path.push(current);
  }
  const ownership = current.terminal ? current.leaf : await expand(current);
  const margin = ownership.reduce((a, b) => a + b, 0);
  for (const entry of path) {
    if (!entry.own) { entry.own = new Float64Array(count); entry.square = new Float64Array(count); }
    entry.visits++;
    entry.sum += margin;
    for (let i = 0; i < count; i++) {
      entry.own[i] += ownership[i];
      entry.square[i] += ownership[i] ** 2;
    }
  }
  return path.length - 1;
}

function ranked(current) {
  // Sums are always Red's margin. Rank each node's moves for its own player,
  // including opponent replies and deeper PV nodes after root reuse.
  const sign = current.stm === 1 ? 1 : -1;
  const score = child => child.visits ? sign * child.sum / child.visits : 0;
  return Array.from(current.moves || [], (move, i) => current.children[i] ||
    {move, prior: current.priors[i], visits: 0, children: null})
    .sort((a, b) => b.visits - a.visits || score(b) - score(a) ||
      b.prior - a.prior || a.move - b.move);
}

function visitLeaderLocked(current, limit) {
  const remaining = limit - current.visits;
  if (remaining <= 0 || remaining >= current.visits || current.moves?.length < 2) return false;
  let first = 0, second = 0;
  for (const child of current.children || []) {
    const visits = child?.visits || 0;
    if (visits > first) { second = first; first = visits; }
    else if (visits > second) second = visits;
  }
  // This worker has one leaf in flight, already backed up before this check.
  // Give every remaining visit to the runner-up. Equality is not decisive:
  // Tied visits can select a different move via the score/prior tie-breaks.
  return first - second > remaining;
}

function visitTarget(value) {
  return Math.min(1000000000, Math.max(1, Math.round(value)));
}

function searchBudget(request) {
  // Match the native app: all targets include inherited root visits; only
  // newly performed work is charged. Game allocations scale with board area.
  const weight = 1 + ((request.openingMultiplier || 1) - 1) * Math.max(0, 1 - request.moves.length / 40);
  const seconds = (request.remainingSeconds !== undefined
    ? request.remainingSeconds * 7 / count : request.seconds || 0) * weight;
  const timed = request.remainingSeconds !== undefined || seconds > 0;
  // One simulation per move is policy-only, even with an opening bonus.
  // A one-visit allocation from a game/time budget keeps normal reuse rules.
  const policyOnly = !timed && request.remainingSimulations === undefined && request.sims === 1;
  const simulations = (request.remainingSimulations !== undefined
    ? request.remainingSimulations * 7 / count : request.sims || 1) * weight;
  return {seconds, timed, policyOnly,
    limit: policyOnly ? 1 : timed ? timeTarget(seconds) : visitTarget(simulations)};
}

function timeTarget(seconds) {
  // Calibrate in the requested search, not in an extra tree. Until we have
  // measured throughput the wall clock still bounds this first search.
  return !seconds ? 1 : searchRate ? visitTarget(seconds * searchRate) : 1000000000;
}

function mapOwnership(current, deviation = false) {
  const out = new Float32Array(grid * grid);
  if (current.visits) cells.forEach((cell, i) => {
    const mean = current.own[i] / current.visits;
    out[cell] = deviation ? Math.sqrt(Math.max(0, current.square[i] / current.visits - mean ** 2)) : mean;
  });
  return out;
}

function variation(current) {
  const moves = [];
  for (let i = 0; i < 16; i++) {
    const child = ranked(current)[0];
    if (!child || !child.visits) break;
    moves.push(child.move);
    current = child;
  }
  return moves;
}

function report(request, type, start, inherited, depth, status, limit, policyOnly = false) {
  restore(request);
  const stm = board._hn_stm(), sign = stm === 1 ? 1 : -1;
  const candidates = ranked(root).map((child, index) => ({
    index, move: child.move, visits: child.visits, prior: child.prior, pending: 0,
    margin: sign * (child.visits ? child.sum / child.visits : root.value),
    samples: child.visits, ownership: mapOwnership(child), pv: [child.move, ...variation(child)],
    replyCount: child.children?.length || 0, replyState: child.children ? "expanded" : "unexpanded",
    replyBest: ranked(child)[0]?.move ?? -1, replyNodeVisits: child.visits,
    replies: ranked(child).slice(0, 8).map(reply => ({move: reply.move, visits: reply.visits,
      margin: -sign * (reply.visits ? reply.sum / reply.visits : child.value), prior: reply.prior})),
  }));
  postMessage({type, gen: request.gen, context: request.context, purpose: request.purpose,
    budgetSims: request.sims, budgetMode: request.budgetMode, budgetRevision: request.budgetRevision,
    side: stm, best: candidates[0]?.move ?? -1, visits: root.visits,
    rootMargin: sign * (root.visits ? root.sum / root.visits : 0),
    inheritedVisits: inherited, simulations: root.visits - inherited, pending: 0,
    ms: root.visits > inherited ? performance.now() - start : 0, depth, samples: root.visits,
    ownership: mapOwnership(root), stdev: mapOwnership(root, true), candidates,
    stopped: status === "cancelled", capacityReached: status === "node_limit",
    capacityReason: status === "node_limit" ? "Browser tree limit reached" : undefined,
    // Exhausting storage is a usable partial search, just like a time limit.
    engineComplete: type === "done" && status !== "cancelled" && root.visits > 0,
    treeNodes: created, treeNodeLimit: maxNodes,
    targetSimulations: limit, simulationsPerSecond: searchRate,
    policyOnly,
    earlyStopped: status === "visit_leader", engineStatus: status});
}

function reuse(request) {
  let candidate = root;
  if (request.fresh || !retained || retained.red !== request.red || retained.white !== request.white ||
      retained.moves.length > request.moves.length ||
      !retained.moves.every((m, i) => m === request.moves[i])) candidate = null;
  if (candidate) for (const move of request.moves.slice(retained.moves.length)) {
    const index = candidate?.moves?.indexOf(move) ?? -1;
    candidate = index < 0 ? null : candidate.children[index];
  }
  if (!candidate) { created = 0; candidate = node(); }
  else if (candidate !== root) {
    // Advancing the board discards unrelated branches. Charge only the tree
    // that remains reachable, so old turns cannot exhaust the browser cap.
    created = 0;
    const todo = [candidate];
    while (todo.length) {
      const entry = todo.pop();
      created++;
      if (entry.children) for (const child of entry.children) if (child) todo.push(child);
    }
  }
  root = candidate;
  retained = {red: request.red, white: request.white, moves: [...request.moves]};
}

async function search(request, ticket) {
  restore(request);
  if (request.codes && JSON.stringify(codes()) !== JSON.stringify(request.codes))
    throw new Error("Browser position differs from the displayed board");
  const budget = searchBudget(request), {seconds, timed, policyOnly} = budget;
  // Discard searched statistics when explicitly testing the policy. Expanding
  // only a fresh root ranks its unvisited legal edges by the network prior.
  reuse(policyOnly ? {...request, fresh: true} : request);
  const inherited = root.visits, start = performance.now();
  let limit = budget.limit;
  let last = start, depth = 0, status = "simulations";
  let epoch = rateEpoch, measuredAt = start, measuredRoot = inherited, measuredVisits = 0;
  postMessage({type: "connected"});
  while (root.visits < limit) {
    if (active !== ticket) { status = "cancelled"; break; }
    if (root.visits && timed && performance.now() - start >= seconds * 1000) {
      status = "time_limit"; break;
    }
    if (visitLeaderLocked(root, limit)) { status = "visit_leader"; break; }
    if (created >= maxNodes) { status = "node_limit"; break; }
    depth = Math.max(depth, await simulate(request));
    if (root.terminal) { status = "terminal"; break; }
    const now = performance.now();
    if (epoch !== rateEpoch) {
      // Exclude device recovery/startup and all visits on the old backend.
      epoch = rateEpoch; measuredAt = now; measuredRoot = root.visits; measuredVisits = 0;
      if (timed) limit = timeTarget(seconds);
    }
    const completed = root.visits - measuredRoot, elapsed = now - measuredAt;
    // Single-leaf browser inference needs a much smaller calibration batch
    // than the native GPU engine's 128 visits. Count real search wall time,
    // including traversal, reporting and cooperative yields, not NN calls alone.
    if (completed - measuredVisits >= 8 && elapsed >= 100) {
      searchRate = completed * 1000 / elapsed;
      measuredVisits = completed;
      if (timed) limit = timeTarget(seconds);
    }
    if (performance.now() - last > 200) {
      report(request, "progress", start, inherited, depth, "searching", limit, policyOnly);
      last = performance.now();
    }
    await pause(); // Keep Stop and position changes responsive even with WASM inference.
  }
  if (active !== ticket) status = "cancelled";
  const completed = root.visits - measuredRoot, elapsed = performance.now() - measuredAt;
  if (epoch === rateEpoch && status !== "cancelled" && completed >= 8 && elapsed >= 100)
    searchRate = completed * 1000 / elapsed;
  report(request, "done", start, inherited, depth, status, limit, policyOnly);
}

async function drain() {
  if (running || !session) return;
  running = true;
  while (pending) {
    const job = pending;
    pending = null;
    try { await search(job.request, job.ticket); }
    catch (error) { postMessage({type: "error", gen: job.request.gen, message: String(error)}); }
  }
  running = false;
}

onmessage = event => {
  const message = event.data;
  if (message.type === "search") {
    active = ++serial;
    pending = {request: message, ticket: active};
    drain();
  } else if (message.type === "stop") { active = null; pending = null; }
  else if (message.type === "preliminary-start") postMessage({type: "preliminary-done", token: message.token});
};

async function checkReference(references) {
  let maxPolicy = 0, maxOwn = 0, maxMargin = 0;
  const times = [];
  for (const expected of references) {
    const start = performance.now(), actual = await predict(expected.codes, expected.stm);
    times.push(performance.now() - start);
    let margin = 0;
    for (let i = 0; i < count; i++) {
      maxPolicy = Math.max(maxPolicy, Math.abs(actual.policy[i] - expected.policy[i]));
      maxOwn = Math.max(maxOwn, Math.abs(actual.own[i] - expected.own[i]));
      margin += 2 * (actual.own[i] - expected.own[i]);
    }
    maxMargin = Math.max(maxMargin, Math.abs(margin));
  }
  if (maxPolicy > .01 || maxOwn > .001 || maxMargin > .02)
    throw new Error(`Browser prediction check failed: ${maxPolicy}, ${maxOwn}, ${maxMargin}`);
  return {maxPolicy, maxOwn, maxMargin, times};
}

async function initialize() {
  postMessage({type: "loading", message: "Loading gated network in this browser…"});
  board = await HN();
  metadata = await (await fetch("../models/model.json", {cache: "no-cache"})).json();
  const entry = metadata.sides[String(side)];
  if (!entry || entry.cells !== count || board._hn_side() !== side)
    throw new Error("Board rules and network size do not match");
  modelBytes = await (await fetch(`../models/${entry.file}?sha=${entry.sha256}`)).arrayBuffer();
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", modelBytes))]
    .map(v => v.toString(16).padStart(2, "0")).join("");
  if (digest !== entry.sha256) throw new Error("Downloaded model checksum mismatch");
  modelReferences = await (await fetch(`../models/${entry.reference}?sha=${metadata.checkpoint_sha256}`)).json();
  ort.env.wasm.wasmPaths = new URL("../vendor/", location.href).href;
  ort.env.wasm.numThreads = 1;
  const force = new URL(location.href).searchParams.get("ep");
  const choices = force === "wasm" || !navigator.gpu ? ["wasm"] : ["webgpu", "wasm"];
  let verification, failure;
  for (const provider of choices) {
    try {
      postMessage({type: "loading", message: `Checking ${provider === "webgpu" ? "WebGPU" : "CPU"} inference…`});
      session = await ort.InferenceSession.create(modelBytes.slice(0), {executionProviders: [provider]});
      backend = provider;
      verification = await checkReference(modelReferences);
      break;
    } catch (error) {
      failure = String(error);
      if (session) await session.release();
      session = null;
    }
  }
  if (!session) throw new Error(`Could not initialize browser inference: ${failure}`);
  initialized = true;
  postMessage({type: "ready", protocol: "highnoon-analysis", version: 1,
    board_sizes: Object.keys(metadata.sides).map(Number).sort((a, b) => a - b),
    model_sha256: metadata.checkpoint_sha256,
    model_label: `${metadata.model_name} · ${backend === "webgpu" ? "WebGPU" : "browser CPU"}`,
    backend, verification, fallbackReason: backend === "wasm" ? failure : null});
  drain();
}

initialize().catch(error => postMessage({type: "error", message: String(error)}));
