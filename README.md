# Adapty A/B Test P-Values

Chrome extension that adds a p-value summary panel beneath Adapty's A/B test metrics table for six metrics: **Revenue per 1K users**, **Unique CR purchases**, **Unique CR trials**, **ARPPU**, **Refund rate**, and **Trial cancellation rate**. The panel lists every non-baseline variant with the absolute change vs. baseline, the relative percent change, and the p-value (e.g. `+$114.38 (+73%)` / `p=0.038`), color-coded by direction and bolded when significant. The lowest-revenue variant is treated as the baseline and omitted from the panel. Adapty's own table is not modified.

## Install (unpacked)

1. Open Chrome → `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this folder.
4. Open an A/B test metrics page: `https://app.adapty.io/ab-tests/<id>/metrics/regular`.

The panel appears automatically below the table once it mounts and re-renders on sort / filter / date-range changes.

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
- **ARPPU**: two-sample z-test on means via the delta method, treating purchase rate as known. Per-row SE is `SE_rev × (arppu / mean)`. Adapty doesn't expose a per-payer revenue distribution, so this is a rough approximation; treat the p-value with caution and prefer the revenue/1K test as the primary signal.
- **Refund rate**: two-proportion pooled-variance z-test on `refunds / purchases`.
- **Trial cancellation rate**: two-proportion pooled-variance z-test on `trialsCancelled / trials`.
- **p-values** use a two-sided normal approximation.
- Panel entries are color-coded by direction (green = positive change vs. baseline, red = negative). For **refund rate** and **trial cancellation rate**, the coloring is inverted — *lower is better*, so a decrease vs. baseline renders green and an increase renders red. The p-value below is bold green when `p < 0.05`.
- Missing or undefined comparisons render as `—`.

## Limitations

- Adapty's metrics page doesn't indicate which paywall is variant A vs. B, so the extension treats the **lowest-revenue** row as the baseline. Every other variant is shown as a delta (and p-value) vs. that floor — typically the direction you'd expect a winning variant to be reported in.
- Assumes Adapty's CI is 95% and symmetric. If that ever changes, the revenue p-values drift accordingly.
- Normal approximation — for tiny n the z-test is optimistic; treat borderline results with caution.
- No multiple-comparison correction. With many variants the family-wise error rate climbs.
- Unique purchasers are estimated from the displayed percentage × unique views (rounded), because Adapty's raw unique counts are not exposed in the DOM.
- **ARPPU** has no CI in Adapty's DOM, so its SE is reconstructed from revenue/1K's SE under the delta method (purchase rate treated as known). The resulting p-value is closely tied to the revenue/1K p-value and should be read as a rough sanity check rather than an independent signal.

## Files

- `manifest.json` — MV3 manifest, content script on Adapty metrics pages, action popup.
- `stats.js` — `normalCDF`, `zTestMeans`, `zTestProportions`.
- `content.js` — table scraping, baseline pick, summary-panel rendering, MutationObserver, debug bridge.
- `styles.css` — panel styling.
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
