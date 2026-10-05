"use strict";

// Each short WASM slice returns to the worker event loop. Position changes and
// Stop can therefore cancel a search without destroying a loaded engine.
importScripts("config.js", "hn.js?v=20261004-53");
let engine = null;
let active = null;
let pending = null;
let timer = null;
let lastReport = 0;
let runningSlice = false;
let position = null;
// Loaded-history previews use a separate small instance, so they never replace
// the normal search's retained tree or add invented visits to its budget.
let preliminaryEngine = null;
let preliminaryLoading = null;
let preliminaryActive = null;
let preliminaryTimer = null;
const PRELIMINARY_SIMS = 2000;
const PRELIMINARY_MEMORY_MIB = 16;

function stopPreliminary() {
  if (preliminaryTimer !== null) clearTimeout(preliminaryTimer);
  preliminaryTimer = null;
  preliminaryActive = null;
  preliminaryEngine = null; // Let the temporary WASM instance be collected.
}

function schedulePreliminary() {
  if (!preliminaryActive || preliminaryTimer !== null) return;
  if (preliminaryEngine) {
    preliminaryTimer = setTimeout(preliminaryStep, 0);
    return;
  }
  if (preliminaryLoading) return;
  preliminaryLoading = HN().then(module => {
    preliminaryLoading = null;
    if (!preliminaryActive) return;
    preliminaryEngine = module;
    schedulePreliminary();
  }).catch(error => {
    preliminaryLoading = null;
    if (preliminaryActive)
      postMessage({type: "preliminary-error", token: preliminaryActive.token,
        message: String(error.message || error)});
    stopPreliminary();
  });
}

function preliminaryStep() {
  preliminaryTimer = null;
  const job = preliminaryActive, m = preliminaryEngine;
  if (!job || !m) return;
  try {
    const index = job.indices[job.next];
    if (!job.started) {
      // Start each prefix independently; inherited visits would change this pass.
      m._hn_init_search(job.red, job.white, PRELIMINARY_MEMORY_MIB);
      for (const move of job.moves.slice(0, index)) {
        if (move < 0) m._hn_pass();
        else if (!m._hn_play(move)) throw new Error("Illegal move in preliminary position.");
      }
      job.started = true;
      if (!m._hn_score(2)) m._hn_search_start(PRELIMINARY_SIMS);
    }
    const exact = !!m._hn_score(2);
    let margin = exact ? m._hn_score(0) - m._hn_score(1) : null;
    if (!exact) {
      // Return to the event loop even on a slow device before another slice.
      if (m._hn_search_step(PRELIMINARY_SIMS, 10)) {
        schedulePreliminary();
        return;
      }
      if (m._hn_last(1) === PRELIMINARY_SIMS && m._hn_last(6) === 0 &&
          !m._hn_last(5) && m._hn_ownership_samples() > 0) {
        margin = 0;
        for (let cell = 0; cell < ANALYSIS_CONFIG.cells; cell++) {
          const ownership = m._hn_ownership(cell);
          // Off-board cells are NaN; playable cells must be finite.
          const x = cell % (2 * ANALYSIS_CONFIG.side - 1), y = Math.floor(cell / (2 * ANALYSIS_CONFIG.side - 1));
          if (Math.abs(x - y) <= ANALYSIS_CONFIG.side - 1) margin += ownership;
        }
        let leader = -1, leaderVisits = 0, leaderMove = -1;
        for (let j = 0; j < m._hn_root_count(); j++) {
          const visits = m._hn_root_visits(j), move = m._hn_root_move(j);
          // Tied visit counts use the lower cell index, just like the main list.
          if (Number.isFinite(visits) && visits > 0 &&
              (leader < 0 || visits > leaderVisits || visits === leaderVisits && move < leaderMove)) {
            leader = j; leaderVisits = visits; leaderMove = move;
          }
        }
        if (leader >= 0 && leaderMove >= 0 && leaderMove < ANALYSIS_CONFIG.cells) {
          const width = 2 * ANALYSIS_CONFIG.side - 1;
          const playable = Math.abs(leaderMove % width - Math.floor(leaderMove / width)) < ANALYSIS_CONFIG.side;
          const leaderMargin = m._hn_root_margin(leader);
          if (playable && Number.isFinite(leaderMargin))
            margin = (margin + leaderMargin * (m._hn_stm() === 1 ? 1 : -1)) / 2;
        }
      }
    }
    if (Number.isFinite(margin)) postMessage({type: "preliminary", token: job.token,
      index, margin, exact, visits: exact ? 0 : PRELIMINARY_SIMS});
    job.next++;
    job.started = false;
    if (job.next < job.indices.length) schedulePreliminary();
    else {
      postMessage({type: "preliminary-done", token: job.token});
      stopPreliminary();
    }
  } catch (error) {
    postMessage({type: "preliminary-error", token: job.token, message: String(error.message || error)});
    stopPreliminary();
  }
}

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
  return {gen: active.gen, type: "progress", context: active.context, purpose: active.purpose,
    budgetSims: active.budgetSims, side: m._hn_stm(), best: m._hn_search_best(),
    visits: m._hn_last(1), inheritedVisits: m._hn_last(6), ms: m._hn_last(2), depth: m._hn_last(0),
    capacityReached: !!m._hn_last(5),
    samples: m._hn_ownership_samples(), candidates, ownership, stdev};
}

function searchJob(message) {
  // Older callers used just a position and a target. New callers isolate Play,
  // Analysis and each difficulty with their own session-qualified context.
  const context = typeof message.context === "string" ? message.context : "";
  const purpose = ["analysis", "play", "offer"].includes(message.purpose) ? message.purpose : "analysis";
  const budgetSims = Number.isSafeInteger(message.sims) && message.sims > 0 &&
    message.sims <= ANALYSIS_CONFIG.searchSims ? message.sims : ANALYSIS_CONFIG.searchSims;
  // Easy must really be one fresh simulation, not a previously searched tree.
  // Color-choice valuations are similarly independent of an earlier offering.
  const fresh = message.fresh === true || purpose === "offer" || purpose === "play" && budgetSims === 1;
  return {...message, context, purpose, budgetSims, fresh};
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
    const forward = !active.fresh && position && position.context === active.context &&
      position.purpose === active.purpose && position.red === active.red && position.white === active.white &&
      position.moves.length <= active.moves.length && position.moves.every((move, index) => move === active.moves[index]);
    if (!forward) engine._hn_init_search(active.red, active.white, ANALYSIS_CONFIG.treeMemoryMiB);
    for (const move of active.moves.slice(forward ? position.moves.length : 0)) {
      if (move < 0) engine._hn_pass();
      else if (!engine._hn_play(move)) throw new Error("Illegal move in search position.");
    }
    position = {red: active.red, white: active.white, moves: active.moves.slice(),
      context: active.context, purpose: active.purpose};
    active.searchStarted = !!engine._hn_search_start(active.budgetSims);
    active.reportInherited = engine._hn_last(6) > 0;
    lastReport = 0;
    timer = setTimeout(step, 0);
  } catch (error) {
    postMessage({type: "error", gen: active.gen, context: active.context, purpose: active.purpose,
      budgetSims: active.budgetSims, message: String(error.message || error)});
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
    postMessage({type: "error", gen: job.gen, context: job.context, purpose: job.purpose,
      budgetSims: job.budgetSims, message: String(error.message || error)});
    active = null;
    position = null;
  } finally {
    runningSlice = false;
    if (pending) beginPending();
  }
}

self.onmessage = event => {
  const message = event.data;
  if (message.type === "preliminary-start") {
    stopPreliminary();
    const indices = (message.indices || []).filter(index => Number.isInteger(index) && index >= 0 && index <= message.moves.length).slice(-2048);
    if (!indices.length) return;
    preliminaryActive = {...message, indices, next: 0};
    schedulePreliminary();
  } else if (message.type === "preliminary-stop") {
    stopPreliminary();
  } else if (message.type === "search") {
    pending = searchJob(message);
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
