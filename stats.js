// Statistical helpers for p-value computation.
// Exposed on window.APV_Stats so content.js can use them.

(function () {
  // Abramowitz & Stegun 26.2.17 — standard normal CDF, |error| < 7.5e-8.
  function normalCDF(x) {
    const b1 = 0.319381530;
    const b2 = -0.356563782;
    const b3 = 1.781477937;
    const b4 = -1.821255978;
    const b5 = 1.330274429;
    const p = 0.2316419;
    const c = 0.39894228; // 1 / sqrt(2π)
    const ax = Math.abs(x);
    const t = 1 / (1 + p * ax);
    const upperTail = c * Math.exp(-(ax * ax) / 2) *
      (b1 * t + b2 * t * t + b3 * t ** 3 + b4 * t ** 4 + b5 * t ** 5);
    const cdfPos = 1 - upperTail;
    return x >= 0 ? cdfPos : 1 - cdfPos;
  }

  function twoSidedP(z) {
    if (!Number.isFinite(z)) return null;
    return 2 * (1 - normalCDF(Math.abs(z)));
  }

  // Two-sample z-test on means with known SEs.
  function zTestMeans(m1, se1, m2, se2) {
    if (![m1, se1, m2, se2].every(Number.isFinite)) return { z: null, p: null };
    const seDiff = Math.sqrt(se1 * se1 + se2 * se2);
    if (seDiff <= 0) return { z: null, p: null };
    const z = (m1 - m2) / seDiff;
    return { z, p: twoSidedP(z) };
  }

  // Two-proportion pooled-variance z-test.
  function zTestProportions(x1, n1, x2, n2) {
    if (![x1, n1, x2, n2].every(Number.isFinite)) return { z: null, p: null };
    if (n1 <= 0 || n2 <= 0) return { z: null, p: null };
    const total = x1 + x2;
    if (total <= 0) return { z: null, p: null }; // both zero — undefined
    const pPool = total / (n1 + n2);
    if (pPool >= 1) return { z: null, p: null }; // both saturated
    const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
    if (se <= 0) return { z: null, p: null };
    const p1 = x1 / n1;
    const p2 = x2 / n2;
    const z = (p1 - p2) / se;
    return { z, p: twoSidedP(z) };
  }

  window.APV_Stats = { normalCDF, twoSidedP, zTestMeans, zTestProportions };

  // Quick sanity checks against the sample page (uncomment in console):
  // APV_Stats.zTestProportions(8, 420, 5, 429)            // p ≈ 0.38
  // APV_Stats.zTestMeans(270.67, 270.67/1.96, 156.29, 156.29/1.96) // p ≈ 0.47
})();
