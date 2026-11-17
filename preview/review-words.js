// The words of a game review: everything between a saved review (the JSON) and its text.
//
// A port of the wording of training/game_review:
//   review.py   opening_text ... text (all that text(r) reaches; no engine, no searches)
//   lines.py    the wording half: whole, stacks, shown_line, named_areas, differing, sentences
// The Python is the reference: change it first, then this file, and run the parity test
//     node tools/review_port/check_words.js
// which requires text(review) to equal the saved .txt of every review in tw8/logs/game_review02, character for
// character, and compares several hundred perturbed entries with what the Python wrote for them.
// Functions keep the Python's names (in camelCase) and order, review.py first and lines.py after it; the saved
// review keeps the Python's keys (snake_case), so the same file is read by both.
//
// Like the Python, wording a review writes into it: shown() sets next, side, decided, close, next_lesson and
// reply_see on the sheets and makes the area labels agree; commentary() sets region_said, unexplained,
// wants_lines, discussed_threat and lesson_kind; keyMoves() sets recommended on the praise. Later entries
// depend on these, so they are reproduced.
//
// How the Python types map here:
//   None                         null (a missing key read with .get() gives null too)
//   the `used` set               Used (below): tuples are arrays, e.g. ["best", "K7", "White", 12, [clauses]]
//   a tuple the Python returns   an array, e.g. keyMoves -> [[kind, sheet, words], ...]
//   dict keyed by 1 and 2        plain object (tally); game.players is read with either kind of key
//   f"..."                       the tag f`...`, which spells None, True and False as Python does
// Where the two languages differ and it could change a character, the Python's behaviour is spelled out:
// rounding (py.fixed, exact ties to even), sum() of floats (py.sum), truth of empty lists and dicts (py.truthy),
// dict.get (py.get), negative indices (at), \b in regular expressions (subWord), the order of dicts (Map).
// Known limits: a number is printed as JavaScript prints it (the Python would print a float that is a whole
// number as "7.0"; no such number reaches the text), and \d matches ASCII digits only.
//
// Needs review-levels.js and review-select.js loaded first (scope.Review.levels, scope.Review.select).
"use strict";
(function (scope) {
  const R = scope.Review = scope.Review || {};
  const S = R.select;
  const {round, percent, int, truthy, get, equal, sum} = S.py;
  const {settled, closeFinish, CLOSE, CLOSE_MINIMUM, betterThan, levelName, MINIMUM_MOVES, localBoard} = S;

  const COLOUR = {1: "Red", 2: "White"};
  const OTHER = {Red: "White", White: "Red"};
  // the effects that make a threat or a reply concrete (review.py keeps this with the sheets' own functions)
  const CONCRETE = ["captures", "attacks", "cuts", "invades", "removes"];

  // ---------------------------------------------------------------- Python's ways

  // str(x) inside an f-string
  const str = x => x === null || x === undefined ? "None" : x === true ? "True" : x === false ? "False" : String(x);
  // f`...`: a template with Python's spelling of None, True and False
  const f = (strings, ...values) => strings.reduce((out, s, i) => out + str(values[i - 1]) + s);
  // x or y
  const or = (x, y) => truthy(x) ? x : y;
  // list[i] with Python's negative indices; out of range is an error
  function at(list, i) {
    const k = i < 0 ? list.length + i : i;
    if (k < 0 || k >= list.length) throw new RangeError("list index out of range");
    return list[k];
  }
  // text.index(part): not found is an error
  function indexOf(text, part) {
    const k = text.indexOf(part);
    if (k < 0) throw new Error("substring not found");
    return k;
  }
  // tuples compared as Python compares them: element by element, numbers as numbers, strings by code
  function compareTuples(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return a.length - b.length;
  }
  // re.sub(r'\b' + pattern, ...) for a pattern that starts with a letter: \b is then "no word character
  // before". Python's word characters are Unicode letters, digits and the underscore; JavaScript's \b knows
  // ASCII only, so the character before each match is checked here. `pattern` must have the g flag.
  const WORD = /[\p{L}\p{N}_]/u;
  function subWord(pattern, replace, text) {
    let out = "", last = 0;
    pattern.lastIndex = 0;
    for (let m; (m = pattern.exec(text)) !== null;) {
      let before = "";
      if (m.index > 0) {
        const low = text.charCodeAt(m.index - 1);
        const pair = low >= 0xDC00 && low <= 0xDFFF && m.index > 1;
        before = pair ? String.fromCodePoint(text.codePointAt(m.index - 2)) : text[m.index - 1];
      }
      if (before !== "" && WORD.test(before)) {
        pattern.lastIndex = m.index + 1;                // not at the start of a word: look on from the next character
        continue;
      }
      out += text.slice(last, m.index) + replace(m);
      last = m.index + m[0].length;
    }
    return out + text.slice(last);
  }

  // The Python's `used`: a set that remembers what earlier entries of the same game said, so that each thing is
  // said once. It holds tuples, here arrays, and the takeaways already given, as plain strings:
  //   ["behind", colour]                        the "very hard for Red" sentence was said
  //   ["threat", cell, colour, move number]     a threat was explained at that move
  //   ["best", cell, colour, move number, [clauses]]   a better move was explained at that move, with these clauses
  class Used {
    constructor(entries = []) {
      this.map = new Map();
      for (const entry of entries) this.add(entry);
    }
    add(entry) {
      this.map.set(JSON.stringify(entry), entry);
    }
    has(entry) {
      return this.map.has(JSON.stringify(entry));
    }
    [Symbol.iterator]() {
      return this.map.values();
    }
    entries() {
      return [...this.map.values()];
    }
  }

  // ---------------------------------------------------------------- the opening offer

  // The two first stacks: under the pie rule, an offer the other player could swap; otherwise (CodeCup) a start
  // set by the judge.
  function openingText(o, pie = true) {
    if (!truthy(o)) return [];
    const side = o.red_value > 0 ? "Red" : "White";
    const size = Math.abs(o.red_value);
    let s;
    if (truthy(pie)) {
      const verdict = size <= 2 ? "a well-balanced offer" : f`an offer that favours ${side} by about ${points(size)}`;
      s = [f`The opening offer put Red at ${o.red} and White at ${o.white}: ${verdict} ` +
           f`(Red's chances about ${percent(o.red_win)}).`];
    } else {
      const verdict = size <= 2 ? "a balanced start" : f`a start that favours ${side} by about ${points(size)}`;
      s = [f`The judge set Red at ${o.red} and White at ${o.white}: ${verdict} ` +
           f`(Red's chances about ${percent(o.red_win)}).`];
    }
    const notes = [];
    const ORD = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh"];
    const line = at(ORD, Math.min(o.red_line, ORD.length) - 1);
    const wline = at(ORD, Math.min(get(o, "white_line", 5), ORD.length) - 1);
    const rs = o.red_sees_neutral, ws = o.white_sees_neutral;
    if (equal(rs, ws) && line === wline) {
      notes.push(f`Both stacks are on the ${line} line; ` + (truthy(rs) ? "both see the neutral" : "neither sees the neutral"));
    } else if (equal(rs, ws)) {
      notes.push(f`Red's stack is on the ${line} line, White's on the ${wline}; ` +
                 (truthy(rs) ? "both see the neutral" : "neither sees the neutral"));
    } else {
      notes.push(f`Red's stack is on the ${line} line and ` + (truthy(rs) ? "sees the neutral" : "doesn't see the neutral"));
      notes.push(f`White's is on the ${wline} line and ` + (truthy(ws) ? "sees it" : "doesn't"));
    }
    if (truthy(o.red_sees_white)) notes.push("and the two stacks see each other, so Red can attack White straight away");
    const tail = notes.filter(x => x.startsWith("and the two stacks"));
    const body = notes.filter(x => !x.startsWith("and the two stacks"));
    s.push(body.join("; ") + (tail.length ? ", " + tail[0] : "") + ".");
    if (!truthy(pie)) return s;
    if (truthy(o.red_sees_neutral) && !truthy(o.white_sees_neutral) && !truthy(o.red_sees_white) && size <= 3 &&
        get(o, "white_line", 0) >= 4) {
      s[s.length - 1] = s[s.length - 1].slice(0, -1) + ": the classic shape of a fair offer.";
    } else if (size > 5) {
      s.push(f`With an offer this uneven, whoever chose the colours should take ${side}.`);
      if (truthy(o.red_sees_white) && o.red_value > 2)
        s[s.length - 1] += ' Offers where Red can attack White at once usually favour Red; "when in doubt, swap".';
    } else if (truthy(o.red_sees_white) && o.red_value > 2) {
      s.push('Offers where Red can attack White at once usually favour Red; "when in doubt, swap".');
    }
    return s;
  }

  // ---------------------------------------------------------------- draft text
  // The voice imitates the commentary players like (Florian Jamain's and Tellorion's videos, the community
  // booklets): say what a move is for, what it allows, and what the opponent does next.

  // "A", "A and B", "A, B and C"
  function listing(items) {
    items = [...items];
    if (items.length < 2) return items.length ? items[0] : "";
    // an item with a comma of its own needs one before "and" too
    const head = items.slice(0, -1);
    return head.join(", ") + (head.some(i => String(i).includes(", ")) ? ", and " : " and ") + items[items.length - 1];
  }

  const BASE = new Map(Object.entries({captures: "capture", attacks: "attack", cuts: "cut", takes: "take", shields: "shield",
    defends: "defend", invades: "invade", adds: "add", removes: "remove", saves: "save",
    reinforces: "reinforce", is: "be", leaves: "leave", opens: "open"}));

  // 'safely attacks J9' -> 'safely attack J9', for 'it would ...'.
  function would(clause) {
    const words = clause.split(" ");
    const k = words[0] === "safely" && words.length > 1 ? 1 : 0;
    const w = words[k];
    words[k] = BASE.has(w) ? BASE.get(w) : w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
    return words.join(" ");
  }

  // '<cell> captures a 2-stack and attacks J9' style clause, good things first, then weaknesses.
  function does(facts, fallback = "doesn't do much") {
    if (facts.kind === "pass") return "a pass";
    const good = get(facts, "good", []), bad = get(facts, "bad", []);
    let text = truthy(good) ? listing(good) : fallback;
    if (truthy(bad)) text += (truthy(good) ? ", but it " : ", and it ") + listing(bad);
    return text;
  }

  const NUMBER = ["", "", "two", "three", "four", "five", "six"];

  // "1 point", "7 points": to the nearest point, at least one
  function points(x) {
    const n = Math.max(1, int(x + .5));
    return n === 1 ? f`${n} point` : f`${n} points`;
  }

  // one-line takeaways, in the spirit of the community's puzzle books ("Build while attacking!")
  const TAKEAWAY = {
    threat: "Always check the new lines of sight from the move your opponent just played.",
    suicidal: "Before placing a stack, count the opponent's lines of sight on that cell.",
    capture: "A capture that also attacks or defends is usually the biggest move on the board.",
    key: "Your opponent's best move is often your best move too.",
    doomed: "A stack that is about to be captured still has its lines of sight: use them before it goes.",
    standing: "Before each move, ask where your opponent most wants to play; a threat can wait on the board for several turns.",
    urgent: "When both sides want the same two points, take the bigger one: you will only get one of them.",
    tenuki: "Before playing elsewhere, check whether your opponent's last move needs an answer.",
    control: "Prefer moves that do several things at once.",
    pass: "Count before passing: there may still be points to play for.",
    // from what recurs in the entries that had no lesson (tw8/logs/game_review12/README.md, November 13)
    fated: "A stack you cannot keep becomes your opponent's: before placing one, count the lines of sight each side can bring to its cell.",
    hurried: "An attack that makes your opponent play a move they wanted anyway only helps them.",
    parried: "Before attacking a stack, look for your opponent's answer: an attack that is simply met gains nothing.",
    ignored: "An attack is only a threat when your opponent has to answer it: check what capturing the stack would really win.",
    ownland: "A move inside your own secure land seldom gains anything: play where the border is still open.",
    greedy: "Winning a stack is not always the biggest move: compare it with the best point elsewhere before you take it.",
    waits: "An attacked stack does not always need a defender at once: ask first what your opponent's best move really is.",
    price: "A stack can be worth giving up: what counts is the whole board after the exchange, not the stack.",
    taller: "When two moves do the same job, prefer the taller stack: it is harder to capture.",
    absent: "Find the part of the board where most is still undecided, and make sure your move does something there.",
  };

  // the newer lessons, in the order they are tried when an entry fits more than one; the older ones come first
  const NOTED = ["fated", "hurried", "parried", "ignored", "ownland", "greedy", "waits", "price", "taller", "absent"];

  const KINDS = {attack: ["attacks", "safely attacks"], defence: ["defends", "shields", "ends the attack", "saves"],
    capture: ["captures"], cut: ["cuts", "blocks", "takes over"], lines: ["opens", "reaches"]};

  // Which takeaway an entry earns, if any (a key of TAKEAWAY).
  const CLEAR_REPLY = .6;

  // The opponent's best reply to the move played, when the search is sure enough of it to be quoted: the reply has
  // at least CLEAR_REPLY of the search's visits, or it is the move the game went on with. A review from before
  // the share was saved counts as sure. null otherwise.
  function quotedReply(s) {
    const cell = get(or(get(s, "reply"), {}), "cell");
    const share = get(s, "reply_share");
    const sure = share === null || share === undefined || share >= CLEAR_REPLY || cell === get(or(get(s, "next"), {}), "move");
    return truthy(cell) && sure ? cell : null;
  }

  // The engine's line after the better move, when its first move has at least CLEAR_REPLY of that search's
  // visits; empty otherwise.
  function quotedLine(s) {
    const share = get(s, "best_reply_share");
    return share === null || share === undefined || share >= CLEAR_REPLY ? or(get(s, "best_pv"), []) : [];
  }

  function lessonKind(s, threat, bestShown = null, playedShown = null) {
    const played = s.played, best = s.best;
    bestShown = or(bestShown, best);
    playedShown = or(playedShown, played);
    const reply = get(get(s, "reply", {}), "cell");
    const sure = quotedReply(s);
    const captures = ["capture", "neutral capture"];
    if (get(played, "kind") === "pass") return "pass";
    if (truthy(get(played, "suicidal")) && !(truthy(threat) && reply !== get(played, "cell"))) return "suicidal";
    if (truthy(get(best, "uses_doomed")) && !truthy(get(played, "uses_doomed"))) return "doomed";
    if (truthy(threat) && truthy(s.shared_reply.played_allows)) return truthy(get(s.shared_reply, "from_last")) ? "threat" : "standing";
    if (captures.includes(get(best, "kind")) && !captures.includes(get(played, "kind")) &&
        get(bestShown, "good", []).some(c => ["attacks", "defends", "shields", "ends"].some(w => c.includes(w)))) return "capture";
    if (truthy(sure) && sure === best.cell) return "key";
    if (quotedLine(s).length && s.best_pv[0] === played.cell && sure === best.cell) return "urgent";
    if (get(played, "locality") === "elsewhere" && ["local", "answer"].includes(get(best, "locality"))) return "tenuki";
    const kinds = new Set();
    for (const c of get(bestShown, "good", [])) {
      for (const [k, words] of Object.entries(KINDS)) if (words.some(w => c.startsWith(w) || c.includes(` ${w}`))) kinds.add(k);
    }
    kinds.delete("lines");
    if (kinds.size >= 2 && get(bestShown, "good", []).length > get(playedShown, "good", []).length) return "control";
    if (truthy(get(played, "suicidal"))) return "suicidal";
    return null;
  }

  // The distance between two cells given by name (not used by the text; kept with the Python).
  function cellDistance(a, b) {
    const [[ra, ca], [rb, cb]] = [a, b].map(n => [Number(n.slice(1)) - 1, n.charCodeAt(0) - 65]);
    const dr = ra - rb, dc = ca - cb;
    return Math.max(Math.abs(dr), Math.abs(dc), Math.abs(dr - dc));
  }

  function chance(w) {
    return w > .99 ? "over 99%" : w < .01 ? "under 1%" : percent(w);
  }

  // A commented move of a close finish after which the lead is the opponent's: the entry says "The lead changes
  // hands here", and "How the game went" counts it (see courseText).
  function changesLead(s) {
    return truthy(get(s, "close")) && truthy(get(s.played, "cell")) && get(s, "value_best", 0) >= .25 && get(s, "value_played", 0) <= -.25;
  }

  // 'winning chances from about 94% to 55%'; near certainty a percentage would read 100% or 0%.
  function chancesDrop(before, after) {
    if (.01 <= before && before <= .99 && .01 <= after && after <= .99)
      return f`winning chances from about ${percent(before)} to ${percent(after)}`;
    const about = w => w > .99 || w < .01 ? chance(w) : f`about ${percent(w)}`;
    return f`winning chances from ${about(before)} to ${about(after)}`;
  }

  // Winning chances are worth quoting only when they add to the points: a big drop, a clearly winning position
  // given away, or a game left clearly lost.
  function dramatic(before, after) {
    return before - after >= .3 || (before >= .75 && after <= .5) || (before >= .5 && after <= .25);
  }

  // Python's $ also matches before a final newline, and its . is anything but a newline
  const OPENS = /^opens ([^\n]+) \((\d+) new cells within reach\)\n?$/;
  const AREAS = ["is the first move into an area nobody controls", "invades"];

  // The number of new cells in an "opens ..." clause, or null for any other clause.
  function reach(clause) {
    const m = OPENS.exec(clause);
    return m ? Number(m[2]) : null;
  }

  // All the new cells a move brings within reach, including a line it takes over from the opponent.
  function totalReach(facts) {
    if (get(facts, "reach") !== null) return facts.reach || null;
    for (const c of get(facts, "good", [])) if (reach(c) !== null) return reach(c);
    return null;
  }

  // Early in the game almost every move opens lines, so their names say little: keep only the count. A line
  // taken over keeps its name: two moves can take over different lines opened by the same stack.
  function unnamed(text) {
    text = subWord(/opens [^()]+? \((\d+) new cells within reach\)/g, m => `reaches ${m[1]} new cells`, text);
    text = subWord(/open [^()]+? \((\d+) new cells within reach\)/g, m => `reach ${m[1]} new cells`, text);
    return text;
  }

  function clearlyMore(a, b) {
    return a !== null && b !== null && a >= b + 3 && a >= 1.3 * b;
  }

  // Copies of the two moves' facts for the text, without what both do (the same clause, attacks on the same
  // stacks, development) and with the development compared instead: "reaches more new cells (21 against 15)".
  function contrast(played, best) {
    let pg = [...get(played, "good", [])], bg = [...get(best, "good", [])];
    for (const c of [...pg]) {
      if (bg.includes(c)) {
        pg.splice(pg.indexOf(c), 1);
        bg.splice(bg.indexOf(c), 1);
      }
    }
    const playedAttacks = get(played, "attacks", []), bestAttacks = get(best, "attacks", []);
    const shared = playedAttacks.filter(a => bestAttacks.includes(a));
    const isAttack = c => c.includes("attacks") && !c.startsWith("threatens");
    if (shared.length && playedAttacks.every(a => shared.includes(a))) pg = pg.filter(c => !isAttack(c));
    if (shared.length && bestAttacks.every(a => shared.includes(a))) bg = bg.filter(c => !isAttack(c));
    const po = totalReach(played), bo = totalReach(best);
    if (po && bo) {
      pg = pg.filter(c => reach(c) === null);
      bg = bg.filter(c => reach(c) === null);
      if (clearlyMore(bo, po)) bg.push(f`reaches more new cells (${bo} against ${po})`);
      else if (clearlyMore(po, bo)) pg.push(f`reaches more new cells (${po} against ${bo})`);
    }
    return [mergeArea({...played, good: pg}), mergeArea({...best, good: bg})];
  }

  // 'reaches 12 new cells' and 'is the first move into an area nobody controls' describe one development.
  function mergeArea(facts) {
    const good = [...get(facts, "good", [])];
    const dev = good.find(c => reach(c) !== null || c.startsWith("reaches"));
    if (dev && good.includes(AREAS[0])) {
      good[good.indexOf(dev)] = dev + ", in an area nobody controls yet";
      good.splice(good.indexOf(AREAS[0]), 1);
    }
    return {...facts, good};
  }

  // The clauses worth saying: a small development (four cells or fewer) is dropped when the move does something
  // else as well.
  function trim(facts, keepSmall = false) {
    let good = [...get(facts, "good", [])];
    // a reinforcement is not an invasion: the stack stood there already
    if (get(facts, "kind") === "reinforcement") good = good.filter(c => c !== "invades");
    const small = good.filter(c => reach(c) !== null && reach(c) <= 4);
    if (small.length && good.length > small.length && !truthy(keepSmall)) good = good.filter(c => !small.includes(c));
    return {...facts, good};
  }

  // Clauses beyond plain development: captures, attacks, defences, cuts, blocks.
  function concreteClauses(facts) {
    return get(facts, "good", []).filter(c => reach(c) === null && !c.startsWith("reaches") && !AREAS.includes(c) &&
      !c.includes("in an area nobody controls yet"));
  }

  // The cells of the region that lie on a line the move opens, and that line: [line, cells].
  function regionLine(region, facts, skip = []) {
    if (!truthy(region)) return [null, []];
    for (const o of get(facts, "opened", [])) {
      const cells = region.around.filter(c => o.cells.includes(c) && !skip.includes(c));
      if (cells.length) return [o.line, cells];
    }
    return [null, []];
  }

  // The area that carries the difference, when one does: at least 70% of the loss in one area on the better
  // move's side, and nothing over 30% going the other way (see CONCEPTS.md).
  function clearRegion(s) {
    const regions = or(get(s, "regions"), []), loss = get(s, "loss", 0);
    if (!regions.length || loss < 2) return null;
    const top = regions[0], against = Math.max(0, ...regions.filter(r => r.cells < 0).map(r => -r.cells));
    return top.cells > 0 && top.cells >= .7 * loss && against <= .3 * loss ? top : null;
  }

  // When the first effects of the better move don't explain the difference: where on the board it shows up
  // (ownership along the engine's lines), or else the engine's line itself, so the reader can play it out.
  // Returns [words or null, whether an area was named].
  function whyElse(s, bc, region = null) {
    if (truthy(get(s, "lines"))) {              // the areas and the engine's two lines follow at the end of the entry
      s.wants_lines = true;
      return [null, namedAreas(s.lines)[0].length > 0];
    }
    const top = or(region, clearRegion(s));
    if (truthy(top)) return [f`most of the difference shows up ${top.where}, around ${listing(top.around)}`, true];
    const pv = or(get(s, "best_pv"), []);
    if (pv.length >= 2) return [f`the engine's line after ${bc} goes on ${pv.slice(0, 4).join(" ")}`, false];
    return [null, false];
  }

  // When the move played does what the better move does, one sentence: what both do, then the difference.
  function similarMoves(played, best, shownBest, pc, bc, attacked = false, region = null, sheet = null) {
    const common = get(played, "good", []).filter(c => reach(c) === null && !AREAS.includes(c)).map(c => would(c));
    const po = totalReach(played), bo = totalReach(best);
    const level = Boolean(po && bo && !clearlyMore(bo, po) && !clearlyMore(po, bo));
    if (!common.length && !level) return null;
    const diffs = [...get(shownBest, "good", [])];
    const hp = get(played, "height"), hb = get(best, "height");
    if (get(played, "kind") === get(best, "kind") && get(best, "kind") === "placement" && hp && hb && hb > hp)
      diffs.push(f`is a ${hb}-stack instead of a ${hp}-stack` + (truthy(attacked) ? " (so it is harder to attack)" : ""));
    const [line, cells] = regionLine(region, best, [pc, bc]);
    if (line && !diffs.some(c => cells.some(cell => c.includes(cell))))
      diffs.push(f`opens ${line} towards ${listing(cells)}, where most of the difference lies`);
    let text;
    if (common.length) text = f`${pc} and ${bc} both ${listing(common)}` + (level ? ", and develop about as much" : "");
    else text = f`${pc} and ${bc} develop about as much`;
    // a stack that can be captured at once is the whole difference between two moves that do the same things
    const flaw = truthy(get(played, "suicidal")) ? f`${pc} can be captured straight away` : null;
    if (diffs.length) return text + (flaw ? f`, but ${flaw}, and ${bc} ${listing(diffs)}.` : f`, but ${bc} ${listing(diffs)}.`);
    if (flaw) return text + f`, but ${flaw}.`;
    const [why, found] = truthy(sheet) ? whyElse(or(sheet, {}), bc, region) : [null, false];
    if (sheet !== null && sheet !== undefined) {
      sheet.unexplained = !found;
      sheet.region_said = found;
    }
    return text + (why ? f`; ${why}.` : ".");
  }

  // The cells past c on the line from a through c. b: a board with beyond() (the local board of review-select.js).
  function beyond(b, a, c) {
    return b.beyond(a, c);
  }

  // "G7" for a placement, "capturing G7", "reinforcing D5": a cell that holds a stack is named with what the move
  // does to it, so that it is not read as the stack.
  function alternativeWords(a) {
    const kind = get(a, "kind");
    return kind === "capture" ? f`capturing ${a.cell}` : kind === "neutral capture" ? f`capturing the neutral stack at ${a.cell}` :
      kind === "reinforcement" ? f`reinforcing ${a.cell}` : a.cell;
  }

  // The search expects the stack just played to be captured before the end (three chances in four or more, the
  // survives facts) and gives the better move's stack clearly more of a chance. Not for a stack that can be
  // captured at once, which the text says in its own words.
  function doomedStack(s) {
    const found = get(or(get(s, "lines"), {}), "survives");
    if (!truthy(found) || found.played === null || found.played === undefined || found.best === null ||
        found.best === undefined || truthy(get(s.played, "suicidal"))) return false;
    return found.played <= -.5 && found.best >= found.played + .5;
  }

  // Where the points are, the better move does something and the move played does not (the presence facts):
  // ["keeps Red out of C6 along the lower left edge and makes D7 and C5 playable", "C4 does nothing there"].
  // A cell the better move takes from the opponent and opens for the mover is named once, as taken. Only for a
  // move played that is absent from the area: no safe cell taken or opened and at most two new lines of sight
  // ("does neither", not "does nothing there", when it has any), or a single cell against three or more of
  // the better move ("A2 only makes E6 playable there"). null otherwise; the second part is null for a pass.
  function presenceClause(s) {
    const found = get(or(get(s, "lines"), {}), "presence");
    const pc = get(s.played, "cell"), bc = s.best.cell, them = OTHER[s.colour];
    if (!truthy(found)) return null;
    const best = found.best, played = found.played;
    const opens = best.opens.filter(c => !best.takes.includes(c));
    const mine = played.takes.length + played.opens.filter(c => !played.takes.includes(c)).length;
    // absent: no cell and at most two new lines of sight, or one cell against three or more of the better move
    if (mine > 1 || played.sees > 2 || (mine && best.takes.length + opens.length < 3)) return null;
    const parts = [];
    if (best.takes.length) parts.push(f`keeps ${them} out of ${listing(best.takes.slice(0, 3))}`);
    if (opens.length) parts.push(f`makes ${listing(opens.slice(0, 3))} playable`);
    if (!parts.length && best.sees >= 3 && !played.sees) parts.push(f`adds a ${s.colour} line of sight on ${best.sees} cells`);
    if (!parts.length) return null;
    parts[0] += f` ${found.where}`;
    const tail = played.takes.length ? f`only keeps ${them} out of ${played.takes[0]} there` :
      played.opens.length ? f`only makes ${played.opens[0]} playable there` :
      !played.sees ? "does nothing there" : parts.length === 2 ? "does neither" : "does not";
    return [parts.join(" and "), truthy(pc) ? f`${pc} ${tail}` : null];
  }

  // Where the points go, from the search's ownership after the two moves (lines.py): the stacks that change
  // hands in the engine's two lines and the areas where the better move ends with more and with less. The lines
  // themselves are printed only with such a stack, or when the entry has nothing else to say for the better move.
  function lineSentences(s, stacksToo = true) {
    if (!truthy(get(s, "lines"))) return [];
    return sentences(s.lines, s, truthy(get(s, "wants_lines")), stacksToo);
  }

  function also(what) {
    return what.startsWith("is ") ? f`it is also ${what.slice(3)}` : f`it also ${what}`;
  }

  // A sentence for the details of an entry: true and checked like the rest, but not part of the reason the entry
  // gives. It is marked by two more spaces of indentation, and commentary moves such sentences to the end.
  const MORE = "  ";
  function more(x) {
    return MORE + x;
  }

  // [main lines, detail lines] of an entry as commentary and keyMoves give it.
  function entryParts(words) {
    const lines = words.split("\n  ");
    return [lines.filter(x => !x.startsWith(MORE)), lines.filter(x => x.startsWith(MORE)).map(x => x.slice(MORE.length))];
  }

  // One lesson, kept short: the threat (once), the move played, the better move and what it changes, and the
  // opponent's answer only when it adds something. Each fact once per entry; a point explained in a recent
  // entry is referred to by its move number. used: a Used (the same one for every entry of a game).
  function commentary(sheet, used = null) {
    used = used === null || used === undefined ? new Used() : used;
    const s = sheet;
    s.region_said = s.unexplained = s.wants_lines = s.area_said = false;
    s.lesson_kind = null;
    const notes = new Set();              // what the entry turns out to say, for the lesson (NOTED)
    const lf = get(s, "lines");
    const me = s.colour, them = OTHER[s.colour];
    const played = s.played, best = s.best;
    const pc = played.cell === undefined ? null : played.cell, bc = best.cell === undefined ? null : best.cell;
    const n = s.move_number;
    let reply = or(get(s, "reply"), {});
    const rc = quotedReply(s);
    if (truthy(get(reply, "cell")) && !rc) reply = {};      // a reply the search was not sure of is not quoted
    const nxt = or(get(s, "next"), {});
    const actual = get(nxt, "move");
    const nf = or(get(s, "next_facts"), {});
    const bestPv = quotedLine(s);
    const side = get(s, "side", 8);
    const early = n <= Math.floor((3 * side * (side - 1) + 1) / 4);
    // what the better move does to the cells the opponent wanted: the kind, and the whole saved record
    const afterBest = new Map(), heights = new Map();
    for (const [k, v] of Object.entries(or(get(s, "after_best"), {}))) {
      afterBest.set(k, Array.isArray(v) ? (v[0] === undefined ? null : v[0]) : v);
      if (Array.isArray(v)) heights.set(k, v);
    }
    const after = c => afterBest.has(c) ? afterBest.get(c) : null;
    const wb = get(s, "win_before", .5), wa = get(s, "win_after", .5);
    // the move number of a recent entry (at most 8 moves back) that explained this point, or null
    const recent = (kind, cell, who) => {
      let found = null;
      for (const u of used) {
        if (Array.isArray(u) && u.length >= 4 && u[0] === kind && u[1] === cell && u[2] === who && 0 < n - u[3] && n - u[3] <= 8 &&
            (found === null || u[3] < found)) found = u[3];
      }
      return found;
    };
    // decided games (see settled): one sentence, with what the better move does
    const decided = truthy(get(s, "decided", (wb > .9 && wa > .85) || wb < .1));
    const behind = decided && wb < .5;          // the side a review is for: its mistakes are still lessons, in full
    if (decided && !behind) {
      const what = listing(concreteClauses(trim(mergeArea(best))));
      const better = what ? f`${bc}, which ${what},` : bc;
      return [f`Move ${n}, ${named(me, s.player)}: ${pc || "a pass"}. ${me} was well ahead and stayed ahead, ` +
              f`so the loss doesn't decide the game; ${better} was about ${points(s.loss)} better.`]
        .concat(lineSentences(s, false).map(more)).join("\n  ");
    }
    // the chances before the move are those the entry on the move before ended with, when there is one: two
    // searches of one position differ a little, and in a close finish a little is "28% for White" above "90% for Red"
    let wf = get(s, "win_from", null);
    wf = wf === null || wf === undefined || wf <= wa ? wb : wf;
    let out = [f`Move ${n}, ${named(me, s.player)}: ` + (pc || "a pass") + f`, about ${points(s.loss)} worse than ${bc}` +
               (dramatic(wf, wa) || (s.loss < 5 && wf - wa >= .12) ? f` (${chancesDrop(wf, wa)}).` : ".")];
    // in a close finish, the move after which the lead is the opponent's
    if (changesLead(s))
      out.push(f`The lead changes hands here: ${me} was about ${points(s.value_best)} ahead before ${pc} and is about ` +
               f`${points(-s.value_played)} behind after it.`);
    if (behind && !used.has(["behind", me])) {            // said once per player
      used.add(["behind", me]);
      out.push(f`By now the game was very hard for ${me} (${chance(wb)} to win), so this and ${me}'s later entries are ` +
               "about the play, not the result.");
    }
    // ---- the threat
    const sr = s.shared_reply;
    const srFacts = get(sr, "facts", {});
    const concrete = get(srFacts, "good", []).some(c => CONCRETE.concat(["invades", "first move into"]).some(w => c.includes(w)));
    const stopsIt = !truthy(sr.best_allows) && !truthy(get(sr, "survives_best"));
    const weakens = !stopsIt && ["gone", "weaker", "exposed"].includes(after(get(sr, "cell")));
    // "then has no time for the threat" is claimed from the small searches behind the shared reply; the deeper
    // search after the better move must not begin with that very move
    const outpaces = !truthy(sr.best_allows) && truthy(get(sr, "survives_best")) && truthy(get(best, "attacks")) &&
      !(or(get(s, "best_pv"), []).length && s.best_pv[0] === get(sr, "cell"));    // the line as the search gave it
    const threat = (truthy(sr.cell) && sr.share >= .6 && sr.legal >= 8 && concrete && truthy(sr.played_allows) &&
                    (sr.cell === bc || stopsIt || outpaces || weakens)) ? sr.cell : null;
    // How the better move deals with the threat the entry has named, for the sentences that would otherwise leave
    // it hanging.
    const answersThreat = (subject = null, said = "") => {
      // said: the sentence it would follow; when that names the threatened point already, nothing is added
      if (!threat || threat === bc || new RegExp("\\b" + threat + "\\b").test(said)) return "";
      const cut = or(get(sr, "cut_by_best"), []);
      subject = subject || bc;
      const afterIt = subject === bc ? subject : subject[0].toLowerCase() + subject.slice(1);
      return stopsIt && cut.length ? f` ${subject} also cuts ${listing(cut)}'s line of sight to ${threat}.` :
        stopsIt ? f` ${subject} also stops ${threat}.` : weakens ? f` ${subject} also weakens ${threat}.` :
        outpaces ? f` After ${afterIt}, ${them} has no time for ${threat}.` : "";
    };
    if (threat) {
      const seenThreat = recent("threat", threat, them);
      const seen = seenThreat || recent("best", threat, them);
      const kind = get(srFacts, "kind");
      let to = kind === "neutral capture" ? f`to capture the neutral stack at ${threat}` :
        kind === "capture" ? f`to capture ${threat}` : f`to play ${threat}`;
      if (seen && seenThreat) {
        out.push(f`${them} was still threatening ${to} (see move ${seen}).`);
      } else if (seen && recent("threat", threat, me) === seen) {
        // the earlier entry called it this side's threat and the other side's better move: nobody took it
        out.push(f`${threat} was still the point both sides wanted (see move ${seen}).`);
      } else if (seen) {                // the opponent's better move of an earlier entry, still there to be played
        out.push(f`${them} could still ${to.slice(3)} (see move ${seen}).`);
      } else {
        const clauses = get(trim(sr.facts), "good", []);
        let tail;
        if (kind === "capture" || kind === "neutral capture") {
          // The capture is the threat itself, so the stack is named once, with its height, and only what else
          // taking it would do follows. It used to read "threatened to capture K10, which would capture a 2-stack".
          const height = get(or(get(sr.facts, "before"), {}), "height");
          if (kind === "capture" && truthy(height))
            to = f`to capture the ${truthy(get(sr.facts, "lone")) ? "lone " : ""}${height}-stack at ${threat}`;
          const effect = listing(clauses.filter(c => !c.startsWith("captures ")).map(c => would(c)));
          tail = effect ? f`, which would also ${effect}` : "";
        } else {
          tail = ", which would " + (listing(clauses.map(c => would(c))) || "be very strong");
        }
        const who = truthy(get(sr, "from_last")) && truthy(s.previous) ? f`${them}'s last move, ${s.previous}, threatened` :
          f`${them} was threatening`;
        out.push(f`${who} ${to}${tail}.`);
      }
      used.add(["threat", threat, them, n]);
    }
    // ---- the move played
    let [shownPlayed, shownBest] = pc ? contrast(played, best) : [played, best];
    shownPlayed = trim(shownPlayed);
    shownBest = trim(shownBest);
    const good = get(shownPlayed, "good");
    const prev = n > 3 ? s.previous : null;
    const targets = get(played, "attacks", []);
    let betterDone = false, say = "", similar = null;
    // thin: the entry's reason for the better move is no more than development (or nothing at all); then how it
    // takes a cell from the opponent, or else where it ends with more, belongs to the main text
    let thin = false;
    // the two moves do the same things: also when all that is left of the move played is that it reaches more cells
    // ("H6 does reach more new cells, but that is not enough here" hid that H6 could be captured at once)
    const onlyReach = truthy(good) && good.every(c => c.startsWith("reaches more new cells"));
    const shared = get(played, "good", []).filter(c => get(best, "good", []).includes(c) && reach(c) === null && !AREAS.includes(c));
    if (pc && truthy(get(played, "good")) && !threat && (!truthy(good) || (onlyReach && shared.length))) {
      const topRegion = or(get(s, "regions"), [null])[0];
      const hit = get(nf, "attacks", []).includes(pc) || get(reply, "attacks", []).includes(pc);
      similar = similarMoves(played, best, shownBest, pc, bc, hit,
        truthy(topRegion) && topRegion.cells >= .5 * s.loss && !truthy(lf) ? topRegion : null, s);
      if (similar) {
        say = similar;
        betterDone = true;
        thin = !similar.includes(", but ");
      }
    }
    const won = [...new Set(targets.filter(t => get(played, "wins", []).includes(t)))].sort();
    const attackClause = truthy(good) ? or(good.find(c => c.includes("attacks")), null) : null;
    if (pc && !similar) {
      if (won.length && attackClause) {
        const rest = good.filter(c => c !== attackClause);
        let whatB = truthy(get(shownBest, "good")) ? does(shownBest) : null;
        const again = recent("best", bc, me);
        if (!whatB && !again) {            // "J5 wins J4 and J6, but D6 was worth more": what D6 does, at least
          const there = presenceClause(s);
          whatB = there ? there[0] : null;
          thin = !there;
        } else if (!again) {
          thin = !concreteClauses(shownBest).length;
        }
        // the better move wins no other stack than the move played does: then the stack is not the reason
        const same = truthy(get(best, "wins")) && best.wins.every(c => won.includes(c));
        thin = thin && (!truthy(get(best, "wins")) || same);
        const better = again ? f`${bc} (see move ${again})` : whatB ? f`${bc}, which ${whatB},` : bc;
        const leansW = get(played, "uses_doomed", []).filter(d => !get(best, "uses_doomed", []).includes(d));
        const caveat = leansW.length ?
          f`, but it relies on ${listing(leansW)}'s line of sight, and ${listing(leansW)} can't be saved this turn;` : "";
        const joint = caveat || ",";
        // when the better move also wins a stack, that is the whole contrast: "H15 wins J15, which is worth more"
        const bestWins = truthy(get(best, "wins"));
        const betterTxt = !bestWins ? better : same ? f`${bc} wins ${listing(best.wins)} too and` : f`${bc} wins ${listing(best.wins)}, which`;
        say = f`${pc} ${listing([f`wins ${listing(won)}`].concat(rest))}` + joint +
              (caveat ? " " : " but ") + (!bestWins ? f`${betterTxt} was worth more` : f`${betterTxt} is worth more`) + ".";
        say = say.split(",,").join(",");
        notes.add("greedy");
        // the threat said above must not be left hanging, unless the sentence names the point already
        if (threat && threat !== bc && !new RegExp("\\b" + threat + "\\b").test(say)) {
          const cut = or(get(sr, "cut_by_best"), []);
          const saves = get(srFacts, "defends_ahead", []).concat(get(srFacts, "defends", []))
            .filter(c => get(best, "wins", []).includes(c));
          say += saves.length ? f` Then ${threat} would come too late to save ${listing(saves)}.` :
            stopsIt && cut.length ? f` ${bc} also cuts ${listing(cut)}'s line of sight to ${threat}.` :
            stopsIt ? f` ${bc} also stops ${threat}.` :
            weakens ? f` ${bc} also weakens ${threat}.` :
            outpaces ? f` After ${bc}, ${them} has no time for ${threat}.` : "";
        }
        betterDone = true;
      } else if (get(best, "kind") === "capture" && get(played, "good", []).some(c => c.startsWith("leaves") && c.endsWith(bc)) &&
                 !truthy(get(played, "suicidal"))) {         // a stack that is captured at once makes sure of nothing
        const rest = {...shownBest, good: get(shownBest, "good", []).filter(c => !c.startsWith("captures"))};
        const others = good.filter(c => !(c.startsWith("leaves") && c.endsWith(bc)));
        say = f`${pc} makes sure of ${bc}` + (others.length ? f` and ${listing(others)}` : "") +
              ", but capturing it at once was bigger" + (rest.good.length ? f`: ${also(does(rest))}.` : ".");
        say += answersThreat(f`Capturing ${bc}`, say);                  // not after "it also ends the attack on J10"
        betterDone = true;
      } else if (prev && get(played, "locality") === "local" && equal(get(played, "attacks"), [prev]) && attackClause) {
        const rest = {...shownPlayed, good: good.filter(c => c !== attackClause)};
        const lasts = attackClause.includes(" while ") ? attackClause.slice(attackClause.indexOf(" while ")) : "";
        say = f`${pc} answers ${prev} by attacking it${lasts}` + (rest.good.length ? f`; ${also(does(rest))}.` : ".");
      } else if (prev && get(played, "locality") === "elsewhere" && ["local", "answer"].includes(get(best, "locality")) && !threat) {
        say = f`${pc} ignores ${prev} and plays elsewhere` + (truthy(good) ? f`: it ${does(shownPlayed)}.` : ".");
      } else if (threat && !concreteClauses(shownPlayed).length) {
        const part = or(get(played, "partial_defence"), []);
        const targetsT = [threat].concat(get(srFacts, "attacks", []));
        if (part.length && part.some(c => targetsT.includes(c))) {
          say = f`${pc} adds a line of sight on ${listing(part)}, but not enough to defend it.`;
        } else {
          say = f`${pc} does nothing about ${threat}` +
                (part.length ? f`; it adds a line of sight on ${listing(part)}, but not enough to defend it.` : ".");
        }
      } else if (truthy(good) && good.every(c => c.startsWith("reaches more new cells"))) {
        say = f`${pc} does reach ${good[0].slice("reaches ".length)}, but ` +
          (truthy(get(shownPlayed, "bad")) ? f`it ${listing(shownPlayed.bad)}.` : "that is not enough here.");
      } else if (truthy(good)) {
        say = f`${pc} ${does(shownPlayed)}.`;
      } else if (truthy(get(played, "partial_defence"))) {
        say = f`${pc} adds a line of sight on ${listing(played.partial_defence)}, but not enough to defend it.`;
      } else if (bestPv.length && bestPv[0] === pc) {
        say = f`${pc} takes a point ${them} also wants, but ${bc} is bigger: after ${bc}, ${them} would answer at ${pc}.`;
      } else if (truthy(get(played, "good"))) {
        const po = totalReach(played), bo = totalReach(best);
        if (truthy(get(reply, "blocks_previous"))) {
          say = actual === rc ? f`${pc} develops, but ${them}'s ${rc} took its new line straight away.` :
            f`${pc} develops, but ${them}'s ${rc} can take its new line straight away.`;
        } else if (po && bo && clearlyMore(bo, po)) {
          // the better move's sentence gives this comparison ("which reaches more new cells (16 against 7)"),
          // unless it only points back to an earlier entry
          say = recent("best", bc, me) ? f`${pc} reaches fewer new cells than ${bc} (${po} against ${bo}).` : "";
        } else {
          say = f`${pc} develops about as much as ${bc}.`;
        }
      } else if (truthy(get(played, "suicidal"))) {
        say = f`${pc} can be captured straight away.`;
      } else {
        say = f`${pc} neither attacks nor defends anything, and opens no new lines.`;
      }
      // a doomed stack the move relies on, in the same sentence's neighbourhood
      const leans = get(played, "uses_doomed", []).filter(d => !get(best, "uses_doomed", []).includes(d));
      if (say && leans.length && (truthy(targets) || truthy(get(played, "defends"))) && !/while [^.,;]* lasts?\b/.test(say) && !say.includes("relies on"))
        say = say.slice(0, -1) + f`, but it relies on ${listing(leans)}'s line of sight, and ${listing(leans)} can't be saved this turn.`;
      // how the opponent deals with an attack
      const met = targets.filter(t => rc && rc !== pc && get(reply, "defends", []).includes(t) && !get(best, "attacks", []).includes(t));
      const did = actual === rc;
      // (not for a stack that was captured at once in the game)
      if (say && met.length && met.length === targets.length && !won.length &&
          !(truthy(get(played, "suicidal")) && actual === pc)) {
        const but = say.includes(", but ") ? " And" : " But";       // not two "but"s in a row
        if (get(reply, "kind") === "capture" && bestPv.length && bestPv[0] === rc) {
          say += f` ${them} captures ${rc} next either way, and that ends the attack.`;
        } else if (get(reply, "kind") === "capture") {
          say += did ? f`${but} ${them} simply captured ${rc}, which ended the attack.` :
            f`${but} ${them} can simply capture ${rc}, which would end the attack.`;
          notes.add("parried");
        } else if (rc === threat || (bestPv.length && bestPv[0] === rc)) {
          say += f`${but} that only hurries ${rc}, which ${them} wants to play anyway: it defends ${listing(met)}.`;
          notes.add("hurried");
        } else {
          say += f`${but} ${them} simply defends with ${rc}` + (did ? ", as played." : ".");
          notes.add("parried");
        }
        reply = {...reply, _said: true};
      } else if (say && truthy(targets) && !won.length && rc && rc !== pc && !targets.includes(rc) && s.loss >= 2 &&
                 !targets.some(t => get(reply, "defends", []).includes(t)) && truthy(good) &&
                 good.some(c => c.includes("attacks")) &&
                 good.every(c => c.includes("attacks") || c.startsWith("cuts") || c.startsWith("threatens"))) {
        // not above a line in which the mover goes on to capture the stack: the opponent's best move is elsewhere,
        // and the stack is what it costs
        const falls = targets.filter(t => truthy(lf) && lf.played.won.some(i => i.cell === t));
        say += falls.length ? f` ${them} can let ${listing(falls)} go for a bigger point elsewhere.` :
          f` ${them} can ignore ${targets.length > 1 ? "the attacks" : "the attack"} for now.`;
        notes.add("ignored");
      }
      if (say && get(nf, "attacks", []).includes(pc) && actual === rc && !truthy(get(nf, "suicidal")) && !truthy(get(reply, "_said"))) {
        // a capture is not "White's J9" when J9 was Red's stack
        say += ["capture", "neutral capture"].includes(get(nf, "kind")) ? f` ${them} captured ${actual}, which attacked ${pc} at once.` :
          f` ${them}'s ${actual} attacked ${pc} at once.`;
        reply = {...reply, _said: true};
      }
      if (truthy(get(played, "suicidal")) && actual === pc) {
        reply = {...reply, _said: true};
        say += say.includes("captured straight away") ? f` ${them} did capture it.` : f` ${them} captured it at once.`;
      }
      const wasBest = recent("best", pc, me);
      if (wasBest) say = f`${pc} was the better move at move ${wasBest}, but it comes too late now. ` + say;
    }
    // the takeaway of such an entry is "use a doomed stack's lines of sight": when the better move has no sentence
    // of its own (two similar moves, "... but H5 was worth more"), say that it does
    const leaning = get(best, "uses_doomed", []).filter(c => !get(played, "uses_doomed", []).includes(c));
    if (say && betterDone && leaning.length && !/line of sight|while [^.,;]* lasts?\b/.test(say))
      say += f` ${bc} also uses ${listing(leaning)}'s line of sight while ` + (leaning.length === 1 ? "it lasts." : "they last.");
    if (say) {
      out.push(say);
      if (say.includes("own secure land")) notes.add("ownland");
      // the height is all the difference
      if (similar && new RegExp(", but " + bc + " is a \\d+-stack instead of a \\d+-stack").test(say)) notes.add("taller");
    }
    // ---- the better move
    let kept = [];
    const unsafe = [];
    if (truthy(get(sr, "cell")) && !truthy(sr.best_allows) && truthy(sr.played_allows) && sr.share >= .6 &&
        ![threat, bc].includes(sr.cell) && after(sr.cell) === "gone") kept.push(sr.cell);
    const aboutBc = get(reply, "defends", []).includes(bc) || get(reply, "attacks", []).includes(bc);
    if (rc && ![threat, bc, pc].includes(rc) && get(reply, "kind") !== "capture" && !aboutBc && after(rc) === "gone") kept.push(rc);
    if (actual && ![rc, bc, threat].includes(actual) && after(actual) === "gone" &&
        !get(nf, "defends", []).includes(bc) && !get(nf, "attacks", []).includes(bc)) kept.push(actual);
    for (const c of [get(sr, "cell"), rc, actual]) {
      // a stack the better move defends is not news a second time ("defends C9 ... keeps White from playing C9")
      if (c && ![threat, bc, pc].includes(c) && after(c) === "exposed" && !unsafe.includes(c) &&
          !get(best, "defends", []).includes(c) && !get(best, "defends_ahead", []).includes(c)) unsafe.push(c);
    }
    kept = [...new Set(kept)];
    // cells on the line the better move takes over or blocks are already counted in its "cells cut off"
    if (prev && get(shownBest, "good", []).some(c => c.includes("cells cut off"))) {
      const cutOff = beyond(localBoard(side), prev, bc);
      kept = kept.filter(c => !cutOff.includes(c));
    }
    // a cell made impossible by cutting or capturing the line of sight that made it playable: say how, and why the
    // cell mattered, in a sentence of its own ("I10 would also have cut J11's line of sight to B3, ...")
    const explained = [], hows = [], whys = [], done = [];
    for (const c of kept) {
      let why = get(or(get(s, "after_best"), {}), c, [null, null, null, null]);
      why = why.length > 3 ? why[3] : null;
      if (!truthy(why) || !(truthy(get(why, "cut")) || truthy(get(why, "captured")))) continue;
      done.push(c);
      if (get(best, "defends", []).includes(c)) continue;             // "K7 shields H7" already says it
      hows.push([truthy(get(why, "cut")) ? [...why.cut] : null, c]);
      const captured = c === actual && ["capture", "neutral capture"].includes(get(nf, "kind"));
      whys.push(c === rc ? f`after ${pc || "the pass"}, ${c} was ${them}'s best reply` :
        c === actual ? f`${them} ${captured ? "captured" : "played"} ${c} in the game` :
        f`${c} was ${them}'s best answer to almost any move`);
    }
    if (hows.length) {
      const groups = new Map();                          // "E3's lines of sight to L10 and M11"
      for (const [stacks, c] of hows) {
        const key = JSON.stringify(stacks);
        if (!groups.has(key)) groups.set(key, [stacks, []]);
        groups.get(key)[1].push(c);
      }
      const sight = cells => f`${cells.length === 1 ? "line" : "lines"} of sight to ${listing(cells)}`;
      const cutting = [...groups.values()].filter(([st]) => truthy(st)).map(([st, cells]) => f`${listing(st)}'s ${sight(cells)}`);
      const taken = groups.has("null") ? groups.get("null")[1] : null;
      const verb = (cutting.length ? f`${bc} would also have cut ${listing(cutting)}` : "") +
        (truthy(taken) ? (cutting.length ? f`; capturing it would also have taken away its ${sight(taken)}` :
          f`Capturing ${bc} would also have taken away its ${sight(taken)}`) : "");
      const neither = hows.length === 1 ? "there" : hows.length > 2 ? "any of them" : "either";
      explained.push(f`${verb}, so ${them} couldn't play ${neither}; ` + (whys.length === 2 ? whys.join(", and ") : listing(whys)) + ".");
    }
    kept = kept.filter(c => !done.includes(c));
    // A cell where a stack could be captured at once is not playable either: suicidal placements are not allowed
    // in the rules the reviews are written for (user, November 10), so both kinds read "keeps White from playing H5".
    const barred = kept.concat(unsafe.filter(c => !kept.includes(c)));
    const keeps = barred.length ? f`${them} from playing ${listing(barred)}` : "";
    if (similar && say.startsWith(similar) && !explained.length && !barred.length && !truthy(get(shownBest, "good")) &&
        !truthy(get(played, "suicidal"))) {
      // two moves that do the same things, and nothing to tell them apart but the height of the stack: what the
      // better one does where the points are, and the other does not
      const there = presenceClause(s);
      if (there) {
        s.unexplained = false;
        const tail = there[0] + (there[1] ? f`; ${there[1]}` : "") + ".";
        thin = false;
        notes.add("absent");
        if (say === similar && out.includes(say) && !say.includes(", but ") && !say.includes(";")) {
          // one sentence: "I9 and G3 develop about as much, but G3 keeps Red out of D3 ...; I9 does nothing there."
          const merged = say.slice(0, -1) + f`, but ${bc} ${tail}`;
          out[out.indexOf(say)] = merged;
          say = merged;
        } else {
          const too = say.includes(" also uses ") ? "" : "also ";      // not two sentences in a row with "also"
          out.push(f`${bc} ${too}${tail}`);
        }
      }
    }
    if (!betterDone) {
      const what = truthy(get(shownBest, "good")) ? does(shownBest) : null;
      const again = recent("best", bc, me);
      const dying = get(best, "uses_doomed", []).filter(c => !get(played, "uses_doomed", []).includes(c));
      let stops = "";
      if (threat && outpaces && threat !== bc) {
        const winning = get(best, "attacks", []).filter(a => get(best, "wins", []).includes(a));
        stops = winning.length ? f` ${them} can't defend ${listing(winning)}, and winning it is worth more than ${threat}.` :
          f` ${them} then has no time for ${threat}: the attack on ${listing(best.attacks)} must be answered first.`;
      }
      if (threat && threat === bc) {
        // "taken" for a point or a capture; a stack of one's own is reinforced
        const verb = get(best, "kind") === "reinforcement" ? "reinforced" : "taken";
        out.push(f`${me} should have ${verb} ${bc} first` + (what ? f`: it ${what}.` : "."));
      } else if (again) {
        const said = c => used.entries().some(u => Array.isArray(u) && u.length > 4 && u[0] === "best" && u[1] === bc &&
          u[2] === me && u[3] === again && u[4].includes(c));
        const fresh = concreteClauses(shownBest).filter(c => !said(c));
        const text = f`Better was again ${bc} (see move ${again})` + (fresh.length ? f`, which now ${listing(fresh)}` : "") +
                 (keeps ? f`; it keeps ${keeps}` : "") + ".";
        out.push(text + (stops || answersThreat(null, text)));
      } else if (dying.length) {
        const d = listing(dying);
        // the clause counts only when it leans on one of the stacks the sentence names
        const uses = get(shownBest, "good", []).filter(c => c.includes(" while ") &&
          dying.some(d0 => new RegExp("\\b" + d0 + "\\b").test(c.slice(c.indexOf(" while ") + 7))));
        const rest = get(shownBest, "good", []).filter(c => !c.startsWith("reinforces") && !uses.includes(c));
        const hb = get(best, "height");
        const how = uses.length ? f`makes use of it first: it ${listing(uses)}` :
          hb && get(best, "kind") === "placement" ? f`still counts its line of sight: ${bc} becomes a ${hb}-stack with ${d}'s help` :
          "makes use of its line of sight while it lasts";
        const then = rest.length ? f` It also ${listing(rest)}.` : "";
        // with a counter-threat the stack may live after all: "can't be saved" would contradict "has no time for it"
        const cant = stops ? "can't be defended directly" : "can't be saved this turn";
        const text = f`Better was ${bc}. ${d} ${cant}, but ${bc} ${how}.${then}`;
        out.push(text + (stops || answersThreat(null, text)));
      } else if (threat && stopsIt && get(best, "kind") === "capture" && get(srFacts, "defends", []).includes(bc)) {
        const rest = {...shownBest, good: get(shownBest, "good", []).filter(c => !c.startsWith("captures") &&
          c !== f`ends the attack on ${threat}`)};
        out.push(f`Better was to capture ${bc} first, which stops ${threat}` + (rest.good.length ? f`; ${also(does(rest))}` : "") + ".");
      } else if (threat && stopsIt && get(best, "defends", []).includes(threat)) {
        out.push(what ? f`Better was ${bc}, which ${what}.` : f`Better was ${bc}.`);
      } else if (threat && (stopsIt || weakens)) {
        const cut = or(get(sr, "cut_by_best"), []);
        let phrase;
        if (stopsIt && cut.length && after(threat) === "gone") {
          phrase = f`cuts ${listing(cut)}'s line of sight to ${threat}, so ${them} can no longer play there`;
        } else if (stopsIt && cut.length) {
          phrase = f`stops ${threat} by cutting ${listing(cut)}'s line of sight to it`;
        } else if (stopsIt) {
          phrase = f`stops ${threat}`;
        } else if (after(threat) === "exposed") {
          phrase = f`stops ${threat}`;
        } else if (heights.has(threat)) {
          phrase = f`weakens ${threat} (${them} could only make a ${heights.get(threat)[2]}-stack there, not a ${heights.get(threat)[1]}-stack)`;
        } else {
          phrase = f`weakens ${threat}`;
        }
        out.push(f`Better was ${bc}, which ${phrase}` + (what ? f`; ${also(what)}` : "") + ".");
      } else {
        const cap = get(best, "kind") === "capture" && get(reply, "defends", []).includes(bc) && rc !== threat ?
          f` before ${them} can defend it with ${rc}` : "";
        let text;
        if (cap) {
          const rest = get(shownBest, "good", []).filter(c => !c.startsWith("captures"));
          const others = barred.filter(c => c !== rc);                 // "defend it with H7" already names H7
          const how = rc === bc ? "reinforce it" : f`defend it with ${rc}`;
          text = f`Better was to capture ${bc} at once, before ${them} can ${how}` +
                 (rest.length ? f`; it also ${listing(rest)}` : "") +
                 (others.length ? f`, and it keeps ${them} from playing ${listing(others)}` : "");
        } else if (what) {
          text = f`Better was ${bc}, which ${what}` + (keeps ? f`, and keeps ${keeps}` : "");
          // a count of new cells is seldom the whole reason: when that is all the better move has, add what it
          // does where the points are
          // ... and so is a point it prepares ("which prepares B5, from where it would attack F9")
          const solid = concreteClauses(shownBest).filter(c => !c.startsWith("prepares "));
          // ... and so is a capture when the move played captured a stack at least as tall ("E3 captures a
          // 3-stack ... Better was H7, which captures a 2-stack")
          const taken = c => { const m = /^captures an? (?:lone \w+ )?(\d)-stack/.exec(c); return m ? Number(m[1]) : 0; };
          const outdone = solid.length === 1 && taken(solid[0]) > 0 &&
            Math.max(0, ...get(shownPlayed, "good", []).map(taken)) >= taken(solid[0]);
          const weak = !solid.length || outdone;
          const there = keeps || explained.length || !weak ? null : presenceClause(s);
          thin = weak && !(keeps || there);
          if (there) {
            text += f`. ${bc} also ${there[0]}` + (there[1] ? f`; ${there[1]}` : "");
            notes.add("absent");
          }
        } else if (keeps) {
          text = f`Better was ${bc}, which keeps ${keeps}`;
        } else if (truthy(get(best, "defends_ahead"))) {
          // the detector's clause for a quiet move, when the comparison left the better move nothing else to say
          const ahead = best.defends_ahead;
          text = f`Better was ${bc}, which defends ${listing(ahead)} in advance, before ${them} can attack ` +
            (ahead.length === 1 ? "it" : "them");
        } else {
          const [why, found] = whyElse(s, bc);
          s.unexplained = !found;
          s.region_said = found;
          // nothing to say about the move itself: say at once where it ends better, not three sentences later
          const area = or(lineSentences(s, false).find(x => x.startsWith(f`${bc} leaves `)), null);
          // what the better move does where the points are, unless the entry goes on to say which cells it takes
          // from the opponent ("K9 would also have cut E3's lines of sight to L10 and M11, so ...")
          const there = explained.length ? null : presenceClause(s);
          thin = !there;
          if (there) {
            s.unexplained = false;
            notes.add("absent");
            text = f`Better was ${bc}, which ${there[0]}` + (there[1] ? f`; ${there[1]}` : "");
          } else if (area) {
            s.area_said = true;
            text = f`Better was ${bc}: it` + area.slice(String(bc).length, -1);
          } else {
            text = f`Better was ${bc}` + (why ? f`: ${why}` : "");
          }
        }
        out.push(text + "." + stops);
      }
      if (!again) used.add(["best", bc, me, n, concreteClauses(shownBest)]);
    } else {
      // not the cells the sentence above has just named
      const left = barred.filter(c => !new RegExp("keeps " + them + " out of [^.;]*\\b" + c + "\\b").test(say));
      if (left.length && say === similar && out.includes(say) && !say.includes(", but ") && !say.includes(";")) {
        // one sentence: "B2 and D8 both capture a 2-stack, but D8 keeps Red from playing D9."
        const merged = say.slice(0, -1) + f`, but ${bc} keeps ${them} from playing ${listing(left)}.`;
        out[out.indexOf(say)] = merged;
        say = merged;
        thin = false;
      } else if (left.length) {
        out.push(f`${bc} would also have kept ${them} from playing ${listing(left)}.`);
        thin = false;
      }
      if (!recent("best", bc, me)) used.add(["best", bc, me, n, concreteClauses(shownBest)]);
    }
    // other moves the search of the position values within a point of the better move
    // plain placements first: "F1 and capturing G4", not "capturing G4 and F1", which reads as two captures
    const plainFirst = a => get(a, "kind", "placement") !== "placement" ? 1 : 0;
    const others = listing([...or(get(s, "alternatives"), [])].sort((a, c) => plainFirst(a) - plainFirst(c))
      .filter(a => a.cell !== pc && a.cell !== bc).map(alternativeWords));
    if (others) out.push(more(f`${others[0].toUpperCase()}${others.slice(1)} ${others.includes(" and ") ? "were" : "was"} about as good as ` +
                              f`${alternativeWords({cell: bc, kind: get(best, "kind")})}.`));
    // how the better move takes a cell from the opponent: the reason itself when the entry has no other
    out = out.concat(thin ? explained : explained.map(more));
    let waits = get(played, "defends", []).filter(c => !get(best, "defends", []).includes(c) && bestPv.length && bestPv[0] !== c &&
      !truthy(get(played, "attacks")));
    if (waits.length && truthy(lf)) {     // not "A5 could wait" above a line of the better move that loses A5
      const lostThere = differing(lf)[3].map(i => i.cell);
      waits = waits.filter(c => !lostThere.includes(c));
    }
    if (waits.length) {
      out.push(f`${listing(waits)} could wait: after ${bc}, capturing ${waits.length === 1 ? waits[0] : "either of them"} ` +
               f`is not ${them}'s best move.`);
      notes.add("waits");
    }
    let givenUp = get(played, "defends", []).filter(c => bestPv.length && bestPv[0] === c);
    if (truthy(lf)) {
      if (differing(lf)[3].some(i => givenUp.includes(i.cell))) givenUp = [];   // "G4 does give up B4 in the engine's line" says it
    }
    if (givenUp.length) {
      out.push(f`${bc} lets ${them} take ${givenUp[0]}, but it is worth more.`);
      notes.add("price");
    }
    const keyPoint = Boolean(rc) && rc === bc && threat !== bc;
    if (keyPoint && !out.some(x => x.includes(f`before ${them} can reinforce it`))) {      // that sentence says it
      const wouldDo = listing(concreteClauses(trim(reply)).map(c => would(c)));
      out.push(f`${bc} was the key point: it is exactly where ${them} wants to play next` +
               (wouldDo ? f`; there ${them} would ${wouldDo}.` : "."));
    }
    // ---- what came next, only when it adds something
    if (rc && !truthy(get(reply, "_said")) && !kept.includes(rc)) {
      const playedIt = actual === rc;
      const afterIt = f`After ${pc || "the pass"}`;
      const gm = get(nf, "kind") === "capture" ? f`captured ${actual}` :
        get(nf, "kind") === "neutral capture" ? f`captured the neutral stack at ${actual}` : f`played ${actual}`;
      let see = truthy(get(s, "next_lesson")) ? f` (see move ${s.next_lesson})` : "";
      if (see && get(s, "reply_see") === f`see move ${s.next_lesson}`) see = "";
      const descClauses = concreteClauses(trim(mergeArea(reply)));
      let desc;
      if (truthy(get(s, "reply_see"))) desc = f` (${s.reply_see})`;
      else if (descClauses.length) desc = f`, which ${listing(descClauses)}`;
      else desc = "";
      const costly = get(nxt, "loss", 0) >= 2;
      let line = null;
      if (rc === threat) {
        line = playedIt ? f`${them} did ${["capture", "neutral capture"].includes(get(reply, "kind")) ? "take" : "play"} ${rc}.` : null;
      } else if (keyPoint) {
        // not after "... so Red couldn't play there; Red played D1 in the game."
        line = actual && !playedIt && !out.some(x => x.includes(f` ${actual} in the game`)) ? f`In the game, ${them} ${gm}${see}.` : null;
      } else if (get(best, "uses_doomed", []).includes(rc)) {
        line = f`Either way, ${them} can capture ${rc} next` + (playedIt ? ", and did." : ".");
      } else if (rc === pc) {
        line = !truthy(get(played, "suicidal")) ? f`${them} can capture ${pc} straight back` + (playedIt ? ", and did." : ".") : null;
      } else if (bestPv.length && bestPv[0] === rc) {
        line = desc && !truthy(get(s, "reply_see")) ? f`Either way, ${them}'s next point is ${rc}${desc}.` : null;
      } else if (playedIt) {
        line = desc ? f`${afterIt}, ${them} played ${rc}${desc}.` : null;
      } else if (actual && costly && explained.some(x => x.includes(f`${rc} was ${them}'s best reply`))) {
        // "... after B6, H9 was Red's best reply." has just said what Red should have played
        line = out.some(x => x.includes(f` ${actual} in the game`)) ? null :      // "... and Red played A5 in the game."
          f`In the game, ${them} ${gm}` + (truthy(get(s, "next_lesson")) ? f` (see move ${s.next_lesson}).` : ".");
      } else if (actual && costly && out.some(x => x.includes(f` ${actual} in the game`))) {
        line = f`${afterIt}, ${them} should have played ${rc}${desc}.`;
      } else if (actual && costly) {
        line = f`${afterIt}, ${them} should have played ${rc}${desc}; in the game, ${them} ${gm}${see}.`;
      }
      if (line) {
        // main text: the threat carried out, the stack taken straight back, and a reply aimed at the move played
        // (it attacks it or blocks the line it opened); what the opponent does anyway is a detail
        const aimed = pc && (get(reply, "attacks", []).includes(pc) || truthy(get(reply, "blocks_previous")));
        const central = rc === threat || rc === pc || (aimed && !keyPoint && !line.startsWith("Either way"));
        // for the player of the move it is an answer that was there, whatever the opponent then played
        if (central && line.startsWith(f`${afterIt}, ${them} should have played ${rc}`)) line = f`${them} could answer ${rc}${desc}.`;
        out.push(central ? line : more(line));
      }
    }
    // ---- where the difference lies, when a line the better move opens explains it
    const regions = get(s, "regions", []);
    if (truthy(lf)) {
      // not again what the entry has just said: the area folded into "Better was ...", and a capture the opponent
      // made in the game ("White did take J6" ... "After E4 the engine expects J6: Red loses J6")
      const told = f`After ${pc} the engine expects ${rc}: ${me} loses ${rc}.`;
      // the stacks are main text when they are the cost made concrete: the move played loses one, the better move
      // wins one, or the better move has a price; a stack won only after the move played is a detail, and a stack
      // the entry has named already is not news
      const [gone, lostP, , lostB, wonB] = differing(lf);
      const said = out.slice(1).filter(x => !x.startsWith(MORE)).join(" ");
      const fresh = lostP.concat(wonB).filter(i => !new RegExp("\\b" + i.cell + "\\b").test(said));
      const stacksMatter = truthy(gone) || lostB.length > 0 || fresh.length > 0;
      const isStacks = x => ["In the engine's lines, ", f`After ${pc} the engine expects `, f`After ${bc} the engine expects `,
                             f`${bc} does give up `].some(h => x.startsWith(h));
      // where the better move ends with more: main text only for an entry with no better reason to give
      const isArea = x => thin && !explained.length && (x.startsWith(f`${bc} leaves `) || x.includes("spread thinly over the board"));
      out = out.concat(lineSentences(s).filter(x => !(s.area_said && x.startsWith(f`${bc} leaves `)) &&
        !(x === told && actual === rc && get(reply, "kind") === "capture") &&
        !(x === f`After ${pc} the engine expects ${pc}: ${me} loses the stack just played.` && actual === pc &&
          truthy(get(played, "suicidal")))).map(x => (stacksMatter && isStacks(x)) || isArea(x) ? x : more(x)));
    } else if (truthy(regions) && s.loss >= 2 && !similar) {
      const top = regions[0], against = Math.max(0, ...regions.filter(r => r.cells < 0).map(r => -r.cells));
      const [line, cells] = regionLine(top, best, [pc, bc]);
      if (top.cells > 0 && top.cells >= .7 * s.loss && against <= .3 * s.loss && line && cells.length >= 2) {
        out.push(f`Most of the difference is around ${listing(cells)}` + (early ? "" : f`, on ${line}`) + f`, which ${bc} would open.`);
      } else if (!truthy(get(s, "region_said")) && truthy(clearRegion(s)) && concreteClauses(shownBest).length <= 1) {
        out.push(f`Most of the difference shows up ${top.where}, around ${listing(top.around)}.`);
      }
    }
    // a stack the engine expects to lose in the end, unless the entry says how it is lost
    if (pc && say && out.includes(say) && doomedStack(s) && !say.includes("relies on") &&
        !out.some(x => !x.includes(" could wait: ") &&         // "capturing F7 is not Red's best move" does not say how it is lost
                  (x.includes("the stack just played") || new RegExp("\\bcaptur\\w+ " + pc + "\\b").test(x)))) {
      const plain = say === f`${pc} ${does(shownPlayed)}.` && !say.includes(", but ");
      const fated = plain ? say.slice(0, -1) + ", but the engine does not expect the stack to survive." :
        say + f` The engine does not expect ${pc} to survive.`;
      // "saves the attacked stack" would be taken back in the same sentence
      out[out.indexOf(say)] = fated.split("saves the attacked stack by reinforcing it to").join("reinforces the attacked stack to");
      notes.add("fated");
    }
    if (early) out = out.map(x => unnamed(x));
    out = out.map(x => subWord(/safely (attack)/g, m => m[1], x));
    s.discussed_threat = threat;
    if (out.some(x => x.startsWith(f`${bc} does give up `))) notes.add("price");
    s.lesson_kind = lessonKind(s, threat, shownBest, shownPlayed) || or(NOTED.find(k => notes.has(k)), null);
    out = out.filter(x => !x.startsWith(MORE)).concat(out.filter(x => x.startsWith(MORE)));
    return out.join("\n  ");
  }

  // k: the position of this praise in the game's list, to alternate between two wordings.
  const SURE = .6;          // the mover's share of a cell (-1 .. +1) from which the engine "expects" to have it at the end

  // What a praised move leads to in the engine's line after it, as a sentence to follow the praise, or "": a
  // stack the move attacks (or the neutral stack it threatens) that the line captures and the search gives the
  // mover at the end (payoff_words in review.py).
  function payoffWords(s) {
    const pay = get(s, "payoff");
    if (!truthy(pay)) return "";
    const facts = s.played, me = s.colour;
    const aimed = get(facts, "attacks", []);
    const neutral = get(facts, "good", []).some(c => c.includes("threatens to capture the neutral stack"));
    const won = pay.won.filter(i => i.share >= SURE && (aimed.includes(i.cell) || (i.neutral && neutral)));
    if (won.length) return f` The engine expects ${me} to win ${stacks(won)}.`;
    return "";
  }

  function praiseText(s, k = 0) {
    let text = praiseWords(s, k) + payoffWords(s);
    const side = get(s, "side", 8);
    text = subWord(/safely (attack)/g, m => m[1], text);
    return s.move_number <= Math.floor((3 * side * (side - 1) + 1) / 4) ? unnamed(text) : text;
  }

  // Praise says what the move does. It never says that the move was the only good one, nor how much worse the
  // next best would have been: a strong move earns the praise whether or not another was as good (user, November
  // 10). Before, a move the scoring pass had 3 points clear of the rest read "The only good move here: the next
  // best was about 4 points worse".
  function praiseWords(s, k) {
    const facts = trim(mergeArea(s.played));
    const n = get(facts, "good", []).length;
    const head = f`Move ${s.move_number}, ${named(s.colour, s.player)}: ${facts.cell}!`;
    if (truthy(get(s, "recommended"))) return f`${head} ${s.colour} plays it now (see move ${s.recommended}).`;
    if (!n) return f`${head} A strong move, the engine's choice.`;
    // a move that defends what the opponent's last move attacked, played next to it or against it
    if (truthy(get(s, "previous")) && truthy(get(s.played, "defends")) && ["local", "answer"].includes(get(s.played, "locality")) &&
        (n === 1 || ((k % 2) + 2) % 2 === 0))
      return f`${head} A good answer to ${s.previous}: it ${does(facts)}.`;
    if (n === 1) return f`${head} A strong move: it ${does(facts)}.`;
    if (((k % 2) + 2) % 2 === 0) return f`${head} A multipurpose move. It ${does(facts)}.`;
    const many = n >= 3 ? f`, ${NUMBER[Math.min(n, 6)]} useful things at once` : "";
    return f`${head} It ${does(facts)}${many}.`;
  }

  // Join open fights that overlap in place and follow each other within a few moves.
  function mergedFights(lessons) {
    const out = [];
    for (const g of lessons) {
      const last = out.length && out[out.length - 1].kind === "open fight" ? out[out.length - 1] : null;
      if (g.kind === "open fight" && last && g.cells.some(c => last.cells.includes(c)) && g.first_move <= last.last_move + 3) {
        const gap = [];                                  // moves where the fight was not the point
        for (let m = last.last_move + 1; m < g.first_move; m++) gap.push(m);
        out[out.length - 1] = {...last, cells: last.cells.concat(g.cells.filter(c => !last.cells.includes(c))),
          last_move: g.last_move, apart: get(last, "apart", []).concat(gap),
          missed: last.missed.concat(g.missed.filter(m => !last.missed.some(x => equal(x, m))))};
      } else {
        out.push(g);
      }
    }
    return out;
  }

  function pointName(g) {
    return truthy(g.neutral) ? f`capturing the neutral stack at ${g.cell}` : truthy(g.capture) ? f`capturing at ${g.cell}` : g.cell;
  }

  function times(n) {
    return n === 2 ? "twice" : n < NUMBER.length ? f`${at(NUMBER, n)} times` : f`${n} times`;
  }

  // The items of a whole-game note as a list; a player who did the same thing forty times gets the first five and
  // a count of the rest. joiner: "; " for items with commas of their own.
  const LISTED = 6;
  function capped(parts, joiner = null) {
    parts = [...parts];
    if (parts.length > LISTED)
      return parts.slice(0, LISTED - 1).join(joiner || ", ") + (joiner ? ";" : "") + f` and ${parts.length - LISTED + 1} more`;
    return joiner ? parts.join(joiner) : listing(parts);
  }

  // One sentence for big points left open, joining the two players' when they overlap in time.
  const TAKEN_WITHIN = 12;      // moves after the last miss within which playing the point is still "finally played"
  const STANDING_SHOWN = 4;     // big points left open that the whole-game notes list, the costliest ones

  function standingText(group, again = false) {
    const first = Math.min(...group.map(g => g.moves[0])), last = Math.max(...group.map(g => at(g.moves, -1)));
    const span = f`From move ${first} to move ${last}`;
    const one = g => {
      const k = g.moves.length;
      return k < g.turns ? f`${g.colour}'s best move was ${pointName(g)} at ${countWord(k)} of ${g.colour}'s ${countWord(g.turns)} turns` :
        f`${g.colour}'s best move was ${pointName(g)} at each of ${g.colour}'s ${countWord(k)} turns`;
    };
    // Who finally played the points, in the order of the game: "White finally played K7 at move 50 and took H4
    // at move 54."
    const taken = (...gs) => {
      // one event once (when both players left the same point, its taker is "finally played" for one and "took"
      // for the other), and only while it is still the same story: not a point played thirty moves later
      const events = new Map();
      for (const g of gs) {
        if (!truthy(g.taken) || g.taken[0] - at(g.moves, -1) > TAKEN_WITHIN) continue;
        const own = g.taken[1] === g.colour, key = f`${g.taken[0]} ${g.cell}`;
        if (own || !events.has(key))
          events.set(key, [g.taken[0], g.taken[1],
            own ? f`finally played ${g.cell} at move ${g.taken[0]}` : f`took ${g.cell} at move ${g.taken[0]}`]);
      }
      const done = [...events.values()].sort(compareTuples);
      const out = [];
      let k = 0;
      while (k < done.length) {
        const who = done[k][1];
        let same = done.slice(k).filter(d => d[1] === who).map(d => d[2]);
        const other = done.slice(k).findIndex(d => d[1] !== who);
        same = same.slice(0, other < 0 ? done.length - k : other);
        out.push(f`${who} ${listing(same)}.`);
        k += same.length;
      }
      return out.length ? " " + out.join(" ") : "";
    };
    // the average cost of one miss: a total over many moves adds up the small differences between searches
    const each = (...gs) => f`each miss cost about ${points(sum(gs.map(g => g.cost)) / sum(gs.map(g => g.moves.length)))}`;
    if (group.length === 1) {
      const g = group[0];
      if (again) return f`${span}: ${one(g)}; ${each(g)}.${taken(g)}`;
      return f`${span}, ${named(g.colour, g.player)} kept leaving a big point open: ${one(g)}, but ${g.colour} ` +
             f`played elsewhere every time; ${each(g)}.${taken(g)}`;
    }
    if (group.length !== 2) throw new Error("a group of big points has one or two entries");
    const [a, b] = [...group].sort((x, y) => Number(x.colour !== "Red") - Number(y.colour !== "Red"));
    if (a.cell === b.cell) {
      const both = again ? f`${a.cell} was the best move` : f`both players kept leaving ${a.cell} open: it was the best move`;
      return f`${span}${again ? ": " : ", "}${both} ${times(a.moves.length)} for Red ` +
             f`and ${times(b.moves.length)} for White; ${each(a, b)}.${taken(a, b)}`;
    }
    if (again) return f`${span}: ${one(a)}, and ${one(b)}; ${each(a, b)}.${taken(a, b)}`;
    return f`${span}, both players kept leaving big points open: ${one(a)}, and ${one(b)}; ${each(a, b)}.${taken(a, b)}`;
  }

  // The lines about the whole game: big points left open and fights left open in the order of the game, then
  // each player's habits.
  // One sentence, or two, for a cell that stayed the best move (wanted_cells in review.py).
  function wantedText(g) {
    const moves = g.moves;
    const k = moves.length, first = moves[0][0], last = at(moves, -1)[0];
    const red = moves.filter(m => m[1] === "Red").length;
    const once = n => n === 1 ? "once" : n === 2 ? "twice" : f`${countWord(n)} times`;
    // the average cost of one miss, as for a big point left open
    const each = f`each miss cost about ${points(g.cost / k)}`;
    let out;
    if (red && k - red) {
      out = f`${g.cell} was the best move at ${countWord(k)} turns between move ${first} and move ${last}, ${once(red)} for Red ` +
        f`and ${once(k - red)} for White, and both played elsewhere; ${each}.`;
    } else {
      const who = red ? "Red" : "White";
      out = f`${g.cell} was ${who}'s best move at ${countWord(k)} turns between move ${first} and move ${last}, and ${who} ` +
        f`played elsewhere every time; ${each}.`;
    }
    const taken = g.taken;
    if (taken && taken[0] - last <= TAKEN_WITHIN) {
      const mine = moves.some(m => m[1] === taken[1]);
      out += f` ${taken[1]} ${mine ? "finally played" : "took"} it at move ${taken[0]}.`;
    } else if (!taken) {
      out += " Nobody played there to the end.";
    }
    return out;
  }

  function gameText(lessons) {
    const lines = [];
    const wanted = lessons.filter(g => g.kind === "wanted");
    // a big point left open that a cell that stayed the best move tells whole is not told twice
    const whole = new Map(wanted.map(g => [g.cell, new Set(g.moves.map(m => m[0]))]));
    const standing = lessons.filter(g => g.kind === "standing point" &&
      !(whole.has(g.cell) && g.moves.every(m => whole.get(g.cell).has(m))));
    const groups = [];
    for (const g of standing) {
      let partner = null;
      search: for (const grp of groups) {
        for (const h of grp) {
          if (grp.length === 1 && h.colour !== g.colour &&
              Math.min(at(h.moves, -1), at(g.moves, -1)) - Math.max(h.moves[0], g.moves[0]) >= 2) {
            partner = h;
            break search;
          }
        }
      }
      if (partner) groups.find(grp => grp.some(h => equal(h, partner))).push(g);
      else groups.push([g]);
    }
    // what the other notes must not say again: every big point left open, shown or not
    const said = groups.map(grp => [new Set(grp.map(g => g.cell)), Math.min(...grp.map(g => g.moves[0])),
      Math.max(...grp.map(g => at(g.moves, -1)))]);
    for (const g of wanted) said.push([new Set([g.cell]), g.moves[0][0], at(g.moves, -1)[0]]);
    // a long game can leave a point open seven times over: the costliest few say it, in the order of the game
    const cost = grp => sum(grp.map(g => g.cost)), start = grp => Math.min(...grp.map(g => g.moves[0]));
    const shownGroups = groups.map((grp, k) => [grp, k]).sort((x, y) => cost(y[0]) - cost(x[0]) || x[1] - y[1])
      .slice(0, STANDING_SHOWN).sort((x, y) => start(x[0]) - start(y[0])).map(x => x[0]);   // stable: the costlier first on a tie
    // the first line says what these lines are about; the ones after it give the facts alone
    const timed = shownGroups.map((grp, k) => [start(grp), standingText(grp, k > 0)]);
    for (const g of wanted) timed.push([g.moves[0][0], wantedText(g)]);
    for (const g of mergedFights(lessons.filter(g => g.kind !== "standing point" && g.kind !== "wanted"))) {
      if (g.kind === "open fight" && said.some(([cells, a, b]) => g.cells.slice(0, 2).some(c => cells.has(c)) &&
          a <= g.last_move && g.first_move <= b)) continue;
      if (g.kind === "open fight" && !g.cells.length) continue;      // every best move was a capture: no cell to name
      if (g.kind === "open fight") {
        const by = new Map();
        for (const [m, c] of g.missed) {
          if (!by.has(c)) by.set(c, []);
          by.get(c).push(str(m));
        }
        const players = [...by.entries()].sort(compareTuples)
          .map(([c, ms]) => f`${c} (${ms.length === 1 ? "move" : "moves"} ${listing(ms)})`).join(" and ");
        const apart = get(g, "apart", []);
        const except = apart.length === 1 ? f`, apart from move ${apart[0]}` :
          apart.length ? f`, apart from moves ${listing(apart.map(m => str(m)))}` : "";
        timed.push([g.first_move, f`From move ${g.first_move} to move ${g.last_move}${except}, the most important place ` +
                    f`on the board was around ${listing(g.cells.slice(0, 4))}, but ${players} kept playing away from it.`]);
      } else {
        const items = g.moves.map(m => Array.isArray(m) ? m : [m, null]);
        const n = items.length;
        const who = named(g.colour, g.player);
        if (g.kind === "costly pass") {
          lines.push(f`On move ${items[0][0]}, ${who} passed while there were still points to play for.`);
          continue;
        }
        if (g.kind === "missed capture") {
          // a capture missed while it was a big point left open is in that note already
          const left = items.filter(([m, c]) => !said.some(([cells, a, b]) => cells.has(c) && a <= m && m <= b));
          if (left.length < 2) continue;
          const byCell = new Map();
          for (const [m, c] of left) {
            if (!byCell.has(c)) byCell.set(c, []);
            byCell.get(c).push(str(m));
          }
          lines.push(f`${who} missed a good capture ${times(left.length)}: ` +
                     capped([...byCell.entries()].map(([c, ms]) => ms.length === 1 ? f`${c} on move ${ms[0]}` :
                       f`${c} on moves ${listing(ms)}`)) + ".");
          continue;
        }
        if (g.kind === "suicidal move") {
          lines.push(f`${who} played a stack that could be captured straight away ` +
                     (n > 1 ? times(n) : "once") + ": " + capped(items.map(([m, c]) => f`${c} on move ${m}`)) + ".");
          continue;
        }
        const count = n > 1 ? times(n) : "Once";
        lines.push((n > 1 ? count.slice(0, 1).toUpperCase() + count.slice(1).toLowerCase() : count) +
                   f`, ${who} played far away when the best move ` + "was close to the opponent's last move: " +
                   capped(items.map(([m, c]) => f`move ${m}, where ${c} was better`), "; ") + ".");
      }
    }
    return timed.sort((a, b) => a[0] - b[0]).map(x => x[1]).concat(lines);            // the sort is stable, as Python's
  }

  // The timeline as the review reports it. Where a move was searched again for a lesson, the deeper search's
  // better move and loss replace the scoring pass's, so that the table, the counts and what an entry says of the
  // next move agree with the entries themselves (they named different better moves for 15 of 112 lessons). The
  // selection still works from the scoring pass (rowsOf): it has to, to be the same before and after a search.
  function decisions(r) {
    const deep = new Map(get(r, "lessons", []).map(s => [s.ply, s]));
    const out = [];
    for (let t of get(r, "timeline", [])) {
      const s = deep.get(t.ply);
      if (truthy(s)) t = {...t, best: s.best.cell, loss: round(Math.max(0, s.loss), 2), searched: true};
      out.push(t);
    }
    return out;
  }

  // The mistakes worth a lesson: the deeper search can find a smaller loss than the scoring pass did, and a loss
  // under two points that hardly changes the winning chances is not worth a lesson.
  function shown(r) {
    const following = new Map(decisions(r).map(t => [t.ply, t]));
    const timeline = get(r, "timeline", []);
    const done = settled(new Map(timeline.map(t => [t.ply, {...t, win_best: t.stm === 1 ? t.red_win : 1 - t.red_win}])));
    const close = closeFinish(new Map(timeline.map(t => [t.ply, {red: t.red_value}])), playedOut(r));
    const out = [];
    const chosen = get(r, "chosen");                    // the current selection (rechance); older files show every lesson
    for (const s of r.lessons) {
      if (chosen !== null && !chosen.includes(s.ply)) continue;
      if (s.loss >= 2 || get(s, "win_before", .5) - get(s, "win_after", .5) >= .05 ||
          (close.has(s.ply) && s.loss >= CLOSE_MINIMUM)) {
        const t = following.get(s.ply + 1);            // what the opponent actually played next, and its cost
        s.next = truthy(t) ? {move: t.move || "a pass", loss: t.loss} : null;
        s.side = r.game.side;
        s.decided = done.has(s.ply);
        s.close = close.has(s.ply);
        out.push(s);
      }
    }
    for (const s of out) {
      const next = out.find(o => o.ply === s.ply + 1);
      s.next_lesson = next ? next.move_number : null;
      const before = out.find(o => o.ply === s.ply - 1);
      delete s.win_from;
      if (before && before.win_after !== undefined) s.win_from = 1 - before.win_after;
    }
    // a reply that is the next lesson's better move or the next good move is described there: point to it
    const later = new Map(out.map(s => [s.ply, ["best", s]]));
    for (const p of praised(r)) later.set(p.ply, ["praise", p]);
    for (const p of get(r, "praise", [])) p.side = r.game.side;
    const earlier = new Map(out.map(s => [s.ply, s]));
    for (const s of out) {
      delete s.reply_see;
      const rc = get(or(get(s, "reply"), {}), "cell");
      const before = earlier.get(s.ply - 1);
      if (rc && truthy(before) && before.best.cell === rc) {
        s.reply_see = f`see move ${before.move_number}`;
        continue;
      }
      const [kind, other] = later.has(s.ply + 1) ? later.get(s.ply + 1) : [null, null];
      if (rc && kind === "best" && other.best.cell === rc) s.reply_see = f`see move ${other.move_number}`;
      else if (rc && kind === "praise" && other.played.cell === rc) s.reply_see = f`see move ${other.move_number}`;
    }
    // one area label per cell: ownership near a threshold must not flip "invades" and "first move into an area"
    const areas = ["invades", "is the first move into an area nobody controls"];
    const label = new Map();
    for (const s of out) {
      const facts = [get(s, "played"), get(s, "best"), get(s, "reply"), get(s, "next_facts"), get(s.shared_reply, "facts")];
      for (const x of facts) {
        if (!truthy(x) || !truthy(get(x, "cell")) || !truthy(get(x, "good"))) continue;
        const have = x.good.filter(c => areas.includes(c));
        if (!have.length) continue;
        if (!label.has(x.cell)) label.set(x.cell, have[0]);
        const first = label.get(x.cell);
        x.good = x.good.map(c => areas.includes(c) ? first : c);
      }
    }
    return out;
  }

  const MARKS = {good: "✓", mistake: "✗", dubious: "?"};
  const MARK_NAMES = {good: "Good move, the engine's choice", mistake: "Mistake", dubious: "Questionable move"};

  // A mistake is marked ✗ when it is clearly costly, ? when it is small, when its player was the clear leader of
  // a game already decided, or when the text can't say what the better move does (then the engine may simply be
  // seeing further than a player can). The side behind in a decided game gets ✗ like anyone else.
  function mark(s, words) {
    const wb = get(s, "win_before", .5), wa = get(s, "win_after", .5);
    const big = s.loss >= 5 || wb - wa >= .12;
    const soft = truthy(get(s, "decided")) && wb >= .5;        // the leader of a decided game rightly plays safe
    return big && !soft && !truthy(get(s, "unexplained")) ? "mistake" : "dubious";
  }

  // The good moves worth showing: the engine's choice that does three or more things, or that the scoring pass
  // had clearly ahead of the other moves (which picks the move but is never said, see praiseWords); not the
  // obvious recapture of a stack the opponent has just placed.
  function praised(r) {
    const timeline = get(r, "timeline", []);
    const previous = new Map(timeline.map(t => [t.ply, t.move]));
    const done = settled(new Map(timeline.map(t => [t.ply, {...t, win_best: t.stm === 1 ? t.red_win : 1 - t.red_win}])));
    const before = ply => previous.has(ply) ? previous.get(ply) : null;
    return get(r, "praise", []).filter(p => (get(p, "gap", 0) >= 3 || get(p.played, "purposes", 0) >= 3) &&
      !done.has(p.ply) &&
      !(get(p.played, "kind") === "capture" && before(p.ply - 1) === p.played.cell));
  }

  // Good moves and mistakes together, in the order they were played: [[kind, sheet, text], ...].
  function keyMoves(r) {
    const lessons = new Map(shown(r).map(s => [s.ply, s]));
    const keep = praised(r).filter(p => {
      const l = lessons.get(p.ply - 1);
      return !(truthy(l) && get(or(get(l, "reply"), {}), "cell") === p.played.cell);
    });
    const items = keep.map(p => [p.ply, "good", p]).concat(shown(r).map(s => [s.ply, "lesson", s]));
    const used = new Used(), out = [];           // each takeaway line once per game, in the order of the game
    let k = 0;
    items.sort((a, b) => a[0] - b[0]);                 // stable, as Python's: a good move before a lesson on the same ply
    for (let [, kind, sheet] of items) {
      let words;
      if (kind === "lesson") {
        words = commentary(sheet, used);
        kind = mark(sheet, words);
        const lesson = get(sheet, "lesson_kind");
        if (kind === "mistake" && lesson && !used.has(lesson)) {
          used.add(lesson);
          if (!Object.prototype.hasOwnProperty.call(TAKEAWAY, lesson)) throw new Error(`no takeaway for ${lesson}`);
          const [main, details] = entryParts(words);                 // the lesson closes the main text
          words = main.concat([f`Lesson: ${TAKEAWAY[lesson]}`], details.map(more)).join("\n  ");
        }
      } else {
        // a better move explained in a recent entry and played now. The Python takes the first match of
        // sorted(used, key=str): entries for one cell and colour differ in the move number, so that order is the
        // order of the move numbers as text ("12" before "4"). Only one entry can match in practice.
        const matches = used.entries().filter(u => Array.isArray(u) && u.length >= 4 && u[0] === "best" && u[1] === sheet.played.cell &&
          u[2] === sheet.colour && 0 < sheet.move_number - u[3] && sheet.move_number - u[3] <= 8)
          .sort((a, b) => str(a[3]) < str(b[3]) ? -1 : str(a[3]) > str(b[3]) ? 1 : 0);
        sheet.recommended = matches.length ? matches[0][3] : null;
        words = praiseText(sheet, k);
        k += 1;
      }
      out.push([kind, sheet, plainEdges(words, r.game.side)]);
    }
    return out;
  }

  // what several of a player's commented moves have in common, by the lesson their entries lead to; the habits the
  // whole-game notes already count are left to those
  const HABIT = {threat: "missed a threat", standing: "missed a threat",
    hurried: "attacked a stack to no effect", parried: "attacked a stack to no effect", ignored: "attacked a stack to no effect",
    fated: "placed a stack the engine does not expect to survive", greedy: "won a stack when another move was bigger",
    waits: "defended a stack that could wait", price: "kept a stack that was worth giving up",
    ownland: "were played inside the player's own secure land", absent: "did nothing where the points were",
    doomed: "did not use a stack that was about to be captured", key: "left the opponent's best point open",
    control: "did less than another move would have"};
  const STRETCH = 5;        // moves in a row, each costing under a point, for a player's best stretch to be told
  const COUNT = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

  function countWord(n) {
    return n >= 1 && n < COUNT.length ? COUNT[n] : str(n);
  }

  // One line for a player when three or more of the moves commented below share a failing.
  function habits(r) {
    const mine = {Red: [], White: []};
    for (const [kind, s] of keyMoves(r)) if (kind !== "good") mine[s.colour].push(s);
    const lines = [];
    for (const colour of ["Red", "White"]) {
      const sheets = mine[colour], groups = new Map();
      for (const s of sheets) {
        const kind = get(s, "lesson_kind");
        const what = kind && Object.prototype.hasOwnProperty.call(HABIT, kind) ? HABIT[kind] : null;
        if (what) groups.set(what, (groups.get(what) || []).concat([s.move_number]));
      }
      const ordered = [...groups.entries()].sort((x, y) => y[1].length - x[1].length || x[1][0] - y[1][0]);
      for (const [what, moves] of ordered)
        if (moves.length >= 3)
          lines.push(f`Of ${colour}'s ${countWord(sheets.length)} mistakes below, ${countWord(moves.length)} ${what}: ` +
                     f`moves ${listing(moves.map(m => str(m)))}.`);
    }
    return lines;
  }

  // A player's longest run of moves that each cost under a point, STRETCH or more, while the game was open.
  function bestStretch(r) {
    const t = decisions(r);
    const done = settled(new Map(or(get(r, "timeline"), []).map(x => [x.ply, {...x, win_best: x.stm === 1 ? x.red_win : 1 - x.red_win}])));
    const lines = [];
    for (const stm of [1, 2]) {
      let best = [], run = [];
      for (const x of t) {
        if (x.stm !== stm) continue;
        if (x.loss < 1 && !done.has(x.ply) && get(x, "in_play", 99) >= 10) {
          run.push(x.move_number);
          if (run.length > best.length) best = run.slice();
        } else {
          run = [];
        }
      }
      if (best.length >= STRETCH)
        lines.push(f`${COLOUR[stm]}'s best stretch: moves ${best[0]} to ${best[best.length - 1]}, ${countWord(best.length)} moves in a row ` +
                   "that each cost less than a point.");
    }
    return lines;
  }

  // The game-level patterns worth a line: fights left open, habits seen three times or more, and patterns that
  // involve a move the key moves don't cover. The rest would repeat what the key moves already say.
  function wholeGame(r) {
    const covered = new Set(shown(r).map(s => s.move_number).concat(get(r, "praise", []).map(p => p.move_number)));
    const keep = [];
    for (const g of get(r, "game_lessons", [])) {
      if (["open fight", "standing point", "wanted"].includes(g.kind)) {
        keep.push(g);
        continue;
      }
      const moves = g.moves.map(m => Array.isArray(m) ? m[0] : m);
      if (moves.length >= 3 || moves.some(m => !covered.has(m))) keep.push(g);
    }
    let lines = gameText(keep);
    const close = closeFinish(new Map(get(r, "timeline", []).map(t => [t.ply, {red: t.red_value}])), playedOut(r));
    const c = course(r);
    if (close.size >= 10 && !(c && c.close_from))            // else "How the game went" says it
      lines.push(f`From move ${Math.min(...close) + 1} to the end the engine had the two sides within ${int(CLOSE)} points of each ` +
                 "other: every point counted.");
    lines = habits(r).concat(lines, bestStretch(r));
    return lines.map(x => plainEdges(x, r.game.side));
  }

  // Per side: moves, how many cost 5 points or more and 2 to 5 points, and the costliest. The deeper search's
  // loss replaces the scoring pass's where a move was searched again. Returns {1: {...}, 2: {...}}.
  function tally(r) {
    const out = {};
    for (const stm of [1, 2]) {
      const mine = decisions(r).filter(x => x.stm === stm);
      let worst = null;                                // max(): the first of the largest
      for (const x of mine) if (worst === null || x.loss > worst.loss) worst = x;
      out[stm] = {moves: mine.length, big: mine.filter(x => x.loss >= 5).length, small: mine.filter(x => 2 <= x.loss && x.loss < 5).length,
        total: sum(mine.map(x => x.loss)),
        worst: worst && {move_number: worst.move_number, move: worst.move || "a pass", loss: worst.loss, best: worst.best}};
    }
    return out;
  }

  // Red's margin as the engine sees it after the last scored move.
  function engineMargin(r) {
    const t = or(get(r, "timeline"), []);
    if (!t.length) return null;
    const last = t[t.length - 1];
    return last.red_value - (last.stm === 1 ? 1 : -1) * last.loss;
  }

  // [Red, White] as recorded with the game, or null.
  function recordedScore(r) {
    const scores = {};
    for (const p of or(get(r.game, "result"), [])) {
      if (p !== null && typeof p === "object" && !Array.isArray(p)) scores[p.colour] = get(p, "score");
    }
    const a = get(scores, "red"), b = get(scores, "white");
    return Number.isInteger(a) && Number.isInteger(b) && a + b > 20 ? [a, b] : null;
  }

  // Was the game played to the end? The site records the count on the board when a game stops; when a player
  // resigns that is not a final score (game 9895 stopped at 85-83 with two stacks still to be captured and the
  // engine expecting a margin of 11). Played out: the record ends with two passes, or the count agrees with the
  // engine's last estimate, which is exact at the end of a finished game.
  function playedOut(r) {
    const moves = or(get(r.game, "moves"), []);
    const passes = moves.length >= 2 && at(moves, -1)[0] === "PASS" && at(moves, -2)[0] === "PASS";
    const score = recordedScore(r), engine = engineMargin(r);
    return passes || score === null || engine === null || Math.abs(score[0] - score[1] - engine) <= 1.5;
  }

  // Red's final margin: the recorded score of a game played to the end, else the engine's last estimate.
  function finalMargin(r) {
    const score = recordedScore(r);
    return score && playedOut(r) ? score[0] - score[1] : engineMargin(r);
  }

  // Where the points went: one line per player, and a note when the loser never made a big mistake. No point
  // totals: summed over a whole game, the small differences between searches add up to more than the result.
  // 'Red (Anna)', or 'Anna (Red)' with the name first. A player without a name (a game typed into the page) is
  // the colour alone.
  function named(colour, name, nameFirst = false) {
    if (name === colour) return colour;
    return nameFirst ? f`${name} (${colour})` : f`${colour} (${name})`;
  }

  function summaryText(r) {
    const g = r.game, lines = [], tallies = tally(r);
    const players = g.players;
    for (const stm of [1, 2]) {
      const x = tallies[stm];
      if (!x.moves) continue;
      const who = named(COLOUR[stm], players[stm]);
      if (!x.big && !x.small) {
        lines.push(f`${who}: none of ${x.moves} moves cost as much as 2 points.`);
        continue;
      }
      const counts = [];
      if (x.big) counts.push(f`${x.big} of ${x.moves} moves cost 5 points or more`);
      if (x.small) counts.push(x.big ? f`${x.small} cost 2 to 5 points` : f`${x.small} of ${x.moves} moves cost 2 to 5 points`);
      const w = x.worst;
      lines.push(f`${who}: ${listing(counts)}; the costliest was ${w.move} at move ${w.move_number}, ` +
                 f`about ${points(w.loss)} worse than ${w.best}.`);
    }
    // costly moves made after the game was decided (see settled) did not change the result: say how many there were
    const rows = new Map(or(get(r, "timeline"), []).map(t => [t.ply, {...t, win_best: t.stm === 1 ? t.red_win : 1 - t.red_win}]));
    const done = settled(rows);
    if (done.size) {
      const first = Math.min(...done);
      const late = [1, 2].map(stm => [stm, decisions(r).filter(x => x.stm === stm && x.loss >= 2 && x.ply >= first).length]);
      const aheadSide = rows.get(first).red_win > .5 ? 1 : 2;
      // not when the other side won the game after all (on time, or by a resignation the engine did not expect)
      const won = get(g, "winner");
      if (late[0][1] + late[1][1] >= 3 && (won === null || won === undefined || won === aheadSide)) {
        const leader = COLOUR[aheadSide];
        const whose = listing(late.filter(([, n]) => n).map(([stm, n]) => f`${n} of ${COLOUR[stm]}'s`));
        lines.push(f`From move ${first + 1} on the game was decided in ${leader}'s favour: ${whose} moves that cost ` +
                   "2 points or more came after that and did not change the result.");
      }
    }
    const winner = get(g, "winner"), margin = finalMargin(r), start = get(or(get(r, "opening"), {}), "red_value");
    if (winner && margin !== null) {
      const loser = 3 - winner;
      const x = tallies[loser];
      const ahead = start === null ? null : loser === 1 ? start : -start;
      if (!x.big && (x.small >= 3 || (ahead !== null && ahead >= 3))) {
        const ended = playedOut(r) ? f`lost by ${points(Math.abs(margin))}` :
          f`was about ${points(Math.abs(margin))} behind when the game stopped`;
        const began = ahead !== null && ahead >= 3 ? f` (${COLOUR[loser]} started about ${points(ahead)} ahead and ${ended})` : "";
        // a close game can turn on one move of under five points: "a little at a time" would hide it
        const sheets = new Map(or(get(r, "lessons"), []).map(s => [s.ply, s]));
        const chances = t => {
          if (sheets.has(t.ply)) return [get(sheets.get(t.ply), "win_before", .5), get(sheets.get(t.ply), "win_after", .5)];
          const before = t.stm === 1 ? t.red_win : 1 - t.red_win;
          return [before, before - t.win_loss];
        };
        const fall = t => chances(t)[0] - chances(t)[1];
        let turn = null;
        for (const t of decisions(r)) if (t.stm === loser && t.loss >= 2 && (turn === null || fall(t) > fall(turn))) turn = t;
        if (turn && fall(turn) >= .3) {
          lines.push(f`None of ${COLOUR[loser]}'s moves cost 5 points or more, but one of them turned a close game: ` +
                     f`${turn.move || "a pass"} at move ${turn.move_number}, about ${points(turn.loss)} ` +
                     f`(${chancesDrop(...chances(turn))}).`);
        } else {
          lines.push(f`None of ${COLOUR[loser]}'s moves cost 5 points or more: ${COLOUR[loser]} lost the game a little ` +
                     f`at a time${began}.`);
        }
      }
    }
    return lines;
  }

  const MELT = 10.0;        // a lead this large that was lost again: the story says with which moves
  const SWING = 10.0;       // a swing of the lead this large, as the first pass has it (extremes), ...
  const SWING_SURE = 7.0;   // ... and this large between the deeper searches of the two positions, is told
  const SWINGS_TOLD = 4;    // with more turning points than this the story only counts them
  const SWING_MOVE = 4.0;   // the costliest move of a swing is named when it cost this much

  // The indices at which a list of Red's margins turns: after a rise of SWING points or more it falls by SWING or
  // more, or the other way round. The margins are first averaged over two positions in a row: a costly move
  // answered by a costly move is a see-saw, not a swing of the lead. [] when the lead never swung.
  function extremes(v) {
    const s = v.map((y, k) => k ? (v[k - 1] + y) / 2 : y);
    const out = [];
    let hi = 0, lo = 0, d = 0;
    for (let k = 1; k < s.length; k++) {
      if (s[k] > s[hi]) hi = k;
      if (s[k] < s[lo]) lo = k;
      if (d >= 0 && s[hi] - s[k] >= SWING) { out.push(hi); d = -1; lo = k; }
      else if (d <= 0 && s[k] - s[lo] >= SWING) { out.push(lo); d = 1; hi = k; }
    }
    if (d) out.push(d > 0 ? hi : lo);
    return out;
  }
  const LEAD = 3.0;         // a lead counts from three points: smaller ones come and go with every small slip

  // Who is ahead along a list of Red's margins: [[first index, last index, leader]], leader 1 or 2, or 0 before
  // anyone has led. A side takes the lead at LEAD points and keeps it until the other side has LEAD points.
  function leadPhases(values) {
    const out = [];
    let leader = 0, start = 0;
    values.forEach((v, k) => {
      const now = v >= LEAD ? 1 : v <= -LEAD ? 2 : leader;
      if (now !== leader) {
        if (k > start) out.push([start, k - 1, leader]);
        leader = now;
        start = k;
      }
    });
    out.push([start, values.length - 1, leader]);
    return out;
  }

  // How the lead went, from the timeline: Red's margin before every move and after the last one (see course in
  // review.py for the fields). null for a short record.
  function course(r) {
    const t = decisions(r);
    if (t.length < 10) return null;
    const v = t.map(x => x.red_value).concat([finalMargin(r)]);
    const after = t.map(x => x.move_number - 1).concat([t[t.length - 1].move_number]);     // v[k] stands after move after[k]
    const phases = leadPhases(v);
    if (!phases.some(p => p[2])) return {leader: null};
    let [first, , leader] = phases[phases.length - 1];
    // the side ahead at the end leads the last phase, even by less than LEAD points
    const ahead = v[v.length - 1] >= .5 ? 1 : v[v.length - 1] <= -.5 ? 2 : leader;
    if (ahead !== leader) {
      const s = ahead === 1 ? 1 : -1;
      let k = v.length - 1;
      while (s * v[k - 1] > 0) k -= 1;
      phases.splice(phases.length - 1, 1, [first, k - 1, leader], [k, v.length - 1, ahead]);
      first = k;
      leader = ahead;
    }
    const sign = leader === 1 ? 1 : -1;
    const changes = phases.filter(p => p[2]).length - 1;
    const x = v.map(y => sign * y);
    let kp = first;
    for (let k = first; k < v.length; k++) if (x[k] > x[kp]) kp = k;
    const chosen = get(r, "chosen");
    const entries = new Set(chosen === null || chosen === undefined ? or(get(r, "lessons"), []).map(s => s.ply) : chosen);
    // of a player's moves that missed the same better move only one is named: the one with an entry if there is
    // one, else the costliest
    const costly = rows => {
      const groups = new Map();
      for (const m of rows) {
        if (m.loss < 2) continue;
        const key = m.stm + " " + m.best;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m);
      }
      const one = [];
      for (const g of groups.values()) {
        let top = g[0];
        for (const m of g) {
          const a = entries.has(m.ply), b = entries.has(top.ply);
          if ((a && !b) || (a === b && m.loss > top.loss)) top = m;
        }
        one.push(top);
      }
      return one.sort((a, b) => b.loss - a.loss).slice(0, 3).sort((a, b) => a.ply - b.ply);
    };
    const brief = m => ({move: m.move || "a pass", move_number: m.move_number, loss: m.loss});
    const led = [];
    for (let k = 0; k < first; k++) if (-x[k] >= LEAD) led.push(k);
    const k1 = led.length ? led[led.length - 1] : Math.max(first - 1, 0);
    const slips = t.slice(k1, first).filter(m => m.stm !== leader && m.loss >= 2);
    let worst = null;
    for (const m of slips) if (worst === null || m.loss > worst.loss) worst = m;
    let kb = null;                   // the largest lead; of equal ones, the later
    for (const k of led) if (kb === null || -x[k] > -x[kb] || (-x[k] === -x[kb] && after[k] > after[kb])) kb = k;
    const best = kb === null ? null : [-x[kb], after[kb]];
    // ... when the moves named account for half of what went (an estimate can also drift by itself)
    const melted = kb === null ? [] : costly(t.slice(kb, k1).filter(m => m.stm !== leader));
    const melts = kb !== null && -x[kb] >= MELT && x[k1] - x[kb] >= -x[kb] / 2 &&
      melted.reduce((sum, m) => sum + m.loss, 0) >= (x[k1] - x[kb]) / 2;
    // what the leader gave back with moves: by the engine's last estimate, not by the count on the board
    const shrank = x[kp] - Math.min(x[kp], sign * engineMargin(r)) >= Math.max(6, x[kp] / 3);
    const ply = k => k < t.length ? t[k].ply : t[t.length - 1].ply + 1;       // of the position v[k] belongs to
    // the swings before the story begins (see course in review.py: turns, phases)
    let early = extremes(v).filter(k => k <= k1 && k < t.length);
    if (early.length < 3) early = [];
    const deep = new Map(or(get(r, "deep"), []).map(d => [d.ply, d.red]));
    let swung = null;
    if (early.length && early.every(k => deep.has(ply(k)))) {
      const at = k => deep.get(ply(k));
      const told = Math.abs(at(early[0])) >= LEAD ? early : early.slice(1);
      const sure = early.slice(1).every((q, i) => Math.abs(at(early[i]) - at(q)) >= SWING_SURE);
      if (sure && told.length > SWINGS_TOLD) {
        swung = {count: early.length - 1, before: after[k1]};
      } else if (sure) {
        const named = [];
        early.slice(1).forEach((q, i) => {
          const p = early[i], loser = at(q) < at(p) ? 1 : 2;
          let top = null;
          for (const m of t.slice(Math.max(p - 1, 0), q)) {
            if (m.stm !== loser || m.loss < SWING_MOVE) continue;
            const a = top !== null && entries.has(top.ply), z = entries.has(m.ply);
            if (top === null || (z && !a) || (z === a && m.loss > top.loss)) top = m;
          }
          if (top) named.push(Object.assign(brief(top), {colour: COLOUR[loser]}));
        });
        swung = {states: told.map(k => [at(k), after[k]]), moves: named};
      }
    }
    const close = closeFinish(new Map(get(r, "timeline", []).map(m => [m.ply, {red: m.red_value}])), playedOut(r));
    let flips = false;
    for (let k = first + 1; k < v.length; k++) if (x[k] <= -.25) flips = true;
    return {leader, changes, span: [ply(k1), ply(kp), ply(t.length)], start: changes === 0 && first <= 4,
            turns: early.map(ply), phases: swung, until: led.length ? after[k1] : null,
            gave: worst ? brief(worst) : null, took: after[first], other_best: best,
            melted: melts ? melted.map(brief) : [],
            peak: x[kp], peak_after: after[kp], final: x[x.length - 1],
            built: costly(t.slice(k1, kp).filter(m => m.stm !== leader)).map(brief),
            returned: shrank ? costly(t.slice(kp).filter(m => m.stm === leader)).map(brief) : [],
            flips, close_from: close.size >= 10 && Math.min(...close) >= ply(first) ? Math.min(...close) + 1 : null};
  }

  // The moves the story names, as course gives them: [gave or null, built, melted, returned].
  function storyMoves(c) {
    const gave = c.start ? null : c.gave;
    const built = c.built.filter(m => !(c.gave && c.built.length === 1 && m.move_number === c.gave.move_number));
    return [gave, built, c.start || c.changes === 0 ? [] : c.melted, c.returned];
  }

  // The plies of the moves "How the game went" names: each of them gets an entry (see add_story_lessons in
  // review.py and addStoryLessons in review-sheets.js).
  function storyPlies(r) {
    const c = course(r);
    if (!c || c.leader === null) return [];
    const [gave, built, melted, returned] = storyMoves(c);
    const swung = (c.phases && c.phases.moves) || [];
    const plies = new Set((gave ? [gave] : []).concat(built, melted, returned, swung).map(m => m.move_number - 1));
    return [...plies].sort((a, b) => a - b);
  }

  // The area where a lead was won (sign = -1: where it was given back), when one stands out, with the largest area
  // that went the other way when that is a third as large or more: [area, other area or null]; null when no
  // compact area holds half of the change, or a large area the other way is not compact (see swing_area in
  // review.py).
  function swingArea(r, span, sign = 1) {
    const sw = or(get(r, "swings"), []).find(s => s.span[0] === span[0] && s.span[1] === span[1]);
    if (!sw || !sw.areas.length) return null;
    const side = r.game.side;
    const compact = a => a.size <= (3 * side * (side - 1) + 1) / 6;
    let top = sw.areas[0], other = sw.areas[0];
    for (const a of sw.areas) {
      if (sign * a.cells > sign * top.cells) top = a;
      if (sign * a.cells < sign * other.cells) other = a;
    }
    if (sign * top.cells < Math.max(4, .5 * sign * sw.total) || !compact(top)) return null;
    if (-sign * other.cells < sign * top.cells / 3) return [top, null];
    return compact(other) ? [top, other] : null;
  }

  // The swings of the lead before the story begins (course's phases), in one or two sentences.
  function phasesText(ph) {
    if (!ph) return [];
    if (ph.count !== undefined) return [f`Before move ${ph.before} the lead swung widely ${times(ph.count)}.`];
    const states = ph.states;
    const subject = states[0][0] > 0 ? 1 : 2, sign = subject === 1 ? 1 : -1;
    const said = [], parts = [];
    for (const [value, n] of states) {
      const x = sign * value;
      const status = Math.abs(x) < 1 ? "level" : x > 0 ? "ahead" : "behind";
      const again = said.length >= 2 && said[said.length - 2] === status && said[said.length - 1] !== status ? " again" : "";
      parts.push((status === "level" ? status : f`${points(Math.abs(x))} ${status}`) + again +
                 (n <= 2 ? " after the opening" : f` after move ${n}`));
      said.push(status);
    }
    const out = [f`${COLOUR[subject]} was ${listing(parts)}.`];
    const ms = ph.moves;
    if (ms.length)
      out.push(f`The costliest ${ms.length === 1 ? "move" : "moves"} on the way ${ms.length === 1 ? "was" : "were"} ` +
               listing(ms.map(m => f`${m.colour}'s ${m.move} at move ${m.move_number}`)) + ".");
    return out;
  }

  // How the game went, in a few sentences: who led and when the lead changed for the last time, how large it
  // became, the other side's costliest moves on the way, and what the leader gave back.
  function courseText(r) {
    const c = course(r);
    if (!c) return [];
    if (c.leader === null) return [f`Neither side was ever as much as ${points(LEAD)} ahead.`];
    const w = COLOUR[c.leader], l = COLOUR[3 - c.leader];
    const moves = ms => listing(ms.map(m => f`${m.move} at move ${m.move_number}`));
    const cost = ms => f`about ${points(ms.reduce((sum, m) => sum + m.loss, 0))}` + (ms.length > 1 ? " between them" : "");
    const after = n => n <= 2 ? "after the opening" : f`after move ${n}`;
    const best = c.other_best, peak = c.peak, final = c.final;
    const [gave, built, melted, returned] = storyMoves(c);
    // entries below that say "The lead changes hands here" after the story's last change of lead: the story is told
    // from the first pass, which can miss a lead of a point changing sides near the end; it must not contradict them
    const since = (gave ? gave.move_number : 0) || get(c, "took") || 0;
    const late = shown(r).filter(s => changesLead(s) && s.move_number > since).map(s => ({move: s.played.cell, move_number: s.move_number}));
    const flips = truthy(c.flips) || late.length > 0;
    const kept = flips ? "" : " and kept it";              // not above "The lead changes hands here" at a later move
    const ending = final >= .5 ? f`${points(final)} at the end` : final > -.5 ? "gone at the end" :
      f`gone at the end: ${l} finished ${points(-final)} ahead`;
    const size = returned.length || (peak - final >= 3 && final < .7 * peak) ?
      f`the lead reached ${points(peak)} (${after(c.peak_after)})` + (returned.length ? "" : f` and was ${ending}`) :
      f`the lead grew to ${points(final)} by the end`;
    const swings = phasesText(c.phases);
    let out;
    if (c.start) {
      out = [f`${w} was ahead from the first moves on; ${size}.`];
    } else {
      let lead;
      if (c.changes === 0) {
        lead = gave ? f`${l} fell behind with ${gave.move} at move ${gave.move_number}` + (flips ? "" : " and never caught up") :
          f`${w} took the lead at move ${c.took}${kept}`;
      } else if (c.changes === 1) {
        // with the move that gave the lead up, no "until move 9": the lead can dip under LEAD points a move or two before
        const head = c.until <= 2 ? f`${l} was ${points(best[0])} ahead after the opening` :
          gave ? f`${l} was up to ${points(best[0])} ahead (${after(best[1])})` :
          f`${l} was ahead until move ${c.until}, by up to ${points(best[0])}` + (best[1] >= c.until ? "" : f` (${after(best[1])})`);
        lead = gave ? f`${head} and gave up the lead with ${gave.move} at move ${gave.move_number}` :
          f`${head}; ${w} took the lead at move ${c.took}${kept}`;
      } else {
        // with the swings told first, the largest lead is in them
        lead = f`The lead changed hands ${times(c.changes)}` + (best && !swings.length ? f`; ${l}'s largest lead was ${points(best[0])}, ${after(best[1])}` : "") +
          ". " + (gave ? f`${l} gave it up${flips ? "" : " for the last time"} with ${gave.move} at move ${gave.move_number}` :
                  f`${w} took it${flips ? "" : " for good"} at move ${c.took}`);
      }
      out = swings.concat([f`${lead}.`]);
      if (melted.length)           // how a large lead went, before the move that gave it up
        out.push(f`Before that, ${l}'s costliest ${melted.length === 1 ? "move was" : "moves were"} ${moves(melted)}, ${cost(melted)}.`);
      out.push(f`${w}'s${size.slice(3)}.`);
    }
    if (c.close_from) out.push(f`From move ${c.close_from} on the two sides were within ${int(CLOSE)} points of each other.`);
    if (late.length)
      out.push(f`In the close finish the lead changed hands ${late.length === 1 ? "once" : times(late.length)} more, with ${moves(late)}.`);
    const [a, k, e] = c.span;
    const area = swingArea(r, [a, k]);
    if (area) {
      // the position at ply a stands before move a + 1, the one at ply k after move k
      const [top, other] = area;
      out.push(f`The lead was won ${top.where}, around ${listing(top.around)}: ${w} gained about ` +
               f`${points(top.cells)} there between moves ${a + 1} and ${k}` +
               (other ? f`, and ${l} about ${points(-other.cells)} ${other.where}.` : "."));
    }
    if (built.length) {
      out.push(f`${l}'s costliest ${built.length === 1 ? "move" : "moves"} on the way ${built.length === 1 ? "was" : "were"} ` +
               f`${moves(built)}, ${cost(built)}.`);
    }
    if (returned.length) {
      const share = final < peak / 3 ? "most" : "some";
      out.push(f`${w} then gave ${share} of it back with ${moves(returned)}, ${cost(returned)}: the lead was ${ending}.`);
      const back = swingArea(r, [k, e], -1);
      if (back) {
        const [top, other] = back;
        out.push(f`${l} won it back ${top.where}, around ${listing(top.around)}: about ${points(-top.cells)} there` +
                 (other ? f`, against ${points(other.cells)} for ${w} ${other.where}.` : "."));
      }
    }
    return out;
  }

  // How well each side played, compared with all recorded games on the site (see level.py).
  function levelLine(r) {
    const lv = get(r, "level"), side = r.game.side;
    if (!truthy(lv)) return null;
    const words = {};
    for (const stm of [1, 2]) {
      const x = or(get(lv, String(stm)), {});
      const share = get(x, "moves", 0) >= MINIMUM_MOVES ? betterThan(side, get(x, "mean")) : null;
      if (share === null) return null;
      words[stm] = levelName(share);
    }
    const one = {expert: "an expert", experienced: "an experienced player", intermediate: "an intermediate player",
      novice: "a novice"};
    const many = {expert: "experts", experienced: "experienced players", intermediate: "intermediate players",
      novice: "novices"};
    const head = words[1] === words[2] ? f`both sides played like ${many[words[1]]}` :
      f`Red played like ${one[words[1]]}, White like ${one[words[2]]}`;
    return head[0].toUpperCase() + head.slice(1) + ", judging by how closely their moves follow the engine's preferences compared with " +
           "all games recorded on tumbleweed.games. One game is a small sample: this describes the game, not the players.";
  }

  // ---------------------------------------------------------------- moments
  // Rare, specific things about one game (moments.py; findMoments in review-sheets.js makes the facts). The kinds
  // in the order of what a reader would least expect a program to notice; "passed" is told in the first line of the
  // review instead (resultLine).
  const MOMENTS = ["paper", "smaller", "mutual", "target", "lived", "cancel", "side", "across", "seesaw", "late", "far", "outpost",
    "thrice", "both", "collapse", "column", "never", "waited", "hung", "clean", "rim", "opening", "early", "safe", "many", "invaders",
    "six"];
  const MOMENTS_SHOWN = 3;

  // "Red passed with White's 2-stack at A4 open to capture."
  function passedWords(m) {
    const left = m.left;
    const cells = items => items.length <= 3 ? listing(items.map(i => i[0])) : items.slice(0, 3).map(i => i[0]).join(", ") + " and others";
    const stacks = items => items.length === 1 ? f`the ${items[0][1]}-stack at ${items[0][0]}` : f`the stacks at ${cells(items)}`;
    const colours = Object.keys(left);
    if (colours.length === 2)
      return f`Both players passed with captures open: Red could take ${stacks(left.Red)}, White ${stacks(left.White)}.`;
    const colour = colours[0], items = left[colour];
    const other = colour === "Red" ? "White" : "Red";
    if (items.length === 1) return f`${colour} passed with ${other}'s ${items[0][1]}-stack at ${items[0][0]} open to capture.`;
    return f`${colour} passed with ${countWord(items.length)} captures open: ${other}'s stacks at ${cells(items)}.`;
  }

  // One moment as a sentence or two.
  function momentWords(m, finished = true) {
    const k = m.kind;
    const played = c => c === null || c === undefined ? "a pass" : c;
    if (k === "across") {
      const n = m.moves.length;
      let s = n <= 6 ?
        f`From move ${m.move} to move ${m.to} every move gave the lead to the other side: ${listing(m.moves.map(played))}.` :
        f`From move ${m.move} to move ${m.to} every move gave the lead to the other side, ${countWord(n)} moves in a row.`;
      if (m.back) s += " When they were over, the game stood where it had been.";
      else if (m.last) s += f` ${m.last}'s was the last.`;
      return s;
    }
    if (k === "collapse")
      return f`${m.colour} lost about ${points(m.total)} in ${countWord(m.moves.length)} moves in a row, ` +
        f`${listing(m.moves.map(played))} (moves ${m.move} to ${m.to}): from ${points(m.ahead)} ahead to ${points(m.behind)} behind.`;
    if (k === "both") {
      const a = m.first, z = m.second, t = m.taker;
      return f`${m.cell} was the best move for both players in turn: ${a.colour} left it for ${played(a.played)} at move ${m.move}` +
        f`, ${z.colour} left it for ${played(z.played)} at move ${m.move + 1}, and ${t.colour} took it at move ${t.move}.`;
    }
    if (k === "hung")
      return f`${m.colour}'s ${m.height}-stack at ${m.cell} could be captured at ${m.turns} of ${m.by}'s turns in a row, ` +
        f`from move ${m.since} on; ${m.by} took it at move ${m.move}` + (m.six ? ", by then seeing it from all six directions." : ".");
    if (k === "six") {
      const what = {move: m.cell, capture: f`capture at ${m.cell}`, reinforcement: f`reinforcement of ${m.cell}`}[m.how];
      return f`${m.colour}'s ${what} (move ${m.move}) made a 6-stack: ${m.colour} stacks in all six directions. ` +
        "Nothing can capture it." + (m.count > 1 ? f` It was the first of ${countWord(m.count)}.` : "");
    }
    if (k === "smaller")
      return f`At move ${m.move} ${m.colour} captured the ${m.played.height}-stack at ${m.played.cell}, but the ` +
        f`${m.best.height}-stack at ${m.best.cell} was the one to take: the engine expects ${listing(m.fall)} to fall with it.`;
    if (k === "lived") {
      const other = m.colour === "Red" ? "White" : "Red";
      return f`${m.cell} (move ${m.move}) landed in the middle of ${other}'s area and was never captured; ${countWord(m.cells)} ` +
        f`cells around it that were ${other}'s then were ${m.colour}'s ${finished ? "at the end" : "when the game stopped"}.`;
    }
    if (k === "invaders") {
      const other = m.colour === "Red" ? "White" : "Red";
      return f`${m.colour} placed ${countWord(m.placed)} stacks inside ${other}'s area after the opening; ${other} captured ` +
        (m.captured === m.placed ? "all of them" : countWord(m.captured) + " of them") + ".";
    }
    if (k === "far")
      return f`${m.cell} (move ${m.move}) worked ${countWord(m.distance)} cells away: along the empty ${m.way}, it gave ` +
        f`${m.colour} another line of sight on ${m.target}, which ${m.colour} captured ${countWord(m.later)} moves later.`;
    if (k === "seesaw") {
      const ldr = m.leader, other = ldr === "Red" ? "White" : "Red";
      const whole = x => Math.max(1, Math.floor(x + .5));
      const band = ([lo, hi]) => whole(lo) === whole(hi) ? f`about ${points(hi)}` : f`${whole(lo)} to ${points(hi)}`;
      let s = f`From move ${m.move} to move ${m.to} each move gave back what the one before had gained, and the lead never ` +
        f`changed hands: after ${ldr}'s moves ${ldr} led by ${band(m.low)}, after ${other}'s by ${band(m.high)}.`;
      const mine = m.best[ldr], theirs = m.best[other];
      if (mine && mine === theirs) s += f` All that time the engine's best move for both players was ${mine}.`;
      else if (mine && theirs) s += f` All that time the engine's best move was ${mine} for ${ldr} and ${theirs} for ${other}.`;
      else if (mine || theirs) s += f` All that time the engine's best move for ${mine ? ldr : other} was ${mine || theirs}.`;
      return s;
    }
    if (k === "many")
      return f`Before move ${m.move}, ${countWord(m.count)} stacks could be captured straight away: ${countWord(m.red)} of ` +
        f`Red's and ${countWord(m.white)} of White's.`;
    if (k === "waited") {
      const caps = m.captures.map(([c, n]) => f`${c} at move ${n}`);
      const named = caps.length <= 4 ? listing(caps) : caps.slice(0, 3).join(", ") + f` and ${countWord(caps.length - 3)} more`;
      const times = countWord(caps.length);
      return f`${times[0].toUpperCase() + times.slice(1)} times ${m.colour} spent a move capturing a stack that had been open to capture for ` +
        f`six turns or more (${named}), each time when the engine wanted a move elsewhere` +
        (caps.length <= 4 ? f`; together that cost about ${points(m.total)}.` : ".");
    }
    if (k === "side")
      return f`From move ${m.move} to move ${m.to}, ` +
        (m.played === m.moves ? f`all ${m.moves} moves` : f`${m.played} of the ${m.moves} moves`) +
        f` were played in the ${m.half} half of the board, while the engine wanted a move in the ${m.other} half at ` +
        (10 * m.wanted >= 9 * m.moves ? "nearly every one" : "most") + " of those turns.";
    if (k === "outpost") {
      const c = m.colour, other = c === "Red" ? "White" : "Red";
      const seen = m.seen.map(x => x[0]), far = m.seen.map(x => x[1]);
      let saw;
      if (seen.length === 1) saw = f`the only ${c} stack it saw was ${seen[0]}, ${countWord(far[0])} cells away`;
      else if (new Set(far).size === 1)
        saw = f`the ${c} stacks it saw, ${listing(seen)}, were ${seen.length === 2 ? "both" : "each"} ${countWord(far[0])} cells away`;
      else saw = f`the ${c} stacks it saw were ` + listing(m.seen.map(([x, d]) => f`${x}, ${countWord(d)} cells away`));
      const end = m.taken ? f`${other} captured ${m.cell} at move ${m.taken}` : f`${m.cell} was never captured`;
      return f`${c}'s ${m.cell} (move ${m.move}) stood alone: ${saw}. From move ${m.from} to move ${m.to} ` +
        f`${countWord(m.moves.length)} moves landed on the cells between them (${listing(m.moves.map(played))}), and ${end}.`;
    }
    if (k === "paper") {
      const c = m.colour, other = c === "Red" ? "White" : "Red";
      return f`Before move ${m.move} ${c} led by ${points(m.lead)}, and that lead counted ${other}'s ${m.height}-stack at ${m.cell} ` +
        f`as captured. Capturing it was the engine's best move at ${countWord(m.wanted)} of ${c}'s turns; ${c} never did, and ` +
        f`${countWord(m.cells)} cells around it that were ${c}'s on the engine's map then were ${other}'s ` +
        (finished ? "at the end" : "when the game stopped") + ".";
    }
    if (k === "cancel") {
      const other = m.colour === "Red" ? "White" : "Red";
      const lost = m.lost.map(c => c === m.neutral ? "the neutral stack" : c);
      return f`${m.colour}'s capture of ${m.cell} (move ${m.move}) took away ${countWord(lost.length)} captures ${other} had: ` +
        f`${listing(lost)} all needed the line of sight from ${m.cell}. ${other} was left with ` +
        (m.left ? countWord(m.left) : "none") + ".";
    }
    if (k === "mutual") {
      const c = m.colour, other = c === "Red" ? "White" : "Red";
      return f`Before move ${m.move} ${c} could capture ${m.mine} and ${other} could capture ${m.theirs}, and each of the two ` +
        f`stacks was one of the other's attackers: whoever captured first saved their own stack. It was ${c}'s turn; ${c} played ` +
        f`${played(m.played)}, and ${other} captured ${m.theirs}.`;
    }
    if (k === "target") {
      const c = m.colour, other = c === "Red" ? "White" : "Red";
      return f`${m.cell} (move ${m.move}) made ${other}'s ${m.height}-stack at ${m.target} capturable. ${c} had ` +
        f`${countWord(m.turns)} turns to capture it and did not; at move ${m.taken} ${other} captured ${m.cell}, and ` +
        f`${m.target} was one of the stacks that capture needed.`;
    }
    if (k === "opening") {
      const a = m.first, z = m.second;
      return f`By move ${m.move} both stacks of the opening offer had been captured: ${a[0]} took ${a[1]} at move ${a[2]} and ` +
        f`${z[0]} took ${z[1]} at move ${z[2]}.`;
    }
    if (k === "early")
      return f`By move ${m.move} ${m.by} had captured three of ${m.colour}'s first ${countWord(m.placed)} stacks: ` +
        f`${listing(m.cells)}.`;
    if (k === "clean")
      return f`From move ${m.move} to the end, ${countWord(m.moves)} moves, neither player gave anything away.`;
    if (k === "never") {
      const since = m.since === null || m.since === undefined ? "from the opening offer" : f`from move ${m.since}`;
      return f`${m.colour}'s stack at ${m.cell} stood ${since} to the end. ${m.by} could have captured it at ` +
        f`${countWord(m.turns)} turns, and ` +
        (m.wanted === m.turns ? "each time" : f`at ${countWord(m.wanted)} of them`) +
        f` the capture was the engine's best move, the first time at move ${m.move}.`;
    }
    if (k === "late")
      return f`${m.cell} was the engine's best move for ${m.colour} at move ${m.earlier}. ${m.colour} played it at move ` +
        f`${m.move}, and by then it cost ${points(m.loss)}.`;
    if (k === "thrice")
      return f`${m.cell} changed hands ${countWord(m.times)} times between move ${m.move} and move ${m.to}.`;
    if (k === "rim")
      return f`${m.colour}'s first three moves all went on the rim of the board: ${listing(m.cells)}.`;
    if (k === "safe") {
      const cells = m.cells, n = countWord(cells.length);
      return f`${n[0].toUpperCase() + n.slice(1)} of ${m.colour}'s moves were new stacks on cells the engine's map already gave to ${m.colour}, ` +
        f`each at a cost of 4 points or more: ${cells.slice(0, 3).join(", ")} and ${countWord(cells.length - 3)} more.`;
    }
    if (k === "column")
      return f`${m.colour} put three stacks in a row in three turns (${listing(m.cells)}, moves ${m.move} to ${m.to}); ` +
        f`${m.by} had captured all three by move ${m.last}.`;
    throw new Error(k);
  }

  // At most MOMENTS_SHOWN of the game's moments, the least expected first chosen, told in the order of play. A
  // 6-stack that the line on a long-hanging stack already tells, a collapse whose moves "How the game went"
  // names or that lies inside a run of moves handing the lead across, a cell both players left that the
  // see-saw already names, and a stack never captured that the lead on paper is about, are left out.
  function momentsText(r) {
    let ms = (get(r, "moments") || []).filter(m => MOMENTS.includes(m.kind));
    const hung = ms.find(m => m.kind === "hung" && m.six);
    if (hung) ms = ms.filter(m => !(m.kind === "six" && m.move === hung.move));
    const c = course(r);
    if (c && c.leader !== null) {
      const [gave, built, melted, returned] = storyMoves(c);
      const told = new Set((gave ? [gave] : []).concat(built, melted, returned).map(x => x.move_number));
      ms = ms.filter(m => !(m.kind === "collapse" && m.numbers.filter(n => told.has(n)).length >= 2));
    }
    const across = ms.find(m => m.kind === "across");
    if (across) ms = ms.filter(m => !(m.kind === "collapse" && m.move <= across.to && across.move <= m.to));
    const paper = ms.find(m => m.kind === "paper");
    if (paper) ms = ms.filter(m => !(m.kind === "never" && m.cell === paper.cell));
    const seesaw = ms.find(m => m.kind === "seesaw");
    if (seesaw) ms = ms.filter(m => !(m.kind === "both" && seesaw.move <= m.move && m.move <= seesaw.to
      && Object.values(seesaw.best).includes(m.cell)));
    if (seesaw)               // a total over moves that gave back what the one before had gained
      ms = ms.filter(m => !(m.kind === "collapse" && m.move <= seesaw.to && seesaw.move <= m.to));
    const left = new Set(ms.filter(m => m.kind === "both").map(m => m.cell));
    ms = ms.filter(m => !(m.kind === "late" && left.has(m.cell)));          // "left it ... took it" says it
    const rows = ms.filter(m => m.kind === "column").map(m => new Set(m.cells));
    ms = ms.filter(m => !(m.kind === "early" && rows.some(x => m.cells.filter(c => x.has(c)).length >= 2)));
    ms = ms.map((m, i) => [m, i]).sort((a, b) => MOMENTS.indexOf(a[0].kind) - MOMENTS.indexOf(b[0].kind) || a[1] - b[1])
      .slice(0, MOMENTS_SHOWN).map(x => x[0]);
    const finished = playedOut(r);
    return ms.map((m, i) => [m, i]).sort((a, b) => a[0].move - b[0].move || a[1] - b[1]).map(x => momentWords(x[0], finished));
  }

  // Who won, with the score of a game played to the end. For a game that stopped earlier, the count on the
  // board is given as what it is, next to what the engine expects with best play to the end. A game without a
  // winner (one typed into the page and still being played) is not finished: the count as it stands.
  function resultLine(r) {
    const g = r.game;
    const w = get(g, "winner");
    const score = recordedScore(r);
    if (!w) {
      if (!score || !truthy(get(r, "timeline"))) return "";
      const lead = score[0] > score[1] ? "Red" : "White";
      const count = score[0] === score[1] ? f`the count is level at ${score[0]}–${score[1]}` :
        f`the count is ${Math.max(...score)}–${Math.min(...score)} for ${lead}`;
      const engine = engineMargin(r);
      const ahead = engine > 0 ? "Red" : "White";
      const expects = Math.abs(engine) < .5 ? "the engine has the game level" :
        f`with best play to the end the engine expects ${ahead} to win by about ${int(Math.abs(engine) + .5)}`;
      return f`The game is not finished: after move ${at(r.timeline, -1).move_number} ${count}, and ${expects}.`;
    }
    const won = f`${named(COLOUR[w], g.players[w], true)} won`;
    if (!score) return won + ".";
    if (playedOut(r)) {
      const a = at(score, w - 1), b = at(score, 2 - w);
      // the count on the board; when both players passed with points still to be won, the engine's estimate of best
      // play differs from it
      const left = truthy(get(r, "timeline")) ? Math.abs(score[0] - score[1] - engineMargin(r)) >= 3 : false;
      const passed = (get(r, "moments") || []).find(m => m.kind === "passed");       // who left what, when known
      const note = passed ? " " + passedWords(passed) : left ? " Both players passed with points still on the board." : "";
      return won + (a > b ? f`, ${a}–${b}.` : ".") + note;
    }
    const lead = score[0] > score[1] ? "Red" : "White";
    const count = score[0] === score[1] ? f`the count level at ${score[0]}–${score[1]}` :
      f`the count at ${Math.max(...score)}–${Math.min(...score)} for ${lead}`;
    const after = truthy(get(r, "timeline")) ? f` after move ${at(r.timeline, -1).move_number}` : "";
    const engine = engineMargin(r);
    const ahead = engine > 0 ? "Red" : "White";
    let expects;
    if (Math.abs(engine) < .5) expects = "the engine had the game level at that point";
    else if (ahead === COLOUR[w]) expects = f`with best play to the end the engine expects ${ahead} to win by about ${int(Math.abs(engine) + .5)}`;
    else expects = f`the engine had ${ahead} ahead by about ${int(Math.abs(engine) + .5)} at that point`;
    return f`${won}. The game stopped${after} with ${count}; ${expects}.`;
  }

  // 'the H15–O15 edge' (older saved regions) -> 'the bottom edge'.
  function plainEdges(text, side) {
    const b = localBoard(side);
    return text.replace(/the ([A-O]\d+)–([A-O]\d+) edge/g, (_, u, v) => "the " + b.edgeName(u, v));
  }

  // The whole review as text, from a saved review (the parsed JSON).
  // An entry's details follow its main text, indented further; details = false leaves them out.
  function text(r, details = true) {
    const g = r.game;
    const title = g.title;
    const date = title.endsWith(")") ? title.slice(title.lastIndexOf("(") + 1, -1) : "";
    const head = f`${named("Red", g.players[1], true)} vs. ${named("White", g.players[2], true)}` + (date ? f`, ${date}` : "");
    const parts = [f`${head}. ${resultLine(r)}`.trim()];
    const lv = levelLine(r);
    if (lv) parts.push("Level of play:\n  " + lv);
    const o = openingText(get(r, "opening"), get(g, "pie", true));
    if (o.length) parts.push("The opening:\n" + o.map(x => "  " + x).join("\n"));
    const went = courseText(r);
    if (went.length) parts.push("How the game went:\n" + went.map(x => "  " + x).join("\n"));
    const ms = momentsText(r);
    if (ms.length) parts.push("Worth noticing:\n" + ms.map(x => "  " + x).join("\n"));
    const sm = summaryText(r);
    if (sm.length) parts.push("Where the points went:\n" + sm.map(x => "  " + x).join("\n"));
    const gl = wholeGame(r);
    if (gl.length) parts.push("Over the whole game:\n" + gl.map(x => "  " + x).join("\n"));
    const moves = keyMoves(r);
    if (moves.length) {
      const legend = {good: "✓ good move, the engine's choice", mistake: "✗ mistake", dubious: "? questionable"};
      const present = ["good", "mistake", "dubious"].filter(k => moves.some(m => m[0] === k)).map(k => legend[k]);
      const entry = words => details ? words : entryParts(words)[0].join("\n  ");
      if (details && moves.some(m => entryParts(m[2])[1].length)) present.push("lines indented further give details");
      parts.push(f`Key moves (${present.join("; ")}):\n\n` + moves.map(([kind, , words]) => f`${MARKS[kind]} ${entry(words)}`).join("\n\n"));
    }
    return parts.join("\n\n");
  }

  // ================================================================ lines.py: the wording
  // Where a mistake loses its points, from the search's own ownership estimate after the move played and after
  // the better move (a sheet's 'lines'): the stacks that change hands in the engine's two lines and the areas
  // where the better move ends with more and with less.

  const SHOWN = 4;                 // replies printed, unless a stack named in the text changes hands later
  // A stack that changes hands in one line is named only when the search agrees that its fate depends on the
  // move: the mover's ownership of its cell has to differ this much between the two searches, the way the line
  // says (a cell that changes hands for certain differs by 2). Without this the text named exchanges the engine
  // expects after either move, which only come earlier in one of the two lines. At .25 the board's wash shows
  // the cell.
  const STACK = .25;

  // A number of cells, to the nearest whole one and at least one.
  function whole(x) {
    return Math.max(1, int(Math.abs(x) + .5));
  }

  // itself: the cell of the move the line begins with ("loses G12 itself after G12", not "loses G12 after G12").
  function stacks(items, itself = null) {
    return listing(items.map(i => truthy(i.neutral) ? "the neutral stack" : i.cell === itself ? f`${i.cell} itself` : i.cell));
  }

  // The line as printed: as far as the last stack the text names in it, or its first replies when it names none.
  function shownLine(side, mentioned) {
    const last = mentioned.length ? Math.max(...mentioned.map(i => i.k - 1)) : SHOWN - 1;
    return side.line.slice(0, last + 1).join(" ");
  }

  // The areas worth naming, largest first: at least a quarter of the loss (and 1.5 cells), two at most each
  // way. Returns [more, less].
  function namedAreas(facts) {
    const floor = Math.max(1.5, .25 * facts.loss);
    const more = facts.areas.filter(a => a.cells >= floor).slice(0, 2);
    const less = facts.areas.filter(a => -a.cells >= floor).slice(0, 2);
    return [more, less];
  }

  // The stacks worth naming: [the stack just played if the line loses it, other stacks lost after the move
  // played, stacks won after it, stacks lost after the better move, stacks won after it]. A stack counts when it
  // changes hands in one line and not in the other, and the search's ownership of its cell differs between the
  // two moves in that direction by at least STACK. The stack just played is the move itself, so it always counts.
  function differing(facts) {
    const played = facts.played, best = facts.best;
    const delta = facts.delta;
    let side = null;
    for (let n = 2; n < 40 && side === null; n++) if (3 * n * (n - 1) + 1 === delta.length) side = n;
    if (side === null) throw new Error("the difference per cell does not fit a board");
    const b = localBoard(side);
    const cells = items => items.map(i => i.cell);
    const real = (items, others, sign) => items.filter(i => !cells(others).includes(i.cell) && sign * delta[b.index(i.cell)] >= STACK);
    const gone = or(played.lost.find(i => i.cell === played.first && !cells(best.lost).includes(i.cell)), null);
    return [gone, real(played.lost.filter(i => i !== gone), best.lost, +1), real(played.won, best.won, -1),
      real(best.lost, played.lost, -1), real(best.won, played.won, +1)];
  }

  // The sentences for one entry, kept short because the board shows the areas: the stacks that change hands in
  // the engine's lines (each line printed as far as the last stack it names), then the largest area each way.
  // linesAlways=false leaves the two lines out when no stack changes hands differently in them;
  // stacksToo=false gives the territory sentence alone.
  function sentences(facts, sheet, linesAlways = true, stacksToo = true) {
    if (!truthy(facts)) return [];
    const me = sheet.colour;
    const played = facts.played, best = facts.best;
    const pc = played.first, bc = best.first;
    const out = [];
    // ---- stacks: only what differs between the two moves, plus the fate of the stack just played
    const [gone, restP, wonP, lostB, wonB] = differing(facts);
    const lostP = restP.concat(gone ? [gone] : []);
    const clause = (lost, won, ownStack = null, first = null) => {
      const parts = [];
      if (won.length) parts.push(f`wins ${stacks(won)}`);
      if (truthy(ownStack)) parts.push("loses the stack just played" + (lost.length ? f` and ${stacks(lost)}` : ""));
      else if (lost.length) parts.push(f`loses ${stacks(lost, first)}`);
      return parts.join(" but ");
    };
    const cp = clause(restP, wonP, gone), cb = clause(lostB, wonB, null, bc);
    const lp = shownLine(played, lostP.concat(wonP)), lb = shownLine(best, lostB.concat(wonB));
    // a line that is only the capture the clause names says nothing more ("loses E6 after I7 (E6)")
    const bare = (line, items) => items.length === 1 && line === items[0].cell;
    const shown = (line, items) => bare(line, items) ? "" : f` (${line})`;
    if (!truthy(stacksToo)) {
      // the territory sentence alone
    } else if (cp && cb) {
      out.push(f`In the engine's lines, ${me} ${cp} after ${pc}${shown(lp, lostP.concat(wonP))}, and ${cb} after ${bc}` +
               f`${shown(lb, lostB.concat(wonB))}.`);
    } else if (cp) {
      out.push(f`After ${pc} the engine expects ${lp}: ${me} ${cp}.`);
    } else if (cb && lostB.length && !wonB.length) {       // the price of the better move
      out.push(f`${bc} does give up ${stacks(lostB)}` + (bare(lb, lostB) ? "" : f` (the engine expects ${lb})`) + ".");
    } else if (cb) {
      out.push(f`After ${bc} the engine expects ${lb}: ${me} ${cb}.`);
    } else if (truthy(linesAlways)) {
      out.push(f`The engine expects ${lp} after ${pc}, and ${lb} after ${bc}.`);
    }
    // ---- territory: the largest area where the better move ends with more, and the largest where with less
    const [more, less] = namedAreas(facts);
    const loss = facts.loss;
    // two areas with one name ("better off in the centre ... and worse off in the centre") are told apart by cells
    const edge = a => a.where.slice(a.where.indexOf(" ") + 1);        // "towards the lower right edge" and "along the ..." are one name
    const same = more.length > 0 && less.length > 0 && edge(more[0]) === edge(less[0]);
    const area = (a, word) => {
      const n = whole(a.cells);
      const place = same ? f`around ${listing(a.around)}` : f`${a.where} (${a.around.join(", ")})`;
      // the difference adds up to the loss, so it is counted in points: a cell that changes hands is two
      return f`about ${n} ${n === 1 ? "point" : "points"} ${word} ${place}`;
    };
    if (facts.method === "ends" && Math.abs(facts.total - loss) > Math.max(2.0, .35 * loss))
      out.push(f`These lines show about ${whole(facts.total)} of the ${points(loss)}.`);
    if (!more.length) {
      out.push(f`The ${points(get(sheet, "loss", loss))} are spread thinly over the board: no area stands out.`);
      return out;
    }
    let text = f`${bc} leaves ${me} ${area(more[0], "better off")}`;
    if (less.length) text += f` and ${area(less[0], "worse off")}`;
    const named = more[0].cells + (less.length ? less[0].cells : 0);
    if (facts.total - named > Math.max(2.0, .35 * loss)) text += "; the rest of its gain is spread thinly";
    out.push(text + ".");
    return out;
  }

  R.words = {Used, COLOUR, OTHER,
    openingText, listing, BASE, would, does, NUMBER, points, TAKEAWAY, KINDS, lessonKind, cellDistance, chance, chancesDrop,
    dramatic, OPENS, AREAS, reach, totalReach, unnamed, clearlyMore, contrast, mergeArea, trim, concreteClauses, regionLine,
    clearRegion, whyElse, similarMoves, beyond, alternativeWords, quotedReply, quotedLine, doomedStack, presenceClause, lineSentences, also, MORE, more, entryParts, commentary, SURE, payoffWords, praiseText, praiseWords, mergedFights,
    pointName, times, standingText, gameText, decisions, shown, MARKS, MARK_NAMES, mark, praised, keyMoves, NOTED, HABIT, STRETCH, countWord, habits, bestStretch, wholeGame, tally,
    engineMargin, recordedScore, playedOut, finalMargin, named, summaryText, LEAD, leadPhases, extremes, course, storyMoves, storyPlies, MELT, swingArea, phasesText, courseText, wantedText, MOMENTS, MOMENTS_SHOWN, passedWords, momentWords, momentsText, levelLine, resultLine, plainEdges, text, CONCRETE,
    SHOWN, STACK, whole, stacks, shownLine, namedAreas, differing, sentences};
  if (typeof module !== "undefined" && module.exports) module.exports = R.words;
})(globalThis);
