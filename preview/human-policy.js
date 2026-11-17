"use strict";
// The shared opening/sampling rules, independent of the inference runtime.
(function(scope) {
  const cells = Position.cells(8), compact = new Map(cells.map((c, i) => [c, i]));
  const random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;

  function sample(entries, rng = random) {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    if (!entries.length || !Number.isFinite(total) || total <= 0) throw new Error("No move probabilities.");
    let draw = rng() * total;
    for (const [value, weight] of entries) {
      draw -= weight;
      if (draw < 0) return value;
    }
    return entries.at(-1)[0];
  }

  class Policy {
    constructor(data) {
      if (data.version !== 1 || data.side !== 8) throw new Error("Unsupported human model.");
      this.data = data;
      this.profiles = new Map(data.profiles.map(p => [p.key, p]));
    }
    profile(key) {
      const person = this.profiles.get(key);
      if (!person) throw new Error("Choose an available opponent.");
      return person;
    }
    canonical(sequence) {
      let best, symmetry = 0;
      this.data.maps.forEach((map, k) => {
        const image = sequence.map(c => map[c]);
        const different = best ? image.findIndex((c, i) => c !== best[i]) : 0;
        if (!best || (different >= 0 && image[different] < best[different])) {
          best = image; symmetry = k;
        }
      });
      return {key: best.join(" "), map: this.data.maps[symmetry]};
    }
    setup(key, rng = random) {
      const person = this.profile(key), offers = person.generic ? this.data.pooled_offers : person.offers;
      let red, white;
      if (offers.length) {
        [red, white] = sample(offers.map(([r, w, n]) => [[r, w], n]), rng);
        const map = this.data.maps[Math.floor(rng() * this.data.maps.length)];
        red = map[red]; white = map[white];
      } else {
        red = sample([0, 7, 77, 91, 161, 168].map(c => [c, 1]), rng);
        white = sample(cells.map((_, c) => c).filter(c => c !== red && c !== 84).map(c => [c, 1]), rng);
      }
      return [cells[red], cells[white]];
    }
    redProbability(key, initial) {
      const person = this.profile(key), red = compact.get(initial.red), white = compact.get(initial.white);
      if (initial.side !== 8 || red === undefined || white === undefined || red === white || [red, white].includes(84))
        throw new Error("Invalid starting cells.");
      const score = this.data.scores[this.canonical([red, white]).key], fit = this.data.pie;
      if (!Number.isFinite(score)) throw new Error("Missing opening score.");
      return 1 / (1 + Math.exp(-((fit.a + fit.b * person.pie_level) * score + fit.bias + fit.bias_per_z * person.pie_level)));
    }
    book(key, initial, moves, legal) {
      const person = this.profile(key);
      if (person.generic || initial.kind !== "normal" || moves.includes(-1)) return [];
      const sequence = [initial.red, initial.white, ...moves].map(c => compact.get(c));
      if (sequence.some(c => c === undefined)) throw new Error("Invalid move record.");
      const {key: context, map} = this.canonical(sequence), found = person.moves[context];
      return Object.entries(found || {}).map(([c, count]) => [cells[map.indexOf(Number(c))], count])
        .filter(([c]) => legal.includes(c));
    }
    history(moves) {
      const planes = new Float32Array(cells.length * 2);
      for (let k = 0; k < 2; k++) {
        const c = compact.get(moves.at(-k - 1));
        if (c !== undefined) planes[c * 2 + k] = 1;
      }
      return planes;
    }
    choose(logits, legal, rng = random) {
      if (logits.length !== cells.length || !Array.from(logits).every(Number.isFinite))
        throw new Error("Invalid human model output.");
      const maximum = Math.max(...legal.map(c => logits[compact.get(c)]));
      return sample(legal.map(c => [c, Math.exp(logits[compact.get(c)] - maximum)]), rng);
    }
  }
  scope.HumanPolicy = {Policy, sample, random, cells, compact};
})(globalThis);
