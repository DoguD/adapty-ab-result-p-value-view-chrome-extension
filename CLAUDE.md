# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Chrome MV3 content-script extension that scrapes Adapty's A/B test metrics table and injects p-value + change annotations into three columns (revenue/1K, CR purchases, CR trials). No build step, no tests, no package manager — load the folder unpacked via `chrome://extensions` and reload the extension after any edit.

## Architecture

Three scripts with sharply separated concerns:

- **`stats.js`** — pure math only. Exports `window.APV_Stats` with `normalCDF` (A&S 26.2.17 approximation), `twoSidedP`, `zTestMeans`, `zTestProportions`. Loaded before `content.js` per `manifest.json`.
- **`content.js`** — DOM scrape + injection. Runs only on `https://app.adapty.io/ab-tests/*/metrics/*`. Reads cells via stable `[data-column-id="..."]` selectors, computes breakdowns, writes annotations, and caches the full intermediate state in a module-local `latestDebug`.
- **`popup.js`** — on open, sends `APV_GET_DEBUG` via `chrome.tabs.sendMessage` to the active tab. The content script re-runs `process()` synchronously and returns `latestDebug`. The popup never re-computes — it only renders what the content script already built.

### Non-obvious invariants

- **Baseline = lowest-revenue row**, tie-breaking on lower `n` (`content.js` ~L414). Adapty's DOM doesn't expose which paywall is variant A vs. B, so we deliberately pick the floor and report every other variant as a delta vs. it. Do not "fix" this to highest-revenue without reading the README's *Limitations* section.
- **Revenue SE is derived** from the displayed CI half-width assuming a 95% symmetric CI: `SE = halfWidth / 1.96` (`Z_95` constant). If Adapty ever changes the CI width, every revenue p-value drifts.
- **Unique purchaser/trial counts are estimated**: `x = round(crPct/100 × uniqueProfilesViews)`. Adapty doesn't expose the raw numerator in the DOM.
- **Revenue range is parsed from an SVG**, not text. `extractRevRange` identifies the mean `<text>` by `dy="-8"` or `fill="black"` and sorts the remaining labels by `dx` to pick lower/upper bounds. This is fragile to chart-rendering changes.

### CSS / layout strategy (read before editing layout)

Layout lives in `styles.css`, scoped by `[table-id="abTestMetrics"]` + the `.apv-cell` / `.apv-row` classes that `content.js` adds during injection. Cells become a 2-row grid (`grid-template-rows: 48px auto`): row 1 is pinned at 48px so the SVG range chart's pixel-anchored `dx` offsets keep rendering correctly; row 2 holds the annotation. `process()` also strips Adapty's inline `style="height: 48px"` from each row so the row can grow to fit the second grid track.

Adapty ships CSS-in-JS that can beat stylesheet rules even with `!important`. A previous attempt to move layout into inline `!important` set from JS (see git history — reverted) caused UI regressions: forcing `padding`, `text-align`, and `grid-template-columns` on the cell collided with Adapty's native row-1 content and hid values. If you need to override Adapty styling, prefer class-scoped stylesheet rules and only reach for inline `!important` when a specific selector can be shown to lose.

### Re-rendering

Adapty is an SPA. `content.js` uses a **debounced (150ms) MutationObserver** on `document.body` plus monkey-patched `history.pushState`/`replaceState` and a `popstate` listener. Don't tighten the debounce — MutationObserver fires constantly on this app.

## Debug / sanity-check

No automated tests. For console sanity (paste `stats.js` first):

```js
APV_Stats.zTestProportions(8, 420, 5, 429);        // ≈ { z: 0.88, p: 0.38 }
APV_Stats.zTestMeans(270.67, 270.67/1.96, 156.29, 156.29/1.96); // ≈ { z: 0.72, p: 0.47 }
```

The toolbar popup is the primary debugging UI — it shows every extracted value and every intermediate term (`p_pool`, `var-factor`, `SE_diff`, `z`) for each non-baseline row. Use it to compare against hand calculations when a result looks off.
