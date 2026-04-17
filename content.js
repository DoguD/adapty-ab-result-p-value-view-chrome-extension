// Content script: injects p-values into Adapty A/B test metrics tables.
//
// Strategy:
//  - Wait for the React table (table-id="abTestMetrics") to mount.
//  - Read each row's relevant cells via stable [data-column-id="..."] selectors.
//  - Pick the row with highest revenue as the baseline.
//  - Compute z-tests vs. baseline for the three target metrics.
//  - Inject "p=0.038" annotations beneath the existing cell value.
//  - Re-run on every relevant DOM mutation (filter, sort, navigate).
//  - Keep full intermediate values in `latestDebug` and respond to
//    APV_GET_DEBUG messages from the popup for step-by-step debugging.

(function () {
  const TABLE_SELECTOR = '[table-id="abTestMetrics"]';
  const URL_MATCH = /\/ab-tests\/[^/]+\/metrics\//;
  const TARGET_COLUMNS = [
    'averagePer1000',
    'conversionRatePurchasesByUsers',
    'conversionRateTrialsByUsers',
  ];
  const Z_95 = 1.96; // half-width multiplier we assume for Adapty's CI

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
    let lower = null;
    let upper = null;
    let halfWidth = null;
    let seRev = null;
    if (range) {
      mean = range.mean;
      lower = range.lower;
      upper = range.upper;
      halfWidth = Math.max(range.upper - range.mean, range.mean - range.lower);
      // 95% CI ⇒ SE = halfWidth / 1.96. If halfWidth ≤ 0, SE is unusable.
      seRev = halfWidth > 0 ? halfWidth / Z_95 : null;
    }

    return {
      row,
      name,
      revenue: Number.isFinite(revenue) ? revenue : 0,
      n,
      mean,
      lower,
      upper,
      halfWidth,
      seRev,
      crPurchPct: Number.isFinite(crPurchPct) ? crPurchPct : null,
      crTrialsPct: Number.isFinite(crTrialsPct) ? crTrialsPct : null,
      xPurch: Number.isFinite(crPurchPct) ? Math.round((crPurchPct / 100) * n) : null,
      xTrials: Number.isFinite(crTrialsPct) ? Math.round((crTrialsPct / 100) * n) : null,
    };
  }

  // ---- breakdown builders ----------------------------------------------
  // These return a serialisable object with every intermediate value so
  // the popup can replay the calculation to the user.

  function revBreakdown(r, b) {
    const stats = window.APV_Stats;
    if (r.mean == null || r.seRev == null || b.mean == null || b.seRev == null) {
      return { status: 'missing' };
    }
    const seDiffSq = r.seRev * r.seRev + b.seRev * b.seRev;
    const seDiff = Math.sqrt(seDiffSq);
    const diffMeans = r.mean - b.mean;
    const z = seDiff > 0 ? diffMeans / seDiff : null;
    const p = z == null ? null : stats.twoSidedP(z);
    return {
      status: 'ok',
      mean1: r.mean,
      halfWidth1: r.halfWidth,
      lower1: r.lower,
      upper1: r.upper,
      se1: r.seRev,
      mean2: b.mean,
      halfWidth2: b.halfWidth,
      lower2: b.lower,
      upper2: b.upper,
      se2: b.seRev,
      seDiffSq,
      seDiff,
      diffMeans,
      z,
      p,
    };
  }

  function propBreakdown(x1, n1, x2, n2) {
    const stats = window.APV_Stats;
    if ([x1, n1, x2, n2].some((v) => !Number.isFinite(v))) {
      return { status: 'missing' };
    }
    if (n1 <= 0 || n2 <= 0) return { status: 'no_n' };
    if (x1 + x2 <= 0) return { status: 'both_zero' };
    const p1 = x1 / n1;
    const p2 = x2 / n2;
    const pPool = (x1 + x2) / (n1 + n2);
    const varFactor = pPool * (1 - pPool) * (1 / n1 + 1 / n2);
    const se = Math.sqrt(varFactor);
    const diff = p1 - p2;
    const z = se > 0 ? diff / se : null;
    const p = z == null ? null : stats.twoSidedP(z);
    return {
      status: 'ok',
      x1,
      n1,
      p1,
      x2,
      n2,
      p2,
      sumX: x1 + x2,
      sumN: n1 + n2,
      pPool,
      varFactor,
      se,
      diff,
      z,
      p,
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
    cell.classList.add('apv-cell');
    cell.appendChild(div);
  }

  function annotateFromBreakdown(cell, b) {
    if (!b || b.status !== 'ok' || b.p == null) {
      appendAnnotation(cell, '—', { na: true });
      return;
    }
    const label = formatP(b.p);
    if (!label) {
      appendAnnotation(cell, '—', { na: true });
      return;
    }
    appendAnnotation(cell, label, { significant: b.p < 0.05 });
  }

  // ---- main pass --------------------------------------------------------

  let latestDebug = null;

  function process() {
    if (!URL_MATCH.test(location.pathname)) {
      latestDebug = null;
      return;
    }
    const table = document.querySelector(TABLE_SELECTOR);
    if (!table) return;
    const rowGroup = table.querySelector('[role="rowgroup"]');
    if (!rowGroup) return;
    const rowEls = Array.from(rowGroup.querySelectorAll('[role="row"]'));
    if (rowEls.length < 2) {
      clearAnnotations(table);
      latestDebug = null;
      return;
    }

    const records = rowEls.map(readRow).filter(Boolean);
    if (records.length < 2) {
      clearAnnotations(table);
      latestDebug = null;
      return;
    }

    // Baseline = highest revenue, tie-break on higher n.
    const base = records.reduce((best, r) =>
      r.revenue > best.revenue || (r.revenue === best.revenue && r.n > best.n) ? r : best
    );

    // Build debug records first (serialisable copies, no DOM refs).
    const debugRows = records.map((rec) => {
      const isBaseline = rec === base;
      const extracted = {
        name: rec.name,
        revenue: rec.revenue,
        n: rec.n,
        mean: rec.mean,
        lower: rec.lower,
        upper: rec.upper,
        halfWidth: rec.halfWidth,
        seRev: rec.seRev,
        crPurchPct: rec.crPurchPct,
        crTrialsPct: rec.crTrialsPct,
        xPurch: rec.xPurch,
        xTrials: rec.xTrials,
      };
      return {
        ...extracted,
        isBaseline,
        comparisons: isBaseline
          ? null
          : {
              rev: revBreakdown(rec, base),
              purch: propBreakdown(rec.xPurch, rec.n, base.xPurch, base.n),
              trials: propBreakdown(rec.xTrials, rec.n, base.xTrials, base.n),
            },
      };
    });

    latestDebug = {
      url: location.href,
      timestamp: Date.now(),
      baselineName: base.name,
      ciMultiplier: Z_95,
      rows: debugRows,
    };

    // Now paint annotations using the same breakdowns we just built.
    clearAnnotations(table);
    for (const rec of records) {
      if (rec === base) {
        for (const col of TARGET_COLUMNS) {
          const cell = cellFor(rec.row, col);
          if (cell) appendAnnotation(cell, '(baseline)', { baseline: true });
        }
      } else {
        const cmp = debugRows.find((d) => d.name === rec.name && !d.isBaseline).comparisons;
        annotateFromBreakdown(cellFor(rec.row, 'averagePer1000'), cmp.rev);
        annotateFromBreakdown(cellFor(rec.row, 'conversionRatePurchasesByUsers'), cmp.purch);
        annotateFromBreakdown(cellFor(rec.row, 'conversionRateTrialsByUsers'), cmp.trials);
      }
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
        console.warn('[apv] process error:', e);
      }
    }, 150);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { subtree: true, childList: true });

  // Also run on initial load and on history navigation in this SPA.
  schedule();
  window.addEventListener('popstate', schedule);
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function () {
      const r = orig.apply(this, arguments);
      schedule();
      return r;
    };
  }

  // Popup ↔ content-script bridge.
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'APV_GET_DEBUG') {
        // Re-run once synchronously to catch any pending updates.
        try {
          process();
        } catch (_) {}
        sendResponse({ ok: true, data: latestDebug });
        return false; // sync response
      }
    });
  }
})();
