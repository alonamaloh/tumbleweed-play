"use strict";
const ANALYSIS_CONFIG = {
  side: 8,
  cells: 225,
  model: "dcm01",
  modelUrls: {float32: "models/dcm01_side8.onnx"},
  searchSims: 500000,
  batchSize: 16,
  provider: "webgpu",
  modelVariant: "float32",
  // The size-8 alpha-beta page's searched offerings, before a random symmetry.
  balancedStarts: [
    "A1 G4", "A1 G7", "A1 K10", "B1 J9", "A1 J4", "B2 I7", "A1 D3",
    "A1 K9", "A1 M9", "A1 I3", "A1 J9", "A1 D2", "A1 G5", "A1 N12",
    "A1 L10", "A1 I6", "A1 E4", "A1 I4", "A1 H7", "A1 L9",
  ],
};
