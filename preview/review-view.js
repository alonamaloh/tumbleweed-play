"use strict";
// Showing a review: the same object the Python tool saves (training/game_review, review.save) and
// review-sheets.js makes in the page, drawn as the sections of the text version with every move number a link.
// One renderer for the web page, the native apps (which install these sources) and saved reviews opened in the
// page. Nothing here computes: the words come from review-words.js.
(function (scope) {
  const R = scope.Review = scope.Review || {};

  // The parts of a review in the order it is made (review in review-sheets.js reports them through onPart), with
  // what to call each while it is still to come. A review being made is shown with the parts it has.
  const PARTS = [["result", null], ["opening", null], ["level", "the level of play"], ["entries", "the key moves"],
    ["points", "where the points went"], ["whole", "the notes on the whole game"], ["story", "how the game went"],
    ["moments", "what is worth noticing"]];

  // The whole-game part of a review, in the order of the text version: [{title, lines}]. parts: the parts a
  // review being made has so far (null: all of them).
  function sections(r, parts = null) {
    const W = R.words, out = [];
    const add = (part, title, lines) => { if ((!parts || parts.includes(part)) && lines().length) out.push({title, lines: lines()}); };
    add("result", "Result", () => [W.resultLine(r)].filter(Boolean));
    add("level", "Level of play", () => [W.levelLine(r)].filter(Boolean));
    add("opening", "The opening", () => W.openingText(r.opening === undefined ? null : r.opening, r.game.pie === undefined ? true : r.game.pie));
    add("story", "How the game went", () => W.courseText(r));
    add("moments", "Worth noticing", () => W.momentsText(r));
    add("points", "Where the points went", () => W.summaryText(r));
    add("whole", "Over the whole game", () => W.wholeGame(r));
    return out;
  }

  // What a review being made does not have yet, as words: "the key moves, how the game went and ...".
  function pending(parts) {
    const left = parts ? PARTS.filter(([name, words]) => words && !parts.includes(name)).map(x => x[1]) : [];
    return left.length > 1 ? `${left.slice(0, -1).join(", ")} and ${left.at(-1)}` : left.join("");
  }

  // The entries of the key moves, in the order of the game: {kind (good, mistake, dubious), ply, moveNumber,
  // colour, cell, loss, lines (main text), details, sheet}.
  function entries(r) {
    const W = R.words;
    return W.keyMoves(r).map(([kind, sheet, words]) => {
      const [lines, details] = W.entryParts(words);
      return {kind, ply: sheet.ply, moveNumber: sheet.move_number, colour: sheet.colour, cell: sheet.played.cell || "pass",
        loss: kind === "good" ? 0 : Math.max(0, sheet.loss || 0), lines, details, sheet};
    });
  }

  // A sentence as nodes, every move number a button: "move 14", "moves 16, 18 and 32", "moves 100 to 112",
  // "Move 20, White". onMove(number) is called on a press.
  function linked(text, onMove) {
    const out = document.createDocumentFragment();
    const pattern = /\b([Mm]oves? )(\d+(?:(?:, | and | to )\d+)*)/g;
    let last = 0, m;
    while ((m = pattern.exec(text)) !== null) {
      out.append(text.slice(last, m.index), m[1]);
      for (const part of m[2].split(/(\d+)/)) {
        if (!/^\d+$/.test(part)) { if (part) out.append(part); continue; }
        const b = document.createElement("button");
        b.type = "button"; b.className = "move-link"; b.textContent = part; b.dataset.move = part;
        b.addEventListener("click", () => onMove(Number(part)));
        out.append(b);
      }
      last = m.index + m[0].length;
    }
    out.append(text.slice(last));
    return out;
  }

  // Draw the whole-game part and the list of key moves into `container`. current: the move number whose entry is
  // open (its row is marked). onMove(number, entry or null): a press on a move number or on a key move. parts: the
  // parts a review being made has so far; what is still to come is named at the end.
  function render(container, r, onMove, current = null, parts = null) {
    const W = R.words;
    container.replaceChildren();
    for (const s of sections(r, parts)) {
      const box = document.createElement("section"), h = document.createElement("h3");
      box.className = "review-section"; h.textContent = s.title; box.append(h);
      for (const line of s.lines) { const p = document.createElement("p"); p.append(linked(line, n => onMove(n, null))); box.append(p); }
      container.append(box);
    }
    const list = !parts || parts.includes("entries") ? entries(r) : [];
    if (list.length) {
      const box = document.createElement("section"), h = document.createElement("h3"), ul = document.createElement("ul");
      box.className = "review-section"; h.textContent = "Key moves"; ul.className = "key-moves"; box.append(h, ul);
      for (const e of list) {
        const li = document.createElement("li"), b = document.createElement("button"), mark = document.createElement("span"), cost = document.createElement("span");
        b.type = "button"; b.className = `key-move ${e.kind}${e.moveNumber === current ? " current" : ""}`;
        mark.className = "explain-mark"; mark.textContent = W.MARKS[e.kind] || "";
        cost.className = "key-cost"; cost.textContent = e.kind === "good" ? "good move" : `about ${W.points(e.loss)}`;
        b.append(mark, `Move ${e.moveNumber}, ${e.colour}: ${e.cell}`, cost);
        b.addEventListener("click", () => onMove(e.moveNumber, e));
        li.append(b); ul.append(li);
      }
      container.append(box);
    }
    const left = pending(parts);
    if (left) {
      const p = document.createElement("p");
      p.className = "review-pending"; p.textContent = `Still to come: ${left}.`;
      container.append(p);
    }
  }

  R.view = {PARTS, sections, pending, entries, linked, render};
  if (typeof module !== "undefined" && module.exports) module.exports = R.view;
})(globalThis);
