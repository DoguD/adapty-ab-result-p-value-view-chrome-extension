# Adapty A/B Test P-Values

Chrome extension that injects p-values into Adapty's A/B test metrics pages for three columns: **Revenue per 1K users**, **Unique CR purchases**, and **Unique CR trials**. It writes a small annotation beneath each cell value (e.g. `p=0.038`) and marks the best-performing variant as `(baseline)`.

## Install (unpacked)

1. Open Chrome → `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this folder.
4. Open an A/B test metrics page: `https://app.adapty.io/ab-tests/<id>/metrics/regular`.

Annotations appear automatically once the table mounts and re-render on sort / filter / date-range changes.

## How it works

- **Baseline**: the row with the highest revenue (tie-break: higher unique views). Every other row is compared against it.
- **Revenue per 1K users**: two-sample z-test on means. Standard error derived from the displayed range, assuming it is a 95% confidence interval (`SE = (upper − mean) / 1.96`).
- **Unique CR purchases / trials**: two-proportion pooled-variance z-test. Numerator = `round(crPct/100 × unique_views)`, denominator = unique views.
- **p-values** use a two-sided normal approximation.
- Values with `p < 0.05` are highlighted in green.
- Missing or undefined comparisons render as `—`.

## Limitations

- Assumes Adapty's CI is 95% and symmetric. If that ever changes, the revenue p-values drift accordingly.
- Normal approximation — for tiny n the z-test is optimistic; treat borderline results with caution.
- No multiple-comparison correction. With many variants the family-wise error rate climbs.
- Unique purchasers are estimated from the displayed percentage × unique views (rounded), because Adapty's raw unique counts are not exposed in the DOM.

## Files

- `manifest.json` — MV3 manifest, content script on Adapty metrics pages.
- `stats.js` — `normalCDF`, `zTestMeans`, `zTestProportions`.
- `content.js` — table scraping, baseline pick, p-value injection, MutationObserver.
- `styles.css` — annotation styling.
- `icons/` — toolbar/store icons.

## Quick console sanity check

Paste `stats.js` into the DevTools console, then:

```js
APV_Stats.zTestProportions(8, 420, 5, 429);
// => { z: ~0.88, p: ~0.38 }

APV_Stats.zTestMeans(270.67, 270.67/1.96, 156.29, 156.29/1.96);
// => { z: ~0.72, p: ~0.47 }
```
