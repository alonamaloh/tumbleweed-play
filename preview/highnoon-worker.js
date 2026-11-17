"use strict";
// The compact mc014/mc014s8 engine, shared by play, analysis and commentary.
// Stop terminates this worker from the UI, including a synchronous WASM search.
const side = Number(new URL(location.href).searchParams.get("size"));
importScripts("position.js", `highnoon/${side}/engine.js`);
const cells = Position.cells(side);
let engine;
function call(name, types = [], args = []) {
  const value = JSON.parse(engine.ccall(name, "string", types, args));
  if (value.error) throw new Error(value.error);
  return value;
}
function setPosition(codes, stm) {
  call("ui_position", ["string", "number"], [codes.map(c => String.fromCharCode(65 + c)).join(""), stm]);
}
function gridMap(compact) {
  const values = new Float32Array(Position.grid(side) ** 2);
  cells.forEach((c, i) => values[c] = compact?.[i] || 0);
  return values;
}
const ready = (async () => {
  postMessage({type: "loading", message: "Loading HighNoon…"});
  engine = await createS8Engine({locateFile: name => new URL(`highnoon/${side}/${name}`, location.href).href,
    print: () => {}, printErr: () => {}});
  if (side === 8) {
    engine.FS.mkdir("/model");
    for (const name of ["parent.bin", "winhead.bin"]) {
      const response = await fetch(`highnoon/8/${name}`);
      if (!response.ok) throw new Error(`Could not load HighNoon: ${response.status}`);
      engine.FS.writeFile(`/model/${name}`, new Uint8Array(await response.arrayBuffer()));
    }
  }
  call("s8_init");
  postMessage({type: "ready", backend: "wasm", model_label: `HighNoon · ${side === 6 ? "mc014" : "mc014s8"} · browser CPU`});
})();
ready.catch(error => postMessage({type: "error", message: error.message}));

async function handle(data) {
  await ready;
  if (data.type === "review-evaluate") {
    const policy = [], own = [];
    for (let i = 0; i < data.codes.length; i++) {
      setPosition(data.codes[i], data.stm[i]);
      const output = call("s8_evaluate");
      policy.push(output.policy);
      own.push(output.ownership.map(value => 1 / (1 + Math.exp(-value))));
    }
    postMessage({type: "review-done", id: data.id, out: {policy, own}});
  } else if (data.type === "review-search") {
    const out = [];
    for (const [codes, stm] of data.jobs) {
      setPosition(codes, stm);
      const found = call("ui_search", ["number", "number"], [data.visits, data.pvLength || 10]);
      if (found.capacity) throw new Error("HighNoon's search memory is full. Choose a lower commentary effort.");
      found.best = found.best < 0 ? null : found.best;
      found.candidates.sort((a, b) => b.visits - a.visits || (b.margin ?? -Infinity) - (a.margin ?? -Infinity));
      out.push(found);
      postMessage({type: "review-progress", id: data.id, done: out.length, total: data.jobs.length});
    }
    postMessage({type: "review-done", id: data.id, out});
  } else if (data.type === "search") {
    const stm = data.moves.length % 2 ? 3 - data.initial.turn : data.initial.turn;
    setPosition(data.codes, stm);
    if (data.preliminaryOwnership) {
      const raw = call("ui_search", ["number", "number"], [1, 1]);
      postMessage({type: "ownership", gen: data.gen, ownership: gridMap(raw.ownership.mean)});
    }
    const start = performance.now();
    const found = call("ui_search", ["number", "number"], [data.sims, 10]);
    const sign = stm === 1 ? 1 : -1;
    const candidates = found.candidates.map(c => ({...c, samples: c.visits, ownership: gridMap(c.ownership)}));
    candidates.sort((a, b) => (b.move === found.best) - (a.move === found.best) || b.visits - a.visits || b.prior - a.prior);
    const rootOwnership = gridMap(found.ownership.mean);
    const rootRedMargin = sign * found.margin;
    const top = candidates.find(c => c.move === found.best);
    const redMargin = top?.samples ? (rootRedMargin + sign * top.margin) / 2 : rootRedMargin;
    postMessage({type: "done", gen: data.gen, engine: "highnoon", model: side === 6 ? "mc014" : "mc014s8",
      side: stm, best: found.best, visits: found.visits, simulations: found.visits, inheritedVisits: 0,
      ms: performance.now() - start, targetSimulations: data.sims, candidates, rootRedMargin, redMargin,
      ownership: top?.samples ? top.ownership : rootOwnership, rootOwnership, samples: found.visits,
      policyOnly: data.sims === 1 && !found.terminal, stopped: false, engineComplete: true,
      capacityReached: found.capacity, engineStatus: found.terminal ? "terminal" : found.capacity ? "node_limit" : "budget",
      purpose: data.purpose, winBonus: 20});
  }
}
// Serialize requests: initialization is asynchronous, but WASM owns one position and tree.
let pending = Promise.resolve();
onmessage = ({data}) => {
  if (data.type === "stop") return; // The owner also terminates us; no later result can reach the UI.
  pending = pending.then(() => handle(data)).catch(error => postMessage(data.type.startsWith("review-")
    ? {type: "review-done", id: data.id, error: error.message}
    : {type: "error", gen: data.gen, message: error.message}));
};
