# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Chrome MV3 content-script extension that scrapes Adapty's A/B test metrics table and renders a p-value summary panel beneath it for three metrics (revenue/1K, CR purchases, CR trials). No build step, no tests, no package manager — load the folder unpacked via `chrome://extensions` and reload the extension after any edit.

## Architecture

Three scripts with sharply separated concerns:

- **`stats.js`** — pure math only. Exports `window.APV_Stats` with `normalCDF` (A&S 26.2.17 approximation), `twoSidedP`, `zTestMeans`, `zTestProportions`. Loaded before `content.js` per `manifest.json`.
- **`content.js`** — DOM scrape + panel render. Runs only on `https://app.adapty.io/ab-tests/*/metrics/*`. Reads cells via stable `[data-column-id="..."]` selectors, computes breakdowns, renders `<section id="apv-summary-panel">` as the immediate next sibling of the table, and caches the full intermediate state in a module-local `latestDebug`. Adapty's table DOM is never mutated.
- **`popup.js`** — on open, sends `APV_GET_DEBUG` via `chrome.tabs.sendMessage` to the active tab. The content script re-runs `process()` synchronously and returns `latestDebug`. The popup never re-computes — it only renders what the content script already built.

### Non-obvious invariants

- **Baseline = lowest-revenue row**, tie-breaking on lower `n`. Adapty's DOM doesn't expose which paywall is variant A vs. B, so we deliberately pick the floor and report every other variant as a delta vs. it. Do not "fix" this to highest-revenue without reading the README's *Limitations* section.
- **Revenue SE is derived** from the displayed CI half-width assuming a 95% symmetric CI: `SE = halfWidth / 1.96` (`Z_95` constant). If Adapty ever changes the CI width, every revenue p-value drifts.
- **Unique purchaser/trial counts are estimated**: `x = round(crPct/100 × uniqueProfilesViews)`. Adapty doesn't expose the raw numerator in the DOM.
- **Revenue range is parsed from an SVG**, not text. `extractRevRange` identifies the mean `<text>` by `dy="-8"` or `fill="black"` and sorts the remaining labels by `dx` to pick lower/upper bounds. This is fragile to chart-rendering changes.

### Panel mount + mutation loop guard

The panel is kept as the immediate next sibling of `[table-id="abTestMetrics"]`. Each `process()` pass: find-or-create `#apv-summary-panel`, re-parent it if React has moved things around, then compare the new HTML against `panel.innerHTML` and only assign if they differ. **This equality check is load-bearing**: without it, our own innerHTML write triggers the MutationObserver, which re-schedules `process()`, which re-writes innerHTML → infinite loop at ~6 Hz. If you refactor the render path, preserve the idempotence guard.

### Historical note: why not inject in-cell?

Earlier versions injected `+$X / p=Z` annotations inside each non-baseline cell, turning cells into 2-row grids. Adapty's CSS-in-JS can beat stylesheet `!important`, which led to persistent layout regressions (annotations hidden, row heights not sticking, SVG chart labels bleeding into neighboring columns). The panel-as-sibling approach sidesteps Adapty's styling entirely. Don't revert to in-cell injection without a concrete reason.

### Re-rendering

Adapty is an SPA. `content.js` uses a **debounced (150ms) MutationObserver** on `document.body` plus monkey-patched `history.pushState`/`replaceState` and a `popstate` listener. Don't tighten the debounce — MutationObserver fires constantly on this app.

## Debug / sanity-check

No automated tests. For console sanity (paste `stats.js` first):

```js
APV_Stats.zTestProportions(8, 420, 5, 429);        // ≈ { z: 0.88, p: 0.38 }
APV_Stats.zTestMeans(270.67, 270.67/1.96, 156.29, 156.29/1.96); // ≈ { z: 0.72, p: 0.47 }
```

The toolbar popup is the primary debugging UI — it shows every extracted value and every intermediate term (`p_pool`, `var-factor`, `SE_diff`, `z`) for each non-baseline row. Use it to compare against hand calculations when a result looks off.
