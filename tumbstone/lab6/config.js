const LAB_BOARD_SIZES = [6, 8, 10, 11];
"use strict";
const ANALYSIS_CONFIG = {
  side: Number(location.pathname.match(/\/lab(6|8|10|11)\//)?.[1] || 8),
  model: "Loading network…",
  searchSims: 100000,
  treeMemoryMiB: 256,
  // Size 6: completed canonical 500k collection from 33443eab (27 pairs).
  // Size 8: completed 500k estimates within one cell.
  // Size 10: completed canonical 500k collection from 363865f5 (55 pairs).
  // Size 11: completed canonical 500k collection from 37bdd3a1 (69 pairs).
  balancedStartsBySize: {
    6: ["A1 I8", "A1 E5", "A1 D4", "A1 G3", "A1 K7", "A1 J8", "A1 H5", "A1 H4", "A1 B2", "B2 G5", "A1 G6", "A1 E2", "A1 G7", "A1 D2", "A1 C2", "A1 H7", "B2 E4", "B1 C2", "A1 D3", "A1 J7", "A1 G4", "B1 G6", "A1 H6", "A1 I7", "A1 H8", "B2 G3", "A1 J9"],
    8: ["A1 I4", "A1 N9", "A1 I3", "A1 G7", "A1 H7", "A1 J7", "A1 J6", "A1 G4", "A1 J5", "A1 L10", "A1 K10", "A1 D3", "A1 J9", "A1 L11", "A1 J4", "B2 I7", "B2 L9", "B2 I5", "A1 N12", "A1 K9", "A1 M10", "A1 D2", "A1 M9", "A1 I6", "A1 N10", "A1 M11"],
    10: [
      "A1 D3", "A1 M7", "A1 I9", "A1 K6", "A1 M12",
      "A1 M5", "A1 I6", "A1 P12", "A1 L8", "A1 P14",
      "A1 L9", "A1 L4", "A1 M9", "A1 O12", "A1 F5",
      "B1 I8", "A1 D2", "A1 I8", "A1 N12", "A1 O14",
      "B2 K9", "A1 N13", "A1 N6", "A1 M6", "A1 M11",
      "A1 K5", "A1 J9", "B1 L11", "A1 P13", "A1 O13",
      "A1 Q12", "A1 L11", "B2 K7", "A1 R11", "A1 L7",
      "A1 Q15", "A1 F4", "A1 E4", "C2 L11", "A1 N7",
      "A1 Q11", "A1 Q14", "A1 K3", "A1 C2", "A1 L5",
      "A1 K8", "A1 E2", "A1 M8", "A1 P11", "A1 G5",
      "A1 M4", "A1 O6", "A1 L6", "A1 G6", "A1 P15",
    ],
    11: [
      "A1 F5", "A1 M5", "A1 E4", "A1 J10", "A1 M10",
      "A1 O14", "A1 M9", "A1 P7", "A1 N13", "A1 J7",
      "A1 P15", "A1 R13", "A1 Q16", "B2 L10", "A1 Q14",
      "A1 O7", "A1 N10", "A1 N12", "A1 D3", "A1 G6",
      "A1 L4", "A1 R15", "A1 R14", "A1 O6", "A1 R16",
      "A1 P8", "A1 L9", "B1 I8", "A1 Q15", "C3 L10",
      "A1 P13", "A1 N5", "A1 T12", "A1 L6", "A1 N7",
      "A1 O13", "A1 P14", "A1 F4", "B1 J9", "B2 L8",
      "A1 O8", "A1 G5", "A1 N6", "A1 N8", "A1 T13",
      "A1 M6", "A1 M12", "A1 R12", "A1 C2", "A1 P6",
      "A1 J8", "A1 N9", "A1 H7", "A1 J6", "A1 H6",
      "B1 M12", "A1 O12", "A1 O10", "A1 Q8", "A1 E2",
      "B1 H7", "A1 Q12", "A1 M8", "A1 E3", "A1 S13",
      "A1 D2", "A1 K10", "A1 L5", "B2 M7",
    ],
  },
  // Randomize all 12 rotations/reflections of each searched offering.
  balancedStartSymmetriesBySize: {6: true, 8: true, 10: true, 11: true},
};
ANALYSIS_CONFIG.cells = (2 * ANALYSIS_CONFIG.side - 1) ** 2;
ANALYSIS_CONFIG.balancedStarts = ANALYSIS_CONFIG.balancedStartsBySize[ANALYSIS_CONFIG.side] || [];
