// Content script: renders a p-value summary panel beneath Adapty A/B
// test metrics tables.
//
// Strategy:
//  - Wait for the React table (table-id="abTestMetrics") to mount.
//  - Read each row's relevant cells via stable [data-column-id="..."] selectors.
//  - Pick the lowest-revenue row as the baseline.
//  - Compute z-tests vs. baseline for the three target metrics.
//  - Render a single <section id="apv-summary-panel"> sibling of the
//    table showing change + p-value per variant. No DOM inside Adapty's
//    table is modified — the panel owns its own subtree.
//  - Re-run on every relevant DOM mutation (filter, sort, navigate).
//  - Keep full intermediate values in `latestDebug` and respond to
//    APV_GET_DEBUG messages from the popup for step-by-step debugging.

(function () {
  const TABLE_SELECTOR = '[table-id="abTestMetrics"]';
  const URL_MATCH = /\/ab-tests\/[^/]+\/metrics\//;
  const PANEL_ID = 'apv-summary-panel';
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
    const arppu = parseNum(cellText(row, 'arppu'));
    const purchases = parseNum(cellText(row, 'purchases'));
    const refunds = parseNum(cellText(row, 'refunds'));
    const trials = parseNum(cellText(row, 'trials'));
    const trialsCancelled = parseNum(cellText(row, 'trialsCancelled'));
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
      arppu: Number.isFinite(arppu) ? arppu : null,
      purchases: Number.isFinite(purchases) ? purchases : null,
      refunds: Number.isFinite(refunds) ? refunds : null,
      trials: Number.isFinite(trials) ? trials : null,
      trialsCancelled: Number.isFinite(trialsCancelled) ? trialsCancelled : null,
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
    const pctChange = b.mean !== 0 ? (diffMeans / b.mean) * 100 : null;
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
      pctChange,
      z,
      p,
    };
  }

  // ARPPU under the delta method, treating purchase rate as known.
  // Per-row SE is rev/1K's SE scaled by (arppu / mean) — the deterministic
  // factor that maps revenue/1K into per-payer revenue. The two scaling
  // factors differ between variants when their purchase rates differ, so
  // the resulting z is *close to* but not identical to revenue/1K's z.
  function arppuBreakdown(r, b) {
    const stats = window.APV_Stats;
    const inputs = [r.arppu, r.mean, r.seRev, b.arppu, b.mean, b.seRev];
    if (inputs.some((v) => v == null || !Number.isFinite(v))) {
      return { status: 'missing' };
    }
    if (r.mean === 0 || b.mean === 0) return { status: 'missing' };
    const scale1 = r.arppu / r.mean;
    const scale2 = b.arppu / b.mean;
    const se1 = r.seRev * scale1;
    const se2 = b.seRev * scale2;
    const seDiffSq = se1 * se1 + se2 * se2;
    const seDiff = Math.sqrt(seDiffSq);
    const diff = r.arppu - b.arppu;
    const pctChange = b.arppu !== 0 ? (diff / b.arppu) * 100 : null;
    const z = seDiff > 0 ? diff / seDiff : null;
    const p = z == null ? null : stats.twoSidedP(z);
    return {
      status: 'ok',
      arppu1: r.arppu,
      mean1: r.mean,
      seRev1: r.seRev,
      scale1,
      se1,
      arppu2: b.arppu,
      mean2: b.mean,
      seRev2: b.seRev,
      scale2,
      se2,
      seDiffSq,
      seDiff,
      diff,
      pctChange,
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
    // Absolute change in percentage points and relative pct change.
    const diffPP = diff * 100;
    const pctChange = p2 !== 0 ? (diff / p2) * 100 : null;
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
      diffPP,
      pctChange,
      z,
      p,
    };
  }

  // ---- formatting + panel rendering ------------------------------------

  const MINUS = '\u2212'; // typographic minus

  function formatPLabel(p) {
    if (p == null || !Number.isFinite(p)) return null;
    if (p < 0.001) return 'p<0.001';
    if (p < 0.01) return `p=${p.toFixed(3)}`;
    return `p=${p.toFixed(2)}`;
  }

  function formatSignedDollar(v) {
    if (v == null || !Number.isFinite(v)) return null;
    const sign = v > 0 ? '+' : v < 0 ? MINUS : '';
    return `${sign}$${Math.abs(v).toFixed(2)}`;
  }

  function formatSignedPP(v) {
    if (v == null || !Number.isFinite(v)) return null;
    const sign = v > 0 ? '+' : v < 0 ? MINUS : '';
    const abs = Math.abs(v);
    const digits = abs >= 10 ? 1 : 2;
    return `${sign}${abs.toFixed(digits)}pp`;
  }

  function formatSignedPct(v) {
    if (v == null || !Number.isFinite(v)) return null;
    const sign = v > 0 ? '+' : v < 0 ? MINUS : '';
    const abs = Math.abs(v);
    const digits = abs >= 100 ? 0 : abs >= 10 ? 0 : 1;
    return `(${sign}${abs.toFixed(digits)}%)`;
  }

  function dirClass(v) {
    if (v == null || !Number.isFinite(v)) return 'apv-flat';
    if (v > 0) return 'apv-up';
    if (v < 0) return 'apv-down';
    return 'apv-flat';
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]);
  }

  // Render one metric's change/p-value block. `kind` selects formatter
  // flavor; `b` is the breakdown object.
  // Kinds:
  //   'rev'          → dollar change, higher = better (green up).
  //   'arppu'        → dollar change, higher = better (green up).
  //   'prop'         → percentage-point change, higher = better.
  //   'inverse-prop' → percentage-point change, higher = WORSE (red up).
  function renderMetricCell(kind, b) {
    if (!b || b.status !== 'ok' || b.p == null) {
      return '<div class="apv-anno apv-flat"><div class="apv-pvalue apv-na">—</div></div>';
    }
    let changeAbs;
    let direction;
    if (kind === 'rev') {
      changeAbs = formatSignedDollar(b.diffMeans);
      direction = b.diffMeans;
    } else if (kind === 'arppu') {
      changeAbs = formatSignedDollar(b.diff);
      direction = b.diff;
    } else {
      changeAbs = formatSignedPP(b.diffPP);
      direction = b.diffPP;
    }
    // For inverse-prop, "up" is worse — flip the color signal but keep the
    // text sign as-is so the absolute change still reads correctly.
    const colorSignal = kind === 'inverse-prop' ? -direction : direction;
    const changePct = formatSignedPct(b.pctChange);
    const changeText = [changeAbs, changePct].filter(Boolean).join(' ');
    const pText = formatPLabel(b.p);
    const significant = b.p < 0.05;
    const cls = `apv-anno ${dirClass(colorSignal)}${significant ? ' apv-sig' : ''}`;
    return (
      `<div class="${cls}">` +
        `<div class="apv-change">${escapeHtml(changeText || '—')}</div>` +
        `<div class="apv-pvalue">${escapeHtml(pText || '—')}</div>` +
      '</div>'
    );
  }

  function renderPanel(table, debugRows, baselineName) {
    const nonBaseline = debugRows.filter((r) => !r.isBaseline);
    const head =
      '<thead><tr>' +
        '<th>Variant</th>' +
        '<th>Revenue per 1K users</th>' +
        '<th>Unique CR purchases</th>' +
        '<th>Unique CR trials</th>' +
        '<th>ARPPU</th>' +
        '<th>Refund rate</th>' +
        '<th>Trial cancel rate</th>' +
      '</tr></thead>';
    const body =
      '<tbody>' +
        nonBaseline
          .map((r) => {
            const c = r.comparisons || {};
            return (
              '<tr>' +
                `<td class="apv-variant">${escapeHtml(r.name)}</td>` +
                `<td>${renderMetricCell('rev', c.rev)}</td>` +
                `<td>${renderMetricCell('prop', c.purch)}</td>` +
                `<td>${renderMetricCell('prop', c.trials)}</td>` +
                `<td>${renderMetricCell('arppu', c.arppu)}</td>` +
                `<td>${renderMetricCell('inverse-prop', c.refundRate)}</td>` +
                `<td>${renderMetricCell('inverse-prop', c.trialCancel)}</td>` +
              '</tr>'
            );
          })
          .join('') +
      '</tbody>';
    const html =
      `<div class="apv-summary-title">P-value summary · baseline: ${escapeHtml(baselineName)}</div>` +
      '<div class="apv-summary-note">Baseline = lowest-revenue variant. Adapty doesn\u2019t expose A/B labels in the DOM, so the floor is treated as baseline and every other variant is shown as a delta vs. it. For refund and trial-cancellation rates, lower is better — green = down vs. baseline.</div>' +
      `<table class="apv-summary-table">${head}${body}</table>`;

    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('section');
      panel.id = PANEL_ID;
    }
    // Ensure the panel sits as the immediate next sibling of the table,
    // even if React re-parented things between passes.
    if (panel.parentElement !== table.parentElement || panel.previousElementSibling !== table) {
      table.parentElement.insertBefore(panel, table.nextSibling);
    }
    // Skip innerHTML assignment when the content is unchanged — otherwise
    // the MutationObserver sees our own write, re-fires schedule(), and
    // we loop at ~6 Hz forever.
    if (panel.innerHTML !== html) {
      panel.innerHTML = html;
    }
  }

  function removePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
  }

  // ---- main pass --------------------------------------------------------

  let latestDebug = null;

  function process() {
    if (!URL_MATCH.test(location.pathname)) {
      latestDebug = null;
      removePanel();
      return;
    }
    const table = document.querySelector(TABLE_SELECTOR);
    if (!table) return;
    const rowGroup = table.querySelector('[role="rowgroup"]');
    if (!rowGroup) return;
    const rowEls = Array.from(rowGroup.querySelectorAll('[role="row"]'));
    if (rowEls.length < 2) {
      latestDebug = null;
      removePanel();
      return;
    }

    const records = rowEls.map(readRow).filter(Boolean);
    if (records.length < 2) {
      latestDebug = null;
      removePanel();
      return;
    }

    // Baseline = lowest revenue, tie-break on lower n. Adapty doesn't
    // tell us which paywall is variant A vs. B, so we treat the floor
    // as baseline and report every other variant as a delta vs. it.
    const base = records.reduce((best, r) =>
      r.revenue < best.revenue || (r.revenue === best.revenue && r.n < best.n) ? r : best
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
        arppu: rec.arppu,
        purchases: rec.purchases,
        refunds: rec.refunds,
        trials: rec.trials,
        trialsCancelled: rec.trialsCancelled,
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
              arppu: arppuBreakdown(rec, base),
              refundRate: propBreakdown(rec.refunds, rec.purchases, base.refunds, base.purchases),
              trialCancel: propBreakdown(rec.trialsCancelled, rec.trials, base.trialsCancelled, base.trials),
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

    renderPanel(table, debugRows, base.name);
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
