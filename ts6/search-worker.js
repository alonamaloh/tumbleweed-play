// One worker, one inference session, and one outstanding GPU batch. Foreground
// searches preempt timeline estimates; no WebAssembly threads are required.
(function (root) {
  'use strict';
  const PRELIMINARY_SIMS = 20;
  const PRELIMINARY_BATCH_SIZE = 1;
  const ANALYSIS_SIMS = 500000;
  const PLAY_BUDGETS = [1, 10, 100, 5000];

  function predictions(output, cellCount = 169) {
    if (![91, 169].includes(cellCount) || !Number.isSafeInteger(output.batch) || output.batch < 1 ||
        output.policy.length !== output.batch * cellCount || output.own.length !== output.batch * cellCount ||
        output.margin.length !== output.batch) throw new Error('Invalid CNN output dimensions');
    return Array.from({length: output.batch}, (_, i) => ({
      policy: output.policy.subarray(i * cellCount, (i + 1) * cellCount),
      own: output.own.subarray(i * cellCount, (i + 1) * cellCount), margin: output.margin[i],
    }));
  }

  function graphMargin(snapshot) {
    let margin = 0;
    for (const value of snapshot.ownership) if (Number.isFinite(value)) margin += value;
    const leader = snapshot.candidates.filter(x => x.visits > 0)
      .sort((a, b) => b.visits - a.visits || a.move - b.move)[0];
    if (leader && leader.move >= 0 && Number.isFinite(leader.margin))
      margin = (margin + leader.margin * (snapshot.side === 1 ? 1 : -1)) / 2;
    return margin;
  }

  class Controller {
    constructor({rulesFactory, Rules, BatchedSearch, inference, post,
      config = {}, now = () => performance.now(), yieldTurn = () => new Promise(r => setTimeout(r, 0))}) {
      Object.assign(this, {rulesFactory, Rules, BatchedSearch, inference, post, config, now, yieldTurn});
      this.side = config.side ?? 8;
      if (![6, 8].includes(this.side)) throw new Error('Unsupported CNN board size');
      this.cellCount = 3 * this.side * (this.side - 1) + 1;
      this.boardCells = (2 * this.side - 1) ** 2;
      if (config.cells !== undefined && config.cells !== this.boardCells)
        throw new Error('CNN configuration has inconsistent board dimensions');
      this.generation = 0;
      this.active = this.retained = this.preliminary = this.flight = null;
      this.running = this.ready = false;
    }

    async start() {
      const [main, preview, info] = await Promise.all([
        this.rulesFactory(), this.rulesFactory(),
        this.inference.init({generation: this.generation,
          provider: this.config.provider || 'webgpu', model: this.config.modelVariant || 'float32'}),
      ]);
      this.board = new this.Rules(main);
      this.previewBoard = new this.Rules(preview);
      if (this.board.side !== this.side || this.previewBoard.side !== this.side)
        throw new Error('CNN configuration and rules board size disagree');
      this.ready = true;
      this.post({type: 'ready', model: this.config.model || 'dcm01', side: this.side,
        provider: info.providerIntent, budgetSims: ANALYSIS_SIMS});
    }

    invalidateFlight() {
      if (this.flight) this.flight.tree.cancel();
      this.inference.cancel(++this.generation);
    }

    validate(data, budgets = PLAY_BUDGETS) {
      if (!budgets.includes(data.sims))
        throw new Error(`Search budget must be one of ${budgets.join(', ')} simulations`);
      if (!Array.isArray(data.moves) || data.moves.length > 4096 ||
          data.moves.some(m => !Number.isInteger(m) || m < -1 || m >= this.boardCells))
        throw new Error('Invalid game history');
    }

    newTree(board, budget, earlyStop, batchSize) {
      // At Medium's ten visits, one ten-leaf batch would give every candidate
      // one visit and choose by coordinate tie-break instead of using feedback.
      // Tiny foreground searches therefore stay serial. Preview callers also
      // request serial evaluation so each result informs the next selection.
      // Hard's 100 visits use smaller batches for more selection feedback.
      if (batchSize === undefined)
        batchSize = budget <= 10 ? 1 : budget === 100 ? 4 : this.config.batchSize || 16;
      return new this.BatchedSearch({board, compactToBoard: board.compactToBoard,
        side: this.side, budget, batchSize, earlyStop});
    }

    receive(data) {
      if (!this.ready) return;
      try {
        if (!data || typeof data.type !== 'string') throw new Error('Invalid worker message');
        if (data.type === 'stop') {
          if (this.active) {
            this.invalidateFlight();
            this.active.tree.cancel();
            this.active = null;
          }
        } else if (data.type === 'preliminary-stop') {
          if (this.flight?.kind === 'preliminary') this.invalidateFlight();
          this.preliminary = null;
        } else if (data.type === 'preliminary-start') {
          this.validate(data, [PRELIMINARY_SIMS]);
          if (!Array.isArray(data.indices) || data.indices.some(i =>
            !Number.isSafeInteger(i) || i < 0 || i > data.moves.length))
            throw new Error('Invalid timeline indices');
          if (this.flight?.kind === 'preliminary') this.invalidateFlight();
          this.preliminary = {...data, moves: data.moves.slice(), indices: data.indices.slice(),
            next: 0, tree: null};
        } else if (data.type === 'search') {
          if (!['play', 'analysis', 'offer'].includes(data.purpose))
            throw new Error('Invalid search purpose');
          this.validate(data, data.purpose === 'analysis' ? [ANALYSIS_SIMS] : PLAY_BUDGETS);
          this.invalidateFlight();
          if (this.active) this.active.tree.cancel();
          this.active = null;
          const previous = this.retained;
          let tree = null;
          // Easy is policy-led, never inherited from a stronger search. Pie
          // evaluation is private even if a caller accidentally omits fresh.
          const canReuse = !data.fresh && data.sims !== 1 && data.purpose !== 'offer' &&
            previous && previous.sims === data.sims && previous.context === data.context &&
            previous.purpose === data.purpose && previous.red === data.red && previous.white === data.white &&
            previous.moves.length <= data.moves.length &&
            previous.moves.every((move, i) => data.moves[i] === move);
          if (canReuse) {
            tree = previous.tree;
            tree.cancel();
            this.board.reset();
            for (const move of data.moves.slice(previous.moves.length)) {
              if (!this.board.play(move)) throw new Error('Illegal forward history move');
              this.board.save();
              if (!tree.reroot(move)) { tree = null; break; }
            }
          }
          if (!tree) {
            this.board.load(data.red, data.white, data.moves);
            tree = this.newTree(this.board, data.sims, true);
          } else tree.inheritedVisits = tree.snapshot().visits;
          const job = {...data, moves: data.moves.slice(), tree, started: this.now(),
            searchStarted: null, lastReport: -Infinity};
          this.active = this.retained = job;
        }
        void this.pump();
      } catch (error) {
        const preliminary = typeof data?.type === 'string' && data.type.startsWith('preliminary');
        if (preliminary) this.preliminary = null;
        else this.active = this.retained = null;
        this.post({type: preliminary ? 'preliminary-error' : 'error', gen: data?.gen,
          token: data?.token, message: String(error.message || error)});
      }
    }

    async evaluate(positions) {
      const cells = new Int32Array(positions.length * this.cellCount), stm = new Int32Array(positions.length);
      positions.forEach((position, i) => {
        if (position.cells.length !== this.cellCount) throw new Error('Invalid CNN input dimensions');
        cells.set(position.cells, i * this.cellCount);
        stm[i] = position.side;
      });
      return predictions(await this.inference.evaluate({generation: this.generation, cells, stm}), this.cellCount);
    }

    report(job, type) {
      const snapshot = job.tree.snapshot(), now = this.now();
      const searchVisits = Math.max(0, snapshot.visits - snapshot.inheritedVisits);
      const searchMs = job.searchStarted === null ? 0 : Math.max(0, now - job.searchStarted);
      const rate = searchVisits * 1000 / searchMs;
      const simsPerSecond = Number.isFinite(searchVisits) && searchVisits > 0 &&
        Number.isFinite(searchMs) && searchMs > 0 && Number.isFinite(rate) ? rate : null;
      this.post({...snapshot, type, gen: job.gen, context: job.context,
        purpose: job.purpose, budgetSims: job.sims, ms: now - job.started,
        searchVisits, searchMs, simsPerSecond});
      job.lastReport = now;
    }

    async pump() {
      if (this.running || !this.ready) return;
      this.running = true;
      try {
        while (this.active || this.preliminary) {
          const main = !!this.active, job = main ? this.active : this.preliminary;
          const current = () => (main ? this.active : this.preliminary) === job;
          try {
            // A replacement may wait for a cancelled GPU batch to settle. Start
            // its clock only when this pump can begin its own search work.
            if (main && job.searchStarted === null) job.searchStarted = this.now();
            if (!main && !job.tree) {
              if (job.next >= job.indices.length) {
                this.post({type: 'preliminary-done', token: job.token});
                this.preliminary = null;
                continue;
              }
              this.previewBoard.load(job.red, job.white, job.moves.slice(0, job.indices[job.next]));
              // Timeline points always get the same fresh budget. Their scalars
              // neither complete a normal search nor contaminate its tree.
              job.tree = this.newTree(this.previewBoard, PRELIMINARY_SIMS, false, PRELIMINARY_BATCH_SIZE);
            }
            const tree = job.tree;
            this.flight = {tree, kind: main ? 'main' : 'preliminary'};
            const revision = this.generation;
            if (!tree.initialized()) {
              const [prediction] = await this.evaluate([tree.rootPosition()]);
              if (!current() || revision !== this.generation) continue;
              tree.initialize(prediction);
              if (main) this.report(job, 'progress');
            } else if (!tree.done()) {
              const batch = tree.gather();
              if (batch.size) {
                const output = await this.evaluate(batch.positions);
                if (!current() || revision !== this.generation) continue;
                tree.complete(batch, output);
              }
            }
            if (!current()) continue;
            if (tree.done()) {
              if (main) {
                this.report(job, 'done');
                this.active = null;
              } else {
                const snapshot = tree.snapshot();
                this.previewBoard.reset();
                const state = this.previewBoard.inspect();
                this.post({type: 'preliminary', token: job.token, index: job.indices[job.next],
                  margin: state.terminal ? state.scoreRed - state.scoreWhite : graphMargin(snapshot),
                  exact: state.terminal, visits: snapshot.visits});
                ++job.next;
                job.tree = null;
              }
            } else if (main && this.now() - job.lastReport >= 120) this.report(job, 'progress');
          } catch (error) {
            if (current() && error.name !== 'CancelledError') {
              this.post({type: main ? 'error' : 'preliminary-error', gen: main ? job.gen : undefined,
                token: job.token, message: String(error.message || error)});
              if (main) this.active = this.retained = null;
              else this.preliminary = null;
            }
          } finally { this.flight = null; }
          // Deliver input/cancellation messages between batches, even for exact
          // leaves that require no asynchronous GPU call.
          await this.yieldTurn();
        }
      } finally { this.running = false; }
    }
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = {Controller, graphMargin, predictions};
  } else {
    importScripts('config.js?v=cnn-v11', 'hn.js?v=cnn-v11', 'rules.js?v=cnn-v11',
      'search.js?v=cnn-v11', 'inference.js?v=cnn-v11', 'runtime/ort.webgpu.min.js?v=cnn-v11');
    const runtimeUrl = name => new URL('runtime/' + name + '?v=cnn-v11', self.location.href).href;
    const inference = new HighNoonCnnInference.Inference({ort,
      cellCount: 3 * ANALYSIS_CONFIG.side * (ANALYSIS_CONFIG.side - 1) + 1,
      modelUrls: ANALYSIS_CONFIG.modelUrls,
      wasmPaths: {
      mjs: runtimeUrl('ort-wasm-simd-threaded.asyncify.mjs'),
      wasm: runtimeUrl('ort-wasm-simd-threaded.asyncify.wasm'),
    }, beforeCreate: async () => {
      if (!self.navigator.gpu || !await self.navigator.gpu.requestAdapter())
        throw new Error('This local CNN page needs a browser with WebGPU enabled. The NNUE pages are unchanged.');
      return {};
    }});
    const controller = new Controller({rulesFactory: HN, Rules: HighNoonCnnRules.Rules,
      BatchedSearch: HighNoonCnnSearch.BatchedSearch, inference,
      config: ANALYSIS_CONFIG, post: data => postMessage(data)});
    onmessage = event => controller.receive(event.data);
    controller.start().catch(error => postMessage({type: 'error', message: String(error.message || error)}));
  }
})(globalThis);
