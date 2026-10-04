"use strict";

const SIDE = ANALYSIS_CONFIG.side;
const N = 2 * SIDE - 1;
const MID = SIDE - 1;
const CENTRE = MID * N + MID;
const $ = id => document.getElementById(id);
const board = $("board");
const candidatePane = $("candidate-scroll");
const cellName = cell => cell < 0 ? "pass" : String.fromCharCode(65 + cell % N) + (Math.floor(cell / N) + 1);
const valid = cell => Number.isInteger(cell) && cell >= 0 && cell < N * N && Math.abs(cell % N - Math.floor(cell / N)) <= MID;
const signed = value => Number.isFinite(value) ? (value > 0 ? "+" : "") + value.toFixed(1) : "—";
const cells = Array.from({length: N * N}, (_, i) => i).filter(valid);
const radius = SIDE === 6 ? 27 : 19.5;
const FIXED_SEARCH_VISITS = ANALYSIS_CONFIG.searchSims || 100000;
const PRELIMINARY_SEARCH_VISITS = 2000;
const CANDIDATE_ROW_SLIDE_MS = 360;
const candidateRowAnimations = new Map();
const candidateMotion = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
const SUMMARY_CACHE_LIMIT = 512;
const SUMMARY_CACHE_BYTE_LIMIT = 64 * 1024 * 1024;
const summaryCache = new Map();
let summaryCacheBytes = 0;
const marginHistory = new Map();
const preliminaryMargins = new Map(); // Provisional graph values, never completed searches.
let preliminaryJob = null;
let preliminarySequence = 0;
const MARGIN_HISTORY_LIMIT = 2048;
const MARGIN_GRAPH = Object.freeze({width: 600, left: 48, right: 584, top: 14, bottom: 150});
const MARGIN_GRAPH_MIN = 5;
let marginGraphLimit = MARGIN_GRAPH_MIN;

let engine = null;
let worker = null;
let workerReady = false;
let starts = SIDE === 6 ? [47, 96] : [79, 176]; // D5/I9 or E6/L12.
let history = [];
let cursor = 0;
let generation = 0;
let searching = false;
let sharingGame = false;
let computerMoveTimer = null;
let gameAnalysis = null;
let gameAnalysisTimer = null;
let moveAudio = null;
let moveAudioUnlock = null;
let thudNoise = null;
let result = null;
let carriedOwnership = null; // Display-only conditional map for the position just played.
let renderedCandidateMoves = [];
let view = "normal";
let hoverMove = null;
let hoverRow = null;
let boardGesture = null;
let rowGesture = null;
let suppressClickUntil = 0;
let suppressRowClickUntil = 0;
let stableBest = null;
let stableSince = 0;
let activePositionKey = null;
let setupPhase = 0; // 0: play, 1: choose Red, 2: choose White.
let setupRed = null;
let timelineGesture = null;
let timelineHoverIndex = null;
let suppressTimelineClickUntil = 0;

function historyPositionKey(index) {
  return JSON.stringify([SIDE, starts[0], starts[1], history.slice(0, index)]);
}

function positionKey() {
  if (setupPhase) return JSON.stringify([SIDE, "setup", setupPhase, setupRed]);
  return historyPositionKey(cursor);
}

function gameText() {
  return [...starts, ...history].map(cellName).join(" ");
}

function loadGameFromUrl() {
  let text;
  try { text = new URL(window.location.href).searchParams.get("game"); }
  catch { return; }
  if (text === null) return;
  $("moves").value = text;
  loadPosition();
}

async function shareGame() {
  if (!engine || setupPhase || sharingGame) return;
  const text = gameText();
  if ($("moves").value !== text) {
    $("position-error").textContent = "Load the edited game before sharing.";
    return;
  }
  let url;
  try {
    url = new URL(window.location.href);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("Open this page through HTTP or HTTPS to share a game.");
    url.searchParams.set("game", text);
    url.hash = "";
  } catch (error) {
    $("position-error").textContent = error.message || "Sharing unavailable for this page.";
    return;
  }
  const link = url.href;
  const feedback = (message, manualLink = false) => {
    // A native share sheet can stay open while computer play or editing changes
    // the game. Share the clicked snapshot, without adding stale UI feedback.
    if (setupPhase || gameText() !== text || $("moves").value !== text) return;
    $("position-error").textContent = message;
    if (manualLink) {
      $("share-link").value = link;
      $("share-link").hidden = false;
    }
  };
  sharingGame = true;
  $("share").disabled = true;
  $("share-link").hidden = true;
  $("share-link").value = "";
  $("position-error").textContent = "";
  try {
    if (typeof navigator.share === "function") {
      try {
        // Some share targets append text/title to the URL when copying it.
        await navigator.share({url: link});
        return;
      } catch (error) {
        if (error && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(link);
      feedback("Game link copied.");
    } catch { feedback("Copy the game link below.", true); }
  } finally {
    sharingGame = false;
    $("share").disabled = !engine || !!setupPhase;
  }
}

function prepareMoveSound(event) {
  if (event && event.isTrusted === false) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!moveAudio && AudioContext) moveAudio = new AudioContext();
    if (moveAudio && moveAudio.state === "suspended") {
      const resumed = moveAudio.resume();
      if (resumed && typeof resumed.catch === "function") moveAudioUnlock = resumed.catch(() => {});
    }
  } catch { /* Sound must never prevent a move. */ }
}

function playMoveSound(delay = 0) {
  const audio = moveAudio;
  // A first gesture can finish resuming audio just after the move handler.
  // Allow that brief delay, but never replay old moves when audio unlocks later.
  if (!audio) return;
  if (audio.state !== "running") {
    if (audio.state === "suspended" && moveAudioUnlock) {
      const requestedAt = performance.now();
      moveAudioUnlock.then(() => {
        if (audio === moveAudio && audio.state === "running" && performance.now() - requestedAt < 150)
          playMoveSound(delay);
      });
    }
    return;
  }
  try {
    if (!thudNoise) {
      thudNoise = audio.createBuffer(1, Math.ceil(audio.sampleRate * .035), audio.sampleRate);
      const samples = thudNoise.getChannelData(0);
      // A fixed noise texture avoids affecting the opening selector's random stream.
      let seed = 0x48534e;
      for (let k = 0; k < samples.length; k++) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        samples[k] = (seed >>> 0) / 2147483648 - 1;
      }
    }
    const now = audio.currentTime + delay;
    const bass = audio.createOscillator(), bassGain = audio.createGain();
    bass.type = "sine";
    bass.frequency.setValueAtTime(150, now);
    bass.frequency.exponentialRampToValueAtTime(65, now + .045);
    bassGain.gain.setValueAtTime(.0001, now);
    bassGain.gain.linearRampToValueAtTime(.35, now + .005);
    bassGain.gain.exponentialRampToValueAtTime(.0001, now + .13);
    bass.connect(bassGain); bassGain.connect(audio.destination);
    bass.onended = () => { bass.disconnect(); bassGain.disconnect(); };
    bass.start(now); bass.stop(now + .14);

    const tap = audio.createBufferSource(), filter = audio.createBiquadFilter(), tapGain = audio.createGain();
    tap.buffer = thudNoise;
    filter.type = "lowpass"; filter.frequency.value = 800; filter.Q.value = .6;
    tapGain.gain.setValueAtTime(.14, now);
    tapGain.gain.exponentialRampToValueAtTime(.0001, now + .03);
    tap.connect(filter); filter.connect(tapGain); tapGain.connect(audio.destination);
    tap.onended = () => { tap.disconnect(); filter.disconnect(); tapGain.disconnect(); };
    tap.start(now); tap.stop(now + .035);
  } catch { /* Missing or interrupted audio is a silent fallback. */ }
}

for (const event of ["pointerdown", "pointerup", "click", "keydown"])
  document.addEventListener(event, prepareMoveSound, {capture: true});

function ownershipMargin(data) {
  if (!data || !(data.samples > 0) || !data.ownership) return null;
  let margin = 0;
  for (const cell of cells) {
    if (!Number.isFinite(data.ownership[cell])) return null;
    margin += data.ownership[cell];
  }
  return margin; // Ownership reports are already Red-relative, even on White's turn.
}

function reportMargin(data) {
  const mean = ownershipMargin(data);
  if (!Number.isFinite(mean)) return null;
  // Follow the same Visits-ranked child used by the list and move selection,
  // not the engine's potentially lightly explored highest-margin candidate.
  const leader = Array.isArray(data.candidates) ? sortedCandidates(data)[0] : null;
  if (!leader || !valid(leader.move) || !Number.isFinite(leader.visits) ||
      !Number.isFinite(leader.margin) || (data.side !== 1 && data.side !== 2)) return mean;
  const leaderRedMargin = leader.margin * (data.side === 1 ? 1 : -1);
  return (mean + leaderRedMargin) / 2;
}

function rememberTimelineMargin(key, margin) {
  if (!key || !Number.isFinite(margin)) return;
  marginGraphLimit = Math.max(marginGraphLimit, Math.abs(margin));
  marginHistory.delete(key);
  marginHistory.set(key, margin);
  while (marginHistory.size > MARGIN_HISTORY_LIMIT)
    marginHistory.delete(marginHistory.keys().next().value);
}

function timelineEstimateAt(index) {
  if (setupPhase || !Number.isInteger(index) || index < 0 || index > history.length) return null;
  const key = historyPositionKey(index);
  const preliminary = preliminaryMargins.get(key);
  if (preliminary && preliminary.exact) return {margin: preliminary.margin, source: "exact"};
  if (marginHistory.has(key)) return {margin: marginHistory.get(key), source: "search"};
  // Reading the whole timeline must not promote every summary in the LRU.
  const cached = summaryCache.get(key);
  if (cached && Number.isFinite(cached.margin)) return {margin: cached.margin, source: "search"};
  return preliminary && Number.isFinite(preliminary.margin)
    ? {margin: preliminary.margin, source: "quick"} : null;
}

function isPreliminaryEstimate(estimate) {
  return estimate && estimate.source === "quick";
}

function preliminaryEstimateLabel() {
  return `${PRELIMINARY_SEARCH_VISITS}-simulation estimate`;
}

function timelineMarginAt(index) {
  const estimate = timelineEstimateAt(index);
  return estimate ? estimate.margin : null;
}

function timelinePositionText(index) {
  const position = index ? `Move ${index}/${history.length}` : "Start";
  const estimate = timelineEstimateAt(index);
  return estimate ? `${position} · Red ${signed(estimate.margin)}${isPreliminaryEstimate(estimate) ? " · " + preliminaryEstimateLabel() : ""}` : position;
}

function updateTimelineLabel(index = cursor) {
  $("move-number").textContent = setupPhase ? "Start" : timelinePositionText(index);
}

function marginGraphX(index) {
  const {left, right} = MARGIN_GRAPH;
  return !setupPhase && history.length ? left + index * (right - left) / history.length : (left + right) / 2;
}

function marginGraphScale(margins) {
  marginGraphLimit = margins.reduce((maximum, margin) =>
    Number.isFinite(margin) ? Math.max(maximum, Math.abs(margin)) : maximum, marginGraphLimit);
  const step = marginGraphLimit < 7 ? 1 : marginGraphLimit < 14 ? 5 : marginGraphLimit < 70 ? 10 : 50;
  return {step, limit: marginGraphLimit};
}

function drawMarginTimeline() {
  const timeline = $("review"), disabled = !engine || !!setupPhase;
  const count = setupPhase ? 1 : history.length + 1;
  const estimates = Array.from({length: count}, (_, index) => timelineEstimateAt(index));
  const margins = estimates.map(estimate => estimate ? estimate.margin : null);
  const {step, limit} = marginGraphScale(margins);
  const {left, right, top, bottom} = MARGIN_GRAPH;
  const zero = (top + bottom) / 2;
  const yAt = margin => zero - margin / limit * (bottom - top) / 2;
  timeline.max = setupPhase ? 0 : history.length;
  timeline.value = setupPhase ? 0 : cursor;
  timeline.disabled = disabled;
  timeline.setAttribute("aria-valuemax", timeline.max);
  timeline.setAttribute("aria-valuenow", timeline.value);
  timeline.setAttribute("aria-valuetext", disabled ? "Start" : timelinePositionText(cursor));
  timeline.setAttribute("aria-disabled", String(disabled));
  timeline.setAttribute("tabindex", disabled ? "-1" : "0");
  timeline.setAttribute("data-range", limit);
  let svg = `<rect class="margin-red-region" x="${left}" y="${top}" width="${right - left}" height="${zero - top}"/>`;
  svg += `<rect class="margin-white-region" x="${left}" y="${zero}" width="${right - left}" height="${bottom - zero}"/>`;
  const gridSteps = Math.floor(limit / step);
  for (let index = -gridSteps; index <= gridSteps; index++) {
    const tick = index * step;
    const y = yAt(tick).toFixed(3);
    const label = tick.toFixed(1).replace(/\.0$/, "");
    svg += `<path class="${tick === 0 ? "margin-zero" : "margin-grid"}" d="M${left},${y}H${right}"/>`;
    svg += `<text class="margin-axis-label" x="${left - 9}" y="${y}" text-anchor="end" dominant-baseline="middle">${tick > 0 ? "+" : ""}${label}</text>`;
  }
  const tickCount = Math.min(count, 5);
  for (let tick = 0; tick < tickCount; tick++) {
    const index = tickCount > 1 ? Math.round(tick * (count - 1) / (tickCount - 1)) : 0;
    svg += `<text class="margin-axis-label" data-move-tick="${index}" x="${marginGraphX(index).toFixed(3)}" y="170" text-anchor="middle">${index}</text>`;
  }
  if (!disabled) {
    const x = marginGraphX(cursor).toFixed(3);
    svg += `<path class="margin-current" data-current="${cursor}" d="M${x},${top}V${bottom}"/>`;
  }
  const lines = {search: "", quick: ""};
  let previousKnown = false, previousStyle = null;
  const pointAt = index => `${marginGraphX(index).toFixed(3)},${yAt(margins[index]).toFixed(3)}`;
  for (let index = 0; index < count; index++) {
    const known = Number.isFinite(margins[index]);
    if (known) {
      // An edge is provisional while either endpoint has only a quick estimate.
      const style = isPreliminaryEstimate(estimates[index]) ||
        previousKnown && isPreliminaryEstimate(estimates[index - 1]) ? "quick" : "search";
      if (!previousKnown) lines[style] += `M${pointAt(index)}`;
      else {
        if (previousStyle !== style) lines[style] += `M${pointAt(index - 1)}`;
        lines[style] += `L${pointAt(index)}`;
      }
      previousStyle = style;
    }
    previousKnown = known;
  }
  if (lines.quick) svg += `<path class="margin-line preliminary" d="${lines.quick}"/>`;
  if (lines.search) svg += `<path class="margin-line" d="${lines.search}"/>`;
  for (let index = 0; index < count; index++) {
    const margin = margins[index], x = marginGraphX(index);
    if (Number.isFinite(margin)) {
      const fill = margin > 0 ? "#ba4238" : margin < 0 ? "#fffdf8" : "#37423a";
      svg += `<circle class="margin-point${isPreliminaryEstimate(estimates[index]) ? " preliminary" : ""}${index === cursor && !disabled ? " current" : ""}" data-index="${index}" data-source="${estimates[index].source}" cx="${x.toFixed(3)}" cy="${yAt(margin).toFixed(3)}" r="3.5" fill="${fill}"/>`;
    } else {
      // Unknown is an explicit gap, not an invented zero-valued point.
      svg += `<path class="margin-unknown" data-index="${index}" d="M${(x - 2).toFixed(3)},${zero - 2}L${(x + 2).toFixed(3)},${zero + 2}M${(x - 2).toFixed(3)},${zero + 2}L${(x + 2).toFixed(3)},${zero - 2}"/>`;
    }
    const start = index ? (marginGraphX(index - 1) + x) / 2 : left;
    const end = index + 1 < count ? (x + marginGraphX(index + 1)) / 2 : right;
    svg += `<rect class="margin-hit" data-index="${index}" x="${start.toFixed(3)}" y="${top}" width="${(end - start).toFixed(3)}" height="${bottom - top}"><title>${timelinePositionText(index)}</title></rect>`;
  }
  timeline.innerHTML = svg;
  updateTimelineLabel(timelineHoverIndex === null ? cursor : timelineHoverIndex);
}

function cacheSearchResult(key, data) {
  if (!key || (data.type !== "progress" && data.type !== "done")) return;
  const margin = reportMargin(data);
  // Keep the latest estimate even if we leave before this search finishes.
  // A timeline color must not make an unfinished position skip reanalysis.
  if (Number.isFinite(margin)) {
    rememberTimelineMargin(key, margin);
    drawMarginTimeline();
  }
  if (data.type !== "done" || data.stopped || data.capacityReached || !(data.visits >= FIXED_SEARCH_VISITS)) return;
  // Cache reports only, never engine instances or trees. Compact maps keep a
  // full game's review history modest; scores and visit counts stay doubles.
  const candidates = data.candidates.map(candidate => Object.freeze({
    ...candidate,
    ownership: Float32Array.from(candidate.ownership),
    pv: Object.freeze(candidate.pv.slice()),
    replies: Object.freeze((candidate.replies || []).map(reply => Object.freeze({
      move: reply.move, visits: reply.visits, prior: reply.prior, margin: reply.margin,
    }))),
  }));
  const snapshot = Object.freeze({...data,
    ownership: Float32Array.from(data.ownership),
    stdev: Float32Array.from(data.stdev),
    candidates: Object.freeze(candidates),
  });
  // Conservative accounting includes scalar reply objects, not only maps.
  const bytes = 512 + snapshot.ownership.byteLength + snapshot.stdev.byteLength + candidates.reduce((sum, candidate) =>
    sum + 256 + candidate.ownership.byteLength + candidate.pv.length * 8 + candidate.replies.length * 128, 0);
  const previous = summaryCache.get(key);
  if (previous) summaryCacheBytes -= previous.bytes;
  summaryCache.delete(key);
  summaryCache.set(key, Object.freeze({data: snapshot, margin, stableBest, stableSince, bytes}));
  summaryCacheBytes += bytes;
  while (summaryCache.size > SUMMARY_CACHE_LIMIT || summaryCacheBytes > SUMMARY_CACHE_BYTE_LIMIT) {
    const oldest = summaryCache.keys().next().value;
    summaryCacheBytes -= summaryCache.get(oldest).bytes;
    summaryCache.delete(oldest);
  }
}

function getCachedResult(key) {
  const cached = summaryCache.get(key);
  if (cached) { summaryCache.delete(key); summaryCache.set(key, cached); }
  return cached;
}

$("board-size").textContent = SIDE;
$("playmode").value = "analysis";
document.title = "HighNoon";
// Fit the board and its coordinate labels closely instead of scaling a large
// invisible border along with every cell.
board.setAttribute("viewBox", SIDE === 6 ? "10 20 580 513" : "18 26 564 503");

function parseCell(text) {
  if (/^(pass|-)$/i.test(text)) return -1;
  const match = /^([a-z])(\d{1,2})$/i.exec(text.trim());
  if (!match) throw new Error(`Invalid coordinate: ${text || "(empty)"}.`);
  const col = match[1].toUpperCase().charCodeAt(0) - 65, row = +match[2] - 1;
  if (col < 0 || col >= N || row < 0 || row >= N) throw new Error(`Coordinate ${text} is outside this board.`);
  const cell = row * N + col;
  if (!valid(cell)) throw new Error(`Coordinate ${text} is outside this board.`);
  return cell;
}

function symmetricCell(cell, symmetry) {
  let a = cell % N - MID, c = -(Math.floor(cell / N) - MID), b = -a - c;
  if (symmetry >= 6) [a, b] = [b, a];
  for (let k = 0; k < symmetry % 6; k++) [a, c, b] = [-c, -b, -a];
  return (-c + MID) * N + a + MID;
}

function randomStart() {
  const options = cells.filter(cell => cell !== CENTRE);
  const red = options[Math.floor(Math.random() * options.length)];
  // Sample White directly from the remaining cells, without a retry loop.
  const whiteOptions = options.filter(cell => cell !== red);
  return [red, whiteOptions[Math.floor(Math.random() * whiteOptions.length)]];
}

function balancedStart() {
  const offerings = ANALYSIS_CONFIG.balancedStarts || [];
  if (!offerings.length) return randomStart();
  const pair = offerings[Math.floor(Math.random() * offerings.length)].split(" ").map(parseCell);
  const symmetry = Math.floor(Math.random() * 12);
  return pair.map(cell => symmetricCell(cell, symmetry));
}

function legalStartCell(cell) {
  return valid(cell) && cell !== CENTRE && (setupPhase !== 2 || cell !== setupRed);
}

function xy(cell) {
  const c = cell % N - MID, r = Math.floor(cell / N) - MID;
  return [300 + (c - r / 2) * radius * 1.78, 277 + r * radius * 1.55];
}

function hexPath(x, y) {
  return Array.from({length: 6}, (_, k) => {
    const a = (60 * k + 30) * Math.PI / 180;
    return (k ? "L" : "M") + (x + radius * Math.cos(a)).toFixed(1) + "," + (y + radius * Math.sin(a)).toFixed(1);
  }).join("") + "Z";
}

function ownershipColor(value) {
  if (!Number.isFinite(value)) return "#e5ddca";
  const amount = Math.min(1, Math.abs(value));
  const end = value >= 0 ? [186, 66, 56] : [255, 255, 255];
  // Blend only the background, so even fully owned cells differ from stacks.
  const background = [229, 221, 202];
  return "rgb(" + end.map((channel, k) => Math.round((background[k] + channel * amount) / 2)).join(",") + ")";
}

function marginLossColor(loss) {
  if (!Number.isFinite(loss)) return null;
  if (loss < 0) return "rgb(149,106,199)";
  const green = [79, 156, 104], yellow = [230, 185, 82], red = [207, 87, 76];
  const from = loss <= 5 ? green : yellow, to = loss <= 5 ? yellow : red;
  const amount = Math.min(1, loss <= 5 ? loss / 5 : (loss - 5) / 5);
  return "rgb(" + from.map((channel, k) => Math.round(channel + (to[k] - channel) * amount)).join(",") + ")";
}

function previewMove() {
  if (boardGesture) return boardGesture.pointerType === "mouse"
    ? boardGesture.cancelled ? null : boardGesture.cell : boardGesture.previewCell;
  if (rowGesture) return rowGesture.pointerType === "mouse"
    ? rowGesture.cancelled ? null : rowGesture.move : rowGesture.previewMove;
  return hoverMove;
}

function previewCandidate() {
  if (setupPhase) return null;
  const move = previewMove();
  const candidate = result && move !== null ? result.candidates.find(c => c.move === move) || null : null;
  return candidate && (view !== "ownership" || candidate.samples > 0) ? candidate : null;
}

function movePressActive() { return !!boardGesture || !!rowGesture; }

function updateMarginMarker() {
  if (!engine || setupPhase) {
    $("ownership-marker-value").textContent = "";
    return "";
  }
  const retained = timelineEstimateAt(cursor);
  const retainedMargin = retained ? retained.margin : null;
  // Cached maps use Float32 storage; retain the graph's original scalar precision.
  const searchedMargin = result && result.type === "cached" && retained && retained.source === "search"
    ? retainedMargin : reportMargin(result);
  const settled = !!engine._hn_score(2);
  const margin = settled ? engine._hn_score(0) - engine._hn_score(1)
    : Number.isFinite(searchedMargin) ? searchedMargin : Number.isFinite(retainedMargin)
      ? retainedMargin : engine._hn_eval_margin() * (engine._hn_stm() === 1 ? 1 : -1);
  const position = Math.max(0, Math.min(100, (margin / cells.length + 1) * 50));
  $("ownership-marker").style.left = `${position}%`;
  $("ownership-marker-value").style.left = `${position}%`;
  $("ownership-marker-value").textContent = signed(margin);
  const source = settled ? "final margin" : Number.isFinite(searchedMargin)
    ? "blended search estimate" : Number.isFinite(retainedMargin)
      ? isPreliminaryEstimate(retained) ? preliminaryEstimateLabel() : retained.source === "exact" ? "final margin" : "retained search estimate"
      : "static ownership estimate";
  const label = `Red ${signed(margin)} cells · ${source}.`;
  $("ownership-legend").title = label;
  $("ownership-legend").setAttribute("aria-label", label);
  return label;
}

function drawBoard(force = false) {
  if (!engine) return;
  // Only board structure freezes during a press; the marker stays with the graph.
  const legendLabel = updateMarginMarker();
  const placing = setupPhase !== 0;
  const settled = !placing && !!engine._hn_score(2);
  $("ownership-legend-row").hidden = placing || view !== "ownership";
  $("margin-loss-legend").hidden = placing || settled || view !== "margin";
  if (movePressActive() && !force) return;
  const preview = placing || settled ? null : previewCandidate();
  const selectedMove = previewMove();
  // The prospective stack is known before any search statistics arrive.
  // Preview it read-only without claiming an unsearched conditional map.
  const ghostLegal = placing ? legalStartCell(selectedMove) : valid(selectedMove) && !engine._hn_score(2) && engine._hn_value(selectedMove) > 0;
  const ghostMove = ghostLegal ? selectedMove : null;
  const ownershipPreview = preview && view === "ownership";
  const replyPreview = preview && (view === "visits" || view === "margin");
  // The dashed hint is the root-list Space action, not an opponent's reply.
  const highlightedMove = !placing && !replyPreview ? firstListedMove() : null;
  const ownershipOn = !placing && (!!ownershipPreview || view === "ownership");
  // Preserve the played move's preview until genuine new-root samples arrive.
  // It is display-only: inherited visits without samples must not replace it
  // with a static NNUE map or turn it into a cached/search/graph observation.
  const carriedMap = carriedOwnership && carriedOwnership.key === positionKey()
    && !(result && result.samples > 0) ? carriedOwnership.ownership : null;
  // Without a previous conditional map, use the display engine's already
  // evaluated Red-relative root prediction before any search report exists.
  const map = placing || settled ? null : ownershipPreview ? preview.ownership
    : carriedMap || result && result.ownership || ownershipOn && cells.reduce((values, cell) => {
      values[cell] = engine._hn_ownership(cell);
      return values;
    }, []);
  const marginOn = !placing && view === "margin" && !ownershipPreview;
  const displayedCandidates = placing || settled ? [] : replyPreview ? preview.replyState === 1 ? preview.replies || [] : [] : result ? result.candidates : [];
  const displayedBest = placing ? null : replyPreview ? preview.replyBest : result && result.best;
  const rootSide = result ? result.side : engine._hn_stm();
  const displayedSide = replyPreview ? 3 - rootSide : rootSide;
  const bestCandidate = displayedCandidates.find(candidate => candidate.move === displayedBest);
  const hasBaseline = bestCandidate && bestCandidate.visits > 0 && Number.isFinite(bestCandidate.margin);
  const marginCandidates = new Map(displayedCandidates.map(candidate => [candidate.move, candidate]));
  const top = displayedCandidates.filter(c => c.visits > 0).slice().sort((a, b) => b.visits - a.visits).slice(0, 6);
  const total = displayedCandidates.reduce((sum, c) => sum + c.visits, 0);
  const rootVisitTotal = result ? result.candidates.reduce((sum, c) => sum + c.visits, 0) : 0;
  const context = $("preview-context");
  context.hidden = !(ownershipPreview || replyPreview);
  if (!context.hidden) {
    let text = `After ${cellName(preview.move)}`;
    if (replyPreview) {
      text += ` · ${displayedSide === 1 ? "Red" : "White"} replies`;
      if (preview.replyState === 2) text += " · settled";
      else if (preview.replyState !== 1) text += " · not expanded";
      else if (!total) text += " · no visited replies";
      else if (top.length === 1 && top[0].move < 0) text += view === "visits" ? ` · pass (${(100 * top[0].visits / total).toFixed(0)}%)` : " · pass";
    }
    context.textContent = text;
  }
  let svg = "", mapMargin = map ? 0 : null;
  for (const cell of cells) {
    const [x, y] = xy(cell);
    const ghost = cell === ghostMove;
    const own = placing ? cell === CENTRE ? 3 : cell === setupRed ? 1 : ghost ? setupPhase : 0 : ghost ? engine._hn_stm() : engine._hn_owner(cell);
    const height = placing ? cell === CENTRE ? 2 : cell === setupRed || ghost ? 1 : 0 : ghost ? engine._hn_value(cell) : engine._hn_height(cell);
    const territory = placing ? 0 : engine._hn_territory(cell);
    // Reply overlays are annotations only. Every hit target and move action
    // remains legal in the actual root position, never the ghost position.
    const legal = placing ? legalStartCell(cell) : !engine._hn_score(2) && engine._hn_value(cell) > 0;
    const candidate = marginCandidates.get(cell);
    const loss = marginOn && (replyPreview || legal) && hasBaseline && candidate && candidate.visits > 0 && Number.isFinite(candidate.margin) ? bestCandidate.margin - candidate.margin : null;
    // Higher values favor the player making each displayed move, matching
    // the table at the root. A ghost retains its root mover's value even when
    // that cell is also one of the opponent's replies.
    const marginCandidate = ghost ? preview : candidate;
    const moveMargin = marginOn && (ghost || replyPreview || legal) && marginCandidate && marginCandidate.visits > 0 && Number.isFinite(marginCandidate.margin)
      ? marginCandidate.margin : null;
    const ownership = settled
      ? territory === 1 ? 1 : territory === 2 ? -1 : NaN
      : ownershipOn && territory === 1 ? 1 : ownershipOn && territory === 2 ? -1
      : map && map[cell];
    if (map && Number.isFinite(ownership)) mapMargin += ownership;
    const fill = settled ? ownershipColor(ownership)
      : Number.isFinite(loss) ? marginLossColor(loss)
      : ownershipOn && map ? ownershipColor(ownership)
      : territory === 1 ? ownershipColor(1) : territory === 2 ? ownershipColor(-1) : "#e5ddca";
    let title = cellName(cell);
    if (settled) {
      title = Number.isFinite(ownership) ? `${((ownership + 1) * 50).toFixed(1)}%` : "";
    } else if (marginOn) {
      title = Number.isFinite(moveMargin) ? signed(moveMargin) : "";
    } else if (!placing && view === "visits" && !ownershipPreview) {
      const tooltipCandidate = ghost ? preview : candidate;
      const tooltipTotal = ghost ? rootVisitTotal : total;
      title = tooltipCandidate && Number.isFinite(tooltipCandidate.visits) && tooltipCandidate.visits >= 0 && tooltipTotal > 0
        ? `${(100 * tooltipCandidate.visits / tooltipTotal).toFixed(1)}%` : "";
    } else if (ownershipOn) {
      title = Number.isFinite(ownership) ? `${((ownership + 1) * 50).toFixed(1)}%` : "";
    }
    const numericTooltip = !placing && (settled || marginOn || view === "visits" || ownershipOn);
    const accessibleLabel = numericTooltip ? ` aria-label="${cellName(cell)}${title ? " " + title : ""}"` : "";
    svg += `<path class="hex${legal ? " legal" : ""}" data-cell="${cell}"${accessibleLabel} d="${hexPath(x, y)}" fill="${fill}">${title ? `<title>${title}</title>` : ""}</path>`;
    if (own) {
      const stackRadius = radius * .60;
      const stackFill = own === 1 ? "#ba4238" : own === 2 ? "#fffefa" : "#8d8575";
      svg += `<circle class="stack" cx="${x}" cy="${y}" r="${stackRadius}" fill="none" stroke="#fffdf8" stroke-width="3"/>`;
      svg += `<circle class="stack${ghost ? " preview-stack" : ""}" cx="${x}" cy="${y}" r="${stackRadius}" fill="${stackFill}" stroke="${ghost ? "#00e676" : "#555b50"}" stroke-width="${ghost ? 2 : 1}"${ghost ? ` data-preview-root="${ghostMove}" stroke-dasharray="3,2" opacity=".8"` : ""}/>`;
      svg += `<text class="stack-number" x="${x}" y="${y}" fill="${own === 2 ? "#454b49" : "#fff"}">${height}</text>`;
    }
    if (territory === 1 || territory === 2) svg += `<g class="territory-lock" data-lock-cell="${cell}" pointer-events="none" transform="translate(${x - radius * .52},${y + radius * .28})"><path d="M-2,-1v-2a2,2 0 0 1 4,0v2" fill="none" stroke="#575e53" stroke-width="1.3"/><rect x="-3" y="-1" width="6" height="5" rx="1" fill="${territory === 1 ? "#ba4238" : "#fffefa"}" stroke="#575e53" stroke-width=".9"/></g>`;
    if (cursor && cell === history[cursor - 1]) svg += `<path class="last-move" data-last-move="${cell}" d="${hexPath(x, y)}" fill="none" stroke="#ff8c00" stroke-width="3" pointer-events="none"/>`;
    if (ghost) svg += `<path d="${hexPath(x, y)}" fill="none" stroke="#00e676" stroke-width="4" pointer-events="none"/>`;
    else if (cell === highlightedMove) svg += `<path class="candidate-recommendation" data-recommended-move="${cell}" d="${hexPath(x, y)}" fill="none" stroke="#bf00ff" stroke-width="3" stroke-dasharray="4,3" pointer-events="none"/>`;
    if (Number.isFinite(moveMargin)) svg += `<text class="margin-loss-number" x="${x}" y="${y + radius * .74}" text-anchor="middle" font-size="9" font-weight="650" fill="#172b1d" pointer-events="none">${signed(moveMargin)}</text>`;
  }
  if (view === "visits" && !ownershipPreview && total) {
    top.forEach((candidate, rank) => {
      if (candidate.move < 0) return;
      const [x, y] = xy(candidate.move), share = candidate.visits / total;
      const circleRadius = radius * (.23 + .40 * Math.sqrt(share));
      svg += `<g pointer-events="none"><circle cx="${x}" cy="${y - radius * .50}" r="${circleRadius}" fill="#e3eed5" stroke="#236949" stroke-width="1.4"/><text x="${x}" y="${y - radius * .50}" text-anchor="middle" dominant-baseline="central" font-size="9" font-weight="650" fill="#245738">${rank + 1}</text><text x="${x}" y="${y + radius * .79}" text-anchor="middle" font-size="9" fill="#245738">${(100 * share).toFixed(0)}%</text></g>`;
    });
  }
  const dx = radius * 1.78, dy = radius * 1.55, offset = .83;
  for (let r = 0; r < N; r++) {
    const [x0, y0] = xy(r * N + Math.max(0, r - MID)), [x1, y1] = xy(r * N + Math.min(N - 1, r + MID));
    if (r <= MID) svg += `<text class="coord" x="${x0 - offset * dx}" y="${y0}">${r + 1}</text>`;
    if (r >= MID) svg += `<text class="coord" x="${x1 + offset * dx}" y="${y1}">${r + 1}</text>`;
  }
  for (let c = 0; c < N; c++) {
    const [x0, y0] = xy(Math.max(0, c - MID) * N + c), [x1, y1] = xy(Math.min(N - 1, c + MID) * N + c);
    const letter = String.fromCharCode(65 + c);
    if (c <= MID) {
      const x = x0 + offset * dx / 2, y = y0 - offset * dy;
      svg += `<text class="coord" x="${x}" y="${y}" transform="rotate(30 ${x} ${y})">${letter}</text>`;
    }
    if (c >= MID) {
      const x = x1 - offset * dx / 2, y = y1 + offset * dy;
      svg += `<text class="coord" x="${x}" y="${y}" transform="rotate(30 ${x} ${y})">${letter}</text>`;
    }
  }
  board.innerHTML = svg;
  if (placing) {
    $("ownership-marker-value").textContent = "";
    $("map-caption").textContent = $("turn-text").textContent;
    return;
  }
  if (settled) $("map-caption").textContent = legendLabel;
  else if (boardGesture && view === "ownership" && !boardGesture.cancelled && !preview) $("map-caption").textContent = `No searched ownership yet for ${cellName(boardGesture.cell)}. Release to play; slide outside to cancel.`;
  else if (replyPreview) $("map-caption").textContent = context.textContent;
  else if (ownershipPreview) $("map-caption").textContent = `After ${cellName(preview.move)} · expected margin ${signed(mapMargin)} for Red · ${preview.samples.toLocaleString()} leaf predictions${boardGesture && !boardGesture.cancelled ? " · release to play" : ""}.`;
  else if (view === "ownership") $("map-caption").textContent = result && result.samples ? `All searched lines · Red ${signed(mapMargin)} cells · ${result.samples.toLocaleString()} leaf predictions.`
    : carriedMap ? `Previous search’s preview · Red ${signed(mapMargin)} cells.` : legendLabel;
  else if (marginOn) $("map-caption").textContent = result ? `Margins for ${displayedSide === 1 ? "Red" : "White"}${hasBaseline ? `; colors show loss relative to ${cellName(displayedBest)}` : ""}.` : "No searched margins yet.";
  else $("map-caption").textContent = legendLabel;
}

function cancelCandidateRowAnimations() {
  for (const [row, animation] of candidateRowAnimations) {
    animation.cancel();
    row.style.zIndex = "";
    row.style.willChange = "";
  }
  candidateRowAnimations.clear();
}

function pauseCandidateRowAnimations() {
  for (const animation of candidateRowAnimations.values()) animation.pause();
}

if (candidateMotion && typeof candidateMotion.addEventListener === "function")
  candidateMotion.addEventListener("change", () => {
    // A pressed target must not jump, even if the preference changes mid-press.
    if (candidateMotion.matches && !movePressActive()) cancelCandidateRowAnimations();
  });

function firstListedMove() {
  if (!engine || setupPhase || engine._hn_score(2) || !result) return null;
  const move = renderedCandidateMoves[0];
  return valid(move) && result.candidates.some(candidate => candidate.move === move && candidate.visits > 0) &&
    engine._hn_value(move) > 0 ? move : null;
}

function cancelComputerMove() {
  if (computerMoveTimer !== null) clearTimeout(computerMoveTimer);
  computerMoveTimer = null;
}

function visitLeadLocked() {
  if (!searching || !result || result.type !== "progress" ||
      result.gen !== generation || activePositionKey !== positionKey() ||
      !Number.isSafeInteger(result.visits) || result.visits < 0 || result.visits > FIXED_SEARCH_VISITS) return false;
  let leader = null, second = 0, total = 0;
  for (const candidate of result.candidates) {
    if (!Number.isSafeInteger(candidate.visits) || candidate.visits < 0 || candidate.visits > result.visits) return false;
    total += candidate.visits;
    if (!leader || candidate.visits > leader.visits) {
      if (leader) second = leader.visits;
      leader = candidate;
    } else second = Math.max(second, candidate.visits);
  }
  // Root visits include inherited work and possibly an initial evaluation
  // with no edge visit. Each remaining simulation can give a rival at most
  // one visit; equality is not enough to guarantee the current first row.
  const remaining = FIXED_SEARCH_VISITS - result.visits;
  return total <= result.visits && leader && leader.move === renderedCandidateMoves[0] &&
    leader.visits > second + remaining;
}

function computerMoveReady() {
  const mode = $("playmode").value;
  const computerSide = mode === "both" && engine ? engine._hn_stm() : mode === "red" ? 1 : mode === "white" ? 2 : 0;
  // A Load click blurs the textbox before its click handler reads the input.
  // Keep an unapplied draft intact even after focus has moved to that button.
  return !!(engine && workerReady && computerSide && !setupPhase && !gameAnalysis &&
    cursor === history.length && !movePressActive() && !timelineGesture &&
    document.activeElement !== $("moves") && $("moves").value === gameText() &&
    !engine._hn_score(2) &&
    computerSide === engine._hn_stm() && result && result.side === computerSide &&
    !result.stopped && !result.capacityReached &&
    ((!searching && (result.type === "done" || result.type === "cached") && result.visits >= FIXED_SEARCH_VISITS) ||
      visitLeadLocked()));
}

function queueComputerMove() {
  cancelComputerMove();
  if (!computerMoveReady() || firstListedMove() === null) return;
  const key = positionKey(), gen = generation;
  // Defer until the current input/report finishes. Recheck the live position,
  // mode and displayed rank so neither stale results nor gestures choose a move.
  computerMoveTimer = setTimeout(() => {
    computerMoveTimer = null;
    if (gen !== generation || key !== positionKey() || !computerMoveReady()) return;
    const move = firstListedMove();
    if (move !== null) playMove(move);
  }, 0);
}

function updateGameAnalysisButton() {
  const button = $("analyze-game");
  button.disabled = !engine || !workerReady || !!setupPhase;
  button.textContent = gameAnalysis ? "Stop analysis" : "Analyze game";
  button.setAttribute("aria-pressed", String(!!gameAnalysis));
  button.setAttribute("aria-label", gameAnalysis
    ? `Stop game analysis at position ${cursor} of ${gameAnalysis.end}` : "Analyze game");
}

function stopGameAnalysis() {
  if (gameAnalysisTimer !== null) clearTimeout(gameAnalysisTimer);
  gameAnalysisTimer = null;
  gameAnalysis = null;
  updateGameAnalysisButton();
}

function gameAnalysisPositionReady() {
  if (!gameAnalysis || searching || !engine || setupPhase ||
      movePressActive() || timelineGesture) return false;
  if (engine._hn_score(2)) return true;
  // A locked visit leader is enough for computer play, but game review needs
  // the entire budget. A cached completion can have an older worker generation.
  return !!(result && (result.type === "done" || result.type === "cached") &&
    (result.type === "cached" || result.gen === generation) &&
    result.side === engine._hn_stm() && !result.stopped && !result.capacityReached &&
    Number.isSafeInteger(result.visits) && result.visits >= FIXED_SEARCH_VISITS);
}

function queueGameAnalysis() {
  if (gameAnalysisTimer !== null || !gameAnalysisPositionReady()) return;
  const run = gameAnalysis, key = positionKey(), gen = generation;
  // Yield even between cached positions, keeping Stop and navigation responsive.
  gameAnalysisTimer = setTimeout(() => {
    gameAnalysisTimer = null;
    if (gameAnalysis !== run || gen !== generation || key !== positionKey() ||
        !gameAnalysisPositionReady()) return;
    if (cursor >= run.end) { stopGameAnalysis(); return; }
    reviewAt(cursor + 1, true);
  }, 0);
}

function toggleGameAnalysis() {
  if (gameAnalysis) {
    stopGameAnalysis();
    cancelSearch(false); // Keep the partial display, but invalidate late reports.
    return;
  }
  if (!engine || !workerReady || setupPhase) return;
  if ($("moves").value !== gameText()) {
    $("position-error").textContent = "Load the edited game before analyzing it.";
    return;
  }
  cancelTimelineGesture();
  cancelComputerMove();
  $("playmode").value = "analysis";
  gameAnalysis = {end: history.length};
  updateGameAnalysisButton();
  // Start with the two stacks already placed, not either incomplete setup step.
  // Refresh even at cursor zero: an interrupted search must finish its budget.
  cancelSearch();
  cursor = 0;
  replay(starts[0], starts[1], history, cursor);
  refreshPosition();
}

function sortedCandidates(data) {
  return data.candidates.filter(candidate => candidate.visits > 0).slice()
    .sort((a, b) => b.visits - a.visits || a.move - b.move);
}

function renderCandidates(candidates, total, best, hasBaseline) {
  const table = $("candidates");
  renderedCandidateMoves = candidates.map(candidate => candidate.move);
  const descriptions = candidates.map(candidate => {
    const share = 100 * candidate.visits / Math.max(1, total);
    const loss = hasBaseline && Number.isFinite(candidate.margin) ? best.margin - candidate.margin : null;
    const marginStyle = Number.isFinite(loss) ? ` style="background:${marginLossColor(loss)}"` : "";
    return {move: candidate.move,
      label: `${cellName(candidate.move)}, ${candidate.visits} visits`,
      html: `<td>${cellName(candidate.move)}</td><td>${candidate.visits.toLocaleString()}</td><td><div class="bar"><i style="width:${share.toFixed(1)}%"></i><span>${share.toFixed(1)}%</span></div></td><td><span class="margin-value"${marginStyle}>${signed(candidate.margin)}</span></td>`};
  });
  // DOM-light consumers can still render the same accessible static table.
  if (typeof table.querySelectorAll !== "function" || typeof document.createElement !== "function") {
    hoverRow = null;
    table.innerHTML = descriptions.map(row => `<tr data-move="${row.move}" tabindex="0" aria-label="${row.label}">${row.html}</tr>`).join("");
    return;
  }
  const oldRows = Array.from(table.querySelectorAll("tr[data-move]"));
  const rowsByMove = new Map(oldRows.map(row => [+row.dataset.move, row]));
  const reordered = descriptions.length !== oldRows.length ||
    descriptions.some((row, index) => row.move !== +oldRows[index].dataset.move);
  const paused = Array.from(candidateRowAnimations.values()).some(animation => animation.playState === "paused");
  const relayout = reordered || paused;
  // Measure visual positions before cancelling: a new report can interrupt a slide.
  const oldTops = relayout ? new Map(oldRows.map(row =>
    [+row.dataset.move, row.getBoundingClientRect().top + candidatePane.scrollTop])) : new Map();
  if (relayout || candidateMotion && candidateMotion.matches) cancelCandidateRowAnimations();
  const focused = document.activeElement && document.activeElement.closest("tr[data-move]");
  const focusedRow = focused && table.contains(focused) ? focused : null;
  const hovered = hoverRow !== null;
  const wanted = new Set(descriptions.map(row => row.move));
  for (const row of oldRows) if (!wanted.has(+row.dataset.move)) row.remove();
  const rows = descriptions.map((description, index) => {
    const row = rowsByMove.get(description.move) || document.createElement("tr");
    row.dataset.move = description.move;
    row.tabIndex = 0;
    row.setAttribute("aria-label", description.label);
    row.innerHTML = description.html;
    if (table.children[index] !== row) table.insertBefore(row, table.children[index] || null);
    return row;
  });
  // Reordering an existing focused node can blur it; keep keyboard identity.
  if (focusedRow && table.contains(focusedRow) && document.activeElement !== focusedRow)
    focusedRow.focus({preventScroll: true});
  if (hovered) hoverRow = rows.find(row => +row.dataset.move === hoverMove) || null;
  if (!relayout || candidateMotion && candidateMotion.matches) return;
  // Batch layout reads before animation writes. New rows simply appear.
  const slides = rows.map(row => ({row,
    delta: oldTops.get(+row.dataset.move) - (row.getBoundingClientRect().top + candidatePane.scrollTop)}));
  for (const {row, delta} of slides) {
    if (!Number.isFinite(delta) || Math.abs(delta) < .5 || typeof row.animate !== "function") continue;
    row.style.zIndex = delta > 0 ? "2" : "1"; // Rising rows occlude falling ones.
    row.style.willChange = "transform";
    const animation = row.animate([{transform: `translateY(${delta}px)`}, {transform: "translateY(0px)"}],
      {duration: CANDIDATE_ROW_SLIDE_MS, easing: "cubic-bezier(.2,.7,.2,1)"});
    candidateRowAnimations.set(row, animation);
    animation.onfinish = () => {
      if (candidateRowAnimations.get(row) !== animation) return;
      candidateRowAnimations.delete(row);
      row.style.zIndex = "";
      row.style.willChange = "";
    };
  }
}

function showResult(data) {
  result = data;
  if (data.samples > 0) carriedOwnership = null;
  const total = data.candidates.reduce((sum, c) => sum + c.visits, 0);
  const candidates = sortedCandidates(data);
  if (stableBest !== data.best) { stableBest = data.best; stableSince = data.visits; }
  const best = data.candidates.find(candidate => candidate.move === data.best);
  const hasBaseline = best && best.visits > 0 && Number.isFinite(best.margin);
  if (!movePressActive()) renderCandidates(candidates, total, best, hasBaseline);
  drawBoard();
  queueComputerMove();
  queueGameAnalysis();
}

function cancelSearch(clear = true) {
  cancelComputerMove();
  generation++;
  if (worker) worker.postMessage({type: "stop"});
  searching = false;
  activePositionKey = null;
  if (clear) {
    const pressedBoard = boardGesture, pressedRow = rowGesture;
    boardGesture = null;
    rowGesture = null;
    if (pressedBoard) {
      suppressClickUntil = performance.now() + 800;
      if (board.hasPointerCapture(pressedBoard.pointerId)) board.releasePointerCapture(pressedBoard.pointerId);
    }
    if (pressedRow) {
      clearRowPreview(pressedRow);
      suppressRowClickUntil = performance.now() + 800;
      if ($("candidates").hasPointerCapture(pressedRow.pointerId)) $("candidates").releasePointerCapture(pressedRow.pointerId);
    }
    clearCandidateRowHover();
    result = null; carriedOwnership = null; hoverMove = null; hoverRow = null; stableBest = null;
    cancelCandidateRowAnimations();
    $("candidates").innerHTML = "";
    renderedCandidateMoves = [];
    candidatePane.scrollTop = 0;
  }
}

function startSearch() {
  if (!engine || !workerReady || setupPhase) return;
  const initialOwnership = carriedOwnership && carriedOwnership.key === positionKey() ? carriedOwnership : null;
  cancelSearch();
  carriedOwnership = initialOwnership;
  $("analysis-error").textContent = "";
  if (engine._hn_score(2)) { drawBoard(); return; }
  searching = true;
  activePositionKey = positionKey();
  worker.postMessage({type: "search", gen: generation, red: starts[0], white: starts[1], moves: history.slice(0, cursor), sims: FIXED_SEARCH_VISITS});
}

function preliminaryMarginEstimate() {
  if (engine._hn_score(2))
    return {margin: engine._hn_score(0) - engine._hn_score(1), exact: true};
  // Leave unsearched graph points empty; static NNUE scores are too noisy.
  return {margin: null, exact: false};
}

function replay(red, white, moves, length, collectMargins = false) {
  if (red === CENTRE || white === CENTRE || red < 0 || white < 0 || red === white) throw new Error("Choose two distinct starting cells, excluding the center.");
  engine._hn_init_display(red, white);
  const estimates = collectMargins ? [preliminaryMarginEstimate()] : null;
  for (let k = 0; k < length; k++) {
    const move = moves[k];
    if (move < 0) {
      if (engine._hn_can_move()) throw new Error(`Move ${k + 1}: pass is only legal with no available move.`);
      engine._hn_pass();
    } else if (!engine._hn_play(move)) throw new Error(`Move ${k + 1} (${cellName(move)}) is illegal.`);
    if (collectMargins) estimates.push(preliminaryMarginEstimate());
  }
  return estimates;
}

function adoptLoadedMargins(red, white, moves, estimates) {
  const retained = new Map(marginHistory);
  marginHistory.clear();
  preliminaryMargins.clear();
  marginGraphLimit = MARGIN_GRAPH_MIN;
  for (let index = 0; index < estimates.length; index++) {
    const key = JSON.stringify([SIDE, red, white, moves.slice(0, index)]);
    // Loading the same game must preserve its genuine partial search values.
    if (retained.has(key)) rememberTimelineMargin(key, retained.get(key));
    preliminaryMargins.set(key, estimates[index]);
    while (preliminaryMargins.size > MARGIN_HISTORY_LIMIT)
      preliminaryMargins.delete(preliminaryMargins.keys().next().value);
  }
}

function cancelPreliminarySearch() {
  if (preliminaryJob && worker) worker.postMessage({type: "preliminary-stop"});
  preliminaryJob = null;
}

function startLoadedPreliminarySearch() {
  cancelPreliminarySearch();
  const indices = [];
  for (let index = 0; index <= history.length; index++) {
    const estimate = timelineEstimateAt(index);
    if (!estimate && preliminaryMargins.has(historyPositionKey(index))) indices.push(index);
  }
  if (!worker || !indices.length) return;
  preliminaryJob = {token: ++preliminarySequence, key: historyPositionKey(history.length),
    red: starts[0], white: starts[1], moves: history.slice(), indices: new Set(indices)};
  worker.postMessage({type: "preliminary-start", token: preliminaryJob.token,
    red: starts[0], white: starts[1], moves: history.slice(), indices, sims: PRELIMINARY_SEARCH_VISITS});
}

function acceptPreliminaryMessage(data) {
  const job = preliminaryJob;
  if (!job || data.token !== job.token || setupPhase ||
      job.key !== historyPositionKey(history.length)) return;
  if (data.type === "preliminary-done" || data.type === "preliminary-error") {
    preliminaryJob = null; // Leave gaps when a quick search is unavailable.
    return;
  }
  if (data.type !== "preliminary" || !job.indices.has(data.index) ||
      !Number.isFinite(data.margin) || (!data.exact && data.visits !== PRELIMINARY_SEARCH_VISITS)) return;
  const key = JSON.stringify([SIDE, job.red, job.white, job.moves.slice(0, data.index)]);
  const prior = preliminaryMargins.get(key);
  if (!prior || prior.exact) return;
  preliminaryMargins.set(key, {margin: data.margin, exact: !!data.exact, source: "quick"});
  // Scalar-only updates do not change candidates, samples, autoplay or caches.
  drawMarginTimeline();
  updateMarginMarker();
}

function refreshPosition(preserveDraft = false) {
  const keepDraft = preserveDraft && $("moves").value !== gameText();
  if (!keepDraft) $("position-error").textContent = "";
  $("analysis-error").textContent = "";
  $("copy").disabled = !!setupPhase;
  $("share").disabled = !!setupPhase || sharingGame;
  $("share-link").hidden = true;
  $("share-link").value = "";
  updateGameAnalysisButton();
  if (setupPhase) {
    $("turn-text").textContent = setupPhase === 1 ? "Choose Red’s starting cell" : "Choose White’s starting cell";
    $("turn-stone").hidden = false;
    $("turn-stone").classList.toggle("red", setupPhase === 1);
    $("turn-indicator").classList.toggle("red", setupPhase === 1);
    $("back").disabled = true; $("forward").disabled = true;
    drawMarginTimeline();
    $("moves").value = setupRed === null ? "" : cellName(setupRed);
    drawBoard();
    return;
  }
  const settled = !!engine._hn_score(2), redToMove = engine._hn_stm() === 1;
  let turnText = redToMove ? "Red to move" : "White to move";
  if (settled) {
    const margin = engine._hn_score(0) - engine._hn_score(1), points = Math.abs(margin);
    rememberTimelineMargin(positionKey(), margin);
    turnText = `${margin > 0 ? "Red" : "White"} wins by ${points} ${points === 1 ? "point" : "points"}`;
  }
  $("turn-text").textContent = workerReady ? turnText : "Loading…";
  $("turn-stone").hidden = settled || !workerReady;
  $("turn-stone").classList.toggle("red", !settled && redToMove);
  $("turn-indicator").classList.toggle("red", !settled && redToMove);
  drawMarginTimeline();
  $("back").disabled = !cursor;
  $("forward").disabled = cursor >= history.length;
  if (!keepDraft) $("moves").value = gameText();
  drawBoard();
  const cached = getCachedResult(positionKey());
  if (cached) {
    cancelSearch();
    stableBest = cached.stableBest; stableSince = cached.stableSince;
    showResult({...cached.data, type: "cached"});
    return;
  }
  startSearch();
  queueGameAnalysis(); // Exact settled positions do not need a search report.
}

function newGame(playSetupSound = true) {
  if (!engine) return;
  cancelPreliminarySearch();
  stopGameAnalysis();
  cancelTimelineGesture();
  marginHistory.clear();
  preliminaryMargins.clear();
  marginGraphLimit = MARGIN_GRAPH_MIN;
  cancelSearch();
  history = []; cursor = 0;
  setupRed = null;
  setupPhase = $("startmode").value === "c" ? 1 : 0;
  if (!setupPhase) {
    starts = $("startmode").value === "b" ? balancedStart() : randomStart();
    engine._hn_init_display(starts[0], starts[1]);
    if (playSetupSound) { playMoveSound(); playMoveSound(.1); }
  }
  refreshPosition();
}

function chooseStartCell(cell) {
  if (!engine || !setupPhase || !legalStartCell(cell)) return;
  if (setupPhase === 1) {
    setupRed = cell;
    setupPhase = 2;
  } else {
    const red = setupRed;
    cancelSearch();
    starts = [red, cell];
    setupPhase = 0; setupRed = null;
    engine._hn_init_display(starts[0], starts[1]);
  }
  playMoveSound();
  refreshPosition();
}

function selectBoardCell(cell) {
  if (setupPhase) chooseStartCell(cell);
  else playMove(cell);
}

function loadPosition() {
  if (!engine) return;
  stopGameAnalysis();
  try {
    let red, white;
    const text = $("moves").value.trim();
    let moves;
    if (text.startsWith("{")) {
      const position = JSON.parse(text);
      if (position.side !== undefined && position.side !== SIDE) throw new Error(`This model only supports size ${SIDE}.`);
      red = parseCell(position.red); white = parseCell(position.white);
      if (!Array.isArray(position.moves)) throw new Error("Position JSON needs a moves array.");
      moves = position.moves.map(move => parseCell(String(move)));
    } else {
      const coordinates = text.split(/[\s,;]+/).filter(Boolean);
      if (coordinates.length < 2) throw new Error("Enter Red’s and White’s starting cells first.");
      red = parseCell(coordinates[0]); white = parseCell(coordinates[1]);
      moves = coordinates.slice(2).map(parseCell);
    }
    // Verify the full input before replacing the review state. Restore the old
    // board if any supplied move is illegal.
    let estimates;
    try { estimates = replay(red, white, moves, moves.length, true); }
    catch (error) { replay(starts[0], starts[1], history, cursor); throw error; }
    cancelPreliminarySearch();
    cancelSearch();
    setupPhase = 0; setupRed = null;
    cancelTimelineGesture();
    adoptLoadedMargins(red, white, moves, estimates);
    starts = [red, white]; history = moves; cursor = moves.length;
    refreshPosition();
    startLoadedPreliminarySearch();
  } catch (error) { $("position-error").textContent = error.message; }
}

function playMove(move) {
  if (!engine || setupPhase || move < 0 || !engine._hn_play(move)) return;
  cancelPreliminarySearch();
  stopGameAnalysis();
  playMoveSound();
  // Look up the move actually played, independent of the hover or table sort.
  // Reports are Red-relative even when this advance changes the player to move.
  const candidate = result && result.candidates.find(candidate => candidate.move === move);
  const ownership = candidate && candidate.samples > 0 && candidate.ownership
    && cells.some(cell => Number.isFinite(candidate.ownership[cell])) ? candidate.ownership.slice() : null;
  cancelSearch();
  history = history.slice(0, cursor);
  history.push(move); cursor++;
  if (!engine._hn_score(2) && !engine._hn_can_move()) { engine._hn_pass(); history.push(-1); cursor++; }
  if (ownership) carriedOwnership = {key: positionKey(), ownership};
  refreshPosition();
}

function reviewAt(next, fromGameAnalysis = false) {
  if (!engine || setupPhase || !Number.isFinite(next)) return;
  if (!fromGameAnalysis) stopGameAnalysis();
  next = Math.max(0, Math.min(history.length, Math.round(next)));
  if (next === cursor) return;
  timelineHoverIndex = null;
  cancelSearch();
  cursor = next;
  replay(starts[0], starts[1], history, cursor);
  refreshPosition();
}

function gestureCellAt(event) {
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const hex = target && target.closest(".hex");
  return hex && board.contains(hex) ? +hex.dataset.cell : null;
}

function previewBoardHover(event) {
  if (event.pointerType !== "mouse" || movePressActive()) return;
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const hex = target && target.closest(".hex.legal");
  const move = hex && board.contains(hex) ? +hex.dataset.cell : null;
  // drawBoard replaces the cell paths. Ignore fresh events for the same cell
  // so replacing a hovered path cannot create a redraw loop.
  if (hoverMove === move && !hoverRow) return;
  clearCandidateRowHover();
  hoverMove = move; hoverRow = null;
  drawBoard();
}

board.addEventListener("pointerover", previewBoardHover);
board.addEventListener("pointerleave", event => {
  if (event.pointerType !== "mouse" || boardGesture || hoverMove === null) return;
  clearCandidateRowHover();
  hoverMove = null; hoverRow = null;
  drawBoard();
});

board.addEventListener("pointerdown", event => {
  if (!["mouse", "touch", "pen"].includes(event.pointerType) || event.isPrimary === false || movePressActive() || timelineGesture || (event.button !== undefined && event.button !== 0)) return;
  const hex = event.target.closest(".hex.legal");
  if (!hex) return;
  event.preventDefault();
  pauseCandidateRowAnimations();
  clearCandidateRowHover();
  hoverMove = null; hoverRow = null;
  suppressClickUntil = 0;
  boardGesture = {pointerId: event.pointerId, pointerType: event.pointerType,
    cell: +hex.dataset.cell, previewCell: +hex.dataset.cell, cancelled: false,
    key: positionKey()};
  board.setPointerCapture(event.pointerId);
  drawBoard(true);
});

board.addEventListener("pointermove", event => {
  if (event.pointerType === "mouse" && !boardGesture) { previewBoardHover(event); return; }
  if (!boardGesture || event.pointerId !== boardGesture.pointerId) return;
  event.preventDefault();
  const cell = gestureCellAt(event);
  let changed = false;
  // Leaving the first cell permanently cancels playing, but touch/pen can
  // continue browsing read-only previews anywhere on the board.
  if (!boardGesture.cancelled && cell !== boardGesture.cell) {
    boardGesture.cancelled = true;
    changed = true;
  }
  if (boardGesture.pointerType !== "mouse") {
    const legal = valid(cell) && (setupPhase ? legalStartCell(cell)
      : !engine._hn_score(2) && engine._hn_value(cell) > 0);
    const next = legal ? cell : null;
    if (next !== boardGesture.previewCell) changed = true;
    boardGesture.previewCell = next;
  }
  if (changed) drawBoard(true);
});

// Safari may also deliver native touch events during a pointer gesture.
// Suppress native panning only during a board or candidate inspection gesture.
document.addEventListener("touchmove", event => {
  const gesture = boardGesture || rowGesture || timelineGesture;
  if (event.cancelable && gesture && gesture.pointerType !== "mouse") event.preventDefault();
}, {passive: false, capture: true});

function finishBoardGesture(event, cancelled) {
  if (!boardGesture || event.pointerId !== boardGesture.pointerId) return;
  event.preventDefault();
  const gesture = boardGesture;
  const play = !cancelled && !gesture.cancelled && gesture.key === positionKey() && gestureCellAt(event) === gesture.cell;
  boardGesture = null;
  suppressClickUntil = performance.now() + 800;
  if (board.hasPointerCapture(event.pointerId)) board.releasePointerCapture(event.pointerId);
  if (play) selectBoardCell(gesture.cell);
  else if (result) showResult(result); else drawBoard();
}

board.addEventListener("pointerup", event => finishBoardGesture(event, false));
board.addEventListener("pointercancel", event => finishBoardGesture(event, true));
board.addEventListener("lostpointercapture", event => {
  if (boardGesture && boardGesture.pointerId === event.pointerId) {
    boardGesture = null; suppressClickUntil = performance.now() + 800;
    if (result) showResult(result); else drawBoard();
  }
});
board.addEventListener("contextmenu", event => event.preventDefault());
board.addEventListener("click", event => {
  if (performance.now() < suppressClickUntil || event.pointerType === "touch" || event.pointerType === "pen") {
    event.preventDefault(); suppressClickUntil = 0; return;
  }
  const hex = event.target.closest(".hex.legal");
  if (hex) selectBoardCell(+hex.dataset.cell);
});
function clearCandidateRowHover() {
  if (hoverRow) hoverRow.classList.toggle("hover-row", false);
}

function previewRowHover(event) {
  const row = event.target.closest("tr[data-move]");
  if (setupPhase || movePressActive() || !row || event.pointerType === "touch" || event.pointerType === "pen") return;
  $("candidates").classList.toggle("mouse-hover", true);
  // Boundary events from sliding rows also update the preview: inspect the
  // move under the pointer, not the move previously occupying that list slot.
  if (row === hoverRow) return;
  if (hoverRow) hoverRow.classList.toggle("hover-row", false);
  row.classList.toggle("hover-row", true);
  hoverRow = row; hoverMove = +row.dataset.move; drawBoard();
}

$("candidates").addEventListener("pointerover", previewRowHover);
$("candidates").addEventListener("pointerleave", () => {
  if (movePressActive()) return;
  if (hoverRow === null && hoverMove === null) return;
  clearCandidateRowHover();
  hoverRow = null; hoverMove = null; drawBoard();
});

function insidePressedRow(event) {
  if (!rowGesture) return false;
  const bounds = rowGesture.row.getBoundingClientRect();
  return event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
}

function rowAtPointer(gesture) {
  const bounds = candidatePane.getBoundingClientRect();
  if (gesture.clientX < bounds.left || gesture.clientX > bounds.right) return null;
  let y = gesture.clientY;
  if (y < bounds.top || y > bounds.bottom) {
    // Probe the visible data edge, not the header or a row hidden by clipping.
    const data = $("candidates").getBoundingClientRect();
    const top = Math.max(bounds.top, data.top), bottom = Math.min(bounds.bottom, data.bottom);
    if (bottom - top < 2) return null;
    y = Math.max(top + 1, Math.min(bottom - 1, y));
  }
  const target = document.elementFromPoint(gesture.clientX, y);
  const row = target && target.closest("tr[data-move]");
  return row && $("candidates").contains(row) && result &&
    result.candidates.some(candidate => candidate.move === +row.dataset.move) ? row : null;
}

function updateRowPreview(gesture) {
  const row = rowAtPointer(gesture);
  const move = row ? +row.dataset.move : null;
  if (gesture.previewRow === row && gesture.previewMove === move) return;
  if (gesture.previewRow) gesture.previewRow.classList.toggle("preview-row", false);
  gesture.previewRow = row; gesture.previewMove = move;
  if (row) row.classList.toggle("preview-row", true);
  hoverRow = row; hoverMove = move;
  drawBoard(true);
}

function rowScrollSpeed(gesture) {
  const bounds = candidatePane.getBoundingClientRect();
  if (gesture.clientX < bounds.left || gesture.clientX > bounds.right ||
      !(candidatePane.scrollHeight > candidatePane.clientHeight)) return 0;
  const maxScroll = candidatePane.scrollHeight - candidatePane.clientHeight;
  // Scroll sizes are rounded but scrollTop can be fractional at either limit.
  if (gesture.clientY < bounds.top && candidatePane.scrollTop > 1)
    return -Math.min(480, 120 + 4 * (bounds.top - gesture.clientY));
  if (gesture.clientY > bounds.bottom && candidatePane.scrollTop < maxScroll - 1)
    return Math.min(480, 120 + 4 * (gesture.clientY - bounds.bottom));
  return 0;
}

function stopRowAutoScroll(gesture) {
  if (gesture.scrollFrame !== null) cancelAnimationFrame(gesture.scrollFrame);
  gesture.scrollFrame = null;
}

function clearRowPreview(gesture) {
  stopRowAutoScroll(gesture);
  if (gesture.previewRow) gesture.previewRow.classList.toggle("preview-row", false);
}

function scrollRowGesture(now) {
  const gesture = rowGesture;
  if (!gesture || gesture.pointerType === "mouse") return;
  gesture.scrollFrame = null;
  if (gesture.key !== positionKey()) return;
  const speed = rowScrollSpeed(gesture);
  if (!speed) return;
  const elapsed = Math.max(0, Math.min(50, now - gesture.lastScrollTime));
  const maxScroll = candidatePane.scrollHeight - candidatePane.clientHeight;
  const before = candidatePane.scrollTop;
  candidatePane.scrollTop = Math.max(0, Math.min(maxScroll, before + speed * elapsed / 1000));
  if (candidatePane.scrollTop === before) {
    // The first frame can precede the event timestamp, and fractional steps
    // can round away. Accumulate time until a scroll step becomes visible.
    if (rowScrollSpeed(gesture)) gesture.scrollFrame = requestAnimationFrame(scrollRowGesture);
    return;
  }
  gesture.lastScrollTime = now;
  gesture.cancelled = true; // Scrolling can never turn back into playing.
  updateRowPreview(gesture); // The finger can remain still as rows move below it.
  if (rowGesture === gesture && rowScrollSpeed(gesture))
    gesture.scrollFrame = requestAnimationFrame(scrollRowGesture);
}

function updateRowAutoScroll(gesture) {
  if (!rowScrollSpeed(gesture)) { stopRowAutoScroll(gesture); return; }
  if (gesture.scrollFrame === null) {
    gesture.lastScrollTime = performance.now();
    gesture.scrollFrame = requestAnimationFrame(scrollRowGesture);
  }
}

$("candidates").addEventListener("pointerdown", event => {
  if (!["mouse", "touch", "pen"].includes(event.pointerType) || event.isPrimary === false || movePressActive() || timelineGesture || (event.button !== undefined && event.button !== 0)) return;
  const row = event.target.closest("tr[data-move]");
  if (!row || !result || !result.candidates.some(candidate => candidate.move === +row.dataset.move)) return;
  pauseCandidateRowAnimations();
  clearCandidateRowHover();
  suppressRowClickUntil = 0;
  if (event.pointerType !== "mouse") event.preventDefault();
  // Captured touch pointers can leave native :hover stuck on the original row.
  // Only actual mouse use enables it; touch/pen highlighting follows previewRow.
  $("candidates").classList.toggle("mouse-hover", event.pointerType === "mouse");
  rowGesture = {pointerId: event.pointerId, pointerType: event.pointerType,
    move: +row.dataset.move, row, previewMove: +row.dataset.move, previewRow: row,
    clientX: event.clientX, clientY: event.clientY, scrollFrame: null,
    lastScrollTime: 0, key: positionKey(), cancelled: false};
  $("candidates").setPointerCapture(event.pointerId);
  hoverMove = rowGesture.move; hoverRow = row;
  row.classList.toggle("preview-row", true);
  drawBoard(true);
});

$("candidates").addEventListener("pointermove", event => {
  if (event.pointerType === "mouse" && !movePressActive()) previewRowHover(event);
  if (!rowGesture || event.pointerId !== rowGesture.pointerId) return;
  const gesture = rowGesture;
  if (!insidePressedRow(event)) gesture.cancelled = true;
  if (gesture.pointerType !== "mouse") {
    event.preventDefault();
    gesture.clientX = event.clientX; gesture.clientY = event.clientY;
    updateRowPreview(gesture);
    updateRowAutoScroll(gesture);
  } else if (gesture.cancelled && gesture.previewMove !== null) {
    gesture.previewMove = null; gesture.previewRow.classList.toggle("preview-row", false);
    hoverMove = null; hoverRow = null; drawBoard(true);
  }
});

function finishRowGesture(event, cancelled) {
  if (!rowGesture || event.pointerId !== rowGesture.pointerId) return;
  const gesture = rowGesture;
  if (gesture.pointerType !== "mouse") event.preventDefault();
  const play = !cancelled && !gesture.cancelled && gesture.key === positionKey() && insidePressedRow(event);
  clearRowPreview(gesture);
  rowGesture = null;
  if (!play) { hoverMove = null; hoverRow = null; }
  suppressRowClickUntil = performance.now() + 800;
  if ($("candidates").hasPointerCapture(event.pointerId)) $("candidates").releasePointerCapture(event.pointerId);
  if (play) playMove(gesture.move);
  else if (result) showResult(result); else drawBoard();
}

$("candidates").addEventListener("pointerup", event => finishRowGesture(event, false));
$("candidates").addEventListener("pointercancel", event => finishRowGesture(event, true));
$("candidates").addEventListener("lostpointercapture", event => {
  if (rowGesture && event.pointerId === rowGesture.pointerId) {
    clearRowPreview(rowGesture);
    rowGesture = null; suppressRowClickUntil = performance.now() + 800;
    hoverMove = null; hoverRow = null;
    if (result) showResult(result); else drawBoard();
  }
});
$("candidates").addEventListener("contextmenu", event => event.preventDefault());
$("candidates").addEventListener("click", event => {
  if (performance.now() < suppressRowClickUntil || event.pointerType === "touch" || event.pointerType === "pen") {
    event.preventDefault(); suppressRowClickUntil = 0; return;
  }
  const row = event.target.closest("tr[data-move]");
  if (!row) return;
  const move = +row.dataset.move;
  if (result && result.candidates.some(candidate => candidate.move === move)) playMove(move);
});
$("candidates").addEventListener("keydown", event => {
  if (event.key === "Enter" && !ignoreGameShortcut(event)) {
    event.preventDefault();
    const row = event.target.closest("tr[data-move]");
    if (!event.repeat && row && result && result.candidates.some(candidate => candidate.move === +row.dataset.move)) playMove(+row.dataset.move);
  }
});
document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {
  clearCandidateRowHover();
  view = button.dataset.view; hoverMove = null; hoverRow = null;
  document.querySelectorAll("[data-view]").forEach(b => { const on = b === button; b.classList.toggle("selected", on); b.setAttribute("aria-pressed", on); });
  drawBoard();
}));
$("playmode").addEventListener("change", () => {
  stopGameAnalysis();
  queueComputerMove();
});
$("moves").addEventListener("focus", () => {
  cancelComputerMove();
  if (gameAnalysis) { stopGameAnalysis(); cancelSearch(false); }
});
$("moves").addEventListener("blur", queueComputerMove);
$("moves").addEventListener("keydown", event => {
  if (event.key !== "Enter" || event.defaultPrevented || event.repeat ||
      event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey ||
      event.metaKey || event.shiftKey || !engine || $("load").disabled) return;
  event.preventDefault();
  loadPosition();
});
$("load").addEventListener("click", () => loadPosition());
$("analyze-game").addEventListener("click", toggleGameAnalysis);
$("newgame").addEventListener("click", newGame);
$("copy").addEventListener("click", async () => {
  if (setupPhase) return;
  const text = $("moves").value;
  try { await navigator.clipboard.writeText(text); $("position-error").textContent = "Game copied."; }
  catch { $("position-error").textContent = "Clipboard unavailable. Select and copy the move list above."; }
});
$("share").addEventListener("click", shareGame);
$("back").addEventListener("click", () => reviewAt(cursor - 1));
$("forward").addEventListener("click", () => reviewAt(cursor + 1));
// Keep the input adapter alongside pointer/keyboard navigation for accessibility.
$("review").addEventListener("input", () => reviewAt(+$("review").value));

function reviewIndexAt(event) {
  const bounds = $("review").getBoundingClientRect();
  if (!(bounds.width > 0) || !Number.isFinite(event.clientX)) return cursor;
  const x = (event.clientX - bounds.left) / bounds.width * MARGIN_GRAPH.width;
  const fraction = Math.max(0, Math.min(1, (x - MARGIN_GRAPH.left) / (MARGIN_GRAPH.right - MARGIN_GRAPH.left)));
  return Math.round(fraction * history.length);
}

function cancelTimelineGesture() {
  const gesture = timelineGesture;
  timelineGesture = null; timelineHoverIndex = null;
  if (!gesture) return;
  suppressTimelineClickUntil = performance.now() + 800;
  if ($("review").hasPointerCapture(gesture.pointerId)) $("review").releasePointerCapture(gesture.pointerId);
}

$("review").addEventListener("pointerdown", event => {
  if (!engine || setupPhase || movePressActive() || timelineGesture || event.isPrimary === false ||
      !["mouse", "touch", "pen"].includes(event.pointerType) || (event.button !== undefined && event.button !== 0)) return;
  event.preventDefault();
  timelineHoverIndex = null;
  timelineGesture = {pointerId: event.pointerId, pointerType: event.pointerType};
  $("review").setPointerCapture(event.pointerId);
  reviewAt(reviewIndexAt(event));
  updateTimelineLabel();
});
$("review").addEventListener("pointermove", event => {
  if (timelineGesture && timelineGesture.pointerId === event.pointerId) {
    event.preventDefault();
    reviewAt(reviewIndexAt(event));
    updateTimelineLabel();
  } else if (!timelineGesture && event.pointerType === "mouse" && !setupPhase) {
    timelineHoverIndex = reviewIndexAt(event);
    updateTimelineLabel(timelineHoverIndex);
  }
});
function finishTimelineGesture(event) {
  if (!timelineGesture || timelineGesture.pointerId !== event.pointerId) return;
  event.preventDefault();
  cancelTimelineGesture();
  updateTimelineLabel();
  queueComputerMove();
}
$("review").addEventListener("pointerup", finishTimelineGesture);
$("review").addEventListener("pointercancel", finishTimelineGesture);
$("review").addEventListener("lostpointercapture", event => {
  if (!timelineGesture || timelineGesture.pointerId !== event.pointerId) return;
  cancelTimelineGesture();
  updateTimelineLabel();
  queueComputerMove();
});
$("review").addEventListener("pointerleave", () => {
  if (!timelineGesture) { timelineHoverIndex = null; updateTimelineLabel(); }
});
$("review").addEventListener("click", event => {
  if (performance.now() < suppressTimelineClickUntil || event.pointerType === "touch" || event.pointerType === "pen") {
    event.preventDefault(); suppressTimelineClickUntil = 0; return;
  }
  reviewAt(reviewIndexAt(event));
});
$("review").addEventListener("keydown", event => {
  if (ignoreGameShortcut(event)) return;
  const targets = {ArrowLeft: cursor - 1, ArrowDown: cursor - 1,
    ArrowRight: cursor + 1, ArrowUp: cursor + 1, Home: 0, End: history.length};
  if (!(event.key in targets)) return;
  event.preventDefault();
  cancelTimelineGesture();
  reviewAt(targets[event.key]);
  updateTimelineLabel();
});
$("review").addEventListener("contextmenu", event => event.preventDefault());

function ignoreGameShortcut(event) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return true;
  const target = event.target;
  return !!(target && (target.isContentEditable || target.closest &&
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')));
}

document.addEventListener("keydown", event => {
  if (ignoreGameShortcut(event)) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    cancelTimelineGesture();
    reviewAt(cursor + (event.key === "ArrowLeft" ? -1 : 1));
    updateTimelineLabel();
  } else if (event.key === " ") {
    // Space is a game command even with a display button or candidate focused.
    // Consume repeats and empty results without scrolling or activating it.
    event.preventDefault();
    // A click-focused control otherwise gains a keyboard focus ring on Space,
    // although this key plays a move rather than activating that control.
    const control = event.target && event.target.closest
      ? event.target.closest("[data-view]") : null;
    if (control && typeof control.blur === "function") control.blur();
    if (event.repeat || !engine || setupPhase || engine._hn_score(2) || !result) return;
    // Read the displayed rank, not a newer report's order during a held press.
    const move = firstListedMove();
    if (move === null) return;
    cancelTimelineGesture();
    playMove(move);
  }
});

HN().then(module => {
  engine = module;
  for (const id of ["load", "newgame", "copy", "share"]) $(id).disabled = false;
  worker = new Worker("search-worker.js?v=20261004-40");
  worker.onmessage = event => {
    const data = event.data;
    if (["preliminary", "preliminary-done", "preliminary-error"].includes(data.type)) {
      acceptPreliminaryMessage(data);
      return;
    }
    if (data.type === "ready") {
      workerReady = true;
      // Setup is already drawn by the main module. Refreshing it here would
      // erase a game the user is typing into Load while the worker starts.
      if (!setupPhase) refreshPosition(true);
      return;
    }
    if (data.gen !== undefined && data.gen !== generation) return;
    if (data.type === "error") {
      stopGameAnalysis();
      cancelSearch(false);
      $("analysis-error").textContent = data.message;
      return;
    }
    if (data.type === "progress" || data.type === "done") {
      if (setupPhase) return;
      if (gameAnalysis && (data.side !== engine._hn_stm() ||
          !Number.isSafeInteger(data.visits) || data.visits < 0)) {
        stopGameAnalysis();
        cancelSearch(false);
        $("analysis-error").textContent = "Analysis could not finish: invalid search result.";
        return;
      }
      showResult(data);
      cacheSearchResult(activePositionKey, data);
      if (data.type === "done") {
        searching = false;
        if (data.capacityReached) $("analysis-error").textContent = "Analysis could not finish: tree capacity reached.";
        else if (data.stopped || data.visits < FIXED_SEARCH_VISITS) $("analysis-error").textContent = "Analysis stopped before completion.";
        if (gameAnalysis && (data.visits < FIXED_SEARCH_VISITS ||
            data.stopped || data.capacityReached)) stopGameAnalysis();
        queueComputerMove();
        queueGameAnalysis();
      }
    }
  };
  worker.onerror = event => {
    cancelPreliminarySearch();
    stopGameAnalysis();
    cancelSearch(false);
    $("analysis-error").textContent = "Search worker error: " + event.message;
  };
  newGame(false);
  loadGameFromUrl();
}).catch(error => { $("turn-text").textContent = "Engine failed to load"; $("analysis-error").textContent = String(error.message || error); });
