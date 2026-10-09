"use strict";
const ANALYSIS_CONFIG = {
  side: 6,
  cells: 121,
  model: "dcm01",
  modelUrls: {float32: "models/dcm01_side6.onnx"},
  searchSims: 500000,
  batchSize: 16,
  provider: "webgpu",
  modelVariant: "float32",
  // The size-6 alpha-beta page's searched offerings, before a random symmetry.
  balancedStarts: [
    "A1 H5", "A1 D3", "A1 J8", "A1 B2", "A1 D2", "A1 E5", "A1 J7",
    "A1 H7", "B2 E4", "A1 H8", "B1 C2", "A1 D4", "A1 E2", "A1 G7",
    "A1 H4", "A1 I8", "A1 C2", "A1 C3", "A1 G6", "A1 H6", "A1 I7",
    "A1 J9", "A1 K7", "B1 H7", "B2 H7", "A1 G2", "A1 G3", "A1 G4",
  ],
};
