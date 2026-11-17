"use strict";
(function(scope) {
  const sides = [6, 8, 10, 11];
  const grid = side => 2 * side - 1;
  const valid = (side, c) => Number.isInteger(c) && c >= 0 && c < grid(side) ** 2 &&
    Math.abs(c % grid(side) - Math.floor(c / grid(side))) < side;
  const cells = side => Array.from({length: grid(side) ** 2}, (_, i) => i).filter(c => valid(side, c));
  const centre = side => (side - 1) * (grid(side) + 1);
  const cellName = (side, c) => c < 0 ? "pass" : String.fromCharCode(65 + c % grid(side)) + (Math.floor(c / grid(side)) + 1);
  function parseCell(side, text) {
    if (/^(pass|-)$/i.test(text)) return -1;
    const m = /^([A-Z])(\d+)$/i.exec(text);
    if (!m) throw new Error(`Invalid cell: ${text}`);
    const c = (Number(m[2]) - 1) * grid(side) + m[1].toUpperCase().charCodeAt(0) - 65;
    if (!valid(side, c)) throw new Error(`Cell ${text} is outside size ${side}.`);
    return c;
  }
  function validate(position) {
    if (!position || !sides.includes(position.side) || ![1, 2].includes(position.turn) || !Array.isArray(position.stacks))
      throw new Error("A position needs a board size, side to move and stacks.");
    const seen = new Set();
    for (const stack of position.stacks) {
      if (!Array.isArray(stack) || stack.length !== 3) throw new Error("Invalid stack.");
      const [c, owner, height] = stack;
      if (!valid(position.side, c) || seen.has(c) || ![1, 2, 3].includes(owner) ||
          !Number.isInteger(height) || height < 1 || height > 6 || (owner === 3 && height !== 2))
        throw new Error("Use distinct cells, Red/White heights 1–6, and neutral stacks of height 2.");
      seen.add(c);
    }
    return position;
  }
  function initialize(board, position) {
    validate(position);
    if (board._hn_side() !== position.side) throw new Error("Position and board sizes differ.");
    board._hn_clear_custom();
    for (const [cell, owner, height] of position.stacks)
      if (!board._hn_set_stack(cell, owner, height)) throw new Error("Invalid stack.");
    if (!board._hn_set_turn(position.turn)) throw new Error("Invalid side to move.");
  }
  function snapshot(board) {
    const side = board._hn_side();
    return {side, turn: board._hn_stm(), stacks: cells(side).filter(c => board._hn_owner(c))
      .map(c => [c, board._hn_owner(c), board._hn_height(c)])};
  }
  function blank(side, neutral = true) {
    return {side, turn: 1, stacks: neutral ? [[centre(side), 3, 2]] : []};
  }
  function opening(side, red, white) {
    const p = blank(side);
    p.stacks.push([red, 1, 1], [white, 2, 1]);
    p.kind = "normal"; p.red = red; p.white = white;
    return validate(p);
  }
  function handicap(side, reds, white = null) {
    if (!Array.isArray(reds) || reds.length < 1 || reds.length > cells(side).length - 2)
      throw new Error("Choose at least one Red stack and leave room for White.");
    const p = blank(side);
    p.stacks.push(...reds.map(c => [c, 1, 1]));
    if (white !== null) p.stacks.push([white, 2, 1]);
    p.turn = white === null ? 2 : 1;
    p.kind = "handicap"; p.reds = [...reds]; p.white = white;
    return validate(p);
  }
  // The number of a player's stacks seen from a cell: the first stack in each of the six directions.
  function sight(board, cell, player) {
    const side = board._hn_side(), g = grid(side);
    let count = 0;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [0, -1], [-1, 0], [-1, -1]]) {
      let r = Math.floor(cell / g) + dr, c = cell % g + dc;
      while (r >= 0 && r < g && c >= 0 && c < g && Math.abs(c - r) < side) {
        const owner = board._hn_owner(r * g + c);
        if (owner) { count += owner === player; break; }
        r += dr; c += dc;
      }
    }
    return count;
  }
  // recorded: the move comes from a game record. People pass while they still have a move, and the site accepts
  // a stack that the opponent can capture at once; the engine does neither, so the board's own play refuses both.
  // A recorded move only has to follow the rule of the game: a stack as high as the player's stacks in sight,
  // higher than what stands there.
  function play(board, move, recorded = false) {
    if (board._hn_score(2)) throw new Error("The position is already settled.");
    if (move === -1) {
      if (!recorded && board._hn_can_move()) throw new Error("Pass is only available when there is no legal move.");
      board._hn_pass();
    } else if (!board._hn_play(move)) {
      const player = board._hn_stm(), height = recorded && valid(board._hn_side(), move) ? sight(board, move, player) : 0;
      if (height <= board._hn_height(move) || !board._hn_set_stack(move, player, height) || !board._hn_set_turn(3 - player))
        throw new Error(`Illegal move: ${cellName(board._hn_side(), move)}`);
    }
  }
  // Moves that were accepted once are replayed as recorded moves, whether they were played here or loaded.
  function replay(board, position, moves, length = moves.length) {
    initialize(board, position);
    for (const move of moves.slice(0, length)) play(board, move, true);
  }
  function serialize(position, moves = []) {
    validate(position);
    const n = c => cellName(position.side, c);
    let prefix;
    if (position.kind === "normal") prefix = `${n(position.red)} ${n(position.white)}`;
    else if (position.kind === "handicap" && position.white !== null)
      prefix = `[${position.reds.map(n).join(" ")}; ${n(position.white)}]`;
    else prefix = `{size=${position.side}; turn=${position.turn === 1 ? "R" : "W"}; ` +
      [1, 2, 3].map(owner => `${["", "R", "W", "N"][owner]}=` + position.stacks
        .filter(s => s[1] === owner).sort((a,b) => a[0]-b[0]).map(s => `${n(s[0])}:${s[2]}`).join(",")).join("; ") + "}";
    return prefix + (moves.length ? " " + moves.map(n).join(" ") : "");
  }
  function parse(text, defaultSide = 8) {
    text = text.trim();
    let position, tail;
    if (text.startsWith("{")) {
      const end = text.indexOf("}");
      if (end < 0) throw new Error("Missing closing } in the initial position.");
      const fields = {};
      for (const part of text.slice(1, end).split(";")) {
        const m = /^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(part);
        if (!m || Object.hasOwn(fields, m[1])) throw new Error("Invalid initial-position field.");
        fields[m[1]] = m[2];
      }
      if (Object.keys(fields).some(k => !["size","turn","R","W","N"].includes(k))) throw new Error("Unknown position field.");
      const side = Number(fields.size);
      if (!sides.includes(side) || !["R", "W"].includes(fields.turn)) throw new Error("Invalid size or turn.");
      position = blank(side, false); position.turn = fields.turn === "R" ? 1 : 2;
      for (const [key, owner] of [["R",1],["W",2],["N",3]]) {
        for (const token of (fields[key] || "").split(",").map(x => x.trim()).filter(Boolean)) {
          const m = /^([A-Z]\d+):(\d+)$/i.exec(token);
          if (!m) throw new Error(`Invalid stack: ${token}`);
          position.stacks.push([parseCell(side,m[1]),owner,Number(m[2])]);
        }
      }
      tail = text.slice(end+1);
    } else if (text.startsWith("[")) {
      const m = /^\[([^;]+);([^\]]+)\](.*)$/s.exec(text);
      if (!m) throw new Error("Use [Red cells; White cell] for a handicap opening.");
      const whites=m[2].trim().split(/\s+/);
      if (whites.length!==1) throw new Error("A handicap opening has exactly one White stack.");
      position=handicap(defaultSide,m[1].trim().split(/\s+/).map(x=>parseCell(defaultSide,x)),parseCell(defaultSide,whites[0]));
      tail=m[3];
    } else {
      const tokens=text.split(/[\s,]+/).filter(Boolean);
      if(tokens.length<2) throw new Error("Enter two starting cells, a handicap opening, or a custom position.");
      position=opening(defaultSide,parseCell(defaultSide,tokens[0]),parseCell(defaultSide,tokens[1]));
      tail=tokens.slice(2).join(" ");
    }
    validate(position);
    return {position,moves:tail.trim().split(/[\s,]+/).filter(Boolean).map(x=>parseCell(position.side,x))};
  }
  const api={sides,grid,valid,cells,centre,cellName,parseCell,validate,initialize,snapshot,blank,opening,handicap,play,replay,serialize,parse};
  if(typeof module!=="undefined"&&module.exports) module.exports=api; else scope.Position=api;
})(globalThis);
