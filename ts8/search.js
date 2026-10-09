// Isolated CNN search, shared by a classic worker and Node tests.
(function (root) {
  'use strict';

  const CELL_COUNT = 169;
  const BOARD_CELLS = 225;
  const DEFAULTS = Object.freeze({
    budget: 1000, batchSize: 16, earlyStop: true,
    cpuct: 0.2, cpuctGrowth: 0.1, cpuctBase: 1000,
    temperature: 1.4, epsilon: 0.02,
  });

  function requireInteger(value, minimum, maximum, name) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new Error(`${name} must be an integer in [${minimum},${maximum}]`);
  }

  function bestVisitedEdge(node) {
    let best = null;
    for (const edge of node.edges) {
      if (edge.visits && (!best || edge.visits > best.visits ||
          edge.visits === best.visits && edge.move < best.move)) best = edge;
    }
    return best;
  }

  /**
   * The board adapter owns the mutable rules board. reset() restores its current
   * root, play(boardIndex) applies a legal move (or -1 for a forced pass), and
   * inspect() returns {side,cells,legal,territory,terminal,scoreRed,scoreWhite}.
   * cells are compact int32 codes; legal/territory use square-board indices.
   * compactToBoard must be the model's cell order, not policy rank order.
   *
   * initialize({policy,own,margin}) expands the root without a simulation.
   * policy contains compact logits, own mover-relative probabilities in [0,1],
   * and margin the raw mover-relative ownership sum. For each gather(), infer
   * its positions together, then complete(batch, predictionsInTheSameOrder).
   * A zero-size batch needs no inference or complete(): exact terminal leaves
   * were already backed up. Only one batch may be pending at a time.
   *
   * Pending paths receive one virtual visit and worst-case utility -1 per
   * parent edge. Those reservations affect selection only; no real visit,
   * margin or ownership sample is added until evaluation completes. A frontier
   * is reserved at most once per batch. If all reachable frontiers are pending,
   * gather returns a smaller batch rather than inventing duplicate samples.
   */
  class BatchedSearch {
    constructor({board, compactToBoard, side = 8, ...settings}) {
      if (side !== 6 && side !== 8) throw new Error('side must be 6 or 8');
      this.side = side;
      this.cellCount = 3 * side * (side - 1) + 1;
      this.boardCells = (2 * side - 1) ** 2;
      if (!board || typeof board.reset !== 'function' ||
          typeof board.play !== 'function' || typeof board.inspect !== 'function')
        throw new Error('A reset/play/inspect board adapter is required');
      if (!compactToBoard || compactToBoard.length !== this.cellCount)
        throw new Error(`compactToBoard must contain ${this.cellCount} board indices`);
      this.compactToBoard = Array.from(compactToBoard);
      this.boardToCompact = new Int16Array(this.boardCells).fill(-1);
      this.compactToBoard.forEach((cell, compact) => {
        requireInteger(cell, 0, this.boardCells - 1, 'compact board index');
        if (this.boardToCompact[cell] !== -1) throw new Error('duplicate compact board index');
        const width = 2 * side - 1;
        if (Math.abs(cell % width - Math.floor(cell / width)) >= side)
          throw new Error('compact board index lies outside the hex geometry');
        this.boardToCompact[cell] = compact;
      });
      this.options = {...DEFAULTS, ...settings};
      const o = this.options;
      requireInteger(o.budget, 1, 1000000, 'budget');
      requireInteger(o.batchSize, 1, 16, 'batchSize');
      if (!Number.isFinite(o.cpuct) || o.cpuct < 0 ||
          !Number.isFinite(o.cpuctGrowth) || o.cpuctGrowth < 0 ||
          !Number.isFinite(o.cpuctBase) || o.cpuctBase <= 0 ||
          !Number.isFinite(o.temperature) || o.temperature <= 0 ||
          !Number.isFinite(o.epsilon) || o.epsilon < 0 || o.epsilon > 1 ||
          typeof o.earlyStop !== 'boolean') throw new Error('Invalid PUCT settings');
      this.board = board;
      this.version = 0;
      this.nextBatchId = 0;
      this.pendingBatch = null;
      this.pending = [];
      this.inheritedVisits = 0;
      board.reset();
      this.root = this.makeNode(this.readState());
    }

    readState() {
      const state = this.board.inspect();
      if (!state || state.side !== 1 && state.side !== 2 ||
          !state.cells || state.cells.length !== this.cellCount ||
          !state.territory || state.territory.length !== this.boardCells ||
          !Array.isArray(state.legal) || typeof state.terminal !== 'boolean')
        throw new Error('Invalid board state');
      for (const code of state.cells) requireInteger(code, 0, 13, 'cell code');
      for (const owner of state.territory) requireInteger(owner, 0, 2, 'territory owner');
      requireInteger(state.scoreRed, 0, this.cellCount, 'Red score');
      requireInteger(state.scoreWhite, 0, this.cellCount, 'White score');
      if (state.scoreRed + state.scoreWhite > this.cellCount) throw new Error('Invalid total score');
      const legal = Array.from(state.legal).sort((a, b) => a - b);
      for (let i = 0; i < legal.length; ++i) {
        const move = legal[i];
        requireInteger(move, 0, this.boardCells - 1, 'legal move');
        if (this.boardToCompact[move] < 0 || i && legal[i - 1] === move)
          throw new Error('Invalid or duplicate legal move');
      }
      return {
        side: state.side, cells: new Int32Array(state.cells), legal,
        territory: new Int8Array(state.territory), terminal: state.terminal,
        scoreRed: state.scoreRed, scoreWhite: state.scoreWhite,
      };
    }

    makeNode(state) {
      const node = {
        state, edges: [], expanded: state.terminal, rawMargin: null,
        rawOwnership: null, visits: 0, marginSum: 0, pending: 0,
        samples: 0, ownershipSum: new Float64Array(this.cellCount), depth: 0,
      };
      if (state.terminal) {
        node.rawMargin = (state.scoreRed - state.scoreWhite) * (state.side === 1 ? 1 : -1);
        node.rawOwnership = this.exactOwnership(state);
      }
      return node;
    }

    rootPosition() {
      return {cells: new Int32Array(this.root.state.cells), side: this.root.state.side};
    }

    initialized() { return this.root.expanded; }

    exactOwnership(state) {
      return Float64Array.from(this.compactToBoard, (cell) =>
        state.territory[cell] === 1 ? 1 : state.territory[cell] === 2 ? -1 : 0);
    }

    preparePrediction(node, prediction) {
      if (!prediction || !prediction.policy || prediction.policy.length !== this.cellCount ||
          !prediction.own || prediction.own.length !== this.cellCount ||
          !Number.isFinite(prediction.margin)) throw new Error('Invalid CNN prediction');
      const ownership = new Float64Array(this.cellCount);
      const sideSign = node.state.side === 1 ? 1 : -1;
      let rawSum = 0;
      for (let i = 0; i < this.cellCount; ++i) {
        const logit = prediction.policy[i], probability = prediction.own[i];
        if (!Number.isFinite(logit) || !Number.isFinite(probability) ||
            probability < 0 || probability > 1) throw new Error('Invalid CNN output value');
        const signed = 2 * probability - 1;
        rawSum += signed;
        const certain = node.state.territory[this.compactToBoard[i]];
        ownership[i] = certain === 1 ? 1 : certain === 2 ? -1 : signed * sideSign;
      }
      if (Math.abs(rawSum - prediction.margin) > 0.02)
        throw new Error('CNN margin does not match raw ownership sum');
      const moves = node.state.legal.length ? node.state.legal : [-1];
      const logits = moves.map(move => move < 0 ? 0 : prediction.policy[this.boardToCompact[move]]);
      const peak = Math.max(...logits);
      const weights = logits.map(logit => Math.exp((logit - peak) / this.options.temperature));
      const total = weights.reduce((a, b) => a + b, 0);
      const edges = moves.map((move, index) => ({
        move, prior: (1 - this.options.epsilon) * weights[index] / total + this.options.epsilon / moves.length,
        visits: 0, marginSum: 0, pending: 0, child: null,
      }));
      return {rawMargin: prediction.margin, rawOwnership: ownership, edges};
    }

    applyPrediction(node, prepared) {
      node.rawMargin = prepared.rawMargin;
      node.rawOwnership = prepared.rawOwnership;
      node.edges = prepared.edges;
      node.expanded = true;
    }

    initialize(prediction) {
      if (this.root.state.terminal) return;
      if (this.root.expanded) throw new Error('Root is already initialized');
      this.applyPrediction(this.root, this.preparePrediction(this.root, prediction));
    }

    select(node, blocked) {
      const visits = node.visits + node.pending;
      const fpu = (node.visits ? node.marginSum / node.visits : node.rawMargin) / this.cellCount;
      const coefficient = this.options.cpuct + this.options.cpuctGrowth *
        Math.log1p(visits / this.options.cpuctBase);
      const factor = coefficient * Math.sqrt(Math.max(1, visits));
      let best = null, bestScore = -Infinity;
      for (const edge of node.edges) {
        if (blocked.has(edge) || edge.child && !edge.child.expanded && edge.child.pending) continue;
        const reservedVisits = edge.visits + edge.pending;
        // Utility is margin / cell count (K=0). Pending edges reserve utility -1.
        const value = reservedVisits ?
          (edge.marginSum / this.cellCount - edge.pending) / reservedVisits : fpu;
        const score = value + factor * edge.prior / (1 + reservedVisits);
        if (score > bestScore || score === bestScore && (!best || edge.move < best.move)) {
          best = edge;
          bestScore = score;
        }
      }
      return best;
    }

    reserve(path) {
      for (const node of path.nodes) ++node.pending;
      for (const edge of path.edges) ++edge.pending;
      this.pending.push(path);
    }

    release(path) {
      for (const node of path.nodes) --node.pending;
      for (const edge of path.edges) --edge.pending;
    }

    backup(path, leafMargin, ownership) {
      const leafSign = path.nodes[path.nodes.length - 1].state.side === 1 ? 1 : -1;
      const redMargin = leafMargin * leafSign;
      for (let i = 0; i < path.nodes.length; ++i) {
        const node = path.nodes[i];
        const margin = redMargin * (node.state.side === 1 ? 1 : -1);
        ++node.visits;
        node.marginSum += margin;
        ++node.samples;
        for (let cell = 0; cell < this.cellCount; ++cell) node.ownershipSum[cell] += ownership[cell];
        node.depth = Math.max(node.depth, path.nodes.length - i - 1);
        if (i < path.edges.length) {
          ++path.edges[i].visits;
          path.edges[i].marginSum += margin;
        }
      }
    }

    gather() {
      if (this.pendingBatch) throw new Error('Complete or discard the pending batch before gathering');
      if (!this.root.expanded) throw new Error('Initialize the root before gathering');
      const batch = {version: this.version, id: ++this.nextBatchId, positions: [], size: 0, simulations: 0};
      if (this.done()) return batch;
      const blocked = new Set();
      // No early-stop check inside this loop: a batch's decision is made only
      // after all its pending predictions have been committed.
      while (batch.simulations < this.options.batchSize &&
             this.root.visits + this.pending.length < this.options.budget) {
        this.board.reset();
        let node = this.root;
        const path = {nodes: [node], edges: []};
        let unavailable = false;
        while (node.expanded && !node.state.terminal) {
          const edge = this.select(node, blocked);
          if (!edge) {
            if (path.edges.length) blocked.add(path.edges[path.edges.length - 1]);
            unavailable = true;
            break;
          }
          if (!this.board.play(edge.move)) throw new Error(`Stored search move ${edge.move} is illegal`);
          if (!edge.child) edge.child = this.makeNode(this.readState());
          path.edges.push(edge);
          node = edge.child;
          path.nodes.push(node);
        }
        if (unavailable) {
          if (!path.edges.length) break;
          continue;
        }
        if (node.state.terminal) this.backup(path, node.rawMargin, node.rawOwnership);
        else {
          this.reserve(path);
          batch.positions.push({cells: new Int32Array(node.state.cells), side: node.state.side});
        }
        ++batch.simulations;
      }
      batch.size = batch.positions.length;
      if (batch.size) this.pendingBatch = batch;
      return batch;
    }

    complete(batch, predictions) {
      // Object identity prevents accidentally applying another search's batch
      // when its numeric version/id happens to be the same.
      if (!batch || batch !== this.pendingBatch || batch.version !== this.version) return false;
      if (!Array.isArray(predictions) || predictions.length !== this.pending.length)
        throw new Error('CNN prediction count does not match the pending batch');
      // Validate the whole batch before changing any real visit or sample.
      const prepared = this.pending.map((path, index) =>
        this.preparePrediction(path.nodes[path.nodes.length - 1], predictions[index]));
      for (let index = 0; index < this.pending.length; ++index) {
        const path = this.pending[index], leaf = path.nodes[path.nodes.length - 1];
        this.release(path);
        this.applyPrediction(leaf, prepared[index]);
        this.backup(path, leaf.rawMargin, leaf.rawOwnership);
      }
      this.pending = [];
      this.pendingBatch = null;
      return true;
    }

    cancel() {
      for (const path of this.pending) this.release(path);
      this.pending = [];
      this.pendingBatch = null;
      ++this.version;
    }

    discard() { this.cancel(); }

    done() {
      if (this.pendingBatch || this.pending.length) return false;
      if (this.root.state.terminal || this.root.visits >= this.options.budget) return true;
      // Match the page's strict lead rule even when only one legal cell exists.
      // A pass sentinel is not a displayed playable candidate, so a pass-only
      // root still finishes its full budget.
      if (!this.options.earlyStop || !this.root.edges.length ||
          this.root.edges.length === 1 && this.root.edges[0].move < 0) return false;
      let first = 0, second = 0;
      for (const edge of this.root.edges) {
        if (edge.visits > first) { second = first; first = edge.visits; }
        else if (edge.visits > second) second = edge.visits;
      }
      return first > second + this.options.budget - this.root.visits;
    }

    /** Call after the owner updates board.reset() to restore the new root. */
    reroot(move) {
      this.cancel();
      const child = this.root.edges.find(edge => edge.move === move)?.child;
      if (!child || !child.expanded) return false;
      this.board.reset();
      const state = this.readState();
      if (child.state.side !== state.side || child.state.terminal !== state.terminal ||
          child.state.cells.some((code, index) => code !== state.cells[index])) return false;
      this.root = child;
      // A retained node includes its initial evaluation visit, as native PUCT
      // does. Its outgoing edges therefore have one fewer inherited visit.
      this.inheritedVisits = child.visits;
      return true;
    }

    ownership(node, fallback) {
      const result = Array(this.boardCells).fill(NaN);
      if (node && (node.samples || fallback && node.rawOwnership)) {
        for (let compact = 0; compact < this.cellCount; ++compact)
          result[this.compactToBoard[compact]] = node.samples ?
            node.ownershipSum[compact] / node.samples : node.rawOwnership[compact];
      }
      return result;
    }

    snapshot() {
      const node = this.root;
      const candidates = node.edges.map((edge, index) => {
        const child = edge.child;
        const replies = child ? child.edges.filter(reply => reply.visits > 0).map(reply => ({
          move: reply.move, visits: reply.visits, prior: reply.prior,
          margin: reply.marginSum / reply.visits,
        })) : [];
        return {
          index, move: edge.move, visits: edge.visits, prior: edge.prior,
          margin: edge.visits ? edge.marginSum / edge.visits : null,
          samples: child?.samples || 0, ownership: this.ownership(child, false), pv: [],
          replyCount: child?.edges.length || 0,
          replyState: !child ? 0 : child.state.terminal ? 2 : child.expanded ? 1 : 0,
          replyBest: child ? bestVisitedEdge(child)?.move ?? -1 : -1,
          replyNodeVisits: child?.visits || 0, replies,
        };
      });
      return {
        side: node.state.side, best: bestVisitedEdge(node)?.move ?? -1,
        visits: node.visits, inheritedVisits: this.inheritedVisits,
        depth: node.depth, capacityReached: false, samples: node.samples,
        candidates, ownership: this.ownership(node, true),
        stdev: Array(this.boardCells).fill(NaN),
      };
    }
  }

  const api = {BatchedSearch, CELL_COUNT, BOARD_CELLS, DEFAULTS};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HighNoonCnnSearch = api;
})(typeof globalThis === 'undefined' ? self : globalThis);
