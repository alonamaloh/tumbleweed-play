// Board geometry and exact Tumbleweed rules for game review.
//
// A port of training/game_review/board.py (everything except check_rules). The Python is the reference:
// change it first, then this file, and run the parity test
//     node tools/review_port/check_detect.js
// which recomputes what the Python computed on real games and must report no mismatch.
//
// Cells use the search modules' grid: index r * g + c with g = 2 * side - 1 and |c - r| < side. The name is
// the column letter c (A, B, ...) followed by the row number r + 1 (as position.js cellName).
// Cell codes: 0 empty, height + 6 * (player - 1) for player 1 (Red) or 2 (White), 13 the neutral stack.
// A "compact" index counts the valid cells in grid order; everything below works on compact indices.
//
// Rules used here: from a cell, a player sees the first stack in each of the six directions. A player may
// place a stack on a cell whose height equals the number of their own stacks seen from it, provided that
// is higher than the stack already there (empty counts as height 0). This can capture an opponent stack,
// the neutral stack, or raise their own stack. CodeCup (and the search modules) also forbid a placement
// the opponent could take over at once: the new height must be at least the opponent's count there. Other
// sites allow such moves; the review calls them exposed. Score: own stacks plus empty cells where the player
// sees more of their own stacks than the opponent does.
//
// How the Python types map here:
//   numpy arrays (codes, own, h, rc, sight)  plain Arrays; p.sight[player][cell] for the Python p.sight[player, cell]
//   dict keyed by cell (can_place, capturable) Map in ascending cell order, like the Python dict
//   Board.compact (dict grid -> compact)     Array over the whole grid, -1 where the grid cell is off the board
//   Board.corners (dict name -> compact)     plain object; its keys keep the Python's insertion order
//   None for a pass                          null (undefined is accepted too)
"use strict";
(function (scope) {
  const R = scope.Review = scope.Review || {};

  const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [0, -1], [-1, 0], [-1, -1]];
  const NEUTRAL = 13;

  class Board {
    constructor(side) {
      this.side = side;
      this.g = 2 * side - 1;
      const g = this.g;
      // cells: grid index of every valid cell; compact: the inverse; rc: [row, column] of every valid cell
      this.cells = [];
      this.compact = new Array(g * g).fill(-1);
      this.rc = [];
      for (let r = 0; r < g; r++) {
        for (let c = 0; c < g; c++) {
          if (Math.abs(c - r) < side) {
            this.compact[r * g + c] = this.cells.length;
            this.cells.push(r * g + c);
            this.rc.push([r, c]);
          }
        }
      }
      this.n = this.cells.length;
      // rays[i][d]: compact indices along direction d from cell i, nearest first
      this.rays = [];
      for (const [r, c] of this.rc) {
        const rays = [];
        for (const [dr, dc] of DIRECTIONS) {
          const ray = [];
          let rr = r + dr, cc = c + dc;
          while (rr >= 0 && rr < g && cc >= 0 && cc < g && Math.abs(cc - rr) < side) {
            ray.push(this.compact[rr * g + cc]);
            rr += dr;
            cc += dc;
          }
          rays.push(ray);
        }
        this.rays.push(rays);
      }
      this.neighbours = this.rays.map(rays => rays.filter(ray => ray.length).map(ray => ray[0]));
      // the six corners by name, in the Python's order (where() breaks ties by this order)
      const s = side - 1;
      const letter = k => String.fromCharCode(65 + k);
      this.corners = {};
      for (const [name, r, c] of [["A1", 0, 0], [`${letter(s)}1`, 0, s], [`A${s + 1}`, s, 0],
                                  [`${letter(2 * s)}${s + 1}`, s, 2 * s], [`${letter(s)}${2 * s + 1}`, 2 * s, s],
                                  [`${letter(2 * s)}${2 * s + 1}`, 2 * s, 2 * s]])
        this.corners[name] = this.compact[r * g + c];
      this.centre = this.compact[s * g + s];
    }

    // The name of compact cell i: column letter, then row number.
    name(i) {
      const [r, c] = this.rc[i];
      return String.fromCharCode(65 + c) + (r + 1);
    }

    // The compact index of a cell name. Where the Python raises KeyError (no such grid cell) this throws.
    // Like the Python it does not check the column on its own: a letter past the last column wraps into the
    // next row ("P1" on size 8 is read as "A2").
    index(name) {
      const c = name[0].toUpperCase().charCodeAt(0) - 65, r = parseInt(name.slice(1), 10) - 1;
      const i = this.compact[r * this.g + c];
      if (!(i >= 0)) throw new Error(`No such cell on a size ${this.side} board: ${name}`);
      return i;
    }

    // Number of steps between two cells on the hexagonal grid.
    distance(i, j) {
      const [r1, c1] = this.rc[i], [r2, c2] = this.rc[j];
      const dr = r1 - r2, dc = c1 - c2;
      return Math.max(Math.abs(dr), Math.abs(dc), Math.abs(dr - dc));
    }
  }

  // Who owns a cell code: 0 nobody, 1 Red, 2 White, 3 the neutral stack.
  function owner(code) {
    return code === 0 ? 0 : code === NEUTRAL ? 3 : code <= 6 ? 1 : 2;
  }

  // The height of the stack a cell code stands for (0 for an empty cell, 2 for the neutral stack).
  function height(code) {
    return code === 0 ? 0 : code === NEUTRAL ? 2 : (code - 1) % 6 + 1;
  }

  // A position as compact codes plus the side to move, with the derived quantities used for review.
  class Position {
    constructor(board, codes, stm) {
      this.b = board;
      this.codes = Array.from(codes, Number);         // a copy: a Position never changes after it is made
      this.stm = Number(stm);
      this.own = this.codes.map(owner);
      this.h = this.codes.map(height);
      // sight[p][i]: number of player p's stacks seen from cell i (p = 1, 2; row 0 stays zero)
      this.sight = [new Array(board.n).fill(0), new Array(board.n).fill(0), new Array(board.n).fill(0)];
      for (let i = 0; i < board.n; i++) {
        for (const ray of board.rays[i]) {
          for (const j of ray) {
            if (this.codes[j]) {
              if (this.own[j] === 1 || this.own[j] === 2) this.sight[this.own[j]][i] += 1;
              break;
            }
          }
        }
      }
    }

    // Cells where player may place, with the new height (Map cell -> height, ascending cells).
    // codecup = true: the engine's legal moves.
    canPlace(player, codecup = false) {
      const s = this.sight[player], o = this.sight[3 - player];
      const out = new Map();
      for (let i = 0; i < this.b.n; i++)
        if (s[i] > this.h[i] && (!codecup || s[i] >= o[i])) out.set(i, s[i]);
      return out;
    }

    // Stacks not belonging to `by` that `by` could take over next turn: Map cell -> [owner, height, new height].
    capturable(by) {
      const s = this.sight[by];
      const out = new Map();
      for (let i = 0; i < this.b.n; i++)
        if (this.own[i] !== 0 && this.own[i] !== by && s[i] > this.h[i]) out.set(i, [this.own[i], this.h[i], s[i]]);
      return out;
    }

    // [Red, White] by the final-count rule, applied to the current position.
    score() {
      let red = 0, white = 0;
      for (let i = 0; i < this.b.n; i++) {
        if (this.own[i] === 1) red += 1;
        else if (this.own[i] === 2) white += 1;
        else if (this.own[i] === 0) {
          if (this.sight[1][i] > this.sight[2][i]) red += 1;
          else if (this.sight[2][i] > this.sight[1][i]) white += 1;
        }
      }
      return [red, white];
    }

    // The position after the side to move places at compact cell `move` (null = pass).
    after(move) {
      const codes = this.codes.slice();
      if (move !== null && move !== undefined) codes[move] = this.sight[this.stm][move] + 6 * (this.stm - 1);
      return new Position(this.b, codes, 3 - this.stm);
    }
  }

  R.board = {Board, Position, owner, height, DIRECTIONS, NEUTRAL};
  if (typeof module !== "undefined" && module.exports) module.exports = R.board;
})(globalThis);
