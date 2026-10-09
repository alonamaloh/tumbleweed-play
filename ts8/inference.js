// Standalone directional-CNN inference. No game rules or search live here.
// This classic script works in a worker and under Node with an injected ORT.
(function (root) {
  'use strict';

  const CELL_COUNT = 169;
  const MODEL_URLS = Object.freeze({
    float32: 'models/dc8i01_side8.onnx',
    'float16-weights': 'models/dc8i01_side8_f16.onnx',
    'float16-compute': 'models/dc8i01_side8_fp16compute.onnx',
  });

  class CancelledError extends Error {
    constructor() {
      super('Inference request was superseded or cancelled');
      this.name = 'CancelledError';
    }
  }

  function checkGeneration(generation) {
    if (!Number.isSafeInteger(generation) || generation < 0)
      throw new Error('generation must be a nonnegative safe integer');
  }

  function inputArray(value, name) {
    if (!Array.isArray(value) && !(value instanceof Int32Array))
      throw new Error(`${name} must be an Int32Array or a flat integer array`);
    return value;
  }

  function packInputs(cells, stm, cellCount) {
    inputArray(cells, 'cells');
    inputArray(stm, 'stm');
    const batch = stm.length;
    if (!batch || cells.length !== batch * cellCount)
      throw new Error(`inputs must have dimensions cells [B,${cellCount}] and stm [B], with B > 0`);
    for (const cell of cells)
      if (!Number.isInteger(cell) || cell < 0 || cell > 13)
        throw new Error('cell codes must be integers from 0 through 13');
    for (const side of stm)
      if (side !== 1 && side !== 2) throw new Error('stm must contain only 1 (Red) or 2 (White)');
    return { batch, cells: new Int32Array(cells), stm: new Int32Array(stm) };
  }

  async function copyOutput(tensor, name, dimensions) {
    if (!tensor || tensor.type !== 'float32' || !Array.isArray(tensor.dims) ||
        tensor.dims.length !== dimensions.length ||
        tensor.dims.some((dimension, index) => dimension !== dimensions[index]))
      throw new Error(`${name} must be float32 with dimensions [${dimensions}]`);
    // getData also handles a GPU-resident output; measuring run() alone would
    // miss that readback. Returned arrays never alias ORT-owned tensor storage.
    const data = typeof tensor.getData === 'function' ? await tensor.getData() : tensor.data;
    if (!(data instanceof Float32Array) || data.length !== dimensions.reduce((a, b) => a * b, 1))
      throw new Error(`${name} has invalid output storage`);
    const copy = new Float32Array(data);
    for (const value of copy)
      if (!Number.isFinite(value)) throw new Error(`${name} contains a nonfinite value`);
    return copy;
  }

  async function disposeTensors(tensors) {
    // Best-effort cleanup must continue after one disposal fails. Preserve the
    // first cleanup error when there is no earlier inference error.
    let firstError;
    for (const tensor of new Set(tensors)) {
      if (tensor && typeof tensor.dispose === 'function') {
        try { await tensor.dispose(); } catch (error) { firstError ??= error; }
      }
    }
    if (firstError) throw firstError;
  }

  class Inference {
    constructor({ ort, cellCount = CELL_COUNT, modelUrls = MODEL_URLS,
      now = () => performance.now(), wasmPaths = 'runtime/', beforeCreate = async () => ({}) }) {
      if (!ort?.InferenceSession?.create || !ort.Tensor || !ort.env?.wasm)
        throw new Error('An ONNX Runtime Web instance is required');
      if (cellCount !== 91 && cellCount !== 169)
        throw new Error('cellCount must be 91 (size 6) or 169 (size 8)');
      if (!modelUrls || typeof modelUrls !== 'object' || Array.isArray(modelUrls) ||
          !Object.hasOwn(modelUrls, 'float32') ||
          Object.entries(modelUrls).some(([variant, url]) =>
            !Object.hasOwn(MODEL_URLS, variant) || typeof url !== 'string' || !url.trim()))
        throw new Error('modelUrls must map supported model variants to nonempty URLs, including float32');
      if (cellCount !== CELL_COUNT && modelUrls === MODEL_URLS)
        throw new Error('Size-6 inference requires explicit modelUrls for its geometry');
      this.ort = ort;
      this.cellCount = cellCount;
      this.modelUrls = Object.freeze({...modelUrls});
      this.now = now;
      this.beforeCreate = beforeCreate;
      this.generation = -1;
      this.revision = 0;
      this.session = null;
      this.provider = null;
      this.model = null;
      this.accepting = false;
      this.queue = Promise.resolve();
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = wasmPaths;
    }

    enqueue(operation) {
      const next = this.queue.then(operation);
      // A rejected call cannot poison future lifecycle operations.
      this.queue = next.catch(() => {});
      return next;
    }

    advance(generation) {
      checkGeneration(generation);
      if (generation <= this.generation)
        throw new Error('lifecycle generation must be greater than the current generation');
      this.generation = generation;
      return ++this.revision;
    }

    current(generation, revision) {
      if (generation !== this.generation || revision !== this.revision) throw new CancelledError();
    }

    async releaseSession() {
      const previous = this.session;
      this.session = null;
      this.provider = this.model = null;
      if (previous) await previous.release();
    }

    async init({ generation, provider, model = 'float32' }) {
      if (provider !== 'webgpu' && provider !== 'wasm')
        throw new Error('provider must explicitly be webgpu or wasm');
      if (!Object.hasOwn(this.modelUrls, model)) throw new Error('unknown model variant');
      const revision = this.advance(generation);
      this.accepting = false;
      return this.enqueue(async () => {
        this.current(generation, revision);
        await this.releaseSession();
        this.current(generation, revision);
        const capabilities = await this.beforeCreate({ provider, model });
        this.current(generation, revision);
        const creationStart = this.now();
        const session = await this.ort.InferenceSession.create(this.modelUrls[model], {
          executionProviders: [provider],
          graphOptimizationLevel: 'all',
        });
        const creationMs = this.now() - creationStart;
        if (generation !== this.generation || revision !== this.revision) {
          await session.release();
          throw new CancelledError();
        }
        this.session = session;
        this.provider = provider;
        this.model = model;
        this.accepting = true;
        return {
          generation, providerIntent: provider, model, modelUrl: this.modelUrls[model],
          numThreads: 1, creationMs, capabilities,
        };
      });
    }

    async evaluate({ generation, cells, stm }) {
      checkGeneration(generation);
      const revision = this.revision;
      this.current(generation, revision);
      if (!this.accepting || !this.session) throw new Error('initialize the session before evaluating');
      const packingStart = this.now();
      const packed = packInputs(cells, stm, this.cellCount);
      const packingMs = this.now() - packingStart;
      return this.enqueue(async () => {
        this.current(generation, revision);
        if (!this.accepting || !this.session) throw new Error('inference session is unavailable');
        const runStart = this.now();
        const feeds = {};
        let outputs;
        let result;
        let failure;
        try {
          feeds.cells = new this.ort.Tensor('int32', packed.cells, [packed.batch, this.cellCount]);
          feeds.stm = new this.ort.Tensor('int32', packed.stm, [packed.batch]);
          outputs = await this.session.run(feeds);
          this.current(generation, revision);
          const policy = await copyOutput(outputs.policy, 'policy', [packed.batch, this.cellCount]);
          const own = await copyOutput(outputs.own, 'own', [packed.batch, this.cellCount]);
          const margin = await copyOutput(outputs.margin, 'margin', [packed.batch]);
          for (const value of own)
            if (value < 0 || value > 1) throw new Error('ownership probabilities must lie in [0,1]');
          for (let row = 0; row < packed.batch; ++row) {
            let sum = 0;
            for (let cell = 0; cell < this.cellCount; ++cell)
              sum += 2 * own[row * this.cellCount + cell] - 1;
            // The export derives margin from these same float32 probabilities.
            // Allow ordinary accumulation-order roundoff, not score drift.
            if (Math.abs(sum - margin[row]) > 0.02)
              throw new Error(`margin does not equal the ownership sum at batch row ${row}`);
          }
          this.current(generation, revision);
          result = {
            generation, batch: packed.batch, policy, own, margin,
            elapsedMs: packingMs + this.now() - runStart,
            providerIntent: this.provider, model: this.model,
          };
        } catch (error) { failure = error; }
        try { await disposeTensors([...Object.values(feeds), ...Object.values(outputs || {})]); }
        catch (error) { failure ??= error; }
        if (failure) throw failure;
        // Cancellation can arrive during asynchronous tensor cleanup as well.
        this.current(generation, revision);
        return result;
      });
    }

    cancel(generation) {
      this.advance(generation);
      // A running session.run() cannot be interrupted portably. Its output is
      // discarded and cleaned up before queued work gets the session again.
      return { generation };
    }

    async dispose(generation) {
      this.advance(generation);
      this.accepting = false;
      return this.enqueue(async () => {
        await this.releaseSession();
        return { generation };
      });
    }
  }

  const api = { Inference, CancelledError, CELL_COUNT, MODEL_URLS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HighNoonCnnInference = api;
})(globalThis);
