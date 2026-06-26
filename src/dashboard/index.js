'use strict';

const health = require('../health');
const { detectPatterns } = require('../patterns');
const { formatMoney } = require('../impact');
const { CSS } = require('./style');

/**
 * Dashboard router (Phase 9). Composed into src/serve.js's request handler;
 * matches /dashboard/*. All pages are server-rendered HTML — no JS framework,
 * no external assets. Vanilla `fetch()` does any client-side refresh.
 *
 *   GET /dashboard               — landing aggregate + recent runs
 *   GET /dashboard/sites         — full sites list (filterable)
 *   GET /dashboard/sites/:id     — per-site drill-down (history + flows)
 *   GET /dashboard/patterns      — cross-merchant pattern queue
 *   GET /dashboard/defects       — defects queue (TODO: needs persisted defects)
 */
function handleDashboardRoute(req, res, { historyDir, defectRepo = null }) {
  if (req.method !== 'GET' || !req.url.startsWith('/dashboard')) return false;
  try {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    // parts[0] === 'dashboard'

    if (parts.length === 1) return send(res, renderIndex(historyDir, defectRepo));
    if (parts[1] === 'sites' && parts.length === 2) return send(res, renderSites(historyDir, url.searchParams));
    if (parts[1] === 'sites' && parts.length === 3) return send(res, renderSiteDetail(historyDir, decodeURIComponent(parts[2]), defectRepo));
    if (parts[1] === 'patterns') return send(res, renderPatterns(historyDir));
    if (parts[1] === 'defects')  return send(res, renderDefects(defectRepo, url.searchParams));
    return sendErr(res, 404, 'not found');
  } catch (e) {
    return sendErr(res, 500, 'internal error: ' + e.message);
  }
}

// ---------- Renderers --------------------------------------------------------

function renderIndex(historyDir, defectRepo) {
  const agg = health.platformHealth(historyDir);
  const sites = health.listSites(historyDir);
  const records = sites.map(s => health.loadLatest(s, historyDir)).filter(Boolean);
  records.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

  const openDefects = defectRepo ? defectRepo.queueAll({ openOnly: true }).length : 0;
  const critDefects = defectRepo
    ? defectRepo.queueAll({ openOnly: true }).filter(d => d.severity === 'critical').length : 0;

  return layout('dashboard', `
    <h2>Platform overview</h2>
    <div class="cards">
      ${card(agg.total, 'merchants')}
      ${card(agg.healthy, 'healthy', '#16a34a')}
      ${card(agg.degraded, 'degraded', '#d97706')}
      ${card(agg.unhealthy + agg.critical, 'unhealthy', '#dc2626')}
      ${card(agg.score_avg ?? '—', 'avg score')}
      ${card(formatMoney(agg.realised_impact_per_hour || 0, 'INR'), 'realised loss/hr', '#fca5a5')}
      ${defectRepo ? card(openDefects, 'open defects', critDefects ? '#dc2626' : undefined) : ''}
    </div>

    <h2>Recent runs (latest first)</h2>
    <table>
      <thead><tr><th>Site</th><th>Status</th><th>Score</th><th>Archetype</th><th>Region</th><th>Impact/hr</th><th>When</th></tr></thead>
      <tbody>
        ${records.slice(0, 30).map(r => `
          <tr>
            <td><a href="/dashboard/sites/${encodeURIComponent(r.site)}"><b>${esc(r.site)}</b></a>
                <div class="muted">${esc(r.url || '')}</div></td>
            <td>${pill(r.status)}</td>
            <td>${r.score ?? '—'}</td>
            <td class="muted">${esc(r.archetype || '')}</td>
            <td class="muted">${esc(r.region || '')}</td>
            <td>${formatMoney(r.business_impact_per_hour || 0, r.currency || 'INR')}</td>
            <td class="muted">${ago(r.ts)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `);
}

function renderSites(historyDir, q) {
  const sites = health.listSites(historyDir);
  const records = sites.map(s => health.loadLatest(s, historyDir)).filter(Boolean);
  const status = q.get('status');
  const archetype = q.get('archetype');
  const filtered = records.filter(r =>
    (!status || (status === 'unhealthy' ? ['failed', 'error'].includes(r.status) : r.status === status)) &&
    (!archetype || r.archetype === archetype));

  return layout('sites', `
    <h2>All merchants <span class="muted">(${filtered.length} of ${records.length})</span></h2>
    <form method="get" style="margin-bottom:18px; display:flex; gap:12px;">
      <input type="search" name="q" placeholder="filter (server-side)" />
      <select name="status">
        <option value="">any status</option>
        <option value="passed">passed</option>
        <option value="degraded">degraded</option>
        <option value="unhealthy">unhealthy</option>
      </select>
      <select name="archetype">
        <option value="">any archetype</option>
        ${[...new Set(records.map(r => r.archetype).filter(Boolean))]
          .map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('')}
      </select>
      <button>filter</button>
    </form>
    <table>
      <thead><tr><th>Site</th><th>Status</th><th>Score</th><th>Archetype</th><th>Region</th><th>Last check</th></tr></thead>
      <tbody>
        ${filtered.map(r => `
          <tr>
            <td><a href="/dashboard/sites/${encodeURIComponent(r.site)}">${esc(r.site)}</a></td>
            <td>${pill(r.status)}</td>
            <td>${r.score ?? '—'}</td>
            <td class="muted">${esc(r.archetype || '')}</td>
            <td class="muted">${esc(r.region || '')}</td>
            <td class="muted">${ago(r.ts)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `);
}

function renderSiteDetail(historyDir, siteId, defectRepo) {
  const history = health.loadHistory(siteId, historyDir, 30);
  const latest = history[history.length - 1];
  if (!latest) return layout(siteId, `<h2>${esc(siteId)}</h2><p class="muted">No data yet.</p>`);
  const defects = defectRepo ? defectRepo.listOpen(siteId) : [];

  const trend = history.map(h => h.score).filter(Number.isFinite);
  const sparkPoints = trend.map((s, i, arr) =>
    `${(i / Math.max(1, arr.length - 1) * 100).toFixed(1)},${100 - s}`).join(' ');

  return layout(siteId, `
    <p><a href="/dashboard/sites">← all sites</a></p>
    <h2>${esc(siteId)} <span class="muted">${esc(latest.url || '')}</span></h2>

    <div class="cards">
      ${card(latest.score ?? '—', 'sanity score')}
      ${card(latest.status, 'status')}
      ${card(latest.archetype || '—', 'archetype')}
      ${card(formatMoney(latest.business_impact_per_hour || 0, latest.currency || 'INR'), 'impact / hr', '#fca5a5')}
      ${card(history.length, 'runs in history')}
      ${card(ago(latest.ts), 'last check')}
    </div>

    ${sparkPoints ? `
      <div class="panel">
        <div class="bd-h">Score trend (last ${trend.length} runs)</div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:120px;background:#0f172a;border-radius:8px">
          <polyline points="${sparkPoints}" fill="none" stroke="#7dd3fc" stroke-width="1.5"/>
        </svg>
      </div>` : ''}

    <div class="panel">
      <div class="bd-h">Latest flows</div>
      ${(latest.flows || []).map(f => `
        <div class="row"><span><b>${esc(f.key)}</b> <span class="muted">${esc([f.viewport, f.persona].filter(Boolean).join(' · '))}</span></span><span>${pill(f.status)}</span></div>
      `).join('') || '<div class="muted">No flow data.</div>'}
    </div>

    ${defects.length ? `
    <div class="panel">
      <div class="bd-h">Open defects (${defects.length})</div>
      ${defects.map(d => `
        <div class="row">
          <span><b>${esc(d.title || d.dedupeKey)}</b> <span class="muted">— ${esc(d.diagnosis || '').slice(0, 90)}</span></span>
          <span class="muted">${d.occurrences}× · ${ago(d.lastSeen)}</span>
        </div>
      `).join('')}
    </div>` : ''}

    <div class="panel">
      <div class="bd-h">Recent runs (${history.length})</div>
      <table>
        <thead><tr><th>When</th><th>Status</th><th>Score</th><th>Duration</th></tr></thead>
        <tbody>
          ${history.slice().reverse().map(h => `
            <tr><td class="muted">${ago(h.ts)}</td><td>${pill(h.status)}</td>
                <td>${h.score ?? '—'}</td><td class="muted">${h.durationMs}ms</td></tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `);
}

function renderPatterns(historyDir) {
  const p = detectPatterns(historyDir);
  const sevColor = { critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#3b82f6' };
  return layout('patterns', `
    <h2>Cross-merchant patterns <span class="muted">(window ${(p.window_ms / 60000) | 0} min, ${p.merchants_in_window} merchants)</span></h2>
    ${p.patterns.length === 0 ? '<p class="muted">No platform-wide regressions detected.</p>' : ''}
    ${p.patterns.map(pat => `
      <div class="panel" style="border-left:4px solid ${sevColor[pat.severity] || '#6b7280'}">
        <div style="font-size:15px;font-weight:600;margin-bottom:6px">
          <span class="status s-${pat.severity === 'critical' ? 'critical' : 'failed'}">${esc(pat.severity)}</span>
          ${esc(pat.headline)}
        </div>
        <div class="muted">
          ${pat.lift}× baseline rate · ${(pat.failure_rate * 100).toFixed(0)}% vs ${(pat.platform_baseline_rate * 100).toFixed(0)}% · ${pat.affected_count}/${pat.total_in_dimension} merchants on ${esc(pat.dimension)}=<b>${esc(pat.value)}</b>
        </div>
        <div class="muted" style="margin-top:6px">
          Affected: ${pat.affected_sites.slice(0, 6).map(s => `<a href="/dashboard/sites/${encodeURIComponent(s)}">${esc(s)}</a>`).join(', ')}${pat.affected_sites.length > 6 ? `, +${pat.affected_sites.length - 6} more` : ''}
        </div>
      </div>
    `).join('')}
  `);
}

function renderDefects(defectRepo, q) {
  if (!defectRepo) {
    return layout('defects', `<h2>Defects queue</h2><p class="muted">No defect store wired in this run.</p>`);
  }
  const includeResolved = q.get('show') === 'all';
  const defects = defectRepo.queueAll({ openOnly: !includeResolved });
  const sevPill = (sev) => {
    const c = { critical: 's-critical', high: 's-failed', medium: 's-degraded', low: 's-passed' }[sev] || 's-degraded';
    return `<span class="status ${c}">${esc(sev || 'unknown')}</span>`;
  };
  return layout('defects', `
    <h2>Defects queue <span class="muted">(${defects.length} ${includeResolved ? 'total' : 'open'})</span></h2>
    <p class="muted" style="margin-bottom:18px">
      <a href="/dashboard/defects${includeResolved ? '' : '?show=all'}">
        ${includeResolved ? '← show open only' : 'show resolved →'}
      </a>
    </p>
    ${defects.length === 0 ? `<p class="muted">No ${includeResolved ? '' : 'open '}defects.</p>` : `
    <table>
      <thead><tr><th>Severity</th><th>Site</th><th>Title</th><th>Occurrences</th><th>First seen</th><th>Last seen</th></tr></thead>
      <tbody>
        ${defects.map(d => `
          <tr>
            <td>${sevPill(d.severity)}</td>
            <td><a href="/dashboard/sites/${encodeURIComponent(d.siteId)}">${esc(d.siteId)}</a></td>
            <td><div><b>${esc(d.title || d.dedupeKey)}</b></div>
                ${d.diagnosis ? `<div class="muted">${esc(d.diagnosis).slice(0, 140)}…</div>` : ''}
                ${d.narrative ? `<div class="muted" style="margin-top:4px">📖 ${esc(d.narrative).slice(0, 200)}…</div>` : ''}</td>
            <td>${d.occurrences}×</td>
            <td class="muted">${ago(d.firstSeen)}</td>
            <td class="muted">${ago(d.lastSeen)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`}
  `);
}

// ---------- HTML helpers -----------------------------------------------------

function layout(active, body) {
  const tab = (href, label, key) =>
    `<a class="${active === key ? 'active' : ''}" href="${href}">${label}</a>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>QA Agent · ${esc(active)}</title>
<style>${CSS}</style></head><body>
  <header>
    <h1>QA Agent Dashboard</h1>
    <nav>
      ${tab('/dashboard', 'Overview', 'dashboard')}
      ${tab('/dashboard/sites', 'Sites', 'sites')}
      ${tab('/dashboard/patterns', 'Patterns', 'patterns')}
      ${tab('/dashboard/defects', 'Defects', 'defects')}
    </nav>
  </header>
  <main>${body}</main>
</body></html>`;
}

function card(n, l, color) {
  return `<div class="card"><div class="n"${color ? ` style="color:${color}"` : ''}>${esc(n)}</div><div class="l">${esc(l)}</div></div>`;
}

function pill(status) {
  const cls = { passed: 's-passed', degraded: 's-degraded', failed: 's-failed', error: 's-failed', quarantined: 's-degraded' }[status] || 's-degraded';
  return `<span class="status ${cls}">${esc(status)}</span>`;
}

function ago(ts) {
  if (!ts) return '—';
  const ms = Date.now() - Date.parse(ts);
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

function send(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
  return true;
}
function sendErr(res, code, msg) {
  res.writeHead(code, { 'content-type': 'text/plain' });
  res.end(msg);
  return true;
}

module.exports = { handleDashboardRoute };
