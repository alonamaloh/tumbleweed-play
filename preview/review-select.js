// Winning chances, the level of play, and which mistakes a review shows.
//
// A port of the engine-free parts of training/game_review:
//   win.py      in_play, spread, win_chance
//   level.py    better_than, name and their constants (the table is review-levels.js; mass_ahead and summary
//               need the engine and are not here)
//   score.py    red_view
//   review.py   settled, annotate, close_finish, choose_mistakes, rows_of and their constants
// The Python is the reference: change it first, then this file, and run the parity test
//     node tools/review_port/check_words.js
// Functions keep the Python's names (in camelCase) and order.
//
// How the Python types map here:
//   rows ({ply: row}) and open_points ({ply: points})   Map keyed by the ply (a number), in the Python's
//                                                       insertion order; the rows keep the Python's keys
//   a set of plies (settled, close_finish)              Set of numbers
//   None                                                null (undefined is accepted where a value is read)
// This file also holds two things the wording (review-words.js) shares with it: the helpers for Python's
// arithmetic and truth (`py`), and a small local board (`localBoard`, marked below).
//
// Needs review-levels.js loaded first for betterThan (scope.Review.levels); nothing else.
"use strict";
(function (scope) {
  const R = scope.Review = scope.Review || {};

  // ---------------------------------------------------------------- Python's arithmetic and truth

  // f"{x:.{digits}f}": the decimal nearest to the exact value of the double, exact ties to the even neighbour.
  // toFixed rounds ties away from zero (0.125 -> "0.13", 2.5 -> "3"), so the digits are made from the exact
  // binary value instead. The sign is kept even when the digits are all zero, as Python does ("-0").
  function fixed(x, digits = 0) {
    if (Number.isNaN(x)) return "nan";
    if (!Number.isFinite(x)) return x < 0 ? "-inf" : "inf";
    const negative = x < 0 || Object.is(x, -0);
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, Math.abs(x));
    const bits = view.getBigUint64(0);
    const exponent = Number(bits >> 52n), fraction = bits & ((1n << 52n) - 1n);
    // |x| = mantissa * 2 ** power, exactly
    const mantissa = exponent === 0 ? fraction : fraction | (1n << 52n);
    const power = exponent === 0 ? -1074 : exponent - 1075;
    let numerator = mantissa * 10n ** BigInt(digits), denominator = 1n;
    if (power >= 0) numerator <<= BigInt(power);
    else denominator <<= BigInt(-power);
    let whole = numerator / denominator;
    const twice = 2n * (numerator % denominator);
    if (twice > denominator || (twice === denominator && (whole & 1n) === 1n)) whole += 1n;
    let text = whole.toString();
    if (digits > 0) {
      text = text.padStart(digits + 1, "0");
      text = text.slice(0, -digits) + "." + text.slice(-digits);
    }
    return (negative ? "-" : "") + text;
  }

  // round(x, digits) of a float: the double nearest to that decimal.
  const round = (x, digits) => Number(fixed(x, digits));

  // f"{x:.0%}": Python multiplies by 100 in floating point, then formats.
  const percent = x => fixed(x * 100, 0) + "%";

  // int(x) of a float: towards zero.
  const int = x => Math.trunc(x);

  // bool(x): None, False, zero, and the empty string, list, tuple, dict, set are false.
  function truthy(x) {
    if (x === null || x === undefined || x === false || x === 0 || x === "") return false;
    if (Array.isArray(x)) return x.length > 0;
    if (x instanceof Map || x instanceof Set) return x.size > 0;
    if (typeof x === "object") {
      for (const k in x) if (Object.prototype.hasOwnProperty.call(x, k)) return true;
      return false;
    }
    return true;
  }

  // d.get(key, fallback): the fallback only when the key is missing; a stored null (None) is returned as it is.
  // A key holding undefined counts as missing (an object made here rather than read from JSON).
  function get(d, key, fallback = null) {
    if (d === null || typeof d !== "object" || Array.isArray(d)) throw new TypeError(`get('${key}') of something that is not a dict`);
    if (!Object.prototype.hasOwnProperty.call(d, key) || d[key] === undefined) return fallback;
    return d[key];
  }

  // a == b for the values a saved review holds (numbers, strings, booleans, None, lists, dicts).
  function equal(a, b) {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return (a === null || a === undefined) && (b === null || b === undefined);
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
    }
    if (typeof a === "object" && typeof b === "object") {
      const ka = Object.keys(a), kb = Object.keys(b);
      return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && equal(a[k], b[k]));
    }
    return false;
  }

  // sum(values) of floats: since Python 3.12 the built-in sum() adds floats with a running correction for the
  // rounding of each step (Neumaier's), so the total can differ in the last digit from adding them one by one.
  // (Python adds an int among them without the correction; a saved review cannot tell 3 from 3.0, so here every
  // number is a float.)
  function sum(values) {
    let total = 0, correction = 0, first = true;
    for (const x of values) {
      if (first) {                                       // 0 + x, as an int start and a float
        total = 0 + x;
        first = false;
        continue;
      }
      const t = total + x;
      correction += Math.abs(total) >= Math.abs(x) ? (total - t) + x : (x - t) + total;
      total = t;
    }
    if (correction && Number.isFinite(correction)) total += correction;
    return total;
  }

  // numpy's sum of a one-dimensional float64 array: pairwise, in blocks of eight (as a.sum() adds them).
  function numpySum(a, start = 0, n = a.length - start) {
    if (n < 8) {
      let total = 0;
      for (let i = 0; i < n; i++) total += a[start + i];
      return total;
    }
    if (n <= 128) {
      const r = [];
      for (let j = 0; j < 8; j++) r.push(a[start + j]);
      let i = 8;
      for (; i < n - n % 8; i += 8) for (let j = 0; j < 8; j++) r[j] += a[start + i + j];
      let total = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
      for (; i < n; i++) total += a[start + i];
      return total;
    }
    let half = Math.floor(n / 2);
    half -= half % 8;
    return numpySum(a, start, half) + numpySum(a, start + half, n - half);
  }

  // numpy.interp(x, xp, fp) for one x and increasing xp. The last bit can differ from numpy's: its compiled loop
  // fuses the multiply and the add below on some machines (Apple silicon) and not on others. Only betterThan
  // uses this, and only the level's thresholds read the result.
  function interp(x, xp, fp) {
    const n = xp.length;
    if (Number.isNaN(x)) return x;
    if (x > xp[n - 1]) return fp[n - 1];
    if (x < xp[0]) return fp[0];
    let low = 0, high = n;                               // the last j with xp[j] <= x
    while (low < high) {
      const middle = (low + high) >> 1;
      if (x >= xp[middle]) low = middle + 1;
      else high = middle;
    }
    const j = low - 1;
    if (j === n - 1 || xp[j] === x) return fp[j];
    const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
    return slope * (x - xp[j]) + fp[j];
  }

  // numpy.linspace(0, 1, n): multiples of the step, the last one exactly 1.
  function linspace01(n) {
    const step = 1 / (n - 1), out = [];
    for (let i = 0; i < n; i++) out.push(i * step);
    if (n > 1) out[n - 1] = 1;
    return out;
  }

  const py = {fixed, round, percent, int, truthy, get, equal, sum, numpySum, interp, linspace01};

  // ---------------------------------------------------------------- LOCAL BOARD HELPER
  // The little of board.py's Board and detect.py's edge_name that the selection and the wording need: a cell
  // name -> compact index (rows_of, lines.differing), the cells past one cell on a line (review.beyond) and the
  // name of an edge (review.plain_edges). It is here, in one place, so that it can be replaced by the Board of
  // review-board.js and the edgeName of review-detect.js; nothing else in the two files knows the geometry.
  //
  // Cells use the grid index r * g + c with g = 2 * side - 1 and |c - r| < side; the compact index counts the
  // valid cells in grid order; a name is the column letter then the row number ("G7": c = 6, r = 6).

  const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [0, -1], [-1, 0], [-1, -1]];
  const EDGES = ["top", "upper left", "upper right", "lower left", "bottom", "lower right"];
  const boards = new Map();

  function localBoard(side) {
    if (boards.has(side)) return boards.get(side);
    const g = 2 * side - 1;
    const cells = [], compact = new Map();
    for (let r = 0; r < g; r++) {
      for (let c = 0; c < g; c++) {
        if (Math.abs(c - r) < side) {
          compact.set(r * g + c, cells.length);
          cells.push(r * g + c);
        }
      }
    }
    const inside = (r, c) => r >= 0 && r < g && c >= 0 && c < g && Math.abs(c - r) < side;
    const board = {
      side, g, n: cells.length,
      // Board.name: compact index -> "G7"
      name(i) {
        return String.fromCharCode(65 + cells[i] % g) + (Math.floor(cells[i] / g) + 1);
      },
      // Board.index: "G7" -> compact index; a name that is not a cell of this board is an error (KeyError)
      index(name) {
        const digits = String(name).slice(1);
        if (!/^\s*[+-]?\d+\s*$/.test(digits)) throw new Error(`not a cell name: ${name}`);
        const c = String(name)[0].toUpperCase().charCodeAt(0) - 65, r = Number(digits) - 1;
        if (!compact.has(r * g + c)) throw new Error(`cell ${name} is not on a board of side ${side}`);
        return compact.get(r * g + c);
      },
      // Board.rays[i]: for each of the six directions, the compact indices from cell i outwards, nearest first
      rays(i) {
        const r0 = Math.floor(cells[i] / g), c0 = cells[i] % g;
        return DIRECTIONS.map(([dr, dc]) => {
          const ray = [];
          for (let r = r0 + dr, c = c0 + dc; inside(r, c); r += dr, c += dc) ray.push(compact.get(r * g + c));
          return ray;
        });
      },
      // review.beyond: the cells past c on the line from a through c (names in, names out)
      beyond(a, c) {
        const i = board.index(a), j = board.index(c);
        const ray = board.rays(i).find(ray => ray.includes(j));
        return ray === undefined ? [] : ray.slice(ray.indexOf(j) + 1).map(k => board.name(k));
      },
      // detect.edge_name: 'H15', 'O15' -> 'bottom edge', as the board is drawn (row 1 at the top)
      edgeName(u, v) {
        const s1 = side - 1;
        const corner = (r, c) => String.fromCharCode(65 + c) + (r + 1);
        const pairs = [[corner(0, 0), corner(0, s1)], [corner(0, 0), corner(s1, 0)], [corner(0, s1), corner(s1, 2 * s1)],
          [corner(s1, 0), corner(2 * s1, s1)], [corner(2 * s1, s1), corner(2 * s1, 2 * s1)],
          [corner(s1, 2 * s1), corner(2 * s1, 2 * s1)]];
        for (let k = 0; k < pairs.length; k++) {
          const [a, z] = pairs[k];
          // {u, v} == set(pair)
          if ((u === a || u === z) && (v === a || v === z) && (a === u || a === v) && (z === u || z === v)) return `${EDGES[k]} edge`;
        }
        return `${u}–${v} edge`;
      },
    };
    boards.set(side, board);
    return board;
  }
  // ---------------------------------------------------------------- end of the local board helper

  // ---------------------------------------------------------------- win.py
  // Winning chances from a search margin and the points still in play.
  //
  //     chance = 1 / (1 + exp(-margin / spread)),   spread = sqrt(A^2 + B * in_play)
  //
  // in_play is the sum over the cells of 1 - (2p - 1)^2 for the network's ownership p (no search): the variance
  // the final margin would have if every cell were decided on its own with that probability. It is about the
  // number of cells at the start of a game and reaches zero when every cell has an owner, so the same lead is
  // worth more and more as the game settles, and at the end one point is nearly the whole game. A lead of one
  // spread is a 73% chance. The fit and what it leaves out are described in win.py; these are chances for human
  // players, for a game that is played out.

  const A = 0.421, B = 1.235;

  // Points still in play, from the network's ownership of one position (probabilities, either side's view).
  function inPlay(own) {
    const terms = Array.from(own, p => {
      const c = 2 * p - 1;
      return 1 - c * c;
    });
    return numpySum(terms);
  }

  // The lead that gives a 73% chance of winning, in points.
  function spread(pointsInPlay) {
    return Math.sqrt(A * A + B * Math.max(pointsInPlay, 0));
  }

  // Chances for the side whose margin this is.
  function winChance(margin, pointsInPlay) {
    const z = margin / spread(pointsInPlay);
    return 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, z))));
  }

  // ---------------------------------------------------------------- level.py
  // The level of play in a game, from how closely each side's moves follow rung 24's preferences. A side's
  // average mass ahead (lower is stronger) is placed among all recorded tumbleweed.games sides with at least 15
  // moves (review-levels.js) and named by its share of sides that played worse:
  //     expert: 90% or more; experienced: 60-90%; intermediate: 20-60%; novice: under 20%.
  // One game is a small sample: the line describes this game, not the player.

  const LEVELS = [[.9, "expert"], [.6, "experienced"], [.2, "intermediate"], [0, "novice"]];
  const MINIMUM_MOVES = 15;

  // The share of recorded sides on this board whose average was higher (worse).
  function betterThan(side, mean) {
    const reference = R.levels;
    if (!reference) throw new Error("review-levels.js is not loaded");
    const q = get(reference.quantiles, String(side));
    if (q === null || mean === null || mean === undefined) return null;
    return 1 - interp(mean, q, linspace01(q.length));
  }

  function levelName(share) {
    const found = LEVELS.find(([limit]) => share >= limit);
    if (!found) throw new Error(`no level for a share of ${share}`);
    return found[1];
  }

  // ---------------------------------------------------------------- score.py

  // The position's value for Red, before the move.
  function redView(row) {
    return row.stm === 1 ? row.value : -row.value;
  }

  // ---------------------------------------------------------------- review.py: the selection

  // The plies from which the game is decided: one side's winning chances stay above `threshold`, and its lead
  // above `lead` points, from there to the end. A clear lead that later melts away does not count as decided, and
  // neither does a lead of a point or two near the end: the chances are lopsided by then, but one slip still
  // turns the game, so its moves are judged like any others. rows: Map ply -> row with stm, win_best and the
  // margin for Red ('red' or 'red_value').
  function settled(rows, threshold = .85, lead = 3.0) {
    const plies = [...rows.keys()].sort((a, b) => a - b);
    const out = new Set();
    let low = 1, high = 0, least = Infinity, most = -Infinity;
    for (let i = plies.length - 1; i >= 0; i--) {
      const k = plies[i], row = rows.get(k);
      const w = row.stm === 1 ? row.win_best : 1 - row.win_best;
      const m = "red" in row ? row.red : row.red_value;
      low = Math.min(low, w); high = Math.max(high, w); least = Math.min(least, m); most = Math.max(most, m);
      if ((low > threshold && least > lead) || (high < 1 - threshold && most < -lead)) out.add(k);
    }
    return out;
  }

  // Winning chances before and after each move, for the mover: the position's value (the search's root value,
  // which the timeline keeps) and that value less the move's loss, both with the points in play before the move.
  // openPoints: Map ply -> points in play.
  function annotate(rows, openPoints) {
    for (const r of rows.values()) {
      r.red = redView(r);
      r.in_play = openPoints.get(r.ply);
      r.win_best = winChance(r.value, r.in_play);
      r.win_played = winChance(r.value - r.loss, r.in_play);
      r.win_loss = Math.max(0, r.win_best - r.win_played);
    }
  }

  const BEHIND_EXTRA = 3;          // lessons for the side behind once the game is decided
  const BEHIND_MINIMUM = 3.0;      // points such a lesson must cost
  const CLOSE = 3.0;               // a close finish: the engine's margin stays within this many points to the end
  const CLOSE_EXTRA = 2;           // lessons per side from a close finish that cost less than the usual minimum
  const CLOSE_MINIMUM = 1.0;       // points such a lesson must cost

  // The plies of a close finish: from some move on, the engine's margin stays within CLOSE points to the end
  // (at least six plies) of a game that was played out. There every point counts, so smaller slips are worth a
  // lesson. A game that stopped early while it was close has no finish to speak of. rows: Map ply -> row with
  // 'red', the margin for Red before the move.
  function closeFinish(rows, finished = true) {
    if (!truthy(finished)) return new Set();
    const zone = new Set();
    const plies = [...rows.keys()].sort((a, b) => b - a);
    for (const k of plies) {
      if (Math.abs(rows.get(k).red) > CLOSE) break;
      zone.add(k);
    }
    return zone.size >= 6 ? zone : new Set();
  }

  // The decisions to search again and comment on, as sorted plies. rows: Map ply -> row with ply, stm, loss,
  // win_loss, win_best (the mover's chances before the move) and best.
  //
  // While the game is open (until it is decided, see settled): each side's worst moves by lost winning chances,
  // with a little weight on the points (a big loss by a clear leader matters when the lead later melts away).
  // The same better move missed again soon after is one lesson, not two.
  // Once it is decided: the leader gets at most one note, on the biggest miss of 5 points or more (players
  // rightly play safe there). The side behind is the one a review is for, so it gets up to BEHIND_EXTRA more
  // lessons, by points lost, at least BEHIND_MINIMUM each, spread over the rest of the game (not within four
  // moves of another one, and one per repeated better move).
  // In a close finish (closeFinish): up to CLOSE_EXTRA more per side that cost CLOSE_MINIMUM or more, below the
  // usual minimum. In the 45-46 game of Monet against HighNoon the move that lost the lead cost 1.8 points and
  // was not shown.
  function chooseMistakes(rows, perSide = 4, minimumLoss = 2.0, finished = true) {
    const chosen = [], done = settled(rows), close = closeFinish(rows, finished);
    const byLoss = (a, b) => b.loss - a.loss;            // sorted(..., key=lambda r: -r['loss']); the sort is stable
    for (const side of [1, 2]) {
      const mine = [...rows.values()].filter(r => r.stm === side);
      const weight = r => -(r.win_loss + .01 * r.loss);
      const live = mine.filter(r => r.loss >= minimumLoss && !done.has(r.ply)).sort((a, b) => weight(a) - weight(b));
      const picked = [];
      for (const r of live) {
        if (picked.length === perSide) break;
        if (!picked.some(q => q.best === r.best && Math.abs(q.ply - r.ply) <= 16)) picked.push(r);
      }
      chosen.push(...picked.map(r => r.ply));
      const late = mine.filter(r => done.has(r.ply));
      const ahead = late.filter(r => r.win_best >= .5 && r.loss >= 5).sort(byLoss);
      chosen.push(...ahead.slice(0, 1).map(r => r.ply));
      const extra = [];
      for (const r of late.filter(r => r.win_best < .5 && r.loss >= BEHIND_MINIMUM).sort(byLoss)) {
        if (extra.length === BEHIND_EXTRA) break;
        if (!extra.some(q => Math.abs(q.ply - r.ply) <= 8 || (q.best === r.best && Math.abs(q.ply - r.ply) <= 16))) extra.push(r);
      }
      chosen.push(...extra.map(r => r.ply));
      const slips = mine.filter(r => close.has(r.ply) && CLOSE_MINIMUM <= r.loss && r.loss < minimumLoss).sort(byLoss);
      chosen.push(...slips.slice(0, CLOSE_EXTRA).map(r => r.ply));
    }
    return [...new Set(chosen)].sort((a, b) => a - b);
  }

  // The scoring pass of a saved review, as chooseMistakes wants it. b: a board with index(name) (default: the
  // local board of the game's side).
  function rowsOf(r, b = localBoard(r.game.side)) {
    return new Map(r.timeline.map(t => [t.ply, {ply: t.ply, stm: t.stm, loss: t.loss, win_loss: t.win_loss, best: b.index(t.best),
      win_best: t.stm === 1 ? t.red_win : 1 - t.red_win, red: t.red_value}]));
  }

  R.select = {py, localBoard, EDGES,
    A, B, inPlay, spread, winChance,
    LEVELS, MINIMUM_MOVES, betterThan, levelName,
    redView,
    settled, annotate, BEHIND_EXTRA, BEHIND_MINIMUM, CLOSE, CLOSE_EXTRA, CLOSE_MINIMUM, closeFinish, chooseMistakes, rowsOf};
  if (typeof module !== "undefined" && module.exports) module.exports = R.select;
})(globalThis);
