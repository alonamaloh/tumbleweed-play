// Small board adapter: each instance owns its WASM module and saved search root.
(function (root) {
  'use strict';
  class Rules {
    constructor(module) {
      const side = module?._hn_side?.();
      if (side !== 6 && side !== 8) throw new Error('CNN rules require board size 6 or 8');
      this.module = module;
      this.side = side;
      this.cellCount = 3 * side * (side - 1) + 1;
      const width = 2 * side - 1;
      this.boardCells = width * width;
      this.centre = (this.boardCells - 1) / 2;
      this.compactToBoard = Array.from({length: this.cellCount}, (_, i) => module._hn_compact_cell(i));
      const expected = Array.from({length: this.boardCells}, (_, cell) => cell)
        .filter(cell => Math.abs(cell % width - Math.floor(cell / width)) < side);
      if (this.compactToBoard.some((cell, index) => cell !== expected[index]) ||
          module._hn_compact_cell(this.cellCount) !== -1)
        throw new Error('CNN compact cell mapping does not match the board geometry');
    }
    load(red, white, moves = []) {
      if (![red, white].every(cell => Number.isSafeInteger(cell) && cell !== this.centre &&
          this.compactToBoard.includes(cell)) || red === white)
        throw new Error('Invalid starting stacks');
      if (!this.module._hn_init_display(red, white)) throw new Error('Invalid starting stacks');
      for (const move of moves)
        if (!this.play(move)) throw new Error(`Illegal history move: ${move}`);
      this.save();
    }
    save() {
      if (!this.module._hn_save_root()) throw new Error('Cannot save an uninitialized board');
    }
    reset() {
      if (!this.module._hn_restore_root()) throw new Error('No saved board root');
    }
    play(move) {
      if (!Number.isInteger(move) || move < -1 || move >= this.boardCells) return false;
      return !!(move === -1 ? this.module._hn_pass() : this.module._hn_play(move));
    }
    inspect() {
      const m = this.module, terminal = !!m._hn_score(2);
      const cells = new Int32Array(this.cellCount), territory = new Int8Array(this.boardCells), legal = [];
      this.compactToBoard.forEach((cell, v) => {
        cells[v] = m._hn_cell_code(v);
        territory[cell] = m._hn_territory(cell);
        if (!terminal && m._hn_value(cell)) legal.push(cell);
      });
      return {side: m._hn_stm(), cells, legal, territory, terminal,
        scoreRed: m._hn_score(0), scoreWhite: m._hn_score(1)};
    }
  }
  const api = {Rules};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HighNoonCnnRules = api;
})(globalThis);
