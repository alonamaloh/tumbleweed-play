"use strict";
// Three opponents and the HighNoon analysis judge; load only required models.
const parameters = new URL(location.href).searchParams;
const SIDE = Number(parameters.get("size") || 8), grid = 2 * SIDE - 1;
const kind = parameters.get("engine") || "tumbstone";
if (![6, 8, 10, 11].includes(SIDE) || !["tumbstone", "frontier", "jesse", "highnoon"].includes(kind))
  throw new Error("Unknown board size or engine");
const searchModel = kind === "jesse" ? "jesse" : kind === "tumbstone" ? "tumbstone" : "strong";
const modelNames = kind === "frontier" ? ["strong", "human"] : [searchModel];
importScripts("runtime-policy.js");
// The desktop may supply native inference and search. This shared worker keeps
// the same rules, requests, review text and cancellation contract.
const nativeInference = globalThis.HighNoonNative || null;
const cpuRuntime = !nativeInference && FrontierRuntime.cpuOnly(navigator, parameters.get("ep"));
importScripts(`rules/side${SIDE}.js`, "random.js", "position.js", "frontier.js");
if (!nativeInference) importScripts(cpuRuntime ? "vendor/ort.wasm.min.js" : "vendor/ort.webgpu.min.js");

const cells = Position.cells(SIDE);
const compact = new Map(cells.map((c, i) => [c, i])), count = cells.length;
// Yield a task so Stop stays responsive, without nested timers' minimum delay.
// This changes scheduling only: every simulation and backup is unchanged.
const yieldChannel = new MessageChannel(), yields = [];
yieldChannel.port1.onmessage = () => yields.shift()?.();
const pause = () => new Promise(resolve => { yields.push(resolve); yieldChannel.port2.postMessage(null); });
let board, metadata, backend, initialized = false, serial = 0, pending = null, running = false, active = null;
const sessions = {}, references = {};
const batchedBackend = () => backend === "webgpu" || backend?.startsWith("native-");
const emptyInference = () => ({ms: 0, calls: 0, rows: 0, failed: 0, batches: {}});
let inferenceMetrics = emptyInference(), measuringInference = false;
function combinedInference(a, b) {
  const out = emptyInference();
  for (const value of [a, b]) if (value) {
    for (const key of ["ms", "calls", "rows", "failed"]) out[key] += value[key];
    for (const [size, calls] of Object.entries(value.batches)) out.batches[size] = (out.batches[size] || 0) + calls;
  }
  return out;
}

function codes() {
  return cells.map(c => {
    const owner = board._hn_owner(c);
    return !owner ? 0 : owner === 3 ? 13 : board._hn_height(c) + (owner === 2 ? 6 : 0);
  });
}
function play(move) {
  if (move === -1) {
    if (board._hn_can_move()) throw new Error("Illegal pass");
    board._hn_pass();
  } else if (!board._hn_play(move)) throw new Error("Illegal move");
}
function restore(request) {
  if (request.initial) {
    Position.initialize(board, request.initial);
  } else if (request.handicapReds) {
    if (request.placement && (request.placement !== "white" || request.moves.length))
      throw new Error("Invalid handicap placement search");
    Position.initialize(board, Position.handicap(SIDE, request.handicapReds, request.placement ? null : request.white));
  } else board._hn_init_display(request.red, request.white);
  // The game so far may hold recorded moves the search itself never makes (an early pass, a stack that can be
  // captured at once); the tree's own moves still go through play() above.
  for (const move of request.moves) Position.play(board, move, true);
}
async function predictBatchOnce(name, positions) {
  const batch = positions.length;
  if (batch < 1 || batch > 32) throw new Error("Invalid inference batch");
  const metrics = measuringInference ? inferenceMetrics : null, started = performance.now();
  const inputs = nativeInference ? {} : {cells: new ort.Tensor("int32", Int32Array.from(positions.flatMap(p => p.codes)), [batch, count]),
    stm: new ort.Tensor("int32", Int32Array.from(positions, p => p.stm), [batch])};
  if (!nativeInference && name === "jesse") inputs.role = new ort.Tensor("int32", Int32Array.from(positions, p => p.role), [batch]);
  const hasWinHead = !!metadata.models[String(SIDE)][name].win_head;
  if (!nativeInference && hasWinHead) inputs.placement = new ort.Tensor("int32", Int32Array.from(positions, p => Number(p.placement || 0)), [batch]);
  let outputs, succeeded = false;
  try {
    outputs = nativeInference ? await nativeInference.predict(name, positions) : await sessions[name].run(inputs);
    const data = nativeInference ? outputs.prediction : outputs.prediction.data;
    if (data.length !== batch * 2 * count) throw new Error("Wrong inference batch shape");
    const win = hasWinHead ? (nativeInference ? outputs.win_logit : outputs.win_logit?.data) : null;
    if (hasWinHead && (!win || win.length !== batch || !Array.from(win).every(Number.isFinite)))
      throw new Error("Invalid win-head output");
    const values = positions.map((_, i) => {
      const offset = i * 2 * count;
      const policy = Array.from(data.slice(offset, offset + count));
      const own = Array.from(data.slice(offset + count, offset + 2 * count));
      if (![...policy, ...own].every(Number.isFinite) || own.some(v => v < -(2 ** -23) || v > 1 + 2 ** -23))
        throw new Error("Invalid network output");
      return {policy, own: own.map(v => Math.min(1, Math.max(0, v))), ...(hasWinHead ? {winLogit: win[i]} : {})};
    });
    succeeded = true;
    return values;
  } finally {
    if (!nativeInference) Object.values(outputs || {}).forEach(t => t.dispose());
    Object.values(inputs).forEach(t => t.dispose());
    if (metrics) {
      metrics.ms += performance.now() - started;
      metrics.calls++; metrics.rows += batch;
      metrics.failed += Number(!succeeded);
      metrics.batches[batch] = (metrics.batches[batch] || 0) + 1;
    }
  }
}
async function predictOnce(name, c, stm, role, placement = false) {
  return (await predictBatchOnce(name, [{codes: c, stm, role, placement}]))[0];
}
async function verify() {
  const result = {};
  for (const name of modelNames) {
    let policy = 0, ownership = 0, margin = 0, winLogit = 0, winUtility = 0;
    const checkWin = (actual, ref) => {
      if (!metadata.models[String(SIDE)][name].win_head) return;
      if (!Number.isFinite(ref.winLogit) || !Number.isFinite(actual.winLogit)) throw new Error("Missing win-head reference");
      winLogit = Math.max(winLogit, Math.abs(actual.winLogit - ref.winLogit));
      winUtility = Math.max(winUtility, 20 * Math.abs(Math.tanh(actual.winLogit / 2) - Math.tanh(ref.winLogit / 2)));
    };
    for (const ref of references[name]) {
      const actual = await predictOnce(name, ref.codes, ref.stm, ref.role, ref.placement);
      checkWin(actual, ref);
      let sum = 0;
      for (let i = 0; i < count; i++) {
        policy = Math.max(policy, Math.abs(actual.policy[i] - ref.policy[i]));
        ownership = Math.max(ownership, Math.abs(actual.own[i] - ref.own[i]));
        sum += 2 * (actual.own[i] - ref.own[i]);
      }
      margin = Math.max(margin, Math.abs(sum));
    }
    if (batchedBackend() && metadata.models[String(SIDE)][name].batch_file) {
      // Warm the largest GPU batch and check changing positions, players and
      // JesseJames roles together before accepting this backend.
      const refs = Array.from({length: 32}, (_, i) => references[name][i % references[name].length]);
      const values = await predictBatchOnce(name, refs);
      for (let r = 0; r < refs.length; r++) {
        checkWin(values[r], refs[r]);
        let sum = 0;
        for (let i = 0; i < count; i++) {
          policy = Math.max(policy, Math.abs(values[r].policy[i] - refs[r].policy[i]));
          ownership = Math.max(ownership, Math.abs(values[r].own[i] - refs[r].own[i]));
          sum += 2 * (values[r].own[i] - refs[r].own[i]);
        }
        margin = Math.max(margin, Math.abs(sum));
      }
    }
    const tolerance = nativeInference?.tolerances || {policy:.01, ownership:.001, margin:.02, winLogit:.01, winUtility:.02};
    if (policy > tolerance.policy || ownership > tolerance.ownership || margin > tolerance.margin ||
        winLogit > tolerance.winLogit || winUtility > tolerance.winUtility)
      throw new Error(`Prediction check failed for ${name}`);
    result[name] = {policy, ownership, margin, winLogit, winUtility};
  }
  return result;
}
async function createSessions(provider) {
  const wasMeasuring = measuringInference;
  measuringInference = false;
  try {
    if (nativeInference) {
      backend = await nativeInference.initialize(SIDE, modelNames, metadata);
      for (const name of modelNames) sessions[name] = {release: async () => {}};
      return await verify();
    }
    for (const name of modelNames) {
      // Load one model at a time and let its download buffer go after creation.
      // A GPU fallback re-fetches and re-verifies through the browser HTTP cache.
      const model = await modelBytes(name, provider === "webgpu");
      sessions[name] = await ort.InferenceSession.create(new Uint8Array(model.data), {
        executionProviders: [provider], externalData: model.externalData});
    }
    backend = provider;
    return await verify();
  } finally { measuringInference = wasMeasuring; }
}
async function release() {
  for (const name of Object.keys(sessions)) {
    try { await sessions[name].release(); } catch (_) { /* lost GPU */ }
    delete sessions[name];
  }
}
async function predict(name, c, stm, role, placement = false) {
  try { return await predictOnce(name, c, stm, role, placement); }
  catch (error) {
    if (!initialized || backend !== "webgpu") throw error;
    postMessage({type: "loading", message: "Switching to browser CPU…"});
    await release();
    searchRate = null; rateEpoch++;
    const verification = await createSessions("wasm");
    postMessage({type: "backend-changed", backend, verification,
      model_label: `${metadata.labels[kind]} · browser CPU`});
    return await predictOnce(name, c, stm, role, placement);
  }
}

async function predictBatch(name, positions) {
  if (!batchedBackend()) {
    const values = [];
    for (const p of positions) values.push(await predict(name, p.codes, p.stm, p.role, p.placement));
    return values;
  }
  try {
    // A small set of shapes bounds shader/pipeline caches. Padding is neural
    // work only: it never creates a search visit or changes a position's role.
    const size = [1, 4, 8, 16, 32].find(n => n >= positions.length);
    const padded = Array.from({length: size}, (_, i) => positions[Math.min(i, positions.length - 1)]);
    return (await predictBatchOnce(name, padded)).slice(0, positions.length);
  }
  catch (error) {
    if (nativeInference) throw error;
    // Preserve the selected leaves and their roles if GPU recovery is needed.
    // The serial CPU model remains the established, separately verified graph.
    postMessage({type: "loading", message: "Switching to browser CPU…"});
    await release(); searchRate = null; rateEpoch++;
    const verification = await createSessions("wasm");
    postMessage({type: "backend-changed", backend, verification,
      model_label: `${metadata.labels[kind]} · browser CPU`});
    return await predictBatch(name, positions);
  }
}

const maxNodes = 100000;
const memoryLimit = (cpuRuntime ? 32 : 64) * 1024 * 1024;
let root = null, retained = null, created = 0, treeBytes = 0;
let strongColour = null, rng = null;
let placingWhite = false;
// A search made for the review (Explain move, Review game) explores as the review tool's own search does
// (tw8/arena/gpu_search_desktop.cpp, the settings of training/game_review/engine.py), so that the tool's numbers
// mean the same here: an untried move is valued at the position's running mean, not at its first evaluation; the
// exploration grows with the visits; and the root's priors are softened like every other node's. With the
// page's ordinary search a 160-visit tree is wide (the first move got 39% of the visits where this gets most of
// them) and the side to move comes out about two points too low, which made every move of a game cost nothing.
let reviewMode = false;
let humanity = .8, beta = Infinity;
let searchRate = null, rateEpoch = 0;
const winBonus = () => ["jesse", "tumbstone"].includes(kind)
  ? (metadata?.models?.[String(SIDE)]?.[searchModel]?.win_bonus || 0) : 0;
function node(move = -1, prior = 1) {
  created++; treeBytes += 512;
  return {move, prior, visits: 0, pending: 0, blocked: false, sum: 0, moves: null, priors: null, children: null, own: null, square: null,
    value: 0, cellValue: 0, cellSum: 0, resultValue: 0, resultSum: 0,
    stm: null, terminal: false, leaf: null, rootPriors: null, probability: null, allocations: null, jitter: null};
}

async function expand(current, suppliedPrediction = null) {
  const stm = board._hn_stm(), sign = stm === 1 ? 1 : -1;
  current.stm = stm;
  const placementRoot = placingWhite && current === root;
  // Ordinary territory guarantees do not apply until White's free placement.
  const terminal = !placementRoot && !!board._hn_score(2);
  const prediction = terminal ? null : suppliedPrediction || await predict(searchModel, codes(), stm, stm === strongColour ? 0 : 1, placementRoot);
  const ownership = new Float64Array(count);
  let margin = 0;
  for (let i = 0; i < count; i++) {
    const territory = placementRoot ? 0 : board._hn_territory(cells[i]);
    ownership[i] = territory === 1 ? 1 : territory === 2 ? -1
      : terminal ? 0 : sign * (2 * prediction.own[i] - 1);
    margin += ownership[i];
  }
  current.cellValue = margin;
  const bonus = winBonus();
  if (bonus && !terminal && !Number.isFinite(prediction.winLogit)) throw new Error("Missing search win logit");
  current.resultValue = bonus ? (terminal ? Math.sign(margin) : sign * Math.tanh(prediction.winLogit / 2)) : 0;
  current.value = margin + bonus * current.resultValue;
  current.terminal = terminal;
  current.children = [];
  // Keep each node's original evaluation. It lets a promoted subtree recover
  // exact ownership sums without storing two accumulated maps at every depth.
  current.leaf = ownership; treeBytes += ownership.byteLength;
  if (terminal) {
    return ownership;
  }
  const legal = cells.filter(c => placementRoot ? board._hn_owner(c) === 0 : board._hn_value(c) > 0);
  if (!legal.length) {
    current.moves = Int16Array.of(-1);
    current.priors = Float64Array.of(1);
  }
  else {
    const continuation = (current !== root || reviewMode) && (kind !== "jesse" || stm === strongColour);
    const rootHuman = kind === "frontier" && current === root ? await predict("human", codes(), stm) : null;
    const logits = legal.map(c => (rootHuman || prediction).policy[compact.get(c)] / (continuation ? 1.4 : 1));
    const maximum = Math.max(...logits), weights = logits.map(x => Math.exp(x - maximum));
    const total = weights.reduce((a, b) => a + b, 0);
    current.moves = Int16Array.from(legal);
    current.priors = Float64Array.from(weights, weight => continuation ? .98 * weight / total + .02 / legal.length : weight / total);
    if (continuation) {
      const rootLogits = legal.map(c => prediction.policy[compact.get(c)]), rootMaximum = Math.max(...rootLogits);
      const rootWeights = rootLogits.map(logit => Math.exp(logit - rootMaximum));
      const rootTotal = rootWeights.reduce((a, b) => a + b, 0);
      current.rootPriors = Float64Array.from(rootWeights, weight => weight / rootTotal);
      treeBytes += 128 + current.rootPriors.byteLength;
    }
    if (kind === "frontier" && current === root)
      current.offsets = Frontier.offsets(logits, beta, () => rng.uniform());
  }
  // Legal moves are compact edges. Allocate a full node only when selected;
  // otherwise a wide position spends the entire node budget on unvisited moves.
  current.children = new Array(current.moves.length).fill(null);
  treeBytes += 256 + current.moves.length * 24;
  return ownership;
}

function select(current) {
  const weak = kind === "jesse" && current.stm !== strongColour;
  if (weak && !current.probability) {
    const total = current.priors.reduce((sum, p) => sum + p, 0);
    if (!(total > 0)) throw new Error("Empty opponent policy");
    current.probability = Float64Array.from(current.priors, p => p / total);
    current.allocations = new Float64Array(current.moves.length);
    current.jitter = Float64Array.from(current.probability, p => p > 0 ? rng.uniform() : 0);
    treeBytes += 256 + current.moves.length * 24;
  }
  const sign = current.stm === 1 ? 1 : -1;
  const seen = current.visits + current.pending;
  const scale = (reviewMode ? .05 + .1 * Math.log1p(seen / 1000) : .05) * Math.sqrt(Math.max(1, seen));
  const untried = reviewMode && current.visits ? current.sum / current.visits : current.value;
  let best = -1, score = -Infinity;
  for (let i = 0; i < current.moves.length; i++) {
    const child = current.children[i], visits = child?.visits || 0;
    if (child?.blocked) continue;
    if (weak && current.probability[i] <= 0) continue;
    const value = sign * (visits ? child.sum / visits : untried) / count;
    const candidate = weak ? current.probability[i] / (current.allocations[i] + current.jitter[i])
      : value + (current.offsets?.[i] || 0) / count + scale * current.priors[i] / (1 + visits + (child?.pending || 0));
    if (candidate > score) { score = candidate; best = i; }
  }
  if (best < 0) throw new Error("Nonterminal search node has no legal moves");
  if (weak) { current.allocations[best]++; current.jitter[best] = rng.uniform(); }
  if (!current.children[best]) current.children[best] = node(current.moves[best], current.priors[best]);
  return current.children[best];
}

async function simulate(request) {
  restore(request);
  let current = root;
  const path = [root];
  while (current.children && !current.terminal) {
    const initialPlacement = placingWhite && current === root;
    current = select(current);
    if (initialPlacement) {
      if (!board._hn_place_initial(current.move, 2)) throw new Error("Illegal White starting placement");
    } else play(current.move);
    path.push(current);
  }
  const ownership = current.terminal ? current.leaf : await expand(current);
  backup(path, ownership);
  return path.length - 1;
}

function backup(path, ownership) {
  const margin = ownership.reduce((a, b) => a + b, 0);
  const leaf = path[path.length - 1];
  for (let depth = 0; depth < path.length; depth++) {
    const entry = path[depth];
    entry.visits++;
    entry.sum += leaf.value;
    entry.cellSum += margin;
    entry.resultSum += leaf.resultValue;
    // Only the root and its immediate alternatives are shown as maps. Deeper
    // nodes retain scalar backups/PVs, avoiding two full maps per tree node.
    if (depth > 1) continue;
    if (!entry.own) {
      entry.own = new Float64Array(count); entry.square = new Float64Array(count);
      treeBytes += 128 + count * 16;
    }
    for (let i = 0; i < count; i++) {
      entry.own[i] += ownership[i];
      entry.square[i] += ownership[i] ** 2;
    }
  }
}

function replayPath(request, path) {
  restore(request);
  for (let i = 1; i < path.length; i++) {
    if (placingWhite && i === 1) {
      if (!board._hn_place_initial(path[i].move, 2)) throw new Error("Illegal White starting placement");
    } else play(path[i].move);
  }
}

async function simulateBatch(request, maximum) {
  // Expand the root before reserving descendants. There is no useful batch
  // until its policy is known. Small budgets and CPU retain the serial path.
  if (!root.children || maximum === 1) return await simulate(request);
  const jobs = [];
  let depth = 0;
  try {
    for (let i = 0; i < maximum && !root.blocked; i++) {
      if (created >= maxNodes || treeBytes >= memoryLimit - 16384) break;
      restore(request);
      let current = root;
      const path = [root];
      while (current.children && !current.terminal) {
        const placement = placingWhite && current === root;
        current = select(current);
        if (placement) {
          if (!board._hn_place_initial(current.move, 2)) throw new Error("Illegal White starting placement");
        } else play(current.move);
        path.push(current);
      }
      depth = Math.max(depth, path.length - 1);
      // Exact terminals need no network work and can be backed up immediately.
      if (current.terminal || board._hn_score(2)) {
        backup(path, current.terminal ? current.leaf : await expand(current));
        continue;
      }
      const stm = board._hn_stm();
      jobs.push({path, leaf: current, codes: codes(), stm, role: stm === strongColour ? 0 : 1});
      for (const entry of path) entry.pending++;
      current.blocked = true;
      for (let d = path.length - 2; d >= 0; d--) {
        const entry = path[d];
        entry.blocked = entry.children.every((c, i) => c?.blocked || entry.probability?.[i] === 0);
      }
    }
    if (jobs.length) {
      const predictions = await predictBatch(searchModel, jobs);
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        replayPath(request, job.path);
        backup(job.path, await expand(job.leaf, predictions[i]));
      }
    }
    return depth;
  } finally {
    // Reservations are never counted as completed visits. Drain them on both
    // normal completion and failure, before reporting, reusing or discarding.
    for (const {path} of jobs) for (const entry of path) { entry.pending--; entry.blocked = false; }
  }
}

function batchLimit(target) {
  if (!batchedBackend() || !metadata.models[String(SIDE)][searchModel].batch_file
      || parameters.get("batch") === "1") return 1;
  return target < 32 ? 4 : target < 64 ? 8 : target < 128 ? 16 : 32;
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
  // Opponent roots estimate an expectation, not a winning move. Cutting them
  // short on a visit lead would bias that estimate toward the most likely reply.
  if (kind === "jesse" && current.stm !== strongColour) return false;
  const remaining = limit - current.visits;
  if (remaining <= 0 || remaining >= current.visits || current.moves?.length < 2) return false;
  let first = 0, second = 0;
  for (const child of current.children || []) {
    const visits = child?.visits || 0;
    if (visits > first) { second = first; first = visits; }
    else if (visits > second) second = visits;
  }
  // All reserved leaves have been backed up before this check.
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
  if (current.visits && current.own) cells.forEach((cell, i) => {
    const mean = current.own[i] / current.visits;
    out[cell] = deviation ? Math.sqrt(Math.max(0, current.square[i] / current.visits - mean ** 2)) : mean;
  });
  return out;
}

function cacheOwnership(current) {
  if (!current?.visits || current.own) return;
  const own = new Float64Array(count), square = new Float64Array(count), stack = [current];
  while (stack.length) {
    const entry = stack.pop();
    if (!entry.visits) continue;
    if (entry.own) {
      for (let i = 0; i < count; i++) { own[i] += entry.own[i]; square[i] += entry.square[i]; }
      continue;
    }
    let localVisits = entry.visits;
    for (const child of entry.children || []) if (child) { localVisits -= child.visits; stack.push(child); }
    if (localVisits) for (let i = 0; i < count; i++) {
      own[i] += localVisits * entry.leaf[i];
      square[i] += localVisits * entry.leaf[i] ** 2;
    }
  }
  current.own = own; current.square = square;
}

function promoteSubtree(next) {
  root = next;
  // Interior strong-player priors use temperature/smoothing. A new root uses
  // the original policy, while retaining every completed value/visit backup.
  if (root.rootPriors) {
    root.priors = root.rootPriors; root.rootPriors = null;
    root.children.forEach((child, i) => { if (child) child.prior = root.priors[i]; });
  }
  cacheOwnership(root);
  for (const child of root.children || []) cacheOwnership(child);
  // Dropped ancestors and siblings are no longer reachable. Reclaim their
  // accounting as well as their storage, including after a previous memory cap.
  created = 0; treeBytes = 0;
  const stack = [root];
  while (stack.length) {
    const entry = stack.pop(); created++; treeBytes += 512;
    if (entry.moves) treeBytes += 256 + entry.moves.length * 24;
    if (entry.rootPriors) treeBytes += 128 + entry.rootPriors.byteLength;
    if (entry.leaf) treeBytes += entry.leaf.byteLength;
    if (entry.own) treeBytes += 128 + count * 16;
    if (entry.probability) treeBytes += 256 + entry.moves.length * 24;
    for (const child of entry.children || []) if (child) stack.push(child);
  }
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
    margin: sign * (child.visits ? child.cellSum / child.visits : root.cellValue),
    utility: sign * (child.visits ? child.sum / child.visits : root.value),
    samples: child.visits, ownership: mapOwnership(child), pv: [child.move, ...variation(child)],
    replyCount: child.children?.length || 0, replyState: child.terminal ? 2 : child.children ? 1 : 0,
    replyBest: ranked(child)[0]?.move ?? -1, replyNodeVisits: child.visits,
    replies: ranked(child).slice(0, 8).map(reply => ({move: reply.move, visits: reply.visits,
      margin: -sign * (reply.visits ? reply.cellSum / reply.visits : child.cellValue), prior: reply.prior})),
  }));
  const leader = ranked(root)[0];
  const displayed = (kind !== "jesse" || stm === strongColour) && leader?.visits ? leader : root;
  const rootRedMargin = root.visits ? root.cellSum / root.visits : root.cellValue;
  const displayedRedMargin = displayed.visits ? displayed.cellSum / displayed.visits : root.cellValue;
  // HighNoon preserves the older TumbStone analysis: blend the root mean with the mean
  // below the most-visited move to reduce alternating-turn score jitter.
  // Both backups already use Red's perspective. With no visited child (e.g.
  // policy-only or terminal analysis), the root is the available estimate.
  const redMargin = kind === "highnoon" && request.purpose === "analysis"
    ? (rootRedMargin + displayedRedMargin) / 2 : displayedRedMargin;
  const redUtility = displayed.visits ? displayed.sum / displayed.visits : root.value;
  return {type, gen: request.gen, engine: kind, strongColour, opponentTurn: kind === "jesse" && stm !== strongColour, redMargin, rootRedMargin, redUtility, winBonus: winBonus(), context: request.context, purpose: request.purpose,
    budgetSims: request.sims, budgetMode: request.budgetMode, budgetRevision: request.budgetRevision,
    side: stm, best: candidates[0]?.move ?? -1, visits: root.visits,
    rootMargin: sign * redMargin,
    inheritedVisits: inherited, simulations: root.visits - inherited, pending: 0,
    ms: root.visits > inherited ? performance.now() - start : 0, depth, samples: displayed.visits,
    ownership: mapOwnership(displayed), stdev: mapOwnership(displayed, true), candidates,
    // The whole tree's mean for this position, before any move: what the move
    // that led here is worth cell by cell, comparable with a candidate's map.
    rootOwnership: mapOwnership(root),
    stopped: status === "cancelled", capacityReached: status === "node_limit",
    capacityReason: status === "node_limit" ? "memory" : undefined,
    // Exhausting storage is a usable partial search, just like a time limit.
    engineComplete: type === "done" && status !== "cancelled" && root.visits > 0,
    treeNodes: created, treeNodeLimit: maxNodes, treeBytes, treeMemoryLimit: memoryLimit,
    targetSimulations: limit, simulationsPerSecond: searchRate,
    inference: combinedInference(inferenceMetrics),
    policyOnly,
    earlyStopped: status === "visit_leader", engineStatus: status};
}

function reusePath(request) {
  const canonical = p => [p.side, p.turn, [...p.stacks].sort((a, b) => a[0] - b[0])];
  const initial = request.initial || (request.handicapReds
    ? Position.handicap(SIDE, request.handicapReds, request.placement ? null : request.white)
    : Position.opening(SIDE, request.red, request.white));
  let base = canonical(initial), moves = [...request.moves], placement = request.placement;
  if (initial.kind === "handicap" && JSON.stringify(base) === JSON.stringify(canonical(Position.handicap(SIDE, initial.reds, initial.white)))) {
    // The UI folds White's free placement into the initial position. Treat it
    // as the first tree edge so its searched continuations survive that handoff.
    base = canonical(Position.handicap(SIDE, initial.reds)); placement = "handicap";
    if (initial.white !== null) moves.unshift(initial.white);
  }
  return {key: JSON.stringify([base, placement, kind === "jesse" ? request.strongColour : null,
    request.context, kind === "frontier" ? request.humanity : null]), moves};
}

function reuse(request) {
  if (kind === "jesse" && ![1, 2].includes(request.strongColour)) throw new Error("Choose JesseJames’s colour before searching");
  const path = reusePath(request);
  let next = !request.fresh && retained?.key === path.key && root &&
    retained.moves.length <= path.moves.length && retained.moves.every((move, i) => path.moves[i] === move) ? root : null;
  if (kind === "frontier" && retained?.moves.length !== path.moves.length) next = null;
  if (next) for (const move of path.moves.slice(retained.moves.length)) {
    next = next.children?.[next.moves?.indexOf(move)];
    if (!next) break;
  }
  if (!next) {
    created = 0; treeBytes = 0; root = node();
    const bytes = crypto.getRandomValues(new Uint32Array(2));
    const seed = request.seed ?? ((BigInt(bytes[0]) << 32n) | BigInt(bytes[1])).toString();
    rng = new Jesse.RandomBits(seed);
  } else if (next !== root) promoteSubtree(next);
  strongColour = request.strongColour;
  placingWhite = request.placement === "white";
  reviewMode = request.purpose === "review";
  if (placingWhite && (!request.initial && !request.handicapReds || board._hn_stm() !== 2)) throw new Error("Invalid White placement");
  humanity = request.humanity ?? .8;
  beta = kind === "frontier" ? Frontier.betaForHumanity(humanity, metadata.frontier) : Infinity;
  retained = path;
}

async function oneSearch(request, ticket, reportProgress = data => postMessage(data)) {
  inferenceMetrics = emptyInference(); measuringInference = true;
  restore(request);
  if (request.codes && JSON.stringify(codes()) !== JSON.stringify(request.codes))
    throw new Error("Browser position differs from the displayed board");
  const budget = searchBudget(request), {seconds, timed, policyOnly} = budget;
  const nativeBeta = kind === "frontier" ? Frontier.betaForHumanity(request.humanity ?? .8, metadata.frontier) : Infinity;
  if (nativeInference?.nativeSearch && nativeBeta > 0) {
    if (kind === "jesse" && ![1, 2].includes(request.strongColour)) throw new Error("Choose JesseJames’s colour before searching");
    postMessage({type: "connected"});
    const result = await nativeInference.search({kind, request, budget, path: reusePath(request),
      codes: codes(), stm: board._hn_stm(), beta: nativeBeta, bonus: winBonus()}, data => {
      if (active === ticket || data.type === "ownership") {
        if (data.simulationsPerSecond) searchRate = data.simulationsPerSecond;
        reportProgress(data);
      }
    });
    if (active !== ticket) { result.stopped = true; result.engineComplete = false; }
    else if (result.simulationsPerSecond) searchRate = result.simulationsPerSecond;
    return result;
  }
  // Discard searched statistics when explicitly testing the policy. Expanding
  // only a fresh root ranks its unvisited legal edges by the network prior.
  reuse(policyOnly ? {...request, fresh: true} : request);
  if (kind === "frontier" && beta === 0 && (placingWhite || !board._hn_score(2))) {
    const start = performance.now(), stm = board._hn_stm();
    const legal = cells.filter(c => placingWhite ? !board._hn_owner(c) : board._hn_value(c) > 0);
    const human = legal.length ? await predict("human", codes(), stm) : null;
    const best = legal.length ? legal[Frontier.sample(legal.map(c => human.policy[compact.get(c)]), () => rng.uniform())] : -1;
    const strong = await predict("strong", codes(), stm);
    const own = new Float32Array(grid * grid);
    for (let i = 0; i < count; i++) {
      const territory = placingWhite ? 0 : board._hn_territory(cells[i]);
      own[cells[i]] = territory === 1 ? 1 : territory === 2 ? -1 : (stm === 1 ? 1 : -1) * (2 * strong.own[i] - 1);
    }
    return {type:"done",gen:request.gen,engine:kind,purpose:request.purpose,best,side:stm,
      redMargin:own.reduce((a,b)=>a+b,0),ownership:own,candidates:[],visits:0,simulations:0,
      ms:performance.now()-start,inference:combinedInference(inferenceMetrics),engineComplete:active===ticket,stopped:active!==ticket,engineStatus:"human_policy"};
  }
  const inherited = root.visits, start = performance.now();
  let limit = budget.limit;
  let last = start, depth = 0, status = "simulations";
  let epoch = rateEpoch, measuredAt = start, measuredRoot = inherited, measuredVisits = 0;
  postMessage({type: "connected"});
  if (inherited) reportProgress(report(request, "progress", start, inherited, depth, "searching", limit, policyOnly));
  if (request.preliminaryOwnership && !inherited) {
    // This is the search's first visit, not an extra search or a completed
    // analysis result. Send its map before collecting the larger batches.
    await simulate(request);
    reportProgress({type:"ownership",gen:request.gen,ownership:mapOwnership(root)});
    if (root.terminal) return report(request,"done",start,inherited,0,active===ticket?"terminal":"cancelled",limit,policyOnly);
  }
  while (root.visits < limit) {
    if (active !== ticket) { status = "cancelled"; break; }
    if (root.visits && timed && performance.now() - start >= seconds * 1000) {
      status = "time_limit"; break;
    }
    if (!request.fullBudget && visitLeaderLocked(root, limit)) { status = "visit_leader"; break; }
    if (created >= maxNodes || treeBytes >= memoryLimit - 16384) { status = "node_limit"; break; }
    // The review's first pass has 160 visits a position and 80 a move, which the review tool searches with eight
    // leaves in flight: thirty-two at once would make so small a tree wide instead of deep.
    const batch = request.purpose === "review" && limit < 600 ? Math.min(8, batchLimit(limit)) : batchLimit(limit);
    depth = Math.max(depth, await simulateBatch(request, Math.min(batch, limit - root.visits)));
    if (root.terminal) { status = "terminal"; break; }
    const now = performance.now();
    if (epoch !== rateEpoch) {
      // Exclude device recovery/startup and all visits on the old backend.
      epoch = rateEpoch; measuredAt = now; measuredRoot = root.visits; measuredVisits = 0;
      if (timed) limit = timeTarget(seconds);
    }
    const completed = root.visits - measuredRoot, elapsed = now - measuredAt;
    // Count real completed search work, including traversal, reporting and
    // cooperative yields. Reservations and padded inference rows are excluded.
    if (completed - measuredVisits >= 8 && elapsed >= 100) {
      searchRate = completed * 1000 / elapsed;
      measuredVisits = completed;
      if (timed) limit = timeTarget(seconds);
    }
    if (performance.now() - last > 200) {
      reportProgress(report(request, "progress", start, inherited, depth, "searching", limit, policyOnly));
      last = performance.now();
    }
    await pause(); // Keep Stop and position changes responsive even with WASM inference.
  }
  if (active !== ticket) status = "cancelled";
  const completed = root.visits - measuredRoot, elapsed = performance.now() - measuredAt;
  if (epoch === rateEpoch && status !== "cancelled" && completed >= 8 && elapsed >= 100)
    searchRate = completed * 1000 / elapsed;
  return report(request, "done", start, inherited, depth, status, limit, policyOnly);
}

async function search(request, ticket) {
  if (request.purpose !== "offer" || kind !== "jesse") {
    const result = await oneSearch(request, ticket);
    if (request.purpose === "offer" && kind === "tumbstone") result.offerPreference = result.redUtility;
    postMessage(result);
    return;
  }
  // The offer is asymmetric: compare Jesse as Red with Jesse as White, using
  // expected opponent replies for the latter, rather than negating one value.
  const started = performance.now();
  const bytes = crypto.getRandomValues(new Uint32Array(2));
  const seed = request.seed ?? ((BigInt(bytes[0]) << 32n) | BigInt(bytes[1])).toString();
  const half = {...request, fresh: true, seed,
    seconds: request.seconds ? request.seconds / 2 : 0,
    ...(request.remainingSeconds !== undefined ? {remainingSeconds: request.remainingSeconds / 2} : {}),
    ...(request.remainingSimulations !== undefined ? {remainingSimulations: request.remainingSimulations / 2} : {})};
  // Keep the existing per-colour search budgets and decisions. Display the
  // combined work so neither colour evaluation looks like a stalled engine.
  const offerProgress = (data, colour, previous = null) => ({...data,
    offerStage: colour, offerStageVisits: data.visits, offerStageTarget: data.targetSimulations,
    visits: (previous?.visits || 0) + data.visits,
    targetSimulations: (previous?.targetSimulations || data.targetSimulations) + data.targetSimulations,
    simulations: (previous?.simulations || 0) + data.simulations,
    inference: combinedInference(previous?.inference, data.inference),
    inheritedVisits: 0, ms: performance.now() - started});
  const red = await oneSearch({...half, strongColour: 1}, ticket,
    data => postMessage(offerProgress(data, "red")));
  if (active !== ticket) { postMessage(offerProgress(red, "red")); return; }
  postMessage(offerProgress({...red, type: "progress", engineComplete: false}, "red"));
  const white = await oneSearch({...half, strongColour: 2}, ticket,
    data => postMessage(offerProgress(data, "white", red)));
  const offerScores = {red: red.redUtility, white: -white.redUtility};
  postMessage({...red, offerStage: "white", offerStageVisits: white.visits,
    offerStageTarget: white.targetSimulations, visits: red.visits + white.visits,
    targetSimulations: red.targetSimulations + white.targetSimulations, inheritedVisits: 0,
    engineComplete: red.engineComplete && white.engineComplete,
    engineStatus: active !== ticket ? "cancelled" : red.engineStatus,
    stopped: active !== ticket, offerScores, offerPreference: offerScores.red - offerScores.white,
    ms: performance.now() - started, simulations: red.simulations + white.simulations,
    inference: combinedInference(red.inference, white.inference)});
}

// ---- Game review (review-sheets.js): fixed-effort searches and plain network evaluations of any position.
// Positions arrive as compact codes and the side to move, and every search starts a new tree and spends its
// whole budget, so the commentary does not depend on what was searched before. Answers follow the review
// tool's engine: margins for the side to move, moves as grid cells, ownership per compact cell for Red.

function reviewPosition(c, stm) {
  if (c.length !== count || ![1, 2].includes(stm)) throw new Error("Invalid review position");
  return {side: SIDE, turn: stm, stacks: cells.flatMap((cell, i) =>
    c[i] ? [[cell, c[i] === 13 ? 3 : c[i] <= 6 ? 1 : 2, c[i] === 13 ? 2 : (c[i] - 1) % 6 + 1]] : [])};
}

// The searched root as the review wants it. A line stops before a pass.
function reviewAnalysis(pvLength) {
  const sign = root.stm === 1 ? 1 : -1;
  if (root.terminal) return {terminal: true, margin: sign * root.cellValue, best: null, candidates: [], visits: 0};
  const line = child => {
    const moves = [child.move, ...variation(child)].slice(0, pvLength), pass = moves.findIndex(m => m < 0);
    return pass < 0 ? moves : moves.slice(0, pass);
  };
  const children = ranked(root).filter(child => child.move >= 0);
  return {terminal: false, margin: sign * (root.visits ? root.cellSum / root.visits : root.cellValue),
    best: children.length ? children[0].move : null, visits: root.visits,
    candidates: children.map(child => ({move: child.move, visits: child.visits, prior: child.prior,
      margin: child.visits ? sign * child.cellSum / child.visits : null, pv: line(child)})),
    ownership: {mean: Array.from(root.own, v => v / root.visits), samples: root.visits}};
}

async function reviewSearch(data, ticket) {
  const out = [], total = data.jobs.length;
  const progress = done => postMessage({type: "review-progress", id: data.id, done, total});
  if (data.visits === 1) {
    // One visit is the network's first choice among the legal moves: no tree, a whole batch per network call.
    const open = [];
    data.jobs.forEach(([c, stm], k) => {
      restore({initial: reviewPosition(c, stm), moves: []});
      const legal = board._hn_score(2) ? [] : cells.filter(cell => board._hn_value(cell) > 0);
      if (legal.length) open.push({k, legal, codes: c, stm, role: 0});
      else out[k] = {terminal: true, margin: null, best: null, candidates: [], visits: 0};
    });
    for (let start = 0; start < open.length; start += 32) {
      if (active !== ticket) return null;
      const chunk = open.slice(start, start + 32), predictions = await predictBatch(searchModel, chunk);
      chunk.forEach((job, i) => {
        const policy = predictions[i].policy;
        const best = job.legal.reduce((a, b) => policy[compact.get(b)] > policy[compact.get(a)] ? b : a);
        out[job.k] = {terminal: false, margin: null, best, candidates: [], visits: 1};
      });
      progress(Math.min(total, start + 32));
      await pause();
    }
    return out;
  }
  for (let k = 0; k < total; k++) {
    const [c, stm] = data.jobs[k];
    const request = {initial: reviewPosition(c, stm), moves: [], sims: data.visits, fresh: true, fullBudget: true,
      purpose: "review", context: "review", strongColour: 1, gen: data.id, _reviewPvLength: data.pvLength || 10};
    const found = await oneSearch(request, ticket, report => progress(k + Math.min(1, report.visits / data.visits)));
    if (active !== ticket || found.stopped) return null;
    out.push(found.nativeReview || reviewAnalysis(data.pvLength || 10));
    progress(k + 1);
  }
  return out;
}

async function reviewEvaluate(data, ticket) {
  const policy = [], own = [];
  for (let start = 0; start < data.codes.length; start += 32) {
    if (active !== ticket) return null;
    const rows = data.codes.slice(start, start + 32).map((c, i) => ({codes: c, stm: data.stm[start + i], role: 0}));
    for (const value of await predictBatch(searchModel, rows)) { policy.push(value.policy); own.push(value.own); }
  }
  return {policy, own};
}

async function drain() {
  if (running || !initialized) return;
  running = true;
  while (pending) {
    const job = pending;
    pending = null;
    if (job.request.type !== "search") {
      try {
        if (kind !== "highnoon") throw new Error("The review uses the analysis engine");
        const out = await (job.request.type === "review-search" ? reviewSearch : reviewEvaluate)(job.request, job.ticket);
        postMessage({type: "review-done", id: job.request.id, out, stopped: out === null});
      } catch (error) {
        postMessage({type: "review-done", id: job.request.id, error: String(error)});
      }
      // A review search leaves its own small tree behind; the next analysis starts from a new one.
      root = null; retained = null;
      continue;
    }
    try { await search(job.request, job.ticket); }
    catch (error) {
      root = null; retained = null;
      postMessage({type: "error", gen: job.request.gen, message: String(error)});
    }
  }
  running = false;
}

onmessage = ({data}) => {
  if (["review-search", "review-evaluate", "search", "stop"].includes(data.type)) nativeInference?.stop?.();
  if (data.type === "review-search" || data.type === "review-evaluate") {
    active = ++serial;
    pending = {request: data, ticket: active};
    drain();
  } else if (data.type === "search") {
    active = ++serial;
    pending = {request: data, ticket: active};
    drain();
  } else if (data.type === "stop") { active = null; pending = null; }
  else if (data.type === "preliminary-start") postMessage({type: "preliminary-done", token: data.token});
};

async function checkedFetch(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path}: ${response.status}`);
  return response;
}
async function modelBytes(name, batched = false) {
  const entry = metadata.models[String(SIDE)][name];
  async function bytes(file, expected) {
    const data = await (await checkedFetch(file)).arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
      .map(x => x.toString(16).padStart(2, "0")).join("");
    if (hash !== expected) throw new Error(`Changed ${name} model`);
    return data;
  }
  const parallel = batched && entry.scan_file && parameters.get("scan") === "parallel";
  const linear = !parallel && batched && entry.linear_file && parameters.get("matrix") === "flat";
  const data = await bytes(parallel ? entry.scan_file : linear ? entry.linear_file : batched && entry.batch_file ? entry.batch_file : entry.file,
    parallel ? entry.scan_sha256 : linear ? entry.linear_sha256 : batched && entry.batch_file ? entry.batch_sha256 : entry.files["network.onnx"]), externalData = [];
  for (const external of entry.external_data || [])
    externalData.push({path: external.path, data: new Uint8Array(await bytes(external.file, external.sha256))});
  return {data, externalData};
}
async function initialize() {
  postMessage({type: "loading", message: "Loading engine…"});
  board = await HN();
  metadata = await (await checkedFetch("engine.json")).json();
  if (board._hn_side() !== SIDE || !metadata.sides.includes(SIDE)) throw new Error("Wrong board size");
  for (const name of modelNames)
    references[name] = await (await checkedFetch(metadata.models[String(SIDE)][name].reference)).json();
  if (!nativeInference) {
    ort.env.wasm.wasmPaths = new URL("vendor/", location.href).href;
    ort.env.wasm.numThreads = 1;
  }
  const providers = nativeInference ? ["native"] : cpuRuntime ? ["wasm"] : ["webgpu", "wasm"];
  let verification, failure;
  for (const provider of providers) {
    try {
      postMessage({type: "loading", message: provider === "native" ? "Preparing the engine…"
        : `Preparing ${provider === "webgpu" ? "GPU" : "CPU"} play…`});
      verification = await createSessions(provider);
      break;
    } catch (error) { failure = error; await release(); }
  }
  if (modelNames.some(name => !sessions[name])) throw failure;
  initialized = true;
  postMessage({type: "ready", protocol: "highnoon-analysis", version: 1, board_sizes: [SIDE], engine:kind,
    model_label: `${metadata.labels[kind]} · ${nativeInference ? (backend === "native-cuda" ? "NVIDIA GPU" : "native CPU") : backend === "webgpu" ? "WebGPU" : "browser CPU"}`,
    model_sha256: metadata.models[String(SIDE)][modelNames[0]].checkpoint_sha256, backend, runtimeBuild: nativeInference ? "native" : cpuRuntime ? "wasm-only" : "webgpu", verification, simulations: metadata.simulations,
    maxBatch: batchLimit(2048),
    scanImplementation: backend === "webgpu" && metadata.models[String(SIDE)][modelNames[0]].scan_file && parameters.get("scan") === "parallel" ? "parallel" : "sequential",
    matrixLayout: backend === "webgpu" && metadata.models[String(SIDE)][modelNames[0]].linear_file && parameters.get("matrix") === "flat" && parameters.get("scan") !== "parallel" ? "flat-fp32" : "original-fp32",
    fallbackReason: backend === "wasm" && failure ? String(failure) : null});
  drain();
}
initialize().catch(error => postMessage({type: "error", message: String(error)}));
