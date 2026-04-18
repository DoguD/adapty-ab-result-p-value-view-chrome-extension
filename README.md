# Adapty A/B Test P-Values

Chrome extension that injects p-values into Adapty's A/B test metrics pages for three columns: **Revenue per 1K users**, **Unique CR purchases**, and **Unique CR trials**. Beneath each non-baseline cell it writes the absolute change vs. baseline, the relative percent change, and the p-value (e.g. `+$114.38 (+73%)` / `p=0.038`), color-coded by direction and bolded when significant. The lowest-revenue variant is treated as the baseline and left unlabeled.

## Install (unpacked)

1. Open Chrome → `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this folder.
4. Open an A/B test metrics page: `https://app.adapty.io/ab-tests/<id>/metrics/regular`.

Annotations appear automatically once the table mounts and re-render on sort / filter / date-range changes.

## Debug popup

Click the extension's toolbar icon while on a metrics page to open a popup that shows:

- The raw values pulled from each row (mean, CI bounds, half-width, derived SE, CR%, derived `x`).
- The chosen baseline.
- For every non-baseline row, the full step-by-step calculation for each of the three metrics — every intermediate term down to `pPool`, `var-factor`, `SE_diff`, `z` and the final `p`.

Use this to compare against your own hand calculation when results disagree with what you see elsewhere.

## How it works

- **Baseline**: the row with the **lowest** revenue (tie-break: lower unique views). Every other row is compared against it. See *Limitations* for why we use the floor instead of the leader.
- **Revenue per 1K users**: two-sample z-test on means. Standard error derived from the displayed range, assuming it is a 95% confidence interval (`SE = (upper − mean) / 1.96`).
- **Unique CR purchases / trials**: two-proportion pooled-variance z-test. Numerator = `round(crPct/100 × unique_views)`, denominator = unique views.
- **p-values** use a two-sided normal approximation.
- Annotations are color-coded by direction (green = positive change vs. baseline, red = negative). The p-value below is bold green when `p < 0.05`.
- Missing or undefined comparisons render as `—`.

## Limitations

- Adapty's metrics page doesn't indicate which paywall is variant A vs. B, so the extension treats the **lowest-revenue** row as the baseline. Every other variant is shown as a delta (and p-value) vs. that floor — typically the direction you'd expect a winning variant to be reported in.
- Assumes Adapty's CI is 95% and symmetric. If that ever changes, the revenue p-values drift accordingly.
- Normal approximation — for tiny n the z-test is optimistic; treat borderline results with caution.
- No multiple-comparison correction. With many variants the family-wise error rate climbs.
- Unique purchasers are estimated from the displayed percentage × unique views (rounded), because Adapty's raw unique counts are not exposed in the DOM.

## Files

- `manifest.json` — MV3 manifest, content script on Adapty metrics pages, action popup.
- `stats.js` — `normalCDF`, `zTestMeans`, `zTestProportions`.
- `content.js` — table scraping, baseline pick, p-value injection, MutationObserver, debug bridge.
- `styles.css` — annotation styling.
- `popup.html` / `popup.js` / `popup.css` — debug breakdown popup.
- `icons/` — toolbar/store icons.

## Quick console sanity check

Paste `stats.js` into the DevTools console, then:

```js
APV_Stats.zTestProportions(8, 420, 5, 429);
// => { z: ~0.88, p: ~0.38 }

APV_Stats.zTestMeans(270.67, 270.67/1.96, 156.29, 156.29/1.96);
// => { z: ~0.72, p: ~0.47 }
```
