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
const SUMMARY_CACHE_LIMIT = 512;
const SUMMARY_CACHE_BYTE_LIMIT = 64 * 1024 * 1024;
const summaryCache = new Map();
let summaryCacheBytes = 0;
const marginHistory = new Map();
const MARGIN_HISTORY_LIMIT = 2048;

let engine = null;
let worker = null;
let workerReady = false;
let starts = [47, 96];
let history = [];
let cursor = 0;
let generation = 0;
let searching = false;
let result = null;
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

function reportMargin(data) {
  if (!data || !(data.samples > 0) || !data.ownership) return null;
  let margin = 0;
  for (const cell of cells) {
    if (!Number.isFinite(data.ownership[cell])) return null;
    margin += data.ownership[cell];
  }
  return margin; // Ownership reports are already Red-relative, even on White's turn.
}

function rememberTimelineMargin(key, margin) {
  if (!key || !Number.isFinite(margin)) return;
  marginHistory.delete(key);
  marginHistory.set(key, margin);
  while (marginHistory.size > MARGIN_HISTORY_LIMIT)
    marginHistory.delete(marginHistory.keys().next().value);
}

function timelineMarginAt(index) {
  if (setupPhase || !Number.isInteger(index) || index < 0 || index > history.length) return null;
  const key = historyPositionKey(index);
  if (marginHistory.has(key)) return marginHistory.get(key);
  // Reading the whole timeline must not promote every summary in the LRU.
  const cached = summaryCache.get(key);
  return cached && Number.isFinite(cached.margin) ? cached.margin : null;
}

function timelinePositionText(index) {
  const position = index ? `Move ${index}/${history.length}` : "Start";
  const margin = timelineMarginAt(index);
  return Number.isFinite(margin) ? `${position} · Red ${signed(margin)}` : position;
}

function updateTimelineLabel(index = cursor) {
  $("move-number").textContent = setupPhase ? "Start" : timelinePositionText(index);
}

function drawMarginTimeline() {
  const timeline = $("review"), disabled = !engine || !!setupPhase;
  const count = setupPhase ? 1 : history.length + 1;
  const width = 600 / count;
  timeline.max = setupPhase ? 0 : history.length;
  timeline.value = setupPhase ? 0 : cursor;
  timeline.disabled = disabled;
  timeline.setAttribute("aria-valuemax", timeline.max);
  timeline.setAttribute("aria-valuenow", timeline.value);
  timeline.setAttribute("aria-valuetext", disabled ? "Start" : timelinePositionText(cursor));
  timeline.setAttribute("aria-disabled", String(disabled));
  timeline.setAttribute("tabindex", disabled ? "-1" : "0");
  let svg = "";
  for (let index = 0; index < count; index++) {
    const margin = timelineMarginAt(index);
    const known = Number.isFinite(margin);
    const fill = known ? ownershipColor(margin / cells.length) : "#dadbd3";
    svg += `<rect class="margin-segment${known ? "" : " margin-missing"}" data-index="${index}" x="${(index * width).toFixed(3)}" y="4" width="${(width + .05).toFixed(3)}" height="24" fill="${fill}"><title>${timelinePositionText(index)}</title></rect>`;
  }
  svg += '<rect class="margin-timeline-outline" x=".5" y="4.5" width="599" height="23" pointer-events="none"/>';
  if (!disabled) {
    const x = (cursor + .5) * width;
    svg += `<path class="margin-current" data-current="${cursor}" d="M${x.toFixed(3)},1V31" pointer-events="none"/>`;
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
$("model-name").textContent = ANALYSIS_CONFIG.model;

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
  return "rgb(" + end.map(channel => Math.round(channel * amount)).join(",") + ")";
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

function drawBoard(force = false) {
  if (!engine) return;
  if (movePressActive() && !force) return;
  const placing = setupPhase !== 0;
  const preview = placing ? null : previewCandidate();
  const selectedMove = previewMove();
  // The prospective stack is known before any search statistics arrive.
  // Preview it read-only without claiming an unsearched conditional map.
  const ghostLegal = placing ? legalStartCell(selectedMove) : valid(selectedMove) && !engine._hn_score(2) && engine._hn_value(selectedMove) > 0;
  const ghostMove = ghostLegal ? selectedMove : null;
  const ownershipPreview = preview && view === "ownership";
  const replyPreview = preview && (view === "visits" || view === "margin");
  const map = placing ? null : ownershipPreview ? preview.ownership : result && result.ownership;
  const ownershipOn = !placing && (!!ownershipPreview || view === "ownership");
  const marginOn = !placing && view === "margin" && !ownershipPreview;
  const displayedCandidates = placing ? [] : replyPreview ? preview.replyState === 1 ? preview.replies || [] : [] : result ? result.candidates : [];
  const displayedBest = placing ? null : replyPreview ? preview.replyBest : result && result.best;
  const rootSide = result ? result.side : engine._hn_stm();
  const displayedSide = replyPreview ? 3 - rootSide : rootSide;
  const bestCandidate = displayedCandidates.find(candidate => candidate.move === displayedBest);
  const hasBaseline = bestCandidate && bestCandidate.visits > 0 && Number.isFinite(bestCandidate.margin);
  const marginCandidates = new Map(displayedCandidates.map(candidate => [candidate.move, candidate]));
  $("ownership-legend-row").hidden = placing || marginOn;
  $("margin-loss-legend").hidden = placing || !marginOn;
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
  let svg = "";
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
    const fill = Number.isFinite(loss) ? marginLossColor(loss) : ownershipOn && map ? ownershipColor(map[cell]) : territory === 1 ? "#f0d5d0" : territory === 2 ? "#dae1e3" : "#e5ddca";
    let title = cellName(cell);
    if (marginOn) {
      title = Number.isFinite(moveMargin) ? signed(moveMargin) : "";
    } else if (!placing && view === "visits" && !ownershipPreview) {
      const tooltipCandidate = ghost ? preview : candidate;
      const tooltipTotal = ghost ? rootVisitTotal : total;
      title = tooltipCandidate && Number.isFinite(tooltipCandidate.visits) && tooltipCandidate.visits >= 0 && tooltipTotal > 0
        ? `${(100 * tooltipCandidate.visits / tooltipTotal).toFixed(1)}%` : "";
    } else if (ownershipOn) {
      title = map && Number.isFinite(map[cell]) ? `${((map[cell] + 1) * 50).toFixed(1)}%` : "";
    }
    const numericTooltip = !placing && (marginOn || view === "visits" || ownershipOn);
    const accessibleLabel = numericTooltip ? ` aria-label="${cellName(cell)}${title ? " " + title : ""}"` : "";
    svg += `<path class="hex${legal ? " legal" : ""}" data-cell="${cell}"${accessibleLabel} d="${hexPath(x, y)}" fill="${fill}">${title ? `<title>${title}</title>` : ""}</path>`;
    if (own) {
      const stackRadius = radius * .60;
      const stackFill = own === 1 ? "#ba4238" : own === 2 ? "#fffefa" : "#8d8575";
      svg += `<circle class="stack" cx="${x}" cy="${y}" r="${stackRadius}" fill="none" stroke="#fffdf8" stroke-width="3"/>`;
      svg += `<circle class="stack${ghost ? " preview-stack" : ""}" cx="${x}" cy="${y}" r="${stackRadius}" fill="${stackFill}" stroke="${ghost ? "#00e676" : "#555b50"}" stroke-width="${ghost ? 2 : 1}"${ghost ? ` data-preview-root="${ghostMove}" stroke-dasharray="3,2" opacity=".8"` : ""}/>`;
      svg += `<text class="stack-number" x="${x}" y="${y}" fill="${own === 2 ? "#454b49" : "#fff"}">${height}</text>`;
    }
    if (territory === 1 || territory === 2) svg += `<g pointer-events="none" transform="translate(${x - radius * .67},${y + radius * .52})"><path d="M-2,-1v-2a2,2 0 0 1 4,0v2" fill="none" stroke="#575e53" stroke-width="1.3"/><rect x="-3" y="-1" width="6" height="5" rx="1" fill="${territory === 1 ? "#ba4238" : "#fffefa"}" stroke="#575e53" stroke-width=".9"/></g>`;
    if (cursor && cell === history[cursor - 1]) svg += `<path d="${hexPath(x, y)}" fill="none" stroke="#bb853d" stroke-width="3" pointer-events="none"/>`;
    if (ghost) svg += `<path d="${hexPath(x, y)}" fill="none" stroke="#00e676" stroke-width="4" pointer-events="none"/>`;
    else if (!placing && result && cell === displayedBest) svg += `<path d="${hexPath(x, y)}" fill="none" stroke="#00e676" stroke-width="3" stroke-dasharray="4,3" pointer-events="none"/>`;
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
    if (c <= MID) svg += `<text class="coord" x="${x0 + offset * dx / 2}" y="${y0 - offset * dy}">${letter}</text>`;
    if (c >= MID) svg += `<text class="coord" x="${x1 - offset * dx / 2}" y="${y1 + offset * dy}">${letter}</text>`;
  }
  board.innerHTML = svg;
  if (placing) {
    $("ownership-marker-value").textContent = "";
    $("map-caption").textContent = $("turn-text").textContent;
    updatePreviewLine();
    return;
  }
  const mapMargin = map ? cells.reduce((sum, c) => sum + (Number.isFinite(map[c]) ? map[c] : 0), 0) : null;
  const legendMargin = mapMargin === null ? engine._hn_eval_margin() * (engine._hn_stm() === 1 ? 1 : -1) : mapMargin;
  const markerPosition = Math.max(0, Math.min(100, (legendMargin / cells.length + 1) * 50));
  $("ownership-marker").style.left = `${markerPosition}%`;
  $("ownership-marker-value").style.left = `${markerPosition}%`;
  $("ownership-marker-value").textContent = signed(legendMargin);
  const legendSource = ownershipPreview ? `after ${cellName(preview.move)}` : result ? "all searched lines" : "static ownership estimate";
  const legendLabel = `Red ${signed(legendMargin)} cells · ${legendSource}.`;
  $("ownership-legend").title = legendLabel;
  $("ownership-legend").setAttribute("aria-label", legendLabel);
  if (boardGesture && view === "ownership" && !boardGesture.cancelled && !preview) $("map-caption").textContent = `No searched ownership yet for ${cellName(boardGesture.cell)}. Release to play; slide outside to cancel.`;
  else if (replyPreview) $("map-caption").textContent = context.textContent;
  else if (ownershipPreview) $("map-caption").textContent = `After ${cellName(preview.move)} · expected margin ${signed(mapMargin)} for Red · ${preview.samples.toLocaleString()} leaf predictions${boardGesture && !boardGesture.cancelled ? " · release to play" : ""}.`;
  else if (view === "ownership") $("map-caption").textContent = result && result.samples ? `All searched lines · Red ${signed(mapMargin)} cells · ${result.samples.toLocaleString()} leaf predictions.` : legendLabel;
  else if (marginOn) $("map-caption").textContent = result ? `Margins for ${displayedSide === 1 ? "Red" : "White"}${hasBaseline ? `; colors show loss relative to ${cellName(displayedBest)}` : ""}.` : "No searched margins yet.";
  else $("map-caption").textContent = legendLabel;
  updatePreviewLine();
}

function updatePreviewLine() {
  if (setupPhase) {
    $("candidate-pv").hidden = true;
    $("candidate-pv").textContent = "";
    return;
  }
  const preview = previewCandidate();
  const candidate = preview || result && result.candidates.find(c => c.move === result.best);
  const moves = candidate && candidate.pv || [];
  $("candidate-pv").hidden = !moves.length;
  $("candidate-pv").textContent = moves.length ? `${preview ? `After ${cellName(preview.move)}: ` : ""}${moves.map(cellName).join(" ")}` : "";
}

function showResult(data) {
  result = data;
  hoverRow = null; // Rows are replaced below; the move preview survives refresh.
  const total = data.candidates.reduce((sum, c) => sum + c.visits, 0);
  const candidates = data.candidates.filter(c => c.visits > 0).slice().sort((a, b) => b.visits - a.visits);
  if (stableBest !== data.best) { stableBest = data.best; stableSince = data.visits; }
  const best = data.candidates.find(candidate => candidate.move === data.best);
  const hasBaseline = best && best.visits > 0 && Number.isFinite(best.margin);
  if (!movePressActive()) $("candidates").innerHTML = candidates.length ? candidates.map(candidate => {
    const share = 100 * candidate.visits / Math.max(1, total);
    const recommended = candidate.move === data.best;
    const loss = hasBaseline && Number.isFinite(candidate.margin) ? best.margin - candidate.margin : null;
    const marginStyle = Number.isFinite(loss) ? ` style="background:${marginLossColor(loss)}"` : "";
    return `<tr data-move="${candidate.move}" tabindex="0" class="${recommended ? "recommend" : ""}" aria-label="${cellName(candidate.move)}, ${candidate.visits} visits${recommended ? ", recommended" : ""}"><td>${cellName(candidate.move)}${recommended ? '<span class="badge">best</span>' : ""}</td><td>${candidate.visits.toLocaleString()}</td><td><div class="bar"><i style="width:${share.toFixed(1)}%"></i><span>${share.toFixed(1)}%</span></div></td><td><span class="margin-value"${marginStyle}>${signed(candidate.margin)}</span></td></tr>`;
  }).join("") : "";
  drawBoard();
}

function cancelSearch(clear = true) {
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
    result = null; hoverMove = null; hoverRow = null; stableBest = null;
    $("candidates").innerHTML = "";
    candidatePane.scrollTop = 0;
    $("candidate-pv").textContent = "";
    $("candidate-pv").hidden = true;
  }
}

function startSearch() {
  if (!engine || !workerReady || setupPhase) return;
  cancelSearch();
  $("analysis-error").textContent = "";
  if (engine._hn_score(2)) { drawBoard(); return; }
  searching = true;
  activePositionKey = positionKey();
  worker.postMessage({type: "search", gen: generation, red: starts[0], white: starts[1], moves: history.slice(0, cursor), sims: FIXED_SEARCH_VISITS});
}

function replay(red, white, moves, length) {
  if (red === CENTRE || white === CENTRE || red < 0 || white < 0 || red === white) throw new Error("Choose two distinct starting cells, excluding the center.");
  engine._hn_init_display(red, white);
  for (let k = 0; k < length; k++) {
    const move = moves[k];
    if (move < 0) {
      if (engine._hn_can_move()) throw new Error(`Move ${k + 1}: pass is only legal with no available move.`);
      engine._hn_pass();
    } else if (!engine._hn_play(move)) throw new Error(`Move ${k + 1} (${cellName(move)}) is illegal.`);
  }
}

function refreshPosition() {
  $("position-error").textContent = "";
  $("analysis-error").textContent = "";
  $("copy").disabled = !!setupPhase;
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
  if (settled) rememberTimelineMargin(positionKey(), engine._hn_score(0) - engine._hn_score(1));
  const turnText = settled ? `Settled · Red ${engine._hn_score(0)}, White ${engine._hn_score(1)}` : redToMove ? "Red to move" : "White to move";
  $("turn-text").textContent = workerReady ? turnText : "Loading…";
  $("turn-stone").hidden = settled || !workerReady;
  $("turn-stone").classList.toggle("red", !settled && redToMove);
  $("turn-indicator").classList.toggle("red", !settled && redToMove);
  drawMarginTimeline();
  $("back").disabled = !cursor;
  $("forward").disabled = cursor >= history.length;
  $("moves").value = [...starts, ...history].map(cellName).join(" ");
  drawBoard();
  const cached = getCachedResult(positionKey());
  if (cached) {
    cancelSearch();
    stableBest = cached.stableBest; stableSince = cached.stableSince;
    showResult({...cached.data, type: "cached"});
    return;
  }
  startSearch();
}

function newGame() {
  if (!engine) return;
  cancelTimelineGesture();
  marginHistory.clear();
  cancelSearch();
  history = []; cursor = 0;
  setupRed = null;
  setupPhase = $("startmode").value === "c" ? 1 : 0;
  if (!setupPhase) {
    starts = $("startmode").value === "b" ? balancedStart() : randomStart();
    engine._hn_init_display(starts[0], starts[1]);
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
  refreshPosition();
}

function selectBoardCell(cell) {
  if (setupPhase) chooseStartCell(cell);
  else playMove(cell);
}

function loadPosition() {
  if (!engine) return;
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
    try { replay(red, white, moves, moves.length); }
    catch (error) { replay(starts[0], starts[1], history, cursor); throw error; }
    cancelSearch();
    setupPhase = 0; setupRed = null;
    cancelTimelineGesture();
    marginHistory.clear();
    starts = [red, white]; history = moves; cursor = moves.length;
    refreshPosition();
  } catch (error) { $("position-error").textContent = error.message; }
}

function playMove(move) {
  if (!engine || setupPhase || move < 0 || !engine._hn_play(move)) return;
  cancelSearch();
  history = history.slice(0, cursor);
  history.push(move); cursor++;
  if (!engine._hn_score(2) && !engine._hn_can_move()) { engine._hn_pass(); history.push(-1); cursor++; }
  refreshPosition();
}

function reviewAt(next) {
  if (!engine || setupPhase || !Number.isFinite(next)) return;
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
  hoverMove = move; hoverRow = null;
  drawBoard();
}

board.addEventListener("pointerover", previewBoardHover);
board.addEventListener("pointerleave", event => {
  if (event.pointerType !== "mouse" || boardGesture || hoverMove === null) return;
  hoverMove = null; hoverRow = null;
  drawBoard();
});

board.addEventListener("pointerdown", event => {
  if (!["mouse", "touch", "pen"].includes(event.pointerType) || event.isPrimary === false || movePressActive() || timelineGesture || (event.button !== undefined && event.button !== 0)) return;
  const hex = event.target.closest(".hex.legal");
  if (!hex) return;
  event.preventDefault();
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
$("candidates").addEventListener("pointerover", event => {
  const row = event.target.closest("tr[data-move]");
  if (setupPhase || movePressActive() || !row || event.pointerType === "touch" || event.pointerType === "pen") return;
  $("candidates").classList.toggle("mouse-hover", true);
  if (row === hoverRow) return;
  hoverRow = row; hoverMove = +row.dataset.move; drawBoard();
});
$("candidates").addEventListener("pointerleave", () => {
  if (movePressActive()) return;
  if (hoverRow === null && hoverMove === null) return;
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
  if (event.pointerType === "mouse" && !movePressActive() && event.target.closest("tr[data-move]"))
    $("candidates").classList.toggle("mouse-hover", true);
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
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    const row = event.target.closest("tr[data-move]");
    if (row && result && result.candidates.some(candidate => candidate.move === +row.dataset.move)) playMove(+row.dataset.move);
  }
});
document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {
  view = button.dataset.view; hoverMove = null; hoverRow = null;
  document.querySelectorAll("[data-view]").forEach(b => { const on = b === button; b.classList.toggle("selected", on); b.setAttribute("aria-pressed", on); });
  drawBoard();
}));
$("load").addEventListener("click", () => loadPosition());
$("newgame").addEventListener("click", newGame);
$("copy").addEventListener("click", async () => {
  if (setupPhase) return;
  const text = $("moves").value;
  try { await navigator.clipboard.writeText(text); $("position-error").textContent = "Game copied."; }
  catch { $("position-error").textContent = "Clipboard unavailable. Select and copy the move list above."; }
});
$("back").addEventListener("click", () => reviewAt(cursor - 1));
$("forward").addEventListener("click", () => reviewAt(cursor + 1));
// Keep the input adapter alongside pointer/keyboard navigation for accessibility.
$("review").addEventListener("input", () => reviewAt(+$("review").value));

function reviewIndexAt(event) {
  const bounds = $("review").getBoundingClientRect();
  if (!(bounds.width > 0) || !Number.isFinite(event.clientX)) return cursor;
  const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  return Math.min(history.length, Math.floor(fraction * (history.length + 1)));
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
}
$("review").addEventListener("pointerup", finishTimelineGesture);
$("review").addEventListener("pointercancel", finishTimelineGesture);
$("review").addEventListener("lostpointercapture", event => {
  if (!timelineGesture || timelineGesture.pointerId !== event.pointerId) return;
  cancelTimelineGesture();
  updateTimelineLabel();
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
  const targets = {ArrowLeft: cursor - 1, ArrowDown: cursor - 1,
    ArrowRight: cursor + 1, ArrowUp: cursor + 1, Home: 0, End: history.length};
  if (!(event.key in targets)) return;
  event.preventDefault();
  timelineHoverIndex = null;
  reviewAt(targets[event.key]);
  updateTimelineLabel();
});
$("review").addEventListener("contextmenu", event => event.preventDefault());

HN().then(module => {
  engine = module;
  for (const id of ["load", "newgame", "copy"]) $(id).disabled = false;
  worker = new Worker("search-worker.js");
  worker.onmessage = event => {
    const data = event.data;
    if (data.type === "ready") { workerReady = true; refreshPosition(); return; }
    if (data.gen !== undefined && data.gen !== generation) return;
    if (data.type === "error") { searching = false; $("analysis-error").textContent = data.message; return; }
    if (data.type === "progress" || data.type === "done") {
      if (setupPhase) return;
      showResult(data);
      cacheSearchResult(activePositionKey, data);
      if (data.type === "done") {
        searching = false;
        if (data.capacityReached) $("analysis-error").textContent = "Analysis could not finish: tree capacity reached.";
        else if (data.stopped || data.visits < FIXED_SEARCH_VISITS) $("analysis-error").textContent = "Analysis stopped before completion.";
      }
    }
  };
  worker.onerror = event => { $("analysis-error").textContent = "Search worker error: " + event.message; searching = false; };
  newGame();
}).catch(error => { $("turn-text").textContent = "Engine failed to load"; $("analysis-error").textContent = String(error.message || error); });
