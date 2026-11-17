"use strict";

// Safari's GPU-enabled ORT build can trigger runaway WebAssembly compilation
// on iOS. Select the separate, non-JSEP CPU bundle before loading the runtime.
// iPadOS can identify itself as a Mac; detect that on the main thread, where
// maxTouchPoints is available, and pass the CPU choice to the worker.
const FrontierRuntime = Object.freeze({
  appleMobile(nav) {
    return /iPhone|iPad|iPod/i.test(nav.userAgent || "") ||
      (/Mac/i.test(nav.platform || "") && nav.maxTouchPoints > 1);
  },
  cpuOnly(nav, forcedProvider) {
    return forcedProvider === "wasm" || this.appleMobile(nav) || !nav.gpu;
  }
});
