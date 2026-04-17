// Content script: injects p-values into Adapty A/B test metrics tables.
//
// Strategy:
//  - Wait for the React table (table-id="abTestMetrics") to mount.
//  - Read each row's relevant cells via stable [data-column-id="..."] selectors.
//  - Pick the row with highest revenue as the baseline.
//  - Compute z-tests vs. baseline for the three target metrics.
//  - Inject "p=0.038" annotations beneath the existing cell value.
//  - Re-run on every relevant DOM mutation (filter, sort, navigate).

(function () {
  const TABLE_SELECTOR = '[table-id="abTestMetrics"]';
  const URL_MATCH = /\/ab-tests\/[^/]+\/metrics\//;
  const TARGET_COLUMNS = [
    'averagePer1000',
    'conversionRatePurchasesByUsers',
    'conversionRateTrialsByUsers',
  ];

  // ---- helpers ----------------------------------------------------------

  function parseNum(text) {
    if (text == null) return NaN;
    const m = String(text).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : NaN;
  }

  function cellFor(row, columnId) {
    return row.querySelector(`[data-column-id="${columnId}"]`);
  }

  function cellText(row, columnId) {
    const cell = cellFor(row, columnId);
    if (!cell) return '';
    const span = cell.querySelector('span') || cell;
    return (span.textContent || '').trim();
  }

  // Extract { mean, lower, upper } from the revenue-per-1K SVG chart cell.
  function extractRevRange(row) {
    const cell = cellFor(row, 'averagePer1000');
    if (!cell) return null;
    const svg = cell.querySelector('svg');
    if (!svg) return null;
    const texts = Array.from(svg.querySelectorAll('text'));
    if (texts.length < 3) return null;

    let meanText = null;
    const others = [];
    for (const t of texts) {
      // mean is rendered with dy="-8" (above the bar) and fill="black"
      const dy = t.getAttribute('dy');
      const fill = t.getAttribute('fill') || '';
      if (dy === '-8' || fill === 'black') {
        meanText = t;
      } else {
        others.push(t);
      }
    }
    if (!meanText || others.length < 2) return null;
    others.sort(
      (a, b) => parseFloat(a.getAttribute('dx')) - parseFloat(b.getAttribute('dx'))
    );
    const lower = parseNum(others[0].textContent);
    const upper = parseNum(others[others.length - 1].textContent);
    const mean = parseNum(meanText.textContent);
    if (![lower, upper, mean].every(Number.isFinite)) return null;
    return { lower, upper, mean };
  }

  // Scrape one row → numeric record. Returns null if row is unusable.
  function readRow(row) {
    const nameEl = row.querySelector('[title]');
    const name = nameEl ? nameEl.getAttribute('title') : '(unknown)';
    const revenue = parseNum(cellText(row, 'revenue'));
    const n = parseNum(cellText(row, 'uniqueProfilesViews'));
    const crPurchPct = parseNum(cellText(row, 'conversionRatePurchasesByUsers'));
    const crTrialsPct = parseNum(cellText(row, 'conversionRateTrialsByUsers'));
    const range = extractRevRange(row);

    if (!Number.isFinite(n) || n <= 0) return null;

    let mean = null;
    let seRev = null;
    if (range) {
      mean = range.mean;
      const halfWidth = Math.max(range.upper - range.mean, range.mean - range.lower);
      // 95% CI ⇒ SE = halfWidth / 1.96. If halfWidth ≤ 0, SE is unusable.
      seRev = halfWidth > 0 ? halfWidth / 1.96 : null;
    }

    return {
      row,
      name,
      revenue: Number.isFinite(revenue) ? revenue : 0,
      n,
      mean,
      seRev,
      xPurch: Number.isFinite(crPurchPct) ? Math.round((crPurchPct / 100) * n) : null,
      xTrials: Number.isFinite(crTrialsPct) ? Math.round((crTrialsPct / 100) * n) : null,
    };
  }

  // ---- p-value formatting / injection ----------------------------------

  function formatP(p) {
    if (p == null || !Number.isFinite(p)) return null;
    if (p < 0.001) return 'p<0.001';
    if (p < 0.01) return `p=${p.toFixed(3)}`;
    return `p=${p.toFixed(2)}`;
  }

  function clearAnnotations(table) {
    table.querySelectorAll('[data-apv]').forEach((n) => n.remove());
    table.querySelectorAll('.apv-cell').forEach((c) => c.classList.remove('apv-cell'));
  }

  function appendAnnotation(cell, text, opts) {
    const div = document.createElement('div');
    div.setAttribute('data-apv', '');
    div.className = opts.baseline
      ? 'apv-baseline'
      : opts.significant
      ? 'apv-pvalue apv-sig'
      : opts.na
      ? 'apv-pvalue apv-na'
      : 'apv-pvalue';
    div.textContent = text;
    // Mark the cell so CSS can switch to vertical flex layout.
    cell.classList.add('apv-cell');
    cell.appendChild(div);
  }

  function annotateBaseline(rec) {
    for (const col of TARGET_COLUMNS) {
      const cell = cellFor(rec.row, col);
      if (!cell) continue;
      appendAnnotation(cell, '(baseline)', { baseline: true });
    }
  }

  function annotateRow(rec, base) {
    const stats = window.APV_Stats;

    // Revenue per 1K: two-sample z-test using CI-derived SE.
    {
      const cell = cellFor(rec.row, 'averagePer1000');
      if (cell) {
        let label = '—';
        let opts = { na: true };
        if (rec.mean != null && rec.seRev != null && base.mean != null && base.seRev != null) {
          const { p } = stats.zTestMeans(rec.mean, rec.seRev, base.mean, base.seRev);
          const f = formatP(p);
          if (f) {
            label = f;
            opts = { significant: p < 0.05 };
          }
        }
        appendAnnotation(cell, label, opts);
      }
    }

    // Unique CR purchases.
    {
      const cell = cellFor(rec.row, 'conversionRatePurchasesByUsers');
      if (cell) {
        let label = '—';
        let opts = { na: true };
        if (rec.xPurch != null && base.xPurch != null) {
          const { p } = stats.zTestProportions(rec.xPurch, rec.n, base.xPurch, base.n);
          const f = formatP(p);
          if (f) {
            label = f;
            opts = { significant: p < 0.05 };
          }
        }
        appendAnnotation(cell, label, opts);
      }
    }

    // Unique CR trials.
    {
      const cell = cellFor(rec.row, 'conversionRateTrialsByUsers');
      if (cell) {
        let label = '—';
        let opts = { na: true };
        if (rec.xTrials != null && base.xTrials != null) {
          const { p } = stats.zTestProportions(rec.xTrials, rec.n, base.xTrials, base.n);
          const f = formatP(p);
          if (f) {
            label = f;
            opts = { significant: p < 0.05 };
          }
        }
        appendAnnotation(cell, label, opts);
      }
    }
  }

  // ---- main pass --------------------------------------------------------

  function process() {
    if (!URL_MATCH.test(location.pathname)) return;
    const table = document.querySelector(TABLE_SELECTOR);
    if (!table) return;
    const rowGroup = table.querySelector('[role="rowgroup"]');
    if (!rowGroup) return;
    const rowEls = Array.from(rowGroup.querySelectorAll('[role="row"]'));
    if (rowEls.length < 2) {
      clearAnnotations(table);
      return;
    }

    const records = rowEls.map(readRow).filter(Boolean);
    if (records.length < 2) {
      clearAnnotations(table);
      return;
    }

    // Baseline = highest revenue, tie-break on higher n.
    const base = records.reduce((best, r) =>
      r.revenue > best.revenue || (r.revenue === best.revenue && r.n > best.n) ? r : best
    );

    clearAnnotations(table);
    for (const rec of records) {
      if (rec === base) annotateBaseline(rec);
      else annotateRow(rec, base);
    }
  }

  // Debounced runner; MutationObserver is noisy on a React app.
  let pending = null;
  function schedule() {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      try {
        process();
      } catch (e) {
        // Don't let a parsing slip kill the observer.
        console.warn('[apv] process error:', e);
      }
    }, 150);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { subtree: true, childList: true });

  // Also run on initial load and on history navigation in this SPA.
  schedule();
  window.addEventListener('popstate', schedule);
  // Patch pushState/replaceState so SPA route changes trigger us too.
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function () {
      const r = orig.apply(this, arguments);
      schedule();
      return r;
    };
  }
})();
