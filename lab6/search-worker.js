"use strict";

// Each short WASM slice returns to the worker event loop. Position changes and
// Stop can therefore cancel a search without destroying a loaded engine.
importScripts("config.js", "hn.js?v=20261002-30");
let engine = null;
let active = null;
let pending = null;
let timer = null;
let lastReport = 0;
let runningSlice = false;
let position = null;

function rootSnapshot() {
  const m = engine;
  const candidates = [];
  const count = m._hn_root_count();
  for (let j = 0; j < count; j++) {
    const visits = m._hn_root_visits(j);
    const ownership = [];
    for (let cell = 0; cell < ANALYSIS_CONFIG.cells; cell++) ownership.push(m._hn_move_ownership(j, cell));
    const pv = [];
    const pvLength = m._hn_root_pv_len(j);
    for (let k = 0; k < pvLength; k++) pv.push(m._hn_root_pv(j, k));
    const replies = [], replyCount = m._hn_reply_count(j);
    for (let k = 0; k < replyCount; k++) {
      const replyVisits = m._hn_reply_visits(j, k);
      // Unvisited edges have no searched margin or distribution to display.
      // Keep their total count, but avoid caching thousands of empty objects.
      if (replyVisits > 0) replies.push({move: m._hn_reply_move(j, k), visits: replyVisits,
        prior: m._hn_reply_prior(j, k), margin: m._hn_reply_margin(j, k)});
    }
    candidates.push({index: j, move: m._hn_root_move(j), visits,
      prior: m._hn_root_prior(j), margin: visits ? m._hn_root_margin(j) : null,
      samples: m._hn_root_samples(j), ownership, pv,
      replyCount, replyState: m._hn_reply_state(j), replyBest: m._hn_reply_best(j),
      replyNodeVisits: m._hn_reply_node_visits(j), replies});
  }
  const ownership = [], stdev = [];
  for (let cell = 0; cell < ANALYSIS_CONFIG.cells; cell++) {
    ownership.push(m._hn_ownership(cell));
    stdev.push(m._hn_ownership_stdev(cell));
  }
  return {gen: active.gen, type: "progress", side: m._hn_stm(), best: m._hn_search_best(),
    visits: m._hn_last(1), inheritedVisits: m._hn_last(6), ms: m._hn_last(2), depth: m._hn_last(0),
    capacityReached: !!m._hn_last(5),
    samples: m._hn_ownership_samples(), candidates, ownership, stdev};
}

function beginPending() {
  if (!engine || !pending || runningSlice) return;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (active) engine._hn_search_stop();
  active = pending;
  pending = null;
  try {
    // Only an exact forward extension refers to descendants of this tree.
    // Review backwards, different starts and sibling branches rebuild safely.
    const forward = position && position.red === active.red && position.white === active.white &&
      position.moves.length <= active.moves.length && position.moves.every((move, index) => move === active.moves[index]);
    if (!forward) engine._hn_init_search(active.red, active.white, ANALYSIS_CONFIG.treeMemoryMiB);
    for (const move of active.moves.slice(forward ? position.moves.length : 0)) {
      if (move < 0) engine._hn_pass();
      else if (!engine._hn_play(move)) throw new Error("Illegal move in search position.");
    }
    position = {red: active.red, white: active.white, moves: active.moves.slice()};
    active.searchStarted = !!engine._hn_search_start(active.sims > 0 ? active.sims : ANALYSIS_CONFIG.searchSims);
    active.reportInherited = engine._hn_last(6) > 0;
    lastReport = 0;
    timer = setTimeout(step, 0);
  } catch (error) {
    postMessage({type: "error", gen: active.gen, message: String(error.message || error)});
    active = null;
    position = null;
  }
}

function step() {
  timer = null;
  if (!active) return;
  const job = active;
  runningSlice = true;
  try {
    // Publish retained analysis before doing new work, but only on the
    // scheduled turn so a newer queued position can supersede this job.
    if (job.reportInherited) {
      job.reportInherited = false;
      const snapshot = rootSnapshot();
      if (!job.searchStarted) snapshot.type = "done";
      postMessage(snapshot);
      lastReport = performance.now();
      if (!job.searchStarted) { active = null; return; }
    }
    const more = engine._hn_search_step(256, 25);
    const now = performance.now();
    if (!more || now - lastReport >= 120) {
      const snapshot = rootSnapshot();
      if (!more) snapshot.type = "done";
      postMessage(snapshot);
      lastReport = now;
    }
    if (!more) active = null;
    else timer = setTimeout(step, 0);
  } catch (error) {
    postMessage({type: "error", gen: job.gen, message: String(error.message || error)});
    active = null;
    position = null;
  } finally {
    runningSlice = false;
    if (pending) beginPending();
  }
}

self.onmessage = event => {
  const message = event.data;
  if (message.type === "search") {
    pending = message;
    beginPending();
  } else if (message.type === "stop") {
    pending = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (active) {
      engine._hn_search_stop();
      const snapshot = rootSnapshot();
      snapshot.type = "done";
      snapshot.stopped = true;
      postMessage(snapshot);
      active = null;
    }
  }
};

HN().then(module => {
  engine = module;
  postMessage({type: "ready"});
  beginPending();
}).catch(error => postMessage({type: "error", message: "Engine load: " + String(error.message || error)}));
