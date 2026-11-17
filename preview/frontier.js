/* Shared calibration and root-selection math; no browser dependencies. */
"use strict";
(function (scope) {
  function betaForHumanity(h, curve) {
    if (!Number.isFinite(h) || h < 0 || h > 1) throw new Error("Humanity must be between 0 and 1");
    if (h === 0) return Infinity;
    if (h === 1) return 0;
    const target = h * curve[0].badness;
    for (let i = 1; i < curve.length; i++) {
      const a = curve[i - 1], b = curve[i];
      if (target >= b.badness) {
        const t = (a.badness - target) / (a.badness - b.badness);
        return a.beta + t * (b.beta - a.beta);
      }
    }
    throw new Error("Humanity is below the calibrated range; select 0 or at least 0.01");
  }
  function softmax(logits) {
    const max = Math.max(...logits), weights = logits.map(x => Math.exp(x - max));
    const sum = weights.reduce((a, b) => a + b, 0);
    return weights.map(x => x / sum);
  }
  function gumbel(random) {
    const u = random();
    if (!(u > 0 && u < 1)) throw new Error("Gumbel sampling requires 0 < U < 1");
    return -Math.log(-Math.log(u));
  }
  function offsets(logits, beta, random) {
    if (beta === Infinity) return logits.map(() => 0);
    if (!(beta > 0)) throw new Error("Use direct policy sampling at beta=0");
    const perturbed = logits.map(x => x + gumbel(random));
    const max = Math.max(...perturbed);
    // Subtract a common constant for stability, without changing selection.
    return perturbed.map(x => (x - max) / beta);
  }
  function sample(logits, random) {
    const perturbed = logits.map(x => x + gumbel(random));
    return perturbed.indexOf(Math.max(...perturbed));
  }
  function edgeScore(sum, visits, fallback, sign, prior, parentVisits, offset, cells) {
    // All value backups remain Red-relative cell margins. Offsets are in
    // mover-relative cells, so normalize them together with Q, exactly once.
    const q = sign * (visits ? sum / visits : fallback);
    return (q + offset) / cells + .05 * Math.sqrt(Math.max(1, parentVisits)) * prior / (1 + visits);
  }
  function rank(edges, sign) {
    const q = e => e.visits ? sign * e.sum / e.visits : 0;
    return edges.slice().sort((a, b) => b.visits - a.visits || q(b) - q(a) || b.prior - a.prior || a.move - b.move);
  }
  function visitLeaderLocked(edges, visits, target) {
    const remaining = target - visits;
    if (!edges || edges.length < 2 || remaining <= 0) return false;
    let first = 0, second = 0;
    for (const edge of edges) {
      const n = edge.visits;
      if (n > first) { second = first; first = n; }
      else if (n > second) second = n;
    }
    // The serial leaf is already backed up. A possible tie is not decisive.
    return first - second > remaining;
  }
  const api = {betaForHumanity, softmax, gumbel, offsets, sample, edgeScore, rank, visitLeaderLocked};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else scope.Frontier = api;
})(globalThis);
