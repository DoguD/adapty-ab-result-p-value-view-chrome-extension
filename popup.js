// Popup that fetches the latest debug snapshot from the content script
// and renders every intermediate value used in p-value calculation.

const URL_MATCH = /\/ab-tests\/[^/]+\/metrics\//;

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function fmt(v, digits) {
  if (v == null || !Number.isFinite(v)) return '—';
  const d = digits == null ? 4 : digits;
  return v.toFixed(d);
}

function fmtP(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  if (p < 0.0001) return '<0.0001';
  return p.toFixed(4);
}

function setStatus(msg, isError) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status' + (isError ? ' error' : '');
  el.style.display = 'block';
}

function hideStatus() {
  $('status').style.display = 'none';
}

async function main() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !URL_MATCH.test(tab.url)) {
      setStatus('Open an Adapty A/B test metrics page first.');
      return;
    }
    $('sub').textContent = tab.url;

    let resp;
    try {
      resp = await chrome.tabs.sendMessage(tab.id, { type: 'APV_GET_DEBUG' });
    } catch (e) {
      setStatus(
        'Content script not reachable. Reload the Adapty tab and try again.',
        true
      );
      return;
    }
    if (!resp || !resp.ok || !resp.data) {
      setStatus('No data yet — the table may still be loading. Try again.');
      return;
    }
    hideStatus();
    render(resp.data);
  } catch (e) {
    setStatus('Unexpected error: ' + (e && e.message ? e.message : e), true);
  }
}

function render(debug) {
  const content = $('content');
  const baseline = debug.rows.find((r) => r.isBaseline);
  const others = debug.rows.filter((r) => !r.isBaseline);

  const parts = [];

  parts.push('<h2>Extracted values</h2>');
  parts.push(renderExtractedTable(debug.rows, debug.ciMultiplier));

  if (baseline) {
    parts.push(`<h2>Baseline · ${escapeHtml(baseline.name)}</h2>`);
    parts.push('<div class="na">Highest-revenue row. All p-values below compare against it.</div>');
  }

  for (const r of others) {
    parts.push(renderComparison(r, baseline ? baseline.name : '(unknown)'));
  }
  if (others.length === 0) {
    parts.push('<div class="na">No non-baseline rows detected.</div>');
  }

  content.innerHTML = parts.join('');
}

function renderExtractedTable(rows, ciMult) {
  const header = [
    'Variant',
    'Revenue',
    'n',
    'Mean $/1K',
    'CI lower',
    'CI upper',
    'half-width',
    `SE = hw/${ciMult}`,
    'CR purch %',
    'x_purch',
    'CR trial %',
    'x_trial',
  ];
  const body = rows
    .map((r) => {
      const cls = r.isBaseline ? ' class="baseline"' : '';
      return `<tr${cls}>
        <td>${escapeHtml(r.name)}${r.isBaseline ? ' (baseline)' : ''}</td>
        <td>$${fmt(r.revenue, 0)}</td>
        <td>${fmt(r.n, 0)}</td>
        <td>${r.mean == null ? '—' : '$' + fmt(r.mean, 4)}</td>
        <td>${r.lower == null ? '—' : '$' + fmt(r.lower, 4)}</td>
        <td>${r.upper == null ? '—' : '$' + fmt(r.upper, 4)}</td>
        <td>${r.halfWidth == null ? '—' : '$' + fmt(r.halfWidth, 4)}</td>
        <td>${r.seRev == null ? '—' : '$' + fmt(r.seRev, 4)}</td>
        <td>${r.crPurchPct == null ? '—' : fmt(r.crPurchPct, 4) + '%'}</td>
        <td>${r.xPurch == null ? '—' : r.xPurch}</td>
        <td>${r.crTrialsPct == null ? '—' : fmt(r.crTrialsPct, 4) + '%'}</td>
        <td>${r.xTrials == null ? '—' : r.xTrials}</td>
      </tr>`;
    })
    .join('');
  return `<table class="apv-table">
    <thead><tr>${header.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function renderComparison(row, baselineName) {
  const c = row.comparisons || {};
  return `<div class="cmp">
    <div class="cmp-title">${escapeHtml(row.name)} &nbsp;vs&nbsp; ${escapeHtml(baselineName)}</div>
    ${renderRev(c.rev)}
    ${renderProp('Unique CR purchases', c.purch)}
    ${renderProp('Unique CR trials', c.trials)}
  </div>`;
}

function renderRev(b) {
  const head = '<div class="section"><div class="label">Revenue per 1K users</div>' +
    '<div class="sublabel">Two-sample z-test on means. SE derived from the displayed range assuming a 95% CI.</div>';
  const close = '</div>';
  if (!b) return head + '<div class="na">No data.</div>' + close;
  if (b.status !== 'ok') return head + `<div class="na">${naReason(b.status)}</div>` + close;
  const sig = Number.isFinite(b.p) && b.p < 0.05;
  const pClass = sig ? 'result-sig' : 'result';
  return head +
    '<div class="steps">' +
    `<div>1. m₁ = ${fmt(b.mean1, 4)},  SE₁ = (upper − mean)/1.96 = (${fmt(b.upper1, 4)} − ${fmt(b.mean1, 4)})/1.96 = ${fmt(b.se1, 6)}</div>` +
    `<div>2. m₂ = ${fmt(b.mean2, 4)},  SE₂ = (${fmt(b.upper2, 4)} − ${fmt(b.mean2, 4)})/1.96 = ${fmt(b.se2, 6)}</div>` +
    `<div>3. SE_diff = √(SE₁² + SE₂²) = √(${fmt(b.se1 * b.se1, 6)} + ${fmt(b.se2 * b.se2, 6)}) = √${fmt(b.seDiffSq, 6)} = ${fmt(b.seDiff, 6)}</div>` +
    `<div>4. z = (m₁ − m₂) / SE_diff = ${fmt(b.diffMeans, 4)} / ${fmt(b.seDiff, 6)} = ${fmt(b.z, 6)}</div>` +
    `<div>5. p = 2·(1 − Φ(|z|)) = <b class="${pClass}">${fmtP(b.p)}</b></div>` +
    '</div>' + close;
}

function renderProp(title, b) {
  const head = `<div class="section"><div class="label">${escapeHtml(title)}</div>` +
    '<div class="sublabel">Two-proportion pooled-variance z-test. x = round(CR% × n / 100).</div>';
  const close = '</div>';
  if (!b) return head + '<div class="na">No data.</div>' + close;
  if (b.status !== 'ok') return head + `<div class="na">${naReason(b.status)}</div>` + close;
  const sig = Number.isFinite(b.p) && b.p < 0.05;
  const pClass = sig ? 'result-sig' : 'result';
  return head +
    '<div class="steps">' +
    `<div>1. p₁ = x₁/n₁ = ${b.x1}/${b.n1} = ${fmt(b.p1, 6)}</div>` +
    `<div>2. p₂ = x₂/n₂ = ${b.x2}/${b.n2} = ${fmt(b.p2, 6)}</div>` +
    `<div>3. p_pool = (x₁+x₂)/(n₁+n₂) = ${b.sumX}/${b.sumN} = ${fmt(b.pPool, 6)}</div>` +
    `<div>4. var-factor = p_pool·(1−p_pool)·(1/n₁ + 1/n₂) = ${fmt(b.pPool, 6)}·${fmt(1 - b.pPool, 6)}·${fmt(1 / b.n1 + 1 / b.n2, 8)} = ${fmt(b.varFactor, 8)}</div>` +
    `<div>5. SE = √(var-factor) = ${fmt(b.se, 6)}</div>` +
    `<div>6. z = (p₁ − p₂) / SE = ${fmt(b.diff, 6)} / ${fmt(b.se, 6)} = ${fmt(b.z, 6)}</div>` +
    `<div>7. p = 2·(1 − Φ(|z|)) = <b class="${pClass}">${fmtP(b.p)}</b></div>` +
    '</div>' + close;
}

function naReason(status) {
  switch (status) {
    case 'missing': return 'Missing input (e.g. the CI range could not be parsed or CR% is empty).';
    case 'no_n': return 'n = 0 for at least one side.';
    case 'both_zero': return 'Both variants are at 0% — p-value is undefined.';
    default: return 'Not computable: ' + status;
  }
}

document.addEventListener('DOMContentLoaded', main);
