"use strict";
const browser = new URL(location.href).searchParams.get("backend") === "browser";
let controller, serial = 0, policy, board, sessionPromise;

async function json(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path}.`);
  return response.json();
}

async function predict(codes, stm, profile, history) {
  const session = await sessionPromise;
  const inputs = {
    cells: new ort.Tensor("int32", Int32Array.from(codes), [1, 169]),
    stm: new ort.Tensor("int32", Int32Array.of(stm), [1]),
    level: new ort.Tensor("float32", Float32Array.of(profile.level), [1]),
    vector: new ort.Tensor("float32", Float32Array.from(profile.vector), [1, 16]),
    history: new ort.Tensor("float32", history, [1, 169, 2])
  };
  let output;
  try {
    output = await session.run(inputs);
    return Array.from(output.logits.data);
  } finally {
    Object.values(inputs).forEach(t => t.dispose());
    Object.values(output || {}).forEach(t => t.dispose());
  }
}

async function loadModel() {
  postMessage({type: "loading", message: "Loading human imitation…"});
  importScripts("vendor/ort.wasm.min.js");
  ort.env.wasm.wasmPaths = new URL("vendor/", location.href).href;
  ort.env.wasm.numThreads = 1;
  const entry = policy.data.model;
  const response = await fetch(entry.file);
  if (!response.ok) throw new Error("Could not download the human model.");
  const bytes = await response.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    b => b.toString(16).padStart(2, "0")).join("");
  if (hash !== entry.sha256) throw new Error("Changed human model.");
  return ort.InferenceSession.create(new Uint8Array(bytes), {executionProviders: ["wasm"]});
}

let verified;
async function ensureModel() {
  if (!verified) {
    sessionPromise = loadModel();
    verified = (async () => {
      await sessionPromise;
      const references = await json(policy.data.model.reference);
      let error = 0;
      for (const ref of references) {
        const history = policy.history([...ref.previous].reverse().map(c => c < 0 ? -1 : HumanPolicy.cells[c]));
        const actual = await predict(ref.codes, ref.stm, policy.profile(ref.profile), history);
        if (!actual.every(Number.isFinite)) throw new Error("Invalid human model output.");
        error = Math.max(error, ...actual.map((x, i) => Math.abs(x - ref.logits[i])));
      }
      if (error > .001) throw new Error("Human model prediction check failed.");
      postMessage({type: "backend-changed", backend: "wasm", model_label: "Human imitation · browser CPU"});
    })().catch(async error => {
      try { await (await sessionPromise).release(); } catch (_) { /* incomplete download/session */ }
      verified = null; sessionPromise = null;
      throw error;
    });
  }
  return verified;
}

async function browserAnswer(data, ticket) {
  const profile = policy.profile(data.profile);
  if (data.purpose === "offer") return {offerPreferRed: HumanPolicy.random() < policy.redProbability(data.profile, data.initial)};
  if (data.initial.side !== 8 || !Array.isArray(data.moves) || data.moves.length > 1500)
    throw new Error("Invalid human game.");
  Position.initialize(board, data.initial);
  for (const move of data.moves) Position.play(board, move);
  const cells = HumanPolicy.cells, legal = cells.filter(c => board._hn_value(c) > 0);
  if (!legal.length || board._hn_score(2)) return {best: -1};
  const found = policy.book(data.profile, data.initial, data.moves, legal);
  if (found.length) return {best: HumanPolicy.sample(found)};
  const codes = cells.map(c => {
    const owner = board._hn_owner(c);
    return owner === 3 ? 13 : owner ? board._hn_height(c) + (owner === 2 ? 6 : 0) : 0;
  });
  const stm = board._hn_stm(), history = policy.history(data.moves);
  await ensureModel();
  if (serial !== ticket) return null;
  const logits = await predict(codes, stm, profile, history);
  return {best: policy.choose(logits, legal)};
}

onmessage = async ({data}) => {
  if (data.type === "stop") { serial++; controller?.abort(); return; }
  if (data.type !== "search") return;
  const ticket = ++serial;
  controller?.abort();
  const current = controller = new AbortController();
  try {
    let answer;
    if (browser) answer = await browserAnswer(data, ticket);
    else {
      const response = await fetch("/api/human", {method: "POST", signal: current.signal,
        headers: {"Content-Type": "application/json"}, body: JSON.stringify({
          action: data.purpose === "offer" ? "offer" : "move", profile: data.profile,
          initial: data.initial, moves: data.moves})});
      answer = await response.json();
      if (!response.ok) throw new Error(answer.error || "The human opponent is unavailable.");
    }
    if (serial !== ticket) return;
    postMessage({type: "done", gen: data.gen, ...answer, engine: "human", engineComplete: true,
      engineStatus: "human_policy", visits: 1, simulations: 0, candidates: [], stopped: false});
  } catch (error) {
    if (serial === ticket && error.name !== "AbortError") postMessage({type: "error", gen: data.gen, message: error.message});
  }
};

async function initialize() {
  if (browser) {
    importScripts("position.js", "human-policy.js", "rules/side8.js");
    policy = new HumanPolicy.Policy(await json("human.json"));
    board = await HN();
  }
  postMessage({type: "ready", backend: browser ? "wasm" : "local-cpu", model_label: "Human imitation"});
}
initialize().catch(error => postMessage({type: "error", message: error.message}));
