"use strict";
// Making a review from engine results: the scoring pass, the choice of moves, the facts for every commented
// move ("sheets"), the areas where a mistake loses its points, and the notes about the whole game.
//
// A port of the fact-making half of training/game_review: score.py, review.py (regions to game_lessons, without
// the wording), lines.py (follow to facts_from_tree) and level.py (mass_ahead, summary). The Python is the
// reference; tools/review_port/check_review.js replays recorded engine answers through this file and requires
// the Python's review. Functions keep the Python's names (in camelCase) and order, and everything that ends up
// in a saved review keeps the Python's keys.
//
// The engine is whatever the page has, behind three calls that may return promises:
//   search(jobs, visits, pvLength) -> one analysis per [codes, stm] job: {terminal, margin (side to move), best,
//       candidates: [{move, visits, prior, margin, pv}], ownership: {mean (per compact cell, -1 White .. +1 Red),
//       samples}}; best, move and pv are grid cells (r * g + c), as in the search modules;
//   evaluate(codes, stm) -> {policy, own}: for each position the network's policy logits and the probability that
//       the side to move owns each compact cell;
//   legal(codes, stm) -> the legal grid cells.
// The rules calls the Python makes through the native module arrive as data (`rules`): the positions before every
// move from the third on ([ply, codes, stm, move]), the final score ({result, winner, over}) and the position
// after the two starting stacks ([codes, stm]).
(function (scope) {
  const R = scope.Review = scope.Review || {};
  const {Position} = R.board;
  const {moveFacts, where} = R.detect;
  const S = R.select;

  const COLOUR = {1: "Red", 2: "White"};
  const OTHER = {1: 2, 2: 1};

  // ---------------------------------------------------------------- Python and numpy arithmetic

  // numpy's sum of a one-dimensional array: pairwise, in blocks of eight. single=true rounds every step to
  // float32, as numpy does for a float32 array.
  function numpySum(a, single = false, start = 0, n = a.length - start) {
    const f = single ? Math.fround : x => x;
    if (n < 8) {
      let total = 0;
      for (let i = 0; i < n; i++) total = f(total + a[start + i]);
      return total;
    }
    if (n <= 128) {
      const r = [];
      for (let j = 0; j < 8; j++) r.push(f(a[start + j]));
      let i = 8;
      for (; i < n - n % 8; i += 8) for (let j = 0; j < 8; j++) r[j] = f(r[j] + a[start + i + j]);
      let total = f(f(f(r[0] + r[1]) + f(r[2] + r[3])) + f(f(r[4] + r[5]) + f(r[6] + r[7])));
      for (; i < n; i++) total = f(total + a[start + i]);
      return total;
    }
    let half = Math.floor(n / 2);
    half -= half % 8;
    return f(numpySum(a, single, start, half) + numpySum(a, single, start + half, n - half));
  }

  // Python's round(x, digits): to the nearest, exact ties to the even neighbour.
  function pyRound(x, digits = 0) {
    const scale = 10 ** digits;
    const twice = Math.abs(x) * 2 ** (digits + 1);           // exact: a power of two
    if (Number.isInteger(twice) && twice % 2 === 1) {        // an exact tie
      const down = Math.floor(Math.abs(x) * scale);
      const even = down % 2 === 0 ? down : down + 1;
      return Math.sign(x) * even / scale;
    }
    return Number(x.toFixed(digits));
  }

  // collections.Counter.most_common(): by count, ties in the order first seen.
  function mostCommon(items) {
    const count = new Map();
    for (const x of items) count.set(x, (count.get(x) || 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1]);
  }

  const first = (ray, codes) => {
    for (const j of ray) if (codes[j]) return j;
    return null;
  };

  // ---------------------------------------------------------------- the scoring pass (score.py)

  // positions: [[ply, codes, stm, move]]. Returns a Map ply -> row with value (the mover's view, before the
  // move), best (compact), best_value, played_value, loss, second_value (or null) and legal (a count).
  async function scoreGame(engine, b, positions, visits = 160) {
    const parents = await engine.search(positions.map(([, codes, stm]) => [codes, stm]), visits);
    const rows = new Map(), children = [], childJobs = [];
    positions.forEach(([ply, codes, stm, move], k) => {
      const a = parents[k];
      if (a.terminal || a.best === null || a.best === undefined) return;
      const cands = new Map(a.candidates.map(c => [b.compact[c.move], c]));
      const best = b.compact[a.best];
      const bestValue = cands.get(best).margin;
      const enough = 3;                  // runner-up values from lightly searched moves are rough but usable
      const others = [...cands].filter(([m, c]) => m !== best && c.visits >= enough).map(([, c]) => c.margin);
      const row = {ply, stm, move, value: a.margin, best, best_value: bestValue,
        second_value: others.length ? Math.max(...others) : null, legal: cands.size};
      rows.set(ply, row);
      if (move === best) row.played_value = bestValue;
      else {
        const p = new Position(b, codes, stm).after(move);
        childJobs.push([p.codes, p.stm]);
        children.push(ply);
      }
    });
    const found = await engine.search(childJobs, Math.max(2, Math.floor(visits / 2)));
    children.forEach((ply, k) => { rows.get(ply).played_value = -found[k].margin; });
    for (const row of rows.values()) row.loss = Math.max(0, row.best_value - row.played_value);
    return rows;
  }

  // The position's value for Red, before the move.
  const redView = row => row.stm === 1 ? row.value : -row.value;

  // ---------------------------------------------------------------- ownership regions

  // Connected groups of cells whose expected gain has the same sign: [[sum, cells sorted by size]]. Groups are
  // found in cell order, summed in cell order and equal sizes keep cell order. single: delta is a float32 array.
  function regions(b, delta, threshold = .25, minimum = 1.0, single = false) {
    const out = [];
    for (const sign of [1, -1]) {
      const todo = new Set();
      for (let i = 0; i < b.n; i++) if (sign * delta[i] >= threshold) todo.add(i);
      for (let start = 0; start < b.n; start++) {
        if (!todo.has(start)) continue;
        todo.delete(start);
        const stack = [start], group = [];
        while (stack.length) {
          const i = stack.pop();
          group.push(i);
          for (const j of b.neighbours[i]) if (todo.has(j)) { todo.delete(j); stack.push(j); }
        }
        group.sort((x, y) => x - y);
        const total = numpySum(group.map(i => delta[i]), single);
        if (Math.abs(total) >= minimum)
          out.push([total, [...group].sort((x, y) => Math.abs(delta[y]) - Math.abs(delta[x]) || x - y)]);
      }
    }
    return out.sort((x, y) => Math.abs(y[0]) - Math.abs(x[0]));
  }

  // Average network ownership, as probabilities for `perspective`, over the position and the next `plies`
  // positions of the principal variation. Float32 throughout, as numpy computes it.
  async function ownershipAlong(engine, b, codes, stm, pv, perspective, plies = 3) {
    let p = new Position(b, codes, stm);
    const rows = [p.codes], sides = [p.stm];
    for (const g of pv.slice(0, plies)) {
      p = p.after(b.compact[g]);
      rows.push(p.codes);
      sides.push(p.stm);
    }
    const {own} = await engine.evaluate(rows, sides);
    const mean = new Float32Array(b.n);
    for (let i = 0; i < b.n; i++) {
      let total = 0;
      rows.forEach((_, k) => {
        const v = sides[k] === perspective ? own[k][i] : Math.fround(1 - own[k][i]);
        total = k ? Math.fround(total + v) : v;
      });
      mean[i] = Math.fround(total / rows.length);
    }
    return mean;
  }

  // The network's ownership of every position, one evaluation each: per position, the probability that the side
  // to move owns each cell.
  async function ownerships(engine, positions) {
    if (!positions.length) return [];
    const {own} = await engine.evaluate(positions.map(p => p[1]), positions.map(p => p[2]));
    return own;
  }

  // {ply: the points still in play} (in_play), from one network evaluation of each position.
  async function pointsInPlay(engine, positions, own = null) {
    const out = new Map();
    if (own === null) own = await ownerships(engine, positions);
    positions.forEach(([ply], k) => out.set(ply, S.inPlay(own[k])));
    return out;
  }

  // ---------------------------------------------------------------- the review

  const CONCRETE = ["captures", "attacks", "cuts", "invades", "removes"];

  // After the better move, can the opponent still play the threat with the same concrete effects? If so the
  // better move did not stop it; it only gave the opponent something more urgent to answer.
  function threatSurvives(p, best, threat) {
    const q = p.after(best);
    if (!q.canPlace(q.stm, true).has(threat)) return false;
    const effects = f => f.good.filter(c => CONCRETE.some(w => c.includes(w)));
    const before = effects(moveFacts(p.after(null), threat));
    return before.length ? effects(moveFacts(q, threat)).length > 0 : true;
  }

  // What the better move does to the opponent's answer to the move played and to the shared threat: 'gone' (no
  // line of sight high enough to place there at all), 'exposed' (a stack there could be captured at once),
  // 'weaker' (a lower stack there), or nothing. The text words 'gone' and 'exposed' alike.
  function afterBest(p, best, move, reply, threat, actual = null) {
    const them = 3 - p.stm, q = p.after(best), out = {};
    for (const [name, ref] of [[reply, () => p.after(move)], [threat, () => p.after(null)], [actual, () => p.after(move)]]) {
      if (!name) continue;
      const c = p.b.index(name);
      if (c === best) continue;
      const position = ref();
      const now = q.canPlace(them, true), before = position.canPlace(them, true), legal = q.canPlace(them);
      if (before.has(c) && !legal.has(c)) out[name] = ["gone", before.get(c), 0, lostSight(position, best, c, them)];
      else if (before.has(c) && !now.has(c)) out[name] = ["exposed", before.get(c), legal.get(c)];
      else if (before.has(c) && now.get(c) < before.get(c)) out[name] = ["weaker", before.get(c), now.get(c)];
    }
    return out;
  }

  // Why the better move makes c impossible for `them`: the stacks of theirs whose line of sight to c it cuts by
  // standing in between, and whether it captures a stack of theirs that saw c.
  function lostSight(p, best, c, them) {
    const cut = [];
    let captured = false;
    for (const ray of p.b.rays[c]) {
      const seen = first(ray, p.codes);
      if (seen === null || p.own[seen] !== them || !ray.includes(best)) continue;
      if (best === seen) captured = true;
      else if (ray.indexOf(best) < ray.indexOf(seen)) cut.push(p.b.name(seen));
    }
    return {cut, captured};
  }

  // The opponent's stacks whose line of sight to the threatened cell the better move cuts: the better move
  // stands between them on one of the cell's six lines.
  function cutSight(p, best, threat) {
    const them = 3 - p.stm, out = [];
    for (const ray of p.b.rays[threat]) {
      if (!ray.includes(best)) continue;
      const seen = first(ray, p.codes), k = ray.indexOf(best);
      if (seen !== null && ray.indexOf(seen) > k && p.own[seen] === them) out.push(p.b.name(seen));
    }
    return out;
  }

  // Did the opponent's last move create the threat: is it the threatened stack, or does it see the threatened
  // cell (a new line of sight there)? Otherwise the threat was already on the board.
  function fromLast(p, prev, threat) {
    if (prev === null || prev === undefined || threat === null || threat === undefined) return false;
    if (prev === threat) return true;
    return p.b.rays[threat].some(ray => first(ray, p.codes) === prev);
  }

  // Other moves that the search of a position values within NEAR points of its best move, each with at least
  // NEAR_SHARE of the search's visits: the choice of the better move was not the only one. Not the move played.
  // [{cell, kind}] with the kinds of moveFacts, most visited first, two at most. p: the position; found: its search.
  const NEAR = 1, NEAR_SHARE = .1;
  function nearEqual(b, p, found, move) {
    const x = p.stm;
    const top = found.candidates.find(c => c.move === found.best);
    let total = 0;
    for (const c of found.candidates) total += c.visits;
    const close = found.candidates.filter(c => c.move !== found.best && b.compact[c.move] !== move &&
      c.visits >= NEAR_SHARE * total && c.margin !== null && c.margin !== undefined && top.margin - c.margin <= NEAR);
    const kind = i => p.own[i] === 0 ? "placement" : p.own[i] === x ? "reinforcement" : p.own[i] === 3 - x ? "capture" : "neutral capture";
    return close.sort((c, d) => d.visits - c.visits || c.move - d.move).slice(0, 2)
      .map(c => ({cell: b.name(b.compact[c.move]), kind: kind(b.compact[c.move])}));
  }

  // The share of a search's visits spent on its best move: how clear the choice is.
  function visitShare(found) {
    let total = 0;
    for (const c of found.candidates) total += c.visits;
    const top = found.candidates.find(c => c.move === found.best).visits;
    return total ? pyRound(top / total, 3) : null;
  }

  // The lesson sheets for the chosen plies: each position searched again more deeply, both the move played and
  // the better move searched alike, and the best reply to every legal move for the shared threat.
  // at: Map ply -> [codes, stm, move]; previous: Map ply -> the opponent's last move.
  async function searchedSheets(engine, b, game, at, previous, chosen, visits = 600, threatVisits = 24) {
    // 1. deep search of each chosen position for the best move
    const parents = await engine.search(chosen.map(ply => at.get(ply).slice(0, 2)), visits);
    // 2. both children, searched alike
    const jobs = [], kids = [];
    chosen.forEach((ply, k) => {
      const [codes, stm, move] = at.get(ply);
      const p = new Position(b, codes, stm), best = b.compact[parents[k].best];
      kids.push([ply, p, move, best]);
      for (const m of [move, best]) {
        const c = p.after(m);
        jobs.push([c.codes, c.stm]);
      }
    });
    const children = await engine.search(jobs, visits);
    // 3. shared refutations: the best reply to every legal move, with small searches
    const threatJobs = [], threatIndex = [];
    for (const [ply, p, move] of kids) {
      const legal = (await engine.legal(p.codes, p.stm)).map(g => b.compact[g]);
      if (move !== null && !legal.includes(move)) legal.push(move);
      for (const m of legal) {
        const c = p.after(m);
        threatJobs.push([c.codes, c.stm]);
        threatIndex.push([ply, m]);
      }
    }
    const threatResults = await engine.search(threatJobs, threatVisits, 2);
    const replies = new Map();
    threatIndex.forEach(([ply, m], k) => {
      if (!replies.has(ply)) replies.set(ply, new Map());
      const r = threatResults[k];
      replies.get(ply).set(m, r.terminal ? null : b.compact[r.best]);
    });
    const sheets = [];
    for (let k = 0; k < kids.length; k++) {
      const [ply, p, move, best] = kids[k];
      const cm = children[2 * k], cb = children[2 * k + 1];
      const vMove = -cm.margin, vBest = -cb.margin;
      const afterMove = p.after(move), afterPass = p.after(null);
      const {own} = await engine.evaluate([p.codes, afterMove.codes, afterPass.codes], [p.stm, afterMove.stm, afterPass.stm]);
      const prev = previous.get(ply);
      const open = S.inPlay(own[0]);
      const sheet = {ply, move_number: ply + 1, player: game.players[p.stm], colour: COLOUR[p.stm],
        previous: prev === null || prev === undefined ? null : b.name(prev),
        played: moveFacts(p, move, own[0], prev, move === best),
        best: moveFacts(p, best, own[0], prev, true),
        loss: vBest - vMove, value_played: vMove, value_best: vBest,
        in_play: pyRound(open, 1),
        win_before: S.winChance(vBest, open), win_after: S.winChance(vMove, open), same_move: move === best};
      sheet.alternatives = nearEqual(b, p, parents[k], move);
      let ownM = null, ownB = null;
      if (!cm.terminal && cm.best !== null && cm.best !== undefined) {
        const reply = b.compact[cm.best];
        const pv = cm.candidates.find(c => c.move === cm.best).pv;
        sheet.reply = moveFacts(afterMove, reply, own[1], move, true);
        if (at.has(ply + 1) && at.get(ply + 1)[2] !== null)          // what the game actually played next
          sheet.next_facts = moveFacts(afterMove, at.get(ply + 1)[2], own[1], move);
        sheet.reply_pv = pv.map(g => b.name(b.compact[g]));
        sheet.reply_share = visitShare(cm);
        ownM = await ownershipAlong(engine, b, afterMove.codes, afterMove.stm, pv, p.stm);
      }
      if (!cb.terminal && cb.best !== null && cb.best !== undefined) {
        const pvb = cb.candidates.find(c => c.move === cb.best).pv;
        ownB = await ownershipAlong(engine, b, p.after(best).codes, 3 - p.stm, pvb, p.stm);
        sheet.best_pv = pvb.map(g => b.name(b.compact[g]));
        sheet.best_reply_share = visitShare(cb);
      }
      if (ownM !== null && ownB !== null) {
        const delta = new Float32Array(b.n);                  // expected cells, mover's view
        for (let i = 0; i < b.n; i++) delta[i] = Math.fround(2 * Math.fround(ownB[i] - ownM[i]));
        sheet.regions = regions(b, delta, .25, 1.0, true).slice(0, 4).map(([total, group]) =>
          ({cells: pyRound(total, 1), where: where(b, group), around: group.slice(0, 3).map(i => b.name(i))}));
      }
      const rep = replies.get(ply) || new Map();
      const counted = mostCommon([...rep.values()].filter(r => r !== null));
      const [common, count] = counted.length ? counted[0] : [null, 0];
      const reply = m => rep.has(m) ? rep.get(m) : null;
      sheet.shared_reply = {cell: common === null ? null : b.name(common), share: pyRound(count / Math.max(rep.size, 1), 2),
        legal: rep.size, played_allows: reply(move) === common, best_allows: reply(best) === common};
      if (common !== null) {
        sheet.shared_reply.facts = moveFacts(afterPass, common, own[2], prev, true);
        sheet.shared_reply.from_last = fromLast(p, prev, common);
        sheet.shared_reply.survives_best = threatSurvives(p, best, common);
        sheet.shared_reply.cut_by_best = cutSight(p, best, common);
      }
      const next = at.has(ply + 1) && at.get(ply + 1)[2] !== null ? b.name(at.get(ply + 1)[2]) : null;
      sheet.after_best = afterBest(p, best, move, (sheet.reply || {}).cell, sheet.shared_reply.cell, next);
      // where the points go: the two searches' tree-averaged ownership, compared cell by cell
      if ([cm, cb].every(c => c.ownership && c.ownership.mean && c.ownership.mean.length)) {
        const found = factsFromTree(b, p, sheet, cm, cb);
        if (found) sheet.lines = found;
      }
      sheets.push(sheet);
    }
    return sheets;
  }

  // One whole review, as the Python's review() returns it (without the seconds it took).
  async function review(game, rules, engine, options = {}) {
    const {perSide = 4, praisePerSide = 2, visits = 600, scoreVisits = 160, threatVisits = 24, minimumLoss = 2.0} = options;
    const b = new R.board.Board(game.side);
    if (game.result === null || game.result === undefined) {
      game.result = rules.final.result;
      game.winner = rules.final.winner;
    }
    const positions = rules.positions;
    const at = new Map(positions.map(([ply, codes, stm, move]) => [ply, [codes, stm, move]]));
    const cell = m => m[0] === "PASS" ? null : b.index(`${m[0]}${m[1]}`);
    const previous = new Map([...at.keys()].map(ply => [ply, cell(game.moves[ply - 1])]));
    const rows = await scoreGame(engine, b, positions, scoreVisits);
    const own = await ownerships(engine, positions);            // also for the moments, at the end
    S.annotate(rows, await pointsInPlay(engine, positions, own));
    // mistakes: see chooseMistakes; good moves: see praised
    const moves = game.moves;
    const finished = rules.final.over || (moves.length >= 2 && moves.at(-1)[0] === "PASS" && moves.at(-2)[0] === "PASS");
    const chosen = S.chooseMistakes(rows, perSide, minimumLoss, finished);
    const timeline = [...rows.values()].sort((x, y) => x.ply - y.ply).map(r => ({
      ply: r.ply, move_number: r.ply + 1, stm: r.stm, red_value: pyRound(redView(r), 2), in_play: pyRound(r.in_play, 1),
      red_win: pyRound(S.winChance(redView(r), r.in_play), 3), loss: pyRound(r.loss, 2), win_loss: pyRound(r.win_loss, 3),
      move: r.move === null ? null : b.name(r.move), best: b.name(r.best),
      only: r.second_value !== null && r.best_value - r.second_value >= 3}));
    const kept = {};
    for (const k of ["id", "side", "title", "players", "result", "winner", "moves"]) kept[k] = game[k];
    kept.pie = game.pie === undefined ? true : game.pie;
    const out = {game: kept, visits, score_visits: scoreVisits, threat_visits: threatVisits, timeline, chosen,
      opening: opening(b, game, rows, rules.setup), lessons: [], praise: [], game_lessons: [], level: null};
    // The page shows a review part by part: options.onPart(copy of the review so far, the parts whose text will
    // not change any more). The parts: result, opening, level, entries (which may still gain a move the story
    // names), points, whole, story; the review returned at the end has everything.
    const ready = [];
    const part = (...names) => { ready.push(...names); if (options.onPart) options.onPart(structuredClone(out), [...ready]); };
    part("result", "opening");
    const done = S.settled(rows);
    const praised = [];
    for (const side of [1, 2]) {
      // good moves: the engine's choice, played while the game was still open
      const good = [...rows.values()].filter(r => r.stm === side && r.move !== null && r.move === r.best && r.legal >= 8 && !done.has(r.ply));
      for (const r of good) r.gap = r.second_value !== null ? r.best_value - r.second_value : 0;
      praised.push(...good.map(r => r.ply));
    }
    praised.sort((x, y) => x - y);
    const sheets = await searchedSheets(engine, b, game, at, previous, chosen, visits, threatVisits);
    // praise: moves doing at least three useful things, and moves clearly ahead of the rest (at least 3 points)
    const praise = [];
    for (const side of [1, 2]) {
      let cands = [];
      for (const ply of praised)
        if (rows.get(ply).stm === side) cands.push(await praiseSheet(engine, b, game, rows.get(ply), at.get(ply), previous.get(ply)));
      const purposes = c => c.played.purposes || 0;
      cands = cands.filter(c => c.gap >= 3 || purposes(c) >= 3);
      cands.sort((x, y) => (y.gap + 2 * purposes(y)) - (x.gap + 2 * purposes(x)));
      praise.push(...cands.slice(0, praisePerSide));
    }
    praise.sort((x, y) => x.ply - y.ply);
    // what each praised move leads to: one search of the position after it
    await praisePayoffs(engine, b, new Map([...at.entries()].map(([ply, [codes, stm]]) => [ply, new Position(b, codes, stm)])), praise, visits);
    out.lessons = sheets;
    out.praise = praise;
    out.game_lessons = gameLessons(b, positions, rows, game, 2.0, null, entryBest(b, sheets));
    out.level = game.engines ? null : levelSummary(await massAhead(engine, b, positions));
    part("level", "entries");
    // the turns of the points left open and the turning points of the lead, searched again with `visits`; with
    // those, the points left open are counted again and the story can tell the swings
    out.deep = await searchDeep(engine, b, positions, out, visits);
    // every move "How the game went" names gets an entry
    await addStoryLessons(out, plies => searchedSheets(engine, b, game, at, previous, plies, visits, threatVisits));
    out.game_lessons = gameLessons(b, positions, rows, game, 2.0, deepBest(b, out));
    part("points", "whole");
    out.swings = await swings(engine, b, positions, R.words.course(out), scoreVisits);    // where the lead moved
    part("story");
    out.area_maps = await searchAreas(engine, b, positions, own, out, visits);    // for "inside the opponent's area"
    out.moments = findMoments(b, positions, own, out);          // rare, specific things: momentsText
    return out;
  }

  // Map ply -> the better move of an entry's search: the entries are searched with the review's deeper visits.
  function entryBest(b, lessons) {
    return new Map(lessons.filter(s => s.best.cell).map(s => [s.ply, b.index(s.best.cell)]));
  }

  // The positions the review searches once more with the visits of its entries (deep_plies in review.py): the turns
  // of the big points left open and of the cells that stayed the best move that have no entry, and the positions
  // at which the lead turned before the story begins.
  function deepPlies(r) {
    const have = new Set((r.lessons || []).map(s => s.ply)), plies = new Set();
    for (const g of r.game_lessons || []) {
      if (g.kind === "standing point") for (const m of g.moves) plies.add(m - 1);
      if (g.kind === "wanted") for (const [m] of g.moves) plies.add(m - 1);
    }
    for (const ply of have) plies.delete(ply);
    const c = R.words.course(r);
    for (const ply of (c && c.turns) || []) plies.add(ply);
    return [...plies].sort((x, y) => x - y);
  }

  // The review's deep: for each of deepPlies, the best move of a search of that position (a cell, or "PASS") and
  // Red's margin, to two decimals.
  async function searchDeep(engine, b, positions, r, visits) {
    const at = new Map(positions.map(([ply, codes, stm]) => [ply, [codes, stm]]));
    const plies = deepPlies(r).filter(ply => at.has(ply));
    const found = plies.length ? await engine.search(plies.map(ply => at.get(ply)), visits, 1) : [];
    const out = [];
    plies.forEach((ply, i) => {
      const a = found[i];
      if (a.terminal) return;
      const best = a.best === null || a.best === undefined ? null : a.best < 0 ? "PASS" : b.name(b.compact[a.best]);
      out.push({ply, best, red: pyRound(a.margin * (at.get(ply)[1] === 1 ? 1 : -1), 2) + 0});
    });
    return out;
  }

  // Map ply -> best cell or null of the review's deeper searches: the entries' and those of searchDeep.
  function deepBest(b, r) {
    const out = entryBest(b, r.lessons || []);
    for (const d of r.deep || []) out.set(d.ply, d.best === null || d.best === "PASS" ? null : b.index(d.best));
    return out;
  }

  // Give every move the story names an entry (see add_story_lessons in review.py). search(plies) returns their
  // sheets. A deeper search can change a move's loss or its better move, and with that the story's choice, so this
  // is done again until nothing is missing (three rounds at most). Returns the plies searched.
  async function addStoryLessons(r, search) {
    const added = [];
    for (let round = 0; round < 3; round++) {
      const want = R.words.storyPlies(r);
      if (r.chosen !== null && r.chosen !== undefined) r.chosen = [...new Set(r.chosen.concat(want))].sort((x, y) => x - y);
      const have = new Set(r.lessons.map(s => s.ply));
      const missing = want.filter(ply => !have.has(ply));
      if (!missing.length) return added;
      r.lessons = r.lessons.concat(await search(missing)).sort((x, y) => x.ply - y.ply);
      added.push(...missing);
    }
    return added;
  }

  async function praiseSheet(engine, b, game, row, position, prev) {
    const [codes, stm, move] = position;
    const p = new Position(b, codes, stm);
    const {own} = await engine.evaluate([p.codes], [p.stm]);
    return {ply: row.ply, move_number: row.ply + 1, player: game.players[stm], colour: COLOUR[stm],
      previous: prev === null || prev === undefined ? null : b.name(prev), played: moveFacts(p, move, own[0], prev, true),
      gap: pyRound(row.gap === undefined ? 0 : row.gap, 1)};
  }

  // ---------------------------------------------------------------- the opening offer

  // The pie offer: its value for Red, and the opening book's fair-pie features. setup: [codes, stm] after the
  // two starting stacks.
  function opening(b, game, rows, setup) {
    if (!rows.size) return null;
    const start = Math.min(...rows.keys());
    const [red, white] = game.moves.slice(0, 2).map(m => b.index(`${m[0]}${m[1]}`));
    const p = new Position(b, setup[0], setup[1]);
    const edgeLine = i => {
      const [r, c] = b.rc[i], s1 = b.side - 1;
      return Math.min(r, c, s1 - (c - r), s1 - (r - c), 2 * s1 - r, 2 * s1 - c) + 1;
    };
    const sees = (i, j) => b.rays[i].some(ray => first(ray, p.codes) === j);
    const value = redView(rows.get(start));
    return {red: b.name(red), white: b.name(white), red_value: pyRound(value, 1),
      red_win: pyRound(S.winChance(value, rows.get(start).in_play), 3),
      red_line: edgeLine(red), white_line: edgeLine(white),
      red_sees_neutral: sees(red, b.centre), white_sees_neutral: sees(white, b.centre), red_sees_white: sees(red, white)};
  }

  // ---------------------------------------------------------------- game-level lessons

  // A big point left open: the same cell is a player's best move at three or more of their turns (at most one
  // other turn in between each time), nobody plays it meanwhile, and together the misses cost at least `minimum`
  // points. Players often see a point once and then forget it while the game moves elsewhere.
  function standingPoints(b, seq, game, minimum = 8.0) {
    const out = [];
    for (const side of [1, 2]) {
      const own = seq.filter(r => r.stm === side);
      for (const c of [...new Set(own.map(r => r.point).filter(c => c !== null))].sort((x, y) => x - y)) {
        const hits = [];
        own.forEach((r, k) => { if (r.point === c && r.move !== c) hits.push(k); });
        const runs = [];
        let run = [];
        for (const k of hits) {
          if (run.length && (k - run.at(-1) > 2 ||
              seq.some(x => x.move === c && own[run.at(-1)].ply < x.ply && x.ply < own[k].ply))) {
            runs.push(run);
            run = [];
          }
          run.push(k);
        }
        if (run.length) runs.push(run);
        for (const one of runs) {
          const misses = one.map(k => own[k]);
          const cost = misses.reduce((total, r) => total + r.bad, 0);
          if (misses.length < 3 || cost < minimum || !misses.some(r => r.live)) continue;
          const last = misses.at(-1).ply;
          const taken = seq.find(x => x.ply > last && x.move === c);
          const start = misses[0].p;
          out.push({kind: "standing point", colour: COLOUR[side], player: game.players[side], cell: b.name(c),
            capture: start.own[c] !== 0 && start.own[c] !== side, neutral: start.own[c] === 3,
            moves: misses.map(r => r.ply + 1), turns: one.at(-1) - one[0] + 1, cost: pyRound(cost, 1),
            taken: taken ? [taken.ply + 1, COLOUR[taken.stm]] : null});
        }
      }
    }
    return out.map((g, k) => [g, k]).sort((x, y) => x[0].moves[0] - y[0].moves[0] || x[1] - y[1]).map(x => x[0]);
  }

  // A cell that stayed the best move (wanted_cells in review.py): an empty cell that is the best move at WANTED
  // turns or more, of either player and not in a row, each time with a move elsewhere that cost WANTED_MISS points
  // or more, and nobody plays there in between; only where WANTED_NEW of the turns are in none of that cell's big
  // points left open.
  const WANTED = 6, WANTED_MISS = 1.5, WANTED_NEW = 2;
  function wantedCells(b, seq, game, standing) {
    const out = [], told = new Map();
    for (const g of standing) {
      if (!told.has(g.cell)) told.set(g.cell, new Set());
      for (const m of g.moves) told.get(g.cell).add(m);
    }
    for (const c of [...new Set(seq.map(r => r.point).filter(c => c !== null))].sort((x, y) => x - y)) {
      const hits = seq.filter(r => r.point === c && r.move !== c && r.bad >= WANTED_MISS && r.live && r.p.codes[c] === 0);
      const runs = [];
      let run = [];
      for (const r of hits) {
        if (run.length && seq.some(x => x.move === c && run.at(-1).ply < x.ply && x.ply < r.ply)) {
          runs.push(run);
          run = [];
        }
        run.push(r);
      }
      if (run.length) runs.push(run);
      const said = told.get(b.name(c)) || new Set();
      for (const one of runs) {
        if (one.length < WANTED || one.filter(r => !said.has(r.ply + 1)).length < WANTED_NEW) continue;
        const taken = seq.find(x => x.ply > one.at(-1).ply && x.move === c);
        out.push({kind: "wanted", cell: b.name(c), moves: one.map(r => [r.ply + 1, COLOUR[r.stm]]),
          cost: pyRound(one.reduce((total, r) => total + r.bad, 0), 1),
          taken: taken ? [taken.ply + 1, COLOUR[taken.stm]] : null});
      }
    }
    return out.map((g, k) => [g, k]).sort((x, y) => x[0].moves[0][0] - y[0].moves[0][0] || x[1] - y[1]).map(x => x[0]);
  }

  // Patterns over the whole game: fights left open, missed captures, suicidal moves, ignored threats and costly
  // passes. Uses every scored decision; decided positions (see settled) are left out. deep: Map ply -> the best
  // move of a deeper search (a cell, or null for a pass): with it the big points left open and the cells that
  // stayed the best move count only those turns, by that best move. known: the same for the entries alone, used
  // with the first pass's best move elsewhere (what the review then searches again, deepPlies).
  function gameLessons(b, positions, rows, game, minimum = 2.0, deep = null, known = null) {
    const done = S.settled(rows);
    const seq = [];
    for (const [ply, codes, stm, move] of positions) {
      const r = rows.get(ply);
      if (!r) continue;
      const point = deep === null ? (known && known.has(ply) ? known.get(ply) : r.best) : (deep.has(ply) ? deep.get(ply) : null);
      seq.push({ply, stm, p: new Position(b, codes, stm), move, best: r.best, bad: r.loss, live: !done.has(ply), point});
    }
    const out = standingPoints(b, seq, game);
    out.push(...wantedCells(b, seq, game, out));
    // 1. a fight left open: for several turns in a row, both sides' best moves stay in one small area (each
    //    within three cells of the previous turn's), while the moves played go elsewhere at a cost
    let i = 0;
    while (i < seq.length) {
      let j = i;
      while (j + 1 < seq.length && seq[j + 1].ply === seq[j].ply + 1 && b.distance(seq[j].best, seq[j + 1].best) <= 3) j++;
      const run = seq.slice(i, j + 1);
      const area = [...new Set(run.map(r => r.best))];
      const compact = Math.max(...area.flatMap(u => area.map(v => b.distance(u, v)))) <= 4;
      const away = r => r.move === null || Math.min(...area.map(c => b.distance(r.move, c))) >= 4;
      const missed = run.filter(r => r.bad >= minimum && r.live && away(r));
      if (compact && run.length >= 3 && missed.length >= 3) {
        const last = run.at(-1).p;
        const cells = mostCommon(run.filter(r => !last.codes[r.best]).map(r => r.best)).map(([c]) => b.name(c));
        out.push({kind: "open fight", cells, first_move: run[0].ply + 1, last_move: missed.at(-1).ply + 1,
          missed: missed.map(r => [r.ply + 1, COLOUR[r.stm]])});
      }
      i = j + 1;
    }
    // 2. per player
    const by = {1: new Map(), 2: new Map()};
    seq.forEach((r, k) => {
      if (r.bad < minimum || !r.live) return;
      const {p, move: m, best} = r;
      const kinds = [];
      const soon = seq.slice(k + 1, k + 5).filter(x => x.stm === r.stm).map(x => x.move);
      const mine = c => p.own[c] === 0 || p.own[c] === p.stm;
      if (!mine(best) && (m === null || mine(m)) && !soon.includes(best)) kinds.push("missed capture");
      if (m !== null && p.sight[p.stm][m] < p.sight[3 - p.stm][m]) kinds.push("suicidal move");
      if (m === null) kinds.push("costly pass");
      const prev = k > 0 ? seq[k - 1].move : null;
      if (prev !== null && m !== null && b.distance(best, prev) <= 2 && b.distance(m, prev) >= 5) {
        const locality = moveFacts(p, m, null, prev).locality;
        if (locality !== "local" && locality !== "answer") kinds.push("ignored the last move");
      }
      const what = p.own[best] === 3 ? "the neutral stack" : b.name(best);
      for (const kind of kinds) {
        const named = kind === "suicidal move" && m !== null ? b.name(m) : what;
        if (!by[r.stm].has(kind)) by[r.stm].set(kind, []);
        by[r.stm].get(kind).push([r.ply + 1, named]);
      }
    });
    for (const stm of [1, 2])
      for (const [kind, items] of by[stm])
        if (items.length >= 2 || kind === "costly pass")
          out.push({kind, colour: COLOUR[stm], player: game.players[stm], moves: items});
    return out;
  }

  // ---------------------------------------------------------------- where a mistake loses its points (lines.py)

  const DEPTH = 4;      // replies followed after the first move of each line

  // Play `cells` (compact indices, null for a pass) from Position p. Returns the events and the final position;
  // stops before a move our rules don't allow (a line of sight count that is not higher than the stack there).
  function follow(p, cells) {
    const events = [];
    let q = p;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k];
      if (c === null) {                                    // a pass
        events.push({k, mover: q.stm, cell: null, owner_before: 0, height_before: 0, height: 0});
        q = q.after(null);
        continue;
      }
      if (q.sight[q.stm][c] <= q.h[c]) break;
      events.push({k, mover: q.stm, cell: c, owner_before: q.own[c], height_before: q.h[c], height: q.sight[q.stm][c]});
      q = q.after(c);
    }
    return [events, q];
  }

  // Stacks that end the line in other hands than they started: [lost, won] for player x, as lists of {cell,
  // height, k, neutral}, k being the move of the line that settled it. A stack placed during the line counts for
  // the side that first placed it; the neutral stack can only be won.
  function changedHands(p, events, end, x) {
    const y = OTHER[x], firstAt = new Map(), lastCapture = new Map();
    for (const e of events) {
      if (e.cell === null) continue;
      if (!firstAt.has(e.cell)) firstAt.set(e.cell, e);
      if (e.owner_before !== 0 && e.owner_before !== e.mover) lastCapture.set(e.cell, e);
    }
    const lost = [], won = [];
    for (const [c, e] of lastCapture) {
      const start = p.own[c] || firstAt.get(c).mover;      // who had the cell at the start, or placed there first
      const final = end.own[c];
      const item = {cell: c, height: e.height_before, k: e.k, neutral: start === 3};
      if (e.k === 0) continue;                             // the first move's own capture: the entry already says it
      if (start === x && final === y) lost.push(item);
      else if ((start === y || start === 3) && final === x) won.push(item);
    }
    return [lost, won];
  }

  // The principal line of a searched position, as cell names.
  function principal(b, analysis) {
    if (analysis.terminal || analysis.best === null || analysis.best === undefined) return [];
    return analysis.candidates.find(c => c.move === analysis.best).pv.map(g => b.name(b.compact[g]));
  }

  // Both lines played out to the same number of moves (so the same side is to move at both ends): the stacks
  // that change hands in each, and the two final positions. null when a line is too short to say anything.
  function twoLines(b, p, pc, bc, replyPv, bestPv, depth = DEPTH) {
    const x = p.stm;
    const cells = {};
    for (const [key, start, pv] of [["played", pc, replyPv], ["best", bc, bestPv]])
      cells[key] = [start === null ? null : b.index(start), ...pv.slice(0, depth).map(c => b.index(c))];
    const n = Math.min(...["played", "best"].map(key => follow(p, cells[key])[0].length));
    if (n < 3) return null;
    const out = {depth: n - 1}, ends = [];
    for (const key of ["played", "best"]) {
      const [events, end] = follow(p, cells[key].slice(0, n));
      const [lost, won] = changedHands(p, events, end, x);
      const named = items => items.map(i => ({cell: b.name(i.cell), height: i.height, k: i.k, neutral: i.neutral}));
      out[key] = {first: cells[key][0] === null ? "the pass" : b.name(cells[key][0]),
        line: cells[key].slice(1, n).map(c => b.name(c)), lost: named(lost), won: named(won)};
      ends.push(end);
    }
    return [out, ends];
  }

  // Connected areas where the difference has one sign, largest first. An area can cover a third of the board, so
  // it is placed by its six cells with the largest difference, not by its middle.
  function areas(b, delta, threshold = .15) {
    return regions(b, delta, threshold).map(([total, group]) =>
      ({cells: pyRound(total, 1), where: where(b, group.slice(0, 6)), around: group.slice(0, 3).map(i => b.name(i)), size: group.length}));
  }

  // What each of the two moves does inside an area where the better move ends with more: the cells there on which
  // the mover gains a line of sight (a count), the cells the opponent could place a safe stack on before the move
  // and cannot after it (takes), and the cells the mover can place a safe stack on after it and could not before
  // (opens). The area is one of the areas the text names that holds at least half as much as the largest, the one
  // where the better move does most. delta: the rounded difference per cell, as saved. null when no area stands
  // out; pc is null for a pass.
  function presence(b, p, pc, bc, delta, loss, namedAreas = null) {
    const x = p.stm, y = 3 - p.stm;
    const floor = Math.max(1.5, .25 * loss);
    let named = regions(b, delta, .15).filter(([total]) => total >= floor).slice(0, 2);
    if (!named.length || bc === null || bc === undefined) return null;
    named = named.filter(([total]) => total >= .5 * named[0][0]).map(([, group]) => group);
    const inside = (cell, group) => {
      if (cell === null || cell === undefined) return {sees: 0, takes: [], opens: []};
      const m = b.index(cell), area = new Set(group);
      const a = p.after(m);
      const names = cells => [...cells].sort((i, j) => Math.abs(delta[j]) - Math.abs(delta[i]) || i - j).map(i => b.name(i));
      const theirs = p.canPlace(y, true), theirsAfter = a.canPlace(y, true);
      const mine = p.canPlace(x, true), mineAfter = a.canPlace(x, true);
      // empty cells only: on a stack the same change is a defence, an attack or a reinforcement, which have their
      // own words
      const empty = i => area.has(i) && !p.h[i] && i !== m;
      const takes = [...theirs.keys()].filter(i => !theirsAfter.has(i) && empty(i));
      const opens = [...mineAfter.keys()].filter(i => !mine.has(i) && empty(i));
      return {sees: group.filter(i => a.sight[x][i] > p.sight[x][i]).length, takes: names(takes), opens: names(opens)};
    };
    const found = named.map(group => inside(bc, group));
    let k = 0;
    const key = f => [f.takes.length + f.opens.length, f.sees];
    for (let j = 1; j < found.length; j++) {
      const [c, d] = key(found[j]), [e, g] = key(found[k]);
      if (c > e || (c === e && d > g)) k = j;
    }
    // the area gets the name it has among the entry's areas (those are cut from the unrounded difference)
    const group = new Set(named[k]);
    const same = (namedAreas || []).find(a => a.cells > 0 && group.has(b.index(a.around[0])));
    return {where: same ? same.where : where(b, named[k].slice(0, 6)), best: found[k], played: inside(pc, named[k])};
  }

  // The mover's share of the cell just played, at the end of the game as the search after that move sees it (tree
  // average, -1 the opponent's .. +1 the mover's), for the move played and for the better move. A stack leaves
  // the board only by being captured, so (1 - value) / 2 is the search's chance that the stack is captured before
  // the end: -.5 is three chances in four. null for a pass.
  // What the engine's line after a praised move brings: the line, the stacks the mover wins and loses in it (not
  // the move's own capture), each with the mover's share of its cell at the end as the search sees it, and that
  // share for the stack just played. null for a finished game or a line too short to follow.
  function payoff(b, p, move, after, depth = DEPTH) {
    if (after.terminal || move === null || move === undefined) return null;
    const x = p.stm;
    const cells = [move].concat(principal(b, after).slice(0, depth).map(c => b.index(c)));
    const [events, end] = follow(p, cells);
    if (events.length < 2) return null;
    const [lost, won] = changedHands(p, events, end, x);
    const sign = x === 1 ? 1 : -1;                        // collected ownership is Red's
    const share = c => pyRound(sign * after.ownership.mean[c], 2);
    const name = items => items.map(i => ({cell: b.name(i.cell), height: i.height, k: i.k, neutral: i.neutral, share: share(i.cell)}));
    return {line: cells.slice(1, events.length).map(c => b.name(c)), won: name(won), lost: name(lost), stack: share(move),
      samples: after.ownership.samples};
  }

  // Search the position after every praised move and put the payoff on its sheet. at: Map ply -> Position.
  async function praisePayoffs(engine, b, at, praise, visits) {
    const moves = praise.map(s => b.index(s.played.cell));
    const jobs = praise.map((s, i) => { const q = at.get(s.ply).after(moves[i]); return [q.codes, q.stm]; });
    const found = jobs.length ? await engine.search(jobs, visits) : [];
    praise.forEach((s, i) => { s.payoff = payoff(b, at.get(s.ply), moves[i], found[i]); });
  }

  // Red's share of every cell of a finished position: +1, -1, or 0 for a cell nobody gets.
  function exactOwnership(p) {
    return Array.from({length: p.b.n}, (_, i) => p.own[i] === 1 ? 1 : p.own[i] === 2 ? -1 :
      p.own[i] === 0 && p.sight[1][i] !== p.sight[2][i] ? (p.sight[1][i] > p.sight[2][i] ? 1 : -1) : 0);
  }

  // Where the lead moved (course in review-words.js): for the stretch in which it was built and, when the leader
  // gave part of it back, for the rest of the game, the change of the search's expected ownership between the
  // two positions, seen from the leader's side, cut into areas: [{span: [ply, ply], total, areas}].
  async function swings(engine, b, positions, c, visits = 160) {
    if (!c || c.leader === null || c.leader === undefined) return [];
    const [a, k, e] = c.span;
    const pairs = [[a, k], c.returned.length ? [k, e] : [k, k]].filter(([p, q]) => q > p);
    if (!pairs.length) return [];
    const at = new Map(positions.map(([ply, codes, stm]) => [ply, new Position(b, codes, stm)]));
    const move = new Map(positions.map(([ply, , , m]) => [ply, m]));
    const plies = [...new Set(pairs.flat())].sort((x, y) => x - y);
    for (const p of plies) if (!at.has(p)) at.set(p, at.get(p - 1).after(move.get(p - 1)));    // after the last move of the record
    const found = await engine.search(plies.map(p => [at.get(p).codes, at.get(p).stm]), visits, 1);    // only the maps are read
    const own = new Map(plies.map((p, i) => [p, found[i].terminal ? exactOwnership(at.get(p)) : found[i].ownership.mean]));
    const sign = c.leader === 1 ? 1 : -1;
    return pairs.map(([p, q]) => {
      const delta = own.get(q).map((v, i) => sign * (v - own.get(p)[i]));
      return {span: [p, q], total: pyRound(numpySum(delta), 1), areas: areas(b, delta, .25).slice(0, 3)};
    });
  }

  function survives(b, p, pc, bc, afterPlayed, afterBestMove) {
    const sign = p.stm === 1 ? 1 : -1;                    // collected ownership is Red's
    const at = (found, cell) => cell === null || cell === undefined ? null : pyRound(sign * found.ownership.mean[b.index(cell)], 2);
    return {played: at(afterPlayed, pc), best: at(afterBestMove, bc)};
  }

  // The comparison from two searches with collected ownership: of the position after the move played and of the
  // position after the better move.
  function factsFromTree(b, p, sheet, afterPlayed, afterBestMove) {
    const x = p.stm;
    const pc = sheet.played.cell === undefined ? null : sheet.played.cell, bc = sheet.best.cell;      // pc is null for a pass
    if (afterPlayed.terminal || afterBestMove.terminal) return null;
    const both = twoLines(b, p, pc, bc, principal(b, afterPlayed), principal(b, afterBestMove));
    if (both === null) return null;
    const [out] = both;
    const sign = x === 1 ? 1 : -1;                         // collected ownership is Red's: -1 White ... +1 Red
    const played = afterPlayed.ownership.mean, better = afterBestMove.ownership.mean;
    const delta = Array.from({length: b.n}, (_, i) => sign * (better[i] - played[i]));
    const rounded = delta.map(v => pyRound(v, 2)), loss = afterPlayed.margin - afterBestMove.margin;
    const found = areas(b, delta);
    Object.assign(out, {method: "tree", loss, saved_loss: sheet.loss,
      total: numpySum(delta), areas: found, delta: rounded, presence: presence(b, p, pc, bc, rounded, loss, found),
      survives: survives(b, p, pc, bc, afterPlayed, afterBestMove),
      samples: [afterPlayed.ownership.samples, afterBestMove.ownership.samples]});
    return out;
  }

  // ---------------------------------------------------------------- the level of play (level.py)

  const SOFT_TEMPERATURE = 1.4, SOFT_UNIFORM = .02;      // the search's root-prior softening

  // The softened policy probability on the moves the network ranks above `move`. logits over compact cells;
  // legal: compact indices.
  function massAheadOf(logits, legal, move) {
    const candidates = [...new Set([...legal, move])].sort((x, y) => x - y);
    const at = candidates.indexOf(move);
    let z = candidates.map(c => logits[c] / SOFT_TEMPERATURE);
    const top = Math.max(...z);
    let p = z.map(v => Math.exp(v - top));
    const total = numpySum(p);
    p = p.map(v => (1 - SOFT_UNIFORM) * (v / total) + SOFT_UNIFORM / p.length);
    return numpySum(p.filter(v => v > p[at]));
  }

  // Per side: the softened mass ahead of every move that is not a pass.
  async function massAhead(engine, b, positions) {
    const out = {1: [], 2: []};
    const moves = positions.filter(p => p[3] !== null).map(([, codes, stm, move]) => [codes, stm, move]);
    for (let start = 0; start < moves.length; start += 32) {
      const chunk = moves.slice(start, start + 32);
      const {policy} = await engine.evaluate(chunk.map(c => c[0]), chunk.map(c => c[1]));
      for (let k = 0; k < chunk.length; k++) {
        const [codes, stm, move] = chunk[k];
        const legal = (await engine.legal(codes, stm)).map(g => b.compact[g]);
        out[stm].push(massAheadOf(policy[k], legal, move));
      }
    }
    return out;
  }

  // {'1': {mean, moves}, '2': ...} for the saved review.
  function levelSummary(values) {
    const out = {};
    for (const stm of [1, 2]) {
      const v = values[stm];
      out[String(stm)] = {mean: v.length ? pyRound(numpySum(v) / v.length, 4) : null, moves: v.length};
    }
    return out;
  }

  // ---------------------------------------------------------------- moments (moments.py)
  // Rare, specific things about one game, from the positions, the timeline, the entries and the network's
  // ownership of every position. The constants and every test are those of moments.py; see there for the kinds.
  const MOMENT = {FLIP: 2.0, EDGE: 1, LATER: .5, RUN: [3, 5], EACH: 5, MEAN: 10, TOTAL: 25, AHEAD: 3, BOTH: 6, HUNG: 30, OWNED: .6,
    STEADY: .3, SEARCHED: .5, TURNED: 8, INVADERS: 6, GONE: .75, OPENING: 20, SMALLER: 4, FALLS: 1.2, FAR: 6,
    SEESAW: 6, SWING: 6, BAND: 4, APART: 4, CLOSE: 12, MANY: 14, MANY_EACH: 3, WAITED: 6, SPENT: 1.5, TIMES: 3,
    AWAY: 4, QUIET: 6, FIGHT: 6, ON: 4, SOON: 8, PAPER: 6, WANTED: 3, PAPER_TURNED: 5,
    HALVES: ["top", "bottom", "upper-left", "lower-right", "lower-left", "upper-right"],
    CANCEL: 3, CANCEL_LEFT: 1, MUTUAL: 15, TARGET: 14, OFFER: 20, EARLY: 14, CLEAN: 12, CLEAN_EACH: .5, CLEAN_MARGIN: 5,
    CLEAN_OPEN: 3, NEVER: 5, NEVER_TURNS: 6, NEVER_LOSS: 1.5, LATE: 10, LATE_BEFORE: 4, LATE_TURNS: 3, THRICE: 3, THRICE_PLIES: 10,
    SAFE: 5, SAFE_LOSS: 6, SAFE_OWNED: .9, COLUMN: 16};

  // The review's replay stops where the engine's rules end the game; a record can go on after that. The positions
  // with the rest of the record added by the plain rules, up to a move those do not allow (to_the_end, moments.py).
  function toTheEnd(b, positions, moves) {
    const out = positions.slice();
    const [ply, codes, stm, mv] = positions.at(-1);
    let p = new R.board.Position(b, codes, stm).after(mv);
    for (let q = ply + 1; q < moves.length; q++) {
      const m = moves[q];
      const c = m[0] === "PASS" ? null : b.index(`${m[0]}${m[1]}`);
      if (c !== null && !(p.sight[p.stm][c] > p.h[c])) break;
      out.push([q, p.codes, p.stm, c]);
      p = p.after(c);
    }
    return out;
  }

  // The position after the last move replayed.
  function lastPosition(b, positions) {
    const [, codes, stm, move] = positions.at(-1);
    return new R.board.Position(b, codes, stm).after(move);
  }

  // +1, -1 or 0 per cell, as the count has it: a stack's owner, else whoever has more lines of sight.
  function finalOwner(p) {
    const out = new Array(p.b.n).fill(0);
    for (let i = 0; i < p.b.n; i++) {
      if (p.own[i] === 1 || p.own[i] === 2) out[i] = p.own[i] === 1 ? 1 : -1;
      else if (p.own[i] === 0) out[i] = Math.sign(p.sight[1][i] - p.sight[2][i]);
    }
    return out;
  }

  // lexicographic comparison of two arrays of numbers
  function tupleLess(x, y) {
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i];
    return false;
  }

  // New stacks, after the opening, on cells that the network's map gave to the opponent in the position they were
  // placed in and in the one before: [ply, cell, mover, never captured, the map from the mover's side].
  function stacksInside(b, P, plies, searched, move, own, last) {
    const K = MOMENT, out = [];
    plies.slice(0, searched).forEach((ply, k) => {
      const p = P.get(ply), c = move.get(ply);
      if (c === null || p.own[c] !== 0 || ply < K.OPENING) return;
      const mine = Array.from(own[k], v => 2 * v - 1);
      if (mine[c] > -K.OWNED) return;
      // one evaluation can be wrong about a cell for a single position; the position before has to agree
      const before = k ? (2 * own[k - 1][c] - 1) * (P.get(plies[k - 1]).stm === p.stm ? 1 : -1) : mine[c];
      if (before > -K.STEADY) return;
      const kept = last.own[c] === p.stm && plies.every(q => q <= ply || P.get(q).own[c] === p.stm);
      out.push([ply, c, p.stm, kept, mine]);
    });
    return out;
  }

  // For a stack in the middle of the opponent's area on every one of the maps ([map from the mover's side, the
  // share that makes a cell the opponent's]): the cells within two steps that were the opponent's on all of them
  // and the mover's at the end. 0 when it was not in the middle: four neighbours the opponent's, and the
  // neighbours on average.
  function turnedAround(b, c, stm, final, maps) {
    const near = b.neighbours[c];
    for (const [mine, level] of maps) {
      let around = 0;
      for (const j of near) around += mine[j];
      if (near.filter(j => mine[j] <= -level).length < Math.min(4, near.length) || around / near.length > -level) return 0;
    }
    let turned = 0;
    for (let j = 0; j < b.n; j++)
      if (b.distance(c, j) <= 2 && final[j] * (stm === 1 ? 1 : -1) > 0 && maps.every(([mine, level]) => mine[j] <= -level)) turned++;
    return turned;
  }

  // The plies whose positions lived and invaders need a searched map of: stacks the network's map puts inside the
  // opponent's area, where a sentence could come of them (area_plies in moments.py).
  function areaPlies(b, positions, own, r) {
    const K = MOMENT;
    if (own === null || own === undefined || !positions.length) return [];
    const searched = positions.length;
    positions = toTheEnd(b, positions, r.game.moves);
    const P = new Map(positions.map(([ply, codes, stm]) => [ply, new R.board.Position(b, codes, stm)]));
    const move = new Map(positions.map(([ply, , , mv]) => [ply, mv === undefined ? null : mv]));
    const last = lastPosition(b, positions), final = finalOwner(last);
    const stacks = stacksInside(b, P, positions.map(p => p[0]), searched, move, own, last);
    const need = new Set(stacks.filter(([, c, stm, kept, mine]) => kept && turnedAround(b, c, stm, final, [[mine, K.OWNED]]) >= K.TURNED).map(s => s[0]));
    for (const side of [1, 2]) {
      const kept = stacks.filter(s => s[2] === side).map(s => s[3]);
      // a search can only take stacks out of the count: six placed and five captured is the least that can fire
      if (kept.length >= K.INVADERS && kept.filter(x => !x).length >= K.GONE * K.INVADERS)
        for (const s of stacks) if (s[2] === side) need.add(s[0]);
    }
    return [...need].sort((x, y) => x - y);
  }

  // The review's area_maps: for each of areaPlies, from a search of that position, the share of the player to move
  // (-1 the opponent's .. +1 the mover's, to two decimals) of the cells within two steps of the new stack, by name:
  // all that lived and invaders read.
  async function searchAreas(engine, b, positions, own, r, visits) {
    const at = new Map(positions.map(([ply, codes, stm, move]) => [ply, [codes, stm, move]]));
    const plies = areaPlies(b, positions, own, r);
    const found = plies.length ? await engine.search(plies.map(ply => at.get(ply).slice(0, 2)), visits, 1) : [];
    return plies.map((ply, i) => {
      const [, stm, c] = at.get(ply), shares = {};
      for (let j = 0; j < b.n; j++)
        if (b.distance(c, j) <= 2) shares[b.name(j)] = pyRound(found[i].ownership.mean[j] * (stm === 1 ? 1 : -1), 2) + 0;
      return {ply, own: shares};
    });
  }

  function findMoments(b, positions, own, r) {
    const W = R.words, K = MOMENT;
    if (!positions.length || !(r.timeline && r.timeline.length)) return [];
    const moves = r.game.moves;
    const searched = positions.length;           // own has this many maps; the timeline ends here too
    positions = toTheEnd(b, positions, moves);
    const P = new Map(positions.map(([ply, codes, stm]) => [ply, new R.board.Position(b, codes, stm)]));
    const move = new Map(positions.map(([ply, , , mv]) => [ply, mv === undefined ? null : mv]));
    const plies = positions.map(p => p[0]);
    const last = lastPosition(b, positions);
    const T = new Map(W.decisions(r).map(t => [t.ply, t]));
    const lead = new Map(plies.filter(ply => T.has(ply)).map(ply => [ply, T.get(ply).red_value]));
    const end = W.finalMargin(r);
    const after = ply => lead.has(ply + 1) ? lead.get(ply + 1) : end;
    const sign = stm => stm === 1 ? 1 : -1;
    const name = ply => move.get(ply) === null ? null : b.name(move.get(ply));
    const out = [];

    // across: the longest run
    const runs = [];
    let run = [];
    for (const ply of plies.concat([null])) {
      const ok = ply !== null && T.has(ply) && T.get(ply).loss >= K.FLIP && lead.get(ply) * after(ply) < 0
        && Math.min(Math.abs(lead.get(ply)), Math.abs(after(ply))) >= K.EDGE;
      if (ok && (!run.length || run.at(-1) === ply - 1)) { run.push(ply); continue; }
      if (run.length >= 4) runs.push(run);
      run = ok ? [ply] : [];
    }
    if (runs.length) {
      run = runs[0];
      for (const x of runs) if (tupleLess([run.length, -run[0]], [x.length, -x[0]])) run = x;
      const z = after(run.at(-1));
      const later = [...lead.keys()].some(q => q > run.at(-1) && lead.get(q) * z < 0 && Math.abs(lead.get(q)) >= K.LATER) || end * z < 0;
      out.push({kind: "across", move: run[0] + 1, to: run.at(-1) + 1, moves: run.map(name), numbers: run.map(q => q + 1),
        back: run.length % 2 === 0 && Math.abs(z - lead.get(run[0])) <= 1.5, last: later ? null : COLOUR[P.get(run.at(-1)).stm]});
    }

    // collapse: the costliest run
    let found = null;
    for (const stm of [1, 2]) {
      run = [];
      for (const q of plies.filter(q => T.has(q) && P.get(q).stm === stm).concat([null])) {
        if (q !== null && T.get(q).loss >= K.EACH) { run.push(q); continue; }
        if (K.RUN[0] <= run.length && run.length <= K.RUN[1]) {
          let total = 0;
          for (const x of run) total += T.get(x).loss;
          const a = sign(stm) * lead.get(run[0]), z = sign(stm) * after(run.at(-1));
          if (total >= K.TOTAL && total / run.length >= K.MEAN && a >= K.AHEAD && z <= -K.AHEAD && (found === null || total > found.total))
            found = {kind: "collapse", move: run[0] + 1, to: run.at(-1) + 1, colour: COLOUR[stm], moves: run.map(name),
              numbers: run.map(x => x + 1), total: pyRound(total, 1), ahead: pyRound(a, 1), behind: pyRound(-z, 1)};
        }
        run = [];
      }
    }
    if (found) out.push(found);

    // both: the first two turns of each such stretch, when one of the two takes the cell soon after
    for (const q of plies) {
      const x = T.get(q), y = T.get(q + 1);
      if (!x || !y || !x.best || x.best !== y.best || x.move === x.best || y.move === y.best) continue;
      if (Math.min(x.loss, y.loss) < K.BOTH) continue;
      const cell = x.best;
      const before = T.get(q - 1);
      if (before && before.best === cell && before.move !== cell && before.loss >= K.BOTH) continue;
      let taker = null;
      for (let j = q + 2; j < q + 8 && taker === null; j++) if (T.has(j) && T.get(j).move === cell) taker = j;
      if (taker === null) continue;
      out.push({kind: "both", move: q + 1, cell, first: {colour: COLOUR[P.get(q).stm], played: name(q)},
        second: {colour: COLOUR[P.get(q + 1).stm], played: name(q + 1)}, taker: {colour: COLOUR[P.get(taker).stm], move: taker + 1}});
    }

    // hung: the longest wait that ended in a capture
    let waits = [];
    const since = new Map();
    for (const ply of plies.concat([plies.at(-1) + 1])) {
      const p = P.has(ply) ? P.get(ply) : last;
      const caps = {1: p.capturable(1), 2: p.capturable(2)};
      for (const c of [...since.keys()].filter(c => !caps[since.get(c)[1]].has(c))) {
        const [s0, by] = since.get(c);
        since.delete(c);
        if (P.has(ply - 1) && move.get(ply - 1) === c && P.get(ply - 1).stm === by) {
          const turns = [];
          for (let q = s0; q < ply; q++) if (P.get(q).stm === by) turns.push(q);
          waits.push([turns.length, -s0, c, by, turns[0], ply - 1]);
        }
      }
      for (const by of [1, 2])
        for (const [c, [o]] of caps[by]) if (o !== 3 && !since.has(c)) since.set(c, [ply, by]);
    }
    waits = waits.filter(w => w[0] >= K.HUNG);
    if (waits.length) {
      let w = waits[0];
      for (const x of waits) if (tupleLess(w, x)) w = x;
      const [turns, , c, by, first, taken] = w;
      const p = P.get(taken);
      out.push({kind: "hung", move: taken + 1, cell: b.name(c), colour: COLOUR[3 - by], by: COLOUR[by], height: p.h[c],
        turns, since: first + 1, six: p.sight[by][c] === 6});
    }

    // six: the first of them
    const six = plies.filter(ply => move.get(ply) !== null && P.get(ply).sight[P.get(ply).stm][move.get(ply)] === 6);
    if (six.length) {
      const p = P.get(six[0]), c = move.get(six[0]);
      const how = p.own[c] === 0 ? "move" : p.own[c] === p.stm ? "reinforcement" : "capture";
      out.push({kind: "six", move: six[0] + 1, cell: b.name(c), colour: COLOUR[p.stm], how, count: six.length});
    }

    // passed: captures left that the opponent could not take back at once, where the engine's count agrees
    const score = W.recordedScore(r);
    if (W.playedOut(r) && score && moves.at(-1)[0] === "PASS" && plies.at(-1) === moves.length - 1) {
      const gap = W.engineMargin(r) - (score[0] - score[1]);
      const left = {};
      for (const by of [1, 2]) {
        const real = [];
        for (const [c, [o, h, n]] of last.capturable(by)) if (o !== 3 && last.sight[3 - by][c] <= n) real.push([b.name(c), h]);
        if (real.length && sign(by) * gap >= 1.5) left[COLOUR[by]] = real;
      }
      if (Object.keys(left).length) out.push({kind: "passed", move: moves.length, left});
    }

    // smaller: an entry whose move captured the taller stack
    for (const s of r.lessons || []) {
      const pl = s.played, be = s.best;
      if (pl.kind !== "capture" || be.kind !== "capture" || s.loss < K.SMALLER || !P.has(s.ply)) continue;
      if (pl.before.owner === 3 || be.before.owner === 3 || be.before.height >= pl.before.height) continue;
      const delta = s.lines ? s.lines.delta : null;
      if (!delta || !delta.length) continue;
      const p = P.get(s.ply);
      const fall = [];
      for (let c = 0; c < b.n; c++)
        if (p.own[c] === 3 - p.stm && delta[c] >= K.FALLS && b.name(c) !== pl.cell && b.name(c) !== be.cell) fall.push(b.name(c));
      if (fall.length)
        out.push({kind: "smaller", move: s.move_number, colour: COLOUR[p.stm], played: {cell: pl.cell, height: pl.before.height},
          best: {cell: be.cell, height: be.before.height}, fall: fall.slice(0, 3)});
    }

    // lived and invaders: new stacks on cells that were the opponent's on the network's map and on the map of a
    // search of the same position (r.area_maps)
    if (own !== null && own !== undefined && r.area_maps !== null && r.area_maps !== undefined) {
      const final = finalOwner(last);
      const deep = new Map(r.area_maps.map(a => {         // only the cells around the stack are read
        const shares = new Array(b.n).fill(0);
        for (const [cell, share] of Object.entries(a.own)) shares[b.index(cell)] = share;
        return [a.ply, shares];
      }));
      const lived = [], inside = {1: [], 2: []};
      for (const [ply, c, stm, kept, mine] of stacksInside(b, P, plies, searched, move, own, last)) {
        if (!deep.has(ply) || deep.get(ply)[c] > -K.SEARCHED) continue;
        inside[stm].push(kept);
        const turned = kept ? turnedAround(b, c, stm, final, [[mine, K.OWNED], [deep.get(ply), K.SEARCHED]]) : 0;
        if (turned >= K.TURNED) lived.push([turned, -ply, c, stm]);
      }
      if (lived.length) {
        let w = lived[0];
        for (const x of lived) if (tupleLess(w, x)) w = x;
        out.push({kind: "lived", move: -w[1] + 1, cell: b.name(w[2]), colour: COLOUR[w[3]], cells: w[0]});
      }
      for (const stm of [1, 2]) {
        const kept = inside[stm], gone = kept.filter(x => !x).length;
        if (kept.length >= K.INVADERS && gone >= K.GONE * kept.length)
          out.push({kind: "invaders", move: 0, colour: COLOUR[stm], placed: kept.length, captured: gone});
      }
    }

    // far: the longest reach
    let reach = null;
    for (const ply of plies) {
      const p = P.get(ply), c = move.get(ply);
      if (c === null) continue;
      const me = p.stm, a = p.after(c);
      const was = p.capturable(me);
      for (const t of a.capturable(me).keys()) {
        if (was.has(t) || a.own[t] !== 3 - me || b.distance(c, t) < K.FAR) continue;
        const d = b.rays[c].findIndex(ray => ray.includes(t));
        if (d < 0 || b.rays[c][d].slice(0, b.rays[c][d].indexOf(t)).some(j => p.codes[j])) continue;
        const taken = [ply + 2, ply + 4].find(q => P.has(q) && move.get(q) === t && P.get(q).own[t] === 3 - me);
        if (taken === undefined) continue;
        const [r0, c0] = b.rc[c], [r1, c1] = b.rc[t];
        const [low, high] = r0 < r1 ? [c, t] : [t, c];
        const way = r0 === r1 ? `row ${r0 + 1}` : c0 === c1 ? `${String.fromCharCode(65 + c0)} line` : `${b.name(low)}–${b.name(high)} diagonal`;
        const key = [b.distance(c, t), -ply];
        if (reach === null || tupleLess(reach[0], key))
          reach = [key, {kind: "far", move: ply + 1, cell: b.name(c), colour: COLOUR[me], target: b.name(t),
            distance: b.distance(c, t), way, later: taken - ply}];
      }
    }
    if (reach) out.push(reach[1]);

    // seesaw: the longest run in which every move costs SWING and the lead stays with one side, in two bands
    {
      const bands = (run, ldr, s) => [run.filter(x => P.get(x).stm === ldr).map(x => s * after(x)),
        run.filter(x => P.get(x).stm !== ldr).map(x => s * after(x))];
      let found = null;
      for (const start of plies) {
        if (!T.has(start) || lead.get(start) === 0) continue;
        const s = lead.get(start) > 0 ? 1 : -1;
        const run = [];
        for (let q = start; T.has(q) && T.get(q).loss >= K.SWING && s * lead.get(q) > 0 && s * after(q) > 0; q++) run.push(q);
        if (run.length < K.SEESAW || (found && run.length <= found.length)) continue;
        const [low, high] = bands(run, s > 0 ? 1 : 2, s);                 // low: after the leader's own moves
        if (Math.max(...low) - Math.min(...low) <= K.BAND && Math.max(...high) - Math.min(...high) <= K.BAND
            && Math.min(...high) - Math.max(...low) >= K.APART && Math.min(...low) <= K.CLOSE) found = run;
      }
      if (found) {
        const run = found, ldr = lead.get(run[0]) > 0 ? 1 : 2;
        const [low, high] = bands(run, ldr, sign(ldr));
        const best = {};
        for (const stm of [1, 2]) {
          const cells = new Set(run.filter(x => P.get(x).stm === stm).map(x => T.get(x).best));
          best[COLOUR[stm]] = cells.size === 1 ? [...cells][0] : null;
        }
        out.push({kind: "seesaw", move: run[0] + 1, to: run.at(-1) + 1, leader: COLOUR[ldr],
          low: [pyRound(Math.min(...low), 1), pyRound(Math.max(...low), 1)],
          high: [pyRound(Math.min(...high), 1), pyRound(Math.max(...high), 1)], best});
      }
    }

    // many: the position with the most stacks open to capture, both colours among them
    {
      let most = null;
      for (const q of plies.slice(0, searched)) {
        const p = P.get(q);
        let red = 0, white = 0;
        for (const [o] of p.capturable(2).values()) if (o === 1) red++;
        for (const [o] of p.capturable(1).values()) if (o === 2) white++;
        if (Math.min(red, white) >= K.MANY_EACH && (most === null || red + white > most[0])) most = [red + white, q, red, white];
      }
      if (most && most[0] >= Math.max(10, Math.floor(b.n / K.MANY)))
        out.push({kind: "many", move: most[1] + 1, count: most[0], red: most[2], white: most[3]});
    }

    // waited: captures of stacks that had been open for WAITED of the capturer's turns, while the engine wanted
    // another move; the network's map gives the cell to the capturer, so the stack was not about to get away
    if (own !== null && own !== undefined) {
      const turns = new Map(), hits = {1: [], 2: []};
      const key = (c, by) => c * 4 + by;
      plies.slice(0, searched).forEach((q, k) => {
        const p = P.get(q), me = p.stm, cap = p.capturable(me);
        for (const x of [...turns.keys()]) if (x % 4 === me && !cap.has((x - me) / 4)) turns.delete(x);
        for (const [c0, [o]] of cap) if (o === 3 - me) turns.set(key(c0, me), (turns.get(key(c0, me)) || 0) + 1);
        const c = move.get(q), t = T.get(q);
        if (c === null) return;
        if (t && p.own[c] === 3 - me && (turns.get(key(c, me)) || 0) >= K.WAITED && t.loss >= K.SPENT && t.best !== b.name(c)
            && 2 * own[k][c] - 1 >= K.OWNED) hits[me].push([q, c, t.loss]);
        turns.delete(key(c, 1));
        turns.delete(key(c, 2));
      });
      for (const me of [1, 2]) {
        const h = hits[me];
        if (h.length < K.TIMES) continue;
        let total = 0;
        for (const x of h) total += x[2];
        out.push({kind: "waited", move: h[0][0] + 1, colour: COLOUR[me], captures: h.map(([q, c]) => [b.name(c), q + 1]),
          total: pyRound(total, 1)});
      }
    }

    // side: the longest stretch played in one half of the board while the engine wanted moves in the other half
    {
      const s1 = b.side - 1, width = 2 * b.side + 4, margin = Math.floor(b.side / 4);
      const axes = c => [b.rc[c][0] - s1, b.rc[c][1] - s1, b.rc[c][1] - b.rc[c][0]];
      let found = null;
      for (let axis = 0; axis < 3; axis++) for (const sg of [-1, 1]) {
        // runs of consecutive plies with a move played and a timeline row
        let here = [], there = [], block = [];
        for (const q of plies.slice(0, searched).concat([null])) {
          if (q !== null && T.has(q) && move.get(q) !== null) {
            block.push(q);
            here.push(sg * axes(move.get(q))[axis] >= margin);
            there.push(sg * axes(b.index(T.get(q).best))[axis] <= -margin && T.get(q).loss >= 1);
            continue;
          }
          for (let i = 0; i < block.length; i++) {
            if (!here[i]) continue;
            let nh = 0, nt = 0;
            for (let j = i; j < block.length; j++) {
              nh += here[j] ? 1 : 0;
              nt += there[j] ? 1 : 0;
              const n = j - i + 1;
              if (n >= width && here[j] && 10 * nh >= 9 * n && 4 * nt >= 3 * n && (found === null || tupleLess(found[0], [n, nt])))
                found = [[n, nt], block[i], block[j], nh, 2 * axis + (sg < 0 ? 0 : 1)];
            }
          }
          here = []; there = []; block = [];
        }
      }
      if (found) {
        const [[n, nt], first, finalPly, nh, half] = found;
        out.push({kind: "side", move: first + 1, to: finalPly + 1, moves: n, played: nh, half: K.HALVES[half], other: K.HALVES[half ^ 1],
          wanted: nt});
      }
    }

    // outpost: a new stack that saw its own colour only from AWAY cells or more; later, a fight on those lines
    {
      let found = null;
      for (const q of plies) {
        const p = P.get(q), c = move.get(q);
        if (c === null || p.own[c] !== 0) continue;
        const me = p.stm, seen = [], line = new Map();
        for (const ray of b.rays[c]) {
          for (let d = 0; d < ray.length; d++) {
            const j = ray[d];
            if (p.own[j] === 0) continue;
            if (p.own[j] === me) {
              seen.push([d + 1, j]);
              for (const x of ray.slice(0, d)) line.set(x, j);
            }
            break;
          }
        }
        if (!seen.length || Math.min(...seen.map(x => x[0])) < K.AWAY) continue;
        const stands = last.own[c] === me && plies.every(x => x <= q || P.get(x).own[c] === me);
        for (const a of plies) {
          if (a <= q + K.QUIET) continue;
          if (P.get(a).own[c] !== me) break;
          const on = [];
          for (let x = a; x < a + K.FIGHT; x++) {
            if (!P.has(x)) continue;
            const mv = move.get(x), px = P.get(x);
            if (mv !== null && line.has(mv) && px.own[mv] === 0 && px.own[line.get(mv)] === me && px.own[c] === me) on.push(x);
          }
          if (on.length < K.ON || on[0] !== a
              || Math.min(on.filter(x => P.get(x).stm === 1).length, on.filter(x => P.get(x).stm === 2).length) < 2) continue;
          let taken = null;
          for (let x = on.at(-1) + 1; x < on.at(-1) + 1 + K.SOON && taken === null; x++)
            if (P.has(x) && move.get(x) === c && P.get(x).stm !== me && P.get(x).own[c] === me) taken = x;
          if ((taken !== null || stands) && (found === null || tupleLess(found[0], [on.length, -q])))
            found = [[on.length, -q], {kind: "outpost", move: q + 1, cell: b.name(c), colour: COLOUR[me],
              seen: seen.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1]).map(([d, j]) => [b.name(j), d]), moves: on.map(name),
              taken: taken === null ? null : taken + 1, from: on[0] + 1, to: on.at(-1) + 1}];
          break;
        }
      }
      if (found) out.push(found[1]);
    }

    // paper: a lead that counted a stack as captured (the network's map gives its cell to the leader, in this
    // position and the one before), the capture was the best move at WANTED turns, and the stack was never captured
    if (own !== null && own !== undefined) {
      const final = finalOwner(last);
      let found = null;
      plies.slice(0, searched).forEach((q, k) => {
        const p = P.get(q), me = p.stm, s = sign(me);
        if (!lead.has(q) || s * lead.get(q) < K.PAPER || s * end > 0) return;
        const mine = j => 2 * own[k][j] - 1;
        for (const [c, [o, h]] of p.capturable(me)) {
          if (o !== 3 - me || mine(c) < K.OWNED) continue;
          if (k && (2 * own[k - 1][c] - 1) * (P.get(plies[k - 1]).stm === me ? 1 : -1) < K.STEADY) continue;
          if (last.own[c] !== o || plies.some(x => x > q && P.get(x).own[c] !== o)) continue;
          let wanted = 0, turned = 0;
          for (const x of plies) if (x >= q && P.get(x).stm === me && T.has(x) && T.get(x).best === b.name(c)) wanted++;
          for (let j = 0; j < b.n; j++) if (j !== c && b.distance(c, j) <= 2 && mine(j) >= K.OWNED && final[j] * s < 0) turned++;
          const rank = [s * lead.get(q), turned, -q, -c];
          if (wanted >= K.WANTED && turned >= K.PAPER_TURNED && (found === null || tupleLess(found[0], rank)))
            found = [rank, {kind: "paper", move: q + 1, colour: COLOUR[me], lead: pyRound(s * lead.get(q), 1), cell: b.name(c),
              height: h, wanted, cells: turned}];
        }
      });
      if (found) out.push(found[1]);
    }

    // the stacks `by` could capture in the position before ply q (after the last move for q past the end)
    const memo = new Map();
    const opens = (q, by) => {
      const key = q * 4 + by;
      if (!memo.has(key)) memo.set(key, (P.has(q) ? P.get(q) : last).capturable(by));
      return memo.get(key);
    };

    // cancel: the capture that takes the most captures away from the opponent
    {
      let found = null;
      for (const q of plies) {
        const p = P.get(q), c = move.get(q);
        if (c === null || p.own[c] !== 3 - p.stm) continue;
        const opp = 3 - p.stm, before = opens(q, opp), left = opens(q + 1, opp);
        const gone = [...before.keys()].filter(t => !left.has(t) && t !== c);
        if (gone.length >= K.CANCEL && left.size <= K.CANCEL_LEFT && (found === null || gone.length > found[0])) {
          const neutral = gone.find(t => p.own[t] === 3);
          found = [gone.length, {kind: "cancel", move: q + 1, cell: b.name(c), colour: COLOUR[p.stm], lost: gone.map(t => b.name(t)),
            neutral: neutral === undefined ? null : b.name(neutral), left: left.size}];
        }
      }
      if (found) out.push(found[1]);
    }

    // mutual: X of the mover and Y of the opponent are both open, capturing either closes the other, the engine
    // wants Y, the mover plays elsewhere at a cost of MUTUAL and the opponent takes X
    {
      let found = null;
      for (const q of plies) {
        const p = P.get(q), t = T.get(q);
        if (!t || move.get(q) === null || t.loss < K.MUTUAL || !move.has(q + 1) || (found && t.loss <= found[0])) continue;
        const me = p.stm, opp = 3 - me, y = b.index(t.best), x = move.get(q + 1);
        if (x === null || y === move.get(q) || x === move.get(q) || p.own[y] !== opp || p.own[x] !== me || !opens(q, me).has(y)
            || !opens(q, opp).has(x)) continue;
        if (p.after(y).capturable(opp).has(x) || new Position(b, p.codes, opp).after(x).capturable(me).has(y)) continue;
        found = [t.loss, {kind: "mutual", move: q + 1, colour: COLOUR[me], mine: b.name(y), theirs: b.name(x), played: name(q)}];
      }
      if (found) out.push(found[1]);
    }

    // target: move A makes the opponent's T open; T stays open and uncaptured at TARGET of the mover's turns; then
    // the opponent captures A, and could not have without T
    {
      let found = null;
      for (const q of plies) {
        const p = P.get(q), a = move.get(q);
        if (a === null) continue;
        const me = p.stm, opp = 3 - me, was = opens(q, me), now = opens(q + 1, me);
        for (const [t, [o, h]] of now) {
          if (was.has(t) || o !== opp) continue;
          let turns = 0, taken = null;
          for (const x of plies) {
            if (x <= q) continue;
            const px = P.get(x);
            if (px.own[a] !== me || px.own[t] !== opp) break;
            if (px.stm === me) {
              if (!opens(x, me).has(t) || move.get(x) === t) break;
              turns++;
            } else if (move.get(x) === a) {
              taken = x;
              break;
            }
          }
          if (taken === null || turns < K.TARGET || (found && !tupleLess(found[0], [turns, -q]))) continue;
          const pz = P.get(taken);
          const sees = b.rays[a].some(ray => ray.find(j => pz.own[j] !== 0) === t);
          if (sees && pz.sight[opp][a] - 1 <= pz.h[a])
            found = [[turns, -q], {kind: "target", move: q + 1, cell: b.name(a), colour: COLOUR[me], target: b.name(t), height: h,
              turns, taken: taken + 1}];
        }
      }
      if (found) out.push(found[1]);
    }

    // opening: both stacks of the offer captured by move OFFER
    {
      const offer = [0, 1].map(i => b.index(`${moves[i][0]}${moves[i][1]}`));
      const took = [0, 1].map(i => {
        const q = plies.find(q => move.get(q) === offer[i] && P.get(q).own[offer[i]] === i + 1 && P.get(q).stm === 2 - i);
        return q === undefined ? null : q;
      });
      if (took[0] !== null && took[1] !== null && Math.max(...took) < K.OFFER) {
        const [first, second] = [[took[1], "Red", b.name(offer[1])], [took[0], "White", b.name(offer[0])]].sort((x, y) => x[0] - y[0]);
        out.push({kind: "opening", move: second[0] + 1, first: [first[1], first[2], first[0] + 1],
          second: [second[1], second[2], second[0] + 1]});
      }
    }

    // early: three stacks of one player captured before ply EARLY (the earlier of the two players)
    {
      let found = null;
      for (const me of [1, 2]) {
        const lost = plies.filter(q => q < K.EARLY && move.get(q) !== null && P.get(q).own[move.get(q)] === me && P.get(q).stm !== me);
        if (lost.length < 3 || new Set(lost.slice(0, 3).map(q => move.get(q))).size < 3 || (found && lost[2] >= found[0])) continue;
        const placed = 1 + plies.filter(q => q <= lost[2] && P.get(q).stm === me && move.get(q) !== null
          && P.get(q).own[move.get(q)] === 0).length;
        found = [lost[2], {kind: "early", move: lost[2] + 1, colour: COLOUR[me], by: COLOUR[3 - me],
          cells: lost.slice(0, 3).map(q => b.name(move.get(q))), placed}];
      }
      if (found) out.push(found[1]);
    }

    // clean: the last moves of a close game, none of them costing CLEAN_EACH
    {
      const qs = plies.slice(0, searched).filter(q => T.has(q));
      while (qs.length && move.get(qs.at(-1)) === null) qs.pop();
      let n = 0;
      while (n < qs.length && T.get(qs[qs.length - 1 - n]).loss < K.CLEAN_EACH) n++;
      if (n >= K.CLEAN && Math.abs(end) <= K.CLEAN_MARGIN && W.playedOut(r) && T.get(qs[qs.length - n]).in_play >= K.CLEAN_OPEN)
        out.push({kind: "clean", move: qs[qs.length - n] + 1, moves: n});
    }

    // never: a stack standing at the end, not open to capture then, that was open at NEVER_TURNS of the opponent's
    // turns, the capture the engine's best move at NEVER of them
    {
      let found = null;
      const past = plies.at(-1) + 1;
      for (let c = 0; c < b.n; c++) {
        const me = last.own[c];
        if ((me !== 1 && me !== 2) || opens(past, 3 - me).has(c)) continue;
        let start = null;
        for (const q of plies) {
          if (P.get(q).own[c] !== me) start = null;
          else if (start === null) start = q;
        }
        if (start === null) continue;
        const turns = plies.filter(q => q >= start && P.get(q).stm !== me && opens(q, 3 - me).has(c));
        const wanted = turns.filter(q => T.has(q) && T.get(q).best === b.name(c) && T.get(q).loss >= K.NEVER_LOSS);
        if (turns.length >= K.NEVER_TURNS && wanted.length >= K.NEVER && (found === null || tupleLess(found[0], [wanted.length, turns.length])))
          found = [[wanted.length, turns.length], {kind: "never", move: wanted[0] + 1, cell: b.name(c), colour: COLOUR[me], by: COLOUR[3 - me],
            since: start === plies[0] ? null : start, turns: turns.length, wanted: wanted.length}];
      }
      if (found) out.push(found[1]);
    }

    // late: the costliest move on a cell that was the same player's best move at one of the LATE_TURNS turns before
    {
      let found = null;
      for (const q of plies.slice(0, searched)) {
        const c = move.get(q), t = T.get(q);
        if (c === null || !t || t.loss < K.LATE || (found && t.loss <= found[0])) continue;
        for (let e = q - 2; e > q - 2 * K.LATE_TURNS - 1; e -= 2) {
          const x = T.get(e);
          if (!(x && P.has(e) && x.best === b.name(c) && move.get(e) !== c && x.loss >= K.LATE_BEFORE && P.get(e).own[c] === P.get(q).own[c]))
            continue;
          let between = false;
          for (let j = e; j < q; j++) if (move.get(j) === c) between = true;
          if (between) continue;
          found = [t.loss, {kind: "late", move: q + 1, cell: b.name(c), colour: COLOUR[P.get(q).stm], earlier: e + 1, loss: pyRound(t.loss, 1)}];
          break;
        }
      }
      if (found) out.push(found[1]);
    }

    // thrice: the cell captured most often within THRICE_PLIES plies
    {
      const caps = new Map();
      let found = null;
      for (const q of plies) {
        const c = move.get(q);
        if (c === null || P.get(q).own[c] !== 3 - P.get(q).stm) continue;
        if (!caps.has(c)) caps.set(c, []);
        caps.get(c).push(q);
      }
      for (const [c, at] of caps) for (const q of at) {
        const near = at.filter(x => q <= x && x <= q + K.THRICE_PLIES);
        if (near.length >= K.THRICE && (found === null || tupleLess(found[0], [near.length, -q])))
          found = [[near.length, -q], {kind: "thrice", move: near[0] + 1, to: near.at(-1) + 1, cell: b.name(c), times: near.length}];
      }
      if (found) out.push(found[1]);
    }

    // rim: a player's first three moves are new stacks on the rim (the rules only)
    {
      const rim = c => b.neighbours[c].length < 6;
      for (const me of [1, 2]) {
        const first = plies.filter(q => P.get(q).stm === me && move.get(q) !== null).slice(0, 3);
        if (first.length === 3 && first.every(q => rim(move.get(q)) && P.get(q).own[move.get(q)] === 0))
          out.push({kind: "rim", move: first[0] + 1, colour: COLOUR[me], cells: first.map(name)});
      }
    }

    // safe: new stacks costing SAFE_LOSS on cells the map gave to the mover, in this position and the one before
    if (own !== null && own !== undefined) {
      const hits = {1: [], 2: []};
      plies.slice(0, searched).forEach((q, k) => {
        const p = P.get(q), c = move.get(q), t = T.get(q);
        if (c === null || p.own[c] !== 0 || !t || t.loss < K.SAFE_LOSS || !k || 2 * own[k][c] - 1 < K.SAFE_OWNED) return;
        if ((2 * own[k - 1][c] - 1) * (P.get(plies[k - 1]).stm === p.stm ? 1 : -1) >= K.STEADY) hits[p.stm].push(q);
      });
      for (const me of [1, 2])
        if (hits[me].length >= K.SAFE) out.push({kind: "safe", move: hits[me][0] + 1, colour: COLOUR[me], cells: hits[me].map(name)});
    }

    // column: one player's three moves in a row are new stacks on three cells in a row; all captured within COLUMN plies
    {
      let found = null;
      for (const me of [1, 2]) {
        const mine = plies.filter(q => P.get(q).stm === me);
        for (let i = 0; i + 2 < mine.length; i++) {
          const qs = mine.slice(i, i + 3), cs = qs.map(q => move.get(q));
          if (qs.some((q, k) => cs[k] === null || P.get(q).own[cs[k]] !== 0) || new Set(cs).size < 3) continue;
          const mid = cs.find(c => cs.every(o => o === c || b.neighbours[c].includes(o)));
          if (mid === undefined) continue;
          const [a, z] = cs.filter(o => o !== mid);
          if (!b.rays[a].some(ray => ray[0] === mid && ray[1] === z)) continue;
          const gone = qs.map((q, k) => {
            const x = plies.find(x => q < x && x <= qs[2] + K.COLUMN && move.get(x) === cs[k] && P.get(x).stm !== me && P.get(x).own[cs[k]] === me);
            return x === undefined ? null : x;
          });
          if (gone.includes(null)) continue;
          if (found === null || qs[0] < found[0])
            found = [qs[0], {kind: "column", move: qs[0] + 1, to: qs[2] + 1, colour: COLOUR[me], by: COLOUR[3 - me],
              cells: cs.map(c => b.name(c)), last: Math.max(...gone) + 1}];
          break;
        }
      }
      if (found) out.push(found[1]);
    }
    return out.map((m, i) => [m, i]).sort((x, y) => x[0].move - y[0].move || x[1] - y[1]).map(x => x[0]);
  }

  R.sheets = {numpySum, pyRound, scoreGame, redView, regions, ownershipAlong, pointsInPlay, ownerships, findMoments, areaPlies, searchAreas, deepPlies, searchDeep, deepBest, entryBest, toTheEnd, lastPosition, finalOwner, threatSurvives, afterBest,
    lostSight, cutSight, fromLast, nearEqual, visitShare, searchedSheets, review, addStoryLessons, praiseSheet, opening, standingPoints, gameLessons,
    follow, changedHands, principal, twoLines, areas, presence, payoff, praisePayoffs, exactOwnership, swings, survives, factsFromTree, massAhead, levelSummary, DEPTH};
  if (typeof module !== "undefined" && module.exports) module.exports = R.sheets;
})(globalThis);
