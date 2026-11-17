"use strict";
// Browser counterpart of the selected direct/divisor JesseJames search.
// Values and backups are Red-relative cells; roles stay fixed during a search.
(function (scope) {
  const mask = (1n << 64n) - 1n;
  function avalanche(value) {
    for (const factor of [0xa3b195354a39b70dn, 0x1b03738712fad5c9n]) {
      const product = value * factor;
      value = ((product >> 64n) ^ product) & mask;
    }
    return value;
  }
  class RandomBits {
    constructor(seed) { this.state = avalanche((BigInt(seed) & mask) ^ 0xc41cbd5c71679d51n); }
    uniform() {
      const value = avalanche(this.state);
      this.state = (this.state + 0x60bee2bee120fc15n) & mask;
      return (Number(value >> 12n) + .5) / 4503599627370496;
    }
  }
  scope.Jesse = {RandomBits};
})(typeof self !== "undefined" ? self : globalThis);
