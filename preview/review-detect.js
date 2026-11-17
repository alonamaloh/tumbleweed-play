// Detectors for what a move does, from the exact rules plus (optionally) the network's ownership.
//
// A port of training/game_review/detect.py. The Python is the reference: change it first, then this file
// (the functions are in the same order, with the same names in camelCase), and run the parity test
//     node tools/review_port/check_detect.js
// which recomputes what the Python computed on real games and must report no mismatch.
// Needs review-board.js loaded first (scope.Review.board).
//
// Vocabulary follows the players' own (see training/game_review/CONCEPTS.md): capture, reinforce, attack,
// double attack, parry, shield, cut, control, hotspot, invade, respond locally / tenuki, suicidal, anchor.
// No abbreviations in text.
//
// A stack is under attack when the opponent could take it over without a suicidal move: their LOS on it is
// higher than its height and at least the owner's lines of sight there (otherwise the capturing stack could
// be taken straight back, which CodeCup forbids and players call suicidal).
//
// How the Python types map here:
//   set of cells                 Set, filled in ascending cell order
//   links(): dict {(i, j): between}   Array of [[i, j], between] in the Python dict's order
//   opened_lines(): list of tuples    Array of [line name, cells]
//   move_facts(): dict           plain object with the same keys in the same order (they are saved as JSON)
//   None                         null (undefined is accepted for arguments)
// ownership may be an Array or a Float32Array; its values are compared as they are, like float(x) in the Python.
"use strict";
(function (scope) {
  const R = scope.Review = scope.Review || {};
  const {Position} = R.board;

  // ---- small helpers for what Python has built in

  const ascending = (a, b) => a - b;
  const sorted = cells => [...cells].sort(ascending);                    // sorted(set of cells)
  const difference = (a, b) => new Set([...a].filter(i => !b.has(i)));   // a - b
  const intersection = (a, b) => new Set([...a].filter(i => b.has(i)));  // a & b
  // The first stack along a ray, or null: next((j for j in ray if p.codes[j]), None)
  function firstStack(p, ray) {
    for (const j of ray) if (p.codes[j]) return j;
    return null;
  }
  const given = x => x !== null && x !== undefined;

  // ---- the detectors

  // Stacks of the other side (or the neutral) that `by` could capture without suicide.
  function underAttack(p, by) {
    const s = p.sight[by], o = p.sight[3 - by];
    const out = new Set();
    for (let i = 0; i < p.b.n; i++)
      if (p.own[i] !== 0 && p.own[i] !== by && s[i] > p.h[i] && s[i] >= o[i]) out.add(i);
    return out;
  }

  // Pairs of `player`'s stacks that see each other along a line: [[i, j], cells between], i ascending.
  function links(p, player) {
    const out = [];
    for (let i = 0; i < p.b.n; i++) {
      if (p.own[i] !== player) continue;
      for (const ray of p.b.rays[i].slice(0, 3)) {      // three directions; the other three mirror them
        const between = [];
        for (const j of ray) {
          if (p.codes[j]) {
            if (p.own[j] === player) out.push([[i, j], between]);
            break;
          }
          between.push(j);
        }
      }
    }
    return out;
  }

  // Empty cells where `player` has more LOS than the opponent.
  function control(p, player) {
    const s = p.sight[player], o = p.sight[3 - player];
    const out = new Set();
    for (let i = 0; i < p.b.n; i++)
      if (p.codes[i] === 0 && s[i] > o[i]) out.add(i);
    return out;
  }

  // The mover's stacks that are under attack and that no legal move can save: they will be captured.
  function doomed(p) {
    const x = p.stm, y = 3 - p.stm;
    let attacked = new Set([...underAttack(p, y)].filter(i => p.own[i] === x));
    for (const m of p.canPlace(x, true).keys()) {
      if (!attacked.size) break;
      attacked = intersection(attacked, underAttack(p.after(m), y));
    }
    return attacked;
  }

  // One more line of sight from `attacker` would put stack i under attack, and an empty cell offers that line:
  // on one of i's lines whose first stack is not the attacker's, where the attacker can place without being
  // captured straight back.
  // The cells each side holds whatever happens, as [Red's, White's] Sets: unconditional territory, the exact
  // territory the engine counts (puct_territory.h). Red's are the cells that are still Red's after White first
  // places a stack everywhere it may, again and again until it has no move left, and then Red does the same;
  // White's likewise with Red filling first. A fill takes every cell where the side sees more of its stacks than
  // the height there and at least as many as the opponent does, all at once, each at the height of its sight.
  // (The Python's sights() only makes this fast there; a Position gives the same counts.)
  function secured(p) {
    const b = p.b;
    const fill = (q, side) => {
      for (;;) {
        const s = q.sight[side], o = q.sight[3 - side];
        const codes = q.codes.slice();
        let any = false;
        for (let i = 0; i < b.n; i++) {
          if (s[i] >= o[i] && s[i] > q.h[i]) { codes[i] = s[i] + 6 * (side - 1); any = true; }
        }
        if (!any) return q;
        q = new Position(b, codes, q.stm);
      }
    };
    const owned = (q, side) => {
      const cells = new Set();
      for (let i = 0; i < b.n; i++) if (q.own[i] === side) cells.add(i);
      return cells;
    };
    return [owned(fill(fill(p, 2), 1), 1), owned(fill(fill(p, 1), 2), 2)];
  }

  function exposed(q, i, attacker) {
    const e = q.sight[attacker][i] + 1, o = q.sight[3 - attacker][i];
    if (!(e > q.h[i] && e >= o)) return false;
    for (const ray of q.b.rays[i]) {
      const first = firstStack(q, ray);
      if (first !== null && q.own[first] === attacker) continue;
      for (const c of ray) {
        if (q.codes[c]) break;
        if (q.sight[attacker][c] >= 1 && q.sight[attacker][c] >= q.sight[3 - attacker][c]) return true;
      }
    }
    return false;
  }

  // The line through `move` in direction d (0-5; d and d+3 are the same line), as players read the board:
  // the D line (one letter), row 7 (one number), or a diagonal named by its two ends.
  function lineName(b, move, d) {
    if (d % 3 === 1)                                    // (1, 0): the row index changes, the letter stays
      return `the ${b.name(move)[0]} line`;
    if (d % 3 === 0)                                    // (0, 1): the letter changes, the number stays
      return `row ${b.name(move).slice(1)}`;
    const ends = [d % 3, d % 3 + 3].map(k => b.rays[move][k].length ? b.rays[move][k][b.rays[move][k].length - 1] : move);
    // the end with the lower row (then column) first
    const [a, z] = ends.sort((i, j) => b.rc[i][0] - b.rc[j][0] || b.rc[i][1] - b.rc[j][1]);
    return `the ${b.name(a)}–${b.name(z)} diagonal`;
  }

  // Lines the move opens: along each of its lines, the empty cells up to the first stack where the mover had
  // no line of sight before (so could not place there) and that are not already safely the mover's.
  // Returns [[line name, [cells]]], best first, only lines with at least `minimum` such cells.
  function openedLines(p, move, ownership = null, minimum = 3) {
    const b = p.b, x = p.stm;
    const found = new Map();                            // line (direction mod 3) -> cells, in the order met
    b.rays[move].forEach((ray, d) => {
      for (const j of ray) {
        if (p.codes[j]) break;
        if (p.sight[x][j] === 0 && (!given(ownership) || ownership[j] < .75)) {
          if (!found.has(d % 3)) found.set(d % 3, []);
          found.get(d % 3).push(j);
        }
      }
    });
    const out = [];
    for (const [d, cells] of found)
      if (cells.length >= minimum) out.push([lineName(b, move, d), cells]);
    return out.sort((s, t) => t[1].length - s[1].length);       // stable: equal lengths keep their order
  }

  // What `move` (compact index or null) does for the side to move in Position p.
  //
  // ownership: the network's ownership before the move, as probabilities for the mover (optional);
  // previous: the opponent's last move (compact index or null); best: whether this is the engine's choice
  // (a suicidal best move is an anchor).
  function moveFacts(p, move, ownership = null, previous = null, best = false) {
    const b = p.b, x = p.stm;
    const y = 3 - x;
    if (!given(move)) move = null;
    if (!given(ownership)) ownership = null;
    if (!given(previous)) previous = null;
    const f = {cell: move === null ? null : b.name(move), tags: [], purposes: 0};
    if (move === null) {
      f.kind = "pass";
      return f;
    }
    const a = p.after(move);
    const fresh = p.sight[x][move];                     // the new stack's height ("new" in the Python)
    f.height = fresh;
    f.before = {owner: p.own[move], height: p.h[move]};
    f.kind = p.own[move] === 0 ? "placement" : p.own[move] === x ? "reinforcement" : p.own[move] === y ? "capture" : "neutral capture";
    f.notation = f.cell + (f.kind === "capture" || f.kind === "neutral capture" ? "x" : f.kind === "reinforcement" ? "+" : "");
    f.suicidal = fresh < p.sight[y][move];
    // Each fact is a clause that completes "<move> ...", in the players' terms and without abbreviations.
    const good = [], bad = [];
    const colour = player => ["Red", "White"][player - 1];
    const names = cells => cells.length <= 2 ? cells.map(i => b.name(i)).join(" and ")
      : cells.slice(0, -1).map(i => b.name(i)).join(", ") + " and " + b.name(cells[cells.length - 1]);
    if (f.kind === "capture") good.push(`captures a ${p.h[move]}-stack`);
    if (f.kind === "neutral capture") good.push("captures the neutral stack");
    // defence: friendly stacks that were under attack and no longer are, and how
    const attackedBefore = underAttack(p, y), attackedAfter = underAttack(a, y);
    const parried = [], shielded = [], reinforced = [], relieved = [];
    let capturedSees = new Set();
    if (f.kind === "capture") capturedSees = new Set(b.rays[move].map(ray => firstStack(p, ray)));
    for (const i of sorted(difference(attackedBefore, attackedAfter))) {
      // a stack of ours that was under attack and is reinforced; the neutral stack, which the opponent could have
      // captured too, is not a stack of ours that was saved
      if (i === move) { if (f.kind === "reinforcement") reinforced.push(i); }
      else if (f.kind === "capture" && capturedSees.has(i) && a.sight[y][i] < p.sight[y][i]) relieved.push(i);
      else if (a.sight[y][i] < p.sight[y][i]) shielded.push(i);
      else parried.push(i);
    }
    if (f.kind === "reinforcement" && !reinforced.length) good.push(`reinforces to a ${fresh}-stack`);
    if (reinforced.length) good.push(`saves the attacked stack by reinforcing it to ${fresh}`);
    if (parried.length) good.push(`defends ${names(parried)} by adding a line of sight (a parry)`);
    if (shielded.length) good.push(`shields ${names(shielded)}`);
    if (relieved.length) good.push(`ends the attack on ${names(relieved)}`);
    f.defends = [...parried, ...shielded, ...reinforced, ...relieved].map(i => b.name(i));
    // a line of sight added to an attacked stack that is still under attack afterwards
    const partial = sorted(intersection(attackedBefore, attackedAfter))
      .filter(i => i !== move && p.own[i] === x && a.sight[x][i] > p.sight[x][i]);
    f.partial_defence = partial.map(i => b.name(i));            // worded only when it is all the move does
    // defending in advance: one more enemy line would have attacked the stack; after the move it would not
    const ahead = [];
    for (let i = 0; i < b.n; i++)
      if (p.own[i] === x && i !== move && !attackedBefore.has(i) && a.sight[x][i] > p.sight[x][i]
          && exposed(p, i, y) && !exposed(a, i, y)) ahead.push(i);
    f.defends_ahead = ahead.map(i => b.name(i));
    const dying = new Set([...doomed(p)].filter(d => attackedAfter.has(d)));    // still capturable after the move
    // attack
    const mineBefore = underAttack(p, x), mineAfter = underAttack(a, x);
    const newTargets = sorted(difference(mineAfter, mineBefore));
    const attacks = newTargets.filter(i => p.own[i] !== 3);
    f.attacks = attacks.map(i => b.name(i));
    // an attack that needs a line of sight from one of our stacks that can't be defended lasts only as long as it
    const leanOf = new Map(attacks.map(t => [t, new Set()]));   // for each attacked stack, the dying stacks its attack needs
    for (const d of dying) {
      const codes = p.codes.slice();
      codes[d] = p.sight[y][d] + 6 * (y - 1);
      const qa = new Position(b, codes, x).after(move);
      const attackedThen = underAttack(qa, x);
      for (const t of attacks)
        if (!attackedThen.has(t)) leanOf.get(t).add(d);
    }
    const union = sets => new Set(sets.flatMap(s => [...s]));
    const leaning = union([...leanOf.values()]);
    f.attack_leans_on = sorted(leaning).map(i => b.name(i));
    // stacks the opponent can then no longer defend: the attack wins them
    const theirDying = doomed(a);
    f.wins = attacks.filter(i => theirDying.has(i)).map(i => b.name(i));
    const cut = links(p, y).filter(([, between]) => between.includes(move)).map(([pair]) => pair);
    // both: the move attacks exactly the two ends of a link it cuts
    const both = attacks.length === 2 && cut.some(([i, j]) => attacks.includes(i) && attacks.includes(j));
    if (attacks.length) {
      const firm = attacks.filter(t => !leanOf.get(t).size);
      const loose = attacks.filter(t => leanOf.get(t).size);
      const pieces = [];
      if (firm.length) pieces.push("attacks " + (firm.length === 2 ? "both " : "") + names(firm));
      if (loose.length) {
        const needs = sorted(union(loose.map(t => leanOf.get(t))));
        const lasts = needs.length === 1 ? "lasts" : "last";
        if (firm.length) pieces[pieces.length - 1] += ` (and ${names(loose)} while ${names(needs)} ${lasts})`;
        else pieces.push("attacks " + (loose.length === 2 ? "both " : "") + names(loose) + ` while ${names(needs)} ${lasts}`);
      }
      let clause = pieces.join(", ");
      if (both) clause += !loose.length ? ", cutting the link between them" : `, cutting the link between ${names(attacks)}`;
      good.push(clause);
    }
    if (newTargets.some(i => p.own[i] === 3)) good.push("threatens to capture the neutral stack");
    // another line of sight on a stack that could already be captured adds nothing worth saying: not a purpose
    f.pinwheel = sorted(intersection(mineBefore, mineAfter)).filter(i => a.sight[x][i] > p.sight[x][i]).map(i => b.name(i));
    // cutting a link between two enemy stacks
    if (cut.length && !both)
      good.push("cuts the link between " + cut.slice(0, 2).map(([i, j]) => `${b.name(i)} and ${b.name(j)}`).join(" and between "));
    // an attacked stack that the opponent could still defend, and now can't
    const beforeTheirs = doomed(new Position(b, p.codes, y));
    const sealed = sorted(difference(theirDying, beforeTheirs)).filter(i => mineBefore.has(i) && p.own[i] === y);
    if (sealed.length) good.push(`leaves ${colour(y)} unable to defend ${names(sealed)}`);
    // territory made safe: cells that become the mover's whatever happens next (see secured). One cell is not
    // worth a clause; the names are kept either way. A move that closes a border makes dozens of cells
    // unconditional at once, cells that were the mover's already in every likely line: from ten up nothing is said
    // ("secures 45 points" was read as a gain of 45, and "makes 59 points of Red's territory safe" read oddly).
    const safeNow = sorted(difference(secured(a)[x - 1], secured(p)[x - 1]));
    f.secures = safeNow.map(i => b.name(i));
    let theirs = false;
    for (let i = 0; i < b.n; i++) if (a.own[i] === y) { theirs = true; break; }
    if (!theirs) good.push(`leaves ${colour(y)} without a stack on the board`);
    else if (safeNow.length >= 2 && safeNow.length < 10) good.push(`secures ${safeNow.length} points of territory`);
    // control and hotspots
    const gained = difference(control(a, x), control(p, x));
    gained.delete(move);
    const hotspot = p.codes[move] === 0 && p.sight[x][move] === p.sight[y][move];
    // cells taken from the opponent's control or from an even count; only a sizeable gain counts as a purpose
    // Players mean control of undecided areas ("this is not controlling anything" about a move that only adds
    // sight in settled land), so with ownership available only undecided cells count.
    const taken = sorted(gained).filter(i => p.sight[y][i] >= p.sight[x][i]
      && (ownership === null || (.25 < ownership[i] && ownership[i] < .75)));
    f.control_gained = taken.map(i => b.name(i));
    let blockedLine = null;
    if (previous !== null && p.own[previous] === y && p.codes[move] === 0) {
      for (let kDir = 0; kDir < 6; kDir++) {
        const ray = b.rays[previous][kDir];
        const k = ray.indexOf(move);
        if (k < 0) continue;
        const behind = firstStack(p, b.rays[previous][(kDir + 3) % 6]);
        if (ray.slice(0, k).some(j => p.codes[j]) || (behind !== null && p.own[behind] === y)) break;
        const beyond = [];
        for (const j of ray.slice(k + 1)) {
          if (p.codes[j]) break;
          beyond.push(j);
        }
        const cutOff = beyond.filter(j => p.sight[y][j] > 0 && a.sight[y][j] === 0);
        if (cutOff.length >= 3) {
          blockedLine = [lineName(b, move, kDir), cutOff.length];
          f.blocks_previous = cutOff.length;
        }
        break;
      }
    }
    // Not phrased as "takes control of N cells" (a bare count says nothing to a player): we name the lines the
    // move opens and how many new cells come within reach along them ("it opens the D line").
    let opened = openedLines(p, move, ownership).slice(0, 2);
    const reach = lines => lines.reduce((total, [, cells]) => total + cells.length, 0);
    f.opened = opened.map(([line, cells]) => ({line, cells: cells.map(i => b.name(i))}));
    f.reach = reach(opened);
    if (blockedLine && opened.some(([line]) => line === blockedLine[0])) {
      opened = opened.filter(([line]) => line !== blockedLine[0]);
      good.push(`takes over ${blockedLine[0]} that ${b.name(previous)} had just opened (${blockedLine[1]} cells cut off)`);
    } else if (blockedLine) {
      good.push(`blocks the line ${b.name(previous)} just opened (${blockedLine[1]} cells cut off)`);
    }
    if (opened.length)
      good.push(`opens ${opened.map(([line]) => line).join(" and ")} (${reach(opened)} new cells within reach)`);
    // where on the board, from the network's ownership before the move
    if (ownership !== null) {
      const mine = ownership[move];
      const near = [];
      for (let i = 0; i < b.n; i++) if (i !== move && b.distance(i, move) <= 2) near.push(i);
      // a lone enemy stack in our land: removing it takes away the opponent's opportunities there
      const friends = b.rays[move].some(ray => { const j = firstStack(p, ray); return j !== null && p.own[j] === y; });
      if (f.kind === "capture" && mine > .6 && !near.some(i => p.own[i] === y) && !friends) {
        // one clause with the capture itself, which it describes, rather than a second "useful thing"
        const k = good.indexOf(`captures a ${p.h[move]}-stack`);
        good[k] = `captures a lone ${colour(y)} ${p.h[move]}-stack in ${colour(x)}'s area`;
        f.lone = true;
      }
      // first into an area nobody controls yet
      if (p.codes[move] === 0 && .35 < mine && mine < .65 && !near.some(i => p.codes[i]))
        good.push("is the first move into an area nobody controls");
      if (mine < .3 && f.kind !== "capture")
        good.push("invades");
      else if (!best && mine > .9 && !f.defends.length && !f.attacks.length && !hotspot
               && f.kind !== "capture" && f.kind !== "neutral capture" && safeNow.length < 2)
        bad.push(`is played inside ${colour(x)}'s own secure land`);
    }
    if (previous !== null) {
      const d = b.distance(move, previous);
      f.distance_to_previous = d;
      // a move that attacks, defends against or cuts next to the last move answers it even from afar
      const seenByPrevious = c => b.rays[b.index(c)].some(ray => firstStack(p, ray) === previous);
      const interacts = f.attacks.includes(b.name(previous))
        || f.defends.some(c => b.distance(previous, b.index(c)) <= 1 || seenByPrevious(c))
        || Boolean(f.blocks_previous) || cut.some(pair => pair.includes(previous));
      if (d <= 2 && interacts) f.locality = "local";
      else if (d <= 2) f.locality = "near";
      else if (interacts) f.locality = "answer";
      else if (d >= 5) f.locality = "elsewhere";
    }
    // using a dying stack: a stack that cannot be saved still lends its line of sight to this move's height
    if (f.kind === "placement" || f.kind === "reinforcement") {
      const seen = new Set(b.rays[move].map(ray => firstStack(p, ray)));
      // only when it matters: after the capture, a stack here would be impossible or could be taken at once
      f.uses_doomed = [];
      f.doomed_loss = null;
      for (const d of sorted(intersection(dying, seen))) {
        const codes = p.codes.slice();
        codes[d] = p.sight[y][d] + 6 * (y - 1);         // the opponent's capturing stack
        const q = new Position(b, codes, x);
        let loss;
        if (q.sight[x][move] <= q.h[move]) loss = "impossible";
        else if (q.sight[x][move] < q.sight[y][move] || underAttack(q.after(move), y).has(move)) loss = "unsafe";
        else continue;
        f.uses_doomed.push(b.name(d));
        f.doomed_loss = f.doomed_loss || loss;
      }
    }
    // weaknesses
    if (f.suicidal) {
      if (best) good.push("is an anchor: it can be captured, but adds lines of sight for now");
      else bad.push("can be captured straight away");
    }
    const newly = sorted(difference(attackedAfter, attackedBefore)).filter(i => i !== move);
    if (newly.length) bad.push(`leaves ${names(newly)} under attack`);
    f.good = good;
    f.bad = bad;
    // quiet moves: say what they do for later, when they do nothing else (being in someone's area is not a purpose)
    const AREA = ["invades", "is the first move into an area nobody controls"];
    const quiet = () => !good.some(c => !AREA.includes(c));
    if (quiet() && ahead.length)
      good.push(`defends ${names(ahead)} in advance, before ${colour(y)} can attack ${ahead.length === 1 ? "it" : "them"}`);
    // a quiet move that sets up an attack: a cell along its lines from which the mover would then attack
    if (quiet() && f.kind === "placement") {
      const again = new Position(b, a.codes, x);
      const legalNow = p.canPlace(x, true), legalThen = again.canPlace(x, true);
      const attackedAgain = underAttack(again, x);
      let found = null;                                 // the best [number of stacks attacked, cell, stacks]
      for (const ray of b.rays[move]) {
        for (const c of ray) {
          if (a.codes[c]) break;
          if (!legalThen.has(c)) continue;
          const qa = again.after(c);
          let gain = new Set([...difference(underAttack(qa, x), attackedAgain)].filter(t => again.own[t] === y));
          if (legalNow.has(c)) gain = difference(gain, difference(underAttack(p.after(c), x), mineBefore));
          // max(found) in the Python: most stacks attacked, then the higher cell (no two entries share a cell)
          if (gain.size && !underAttack(qa, y).has(c) && (found === null || gain.size > found[0] || (gain.size === found[0] && c > found[1])))
            found = [gain.size, c, sorted(gain)];
        }
      }
      if (found !== null) {
        const [, c, gain] = found;
        f.prepares = {cell: b.name(c), attacks: gain.map(t => b.name(t))};
        good.push(`prepares ${b.name(c)}, from where it would attack ${names(gain)}`);
        if (previous !== null && gain.includes(previous) && f.locality === "near") f.locality = "local";
        // "bad" is the list already stored in f.bad, so it is emptied in place (bad[:] = ... in the Python)
        const kept = bad.filter(c => !c.includes("own secure land"));
        bad.length = 0;
        bad.push(...kept);
      }
    }
    f.tags = [...good, ...bad];
    f.purposes = good.length - (f.opened.length && good.includes("is the first move into an area nobody controls") ? 1 : 0);
    return f;
  }

  // A short location for a group of compact cells: centre, near a corner, or along / towards an edge.
  function where(b, cells) {
    const s1 = b.side - 1;
    // the cell of the group nearest to the group's mean position (the first such cell on a tie)
    let meanR = 0, meanC = 0;
    for (const i of cells) {
      meanR += b.rc[i][0];
      meanC += b.rc[i][1];
    }
    meanR /= cells.length;
    meanC /= cells.length;
    let c = null, least = Infinity;
    for (const i of cells) {
      const dr = b.rc[i][0] - meanR, dc = b.rc[i][1] - meanC;
      const d = dr * dr + dc * dc;
      if (d < least) [c, least] = [i, d];
    }
    if (b.distance(c, b.centre) <= Math.floor(s1 / 3)) return "in the centre";
    // the nearest corner (the first in the corners' order on a tie)
    let corner = null, nearest = Infinity;
    for (const [name, cell] of Object.entries(b.corners)) {
      if (b.distance(c, cell) < nearest) [corner, nearest] = [name, b.distance(c, cell)];
    }
    if (nearest <= Math.max(1, Math.floor(s1 / 3))) return `near the ${corner} corner`;
    const [r, col] = b.rc[c];
    const pairs = edgePairs(b);
    // distance to each of the six edges, in the order of EDGES
    const distances = [r, col, s1 - (col - r), s1 - (r - col), 2 * s1 - r, 2 * s1 - col];
    // min(edges) in the Python compares (distance, (corner, corner)) tuples: on equal distances the edge whose
    // corner names come first as strings wins, not the first edge in the list
    let k = 0;
    for (let e = 1; e < 6; e++) {
      const closer = distances[e] !== distances[k] ? distances[e] < distances[k]
        : pairs[e][0] !== pairs[k][0] ? pairs[e][0] < pairs[k][0] : pairs[e][1] < pairs[k][1];
      if (closer) k = e;
    }
    const edge = edgeName(b, pairs[k][0], pairs[k][1]);
    return distances[k] <= 1 ? `along the ${edge}` : `towards the ${edge}`;
  }

  const EDGES = ["top", "upper left", "upper right", "lower left", "bottom", "lower right"];

  // The corner names at the two ends of each edge, in the order of EDGES (the list both where() and
  // edge_name() build in the Python).
  function edgePairs(b) {
    const s1 = b.side - 1;
    const name = new Map(Object.entries(b.corners).map(([k, v]) => [v, k]));
    const g = (rr, cc) => name.get(b.compact[rr * b.g + cc]);
    return [[g(0, 0), g(0, s1)], [g(0, 0), g(s1, 0)], [g(0, s1), g(s1, 2 * s1)], [g(s1, 0), g(2 * s1, s1)],
            [g(2 * s1, s1), g(2 * s1, 2 * s1)], [g(s1, 2 * s1), g(2 * s1, 2 * s1)]];
  }

  // 'H15', 'O15' -> 'bottom edge', as the board is drawn (row 1 at the top).
  function edgeName(b, u, v) {
    const pairs = edgePairs(b);
    for (let k = 0; k < pairs.length; k++) {
      const [s, t] = pairs[k];
      if ((u === s && v === t) || (u === t && v === s)) return `${EDGES[k]} edge`;
    }
    return `${u}–${v} edge`;
  }

  R.detect = {underAttack, links, control, doomed, secured, exposed, lineName, openedLines, moveFacts, where, EDGES, edgeName};
  if (typeof module !== "undefined" && module.exports) module.exports = R.detect;
})(globalThis);
