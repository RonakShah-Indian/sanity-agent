'use strict';

/**
 * Phase 4 — Health-as-a-Service.
 *
 * Turns the agent's per-run JSON into:
 *   - a per-merchant health record (latest + short history)
 *   - a `/health/:id` API the merchant (and Fynd's admin) can poll
 *   - an embeddable SVG badge merchants drop on their storefront
 *   - a single-page merchant status page
 *
 * The history substrate is dead-simple: one JSONL file per merchant,
 * appended on every run. Each line is the summary fields used by the
 * dashboard — full reports still live in reports/run-<ts>/ as before.
 * At 1000-merchant scale this becomes one row per merchant in a real
 * datastore; the read API stays identical.
 */

const fs = require('fs');
const path = require('path');
const { formatMoney } = require('./impact');
const { FileRunHistoryRepo } = require('./storage/repositories');

/**
 * Phase 8 refactor: file-IO functions below now delegate to a RunHistoryRepo.
 * When the historyDir argument is a string (the historical contract), we
 * construct a FileRunHistoryRepo against it — fully backwards compatible.
 * When the caller passes a repo object directly (new path), we use it as-is.
 */
function _repo(historyDirOrRepo) {
  if (historyDirOrRepo && typeof historyDirOrRepo === 'object' && historyDirOrRepo.append) {
    return historyDirOrRepo;
  }
  return new FileRunHistoryRepo(historyDirOrRepo);
}

// ---- Scoring ---------------------------------------------------------------
// Simple, defensible, easy to argue with: start at 100, deduct for issues.
function computeScore(result) {
  if (!result) return null;
  if (result.status === 'error') return 0;
  let score = 100;
  for (const f of result.flows || []) {
    if (f.status === 'failed' && f.critical) score -= 20;
    else if (f.status === 'failed') score -= 10;
    else if (f.status === 'degraded' || f.status === 'quarantined') score -= 8;
  }
  for (const pf of result.personaFindings || []) {
    for (const finding of pf.findings || []) if (finding.status === 'failed') score -= 4;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function severityLabel(score) {
  if (score >= 90) return { label: 'healthy', color: '#16a34a' };
  if (score >= 70) return { label: 'degraded', color: '#d97706' };
  if (score >= 40) return { label: 'unhealthy', color: '#dc2626' };
  return { label: 'critical', color: '#991b1b' };
}

// ---- History persistence ---------------------------------------------------

function recordRun(run, historyDir) {
  const repo = _repo(historyDir);
  for (const r of run.results || []) {
    if (!r.site) continue;
    repo.append(buildRecord(r));
  }
}

function buildRecord(r) {
  return {
    ts: r.finishedAt || new Date().toISOString(),
    site: r.site,
    url: r.url || null,
    status: r.status,
    score: computeScore(r),
    archetype: r.business?.archetype || null,
    locale: r.locale?.lang || null,
    region: r.region || null,
    themeVersion: r.themeVersion || null,
    durationMs: r.durationMs || 0,
    flows: (r.flows || []).map(f => ({ key: f.key || f.flow, status: f.status, viewport: f.viewport || null, persona: f.persona || null })),
    persona_findings_count: (r.personaFindings || []).reduce((s, pf) => s + (pf.findings?.length || 0), 0),
    business_impact_per_hour: r.business_impact?.realised_impact_per_hour || 0,
    currency: r.business_impact?.currency || null,
  };
}

function loadLatest(siteId, historyDir)              { return _repo(historyDir).loadLatest(siteId); }
function loadHistory(siteId, historyDir, limit = 50) { return _repo(historyDir).loadHistory(siteId, limit); }
function listSites(historyDir)                       { return _repo(historyDir).listSites(); }

// ---- Aggregate (platform-level) --------------------------------------------

function platformHealth(historyDir) {
  const sites = listSites(historyDir);
  const records = sites.map(s => loadLatest(s, historyDir)).filter(Boolean);
  if (!records.length) return { total: 0, healthy: 0, degraded: 0, unhealthy: 0, critical: 0, score_avg: null, last_check: null };

  const buckets = { healthy: 0, degraded: 0, unhealthy: 0, critical: 0 };
  let scoreSum = 0;
  let impactSum = 0;
  let lastTs = null;
  const byArch = new Map();
  for (const r of records) {
    buckets[severityLabel(r.score).label]++;
    scoreSum += r.score;
    impactSum += r.business_impact_per_hour || 0;
    if (!lastTs || r.ts > lastTs) lastTs = r.ts;
    if (r.archetype) byArch.set(r.archetype, (byArch.get(r.archetype) || 0) + 1);
  }

  return {
    total: records.length,
    ...buckets,
    score_avg: +(scoreSum / records.length).toFixed(1),
    realised_impact_per_hour: impactSum,
    last_check: lastTs,
    by_archetype: Object.fromEntries([...byArch.entries()].sort((a, b) => b[1] - a[1])),
  };
}

// ---- Public API: assemble the response shape -------------------------------

function buildHealthResponse(siteId, historyDir, { history_limit = 20 } = {}) {
  const latest = loadLatest(siteId, historyDir);
  if (!latest) return null;
  const history = loadHistory(siteId, historyDir, history_limit);
  const severity = severityLabel(latest.score);
  const past24 = history.filter(h => Date.parse(h.ts) > Date.now() - 24 * 60 * 60 * 1000);
  const uptime24h = past24.length
    ? +(past24.filter(h => h.status === 'passed').length / past24.length).toFixed(3)
    : null;

  return {
    merchant_id: siteId,
    url: latest.url,
    score: latest.score,
    severity: severity.label,
    status: latest.status,
    last_check: latest.ts,
    archetype: latest.archetype,
    region: latest.region,
    flows: latest.flows,
    persona_findings_count: latest.persona_findings_count,
    business_impact_per_hour: latest.business_impact_per_hour,
    currency: latest.currency,
    trend: {
      runs_last_24h: past24.length,
      uptime_24h: uptime24h,
      score_history: history.map(h => ({ ts: h.ts, score: h.score, status: h.status })),
    },
  };
}

// ---- Renderers: badge SVG + merchant HTML ---------------------------------

function renderBadgeSVG(health) {
  const score = health.score;
  const sev = severityLabel(score);
  const left = 'sanity';
  const right = `${score}/100`;
  // Simple Shields-like two-segment badge. Widths approximated by char count.
  const lw = 56;
  const rw = 16 + right.length * 7;
  const w = lw + rw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="sanity: ${score}/100">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-opacity=".15"/></linearGradient>
  <clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="20" fill="#555"/>
    <rect x="${lw}" width="${rw}" height="20" fill="${sev.color}"/>
    <rect width="${w}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" font-size="11">
    <text x="${lw/2}" y="14">${left}</text>
    <text x="${lw + rw/2}" y="14">${right}</text>
  </g>
</svg>`;
}

function renderMerchantPage(health, host) {
  const sev = severityLabel(health.score);
  const lastAgoMin = Math.floor((Date.now() - Date.parse(health.last_check)) / 60000);
  const flows = (health.flows || []).map(f => {
    const c = { passed: '#16a34a', degraded: '#d97706', failed: '#dc2626', quarantined: '#9333ea' }[f.status] || '#6b7280';
    const tag = [f.viewport, f.persona].filter(Boolean).join(' · ');
    return `<div class="row" style="border-left-color:${c}"><b>${esc(f.key)}</b><span class="muted">${tag ? ' — ' + esc(tag) : ''}</span><span class="status" style="color:${c}">${esc(f.status)}</span></div>`;
  }).join('');
  const histPoints = (health.trend?.score_history || []).map((h, i, arr) => {
    const x = (i / Math.max(1, arr.length - 1)) * 100;
    const y = 100 - h.score;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const impact = health.business_impact_per_hour
    ? `<div class="muted">Estimated loss: ${esc(formatMoney(health.business_impact_per_hour, health.currency || 'INR'))} / hr</div>`
    : '';
  const badgeUrl = `${host}/health/${encodeURIComponent(health.merchant_id)}/badge.svg`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="60">
<title>${esc(health.merchant_id)} — Sanity status</title>
<style>
  body{margin:0;background:#0f172a;color:#e2e8f0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:32px}
  .hero{display:flex;gap:32px;align-items:center;margin-bottom:28px}
  .score{font-size:88px;font-weight:800;color:${sev.color};letter-spacing:-.04em;line-height:1}
  .of100{font-size:24px;color:#94a3b8;margin-left:6px}
  .label{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8}
  .sev{display:inline-block;padding:4px 12px;border-radius:99px;background:${sev.color}22;color:${sev.color};border:1px solid ${sev.color}77;font-weight:600;font-size:13px}
  h1{margin:0 0 6px;font-size:22px}
  .muted{color:#94a3b8;font-size:13px}
  .panel{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:18px 22px;margin-bottom:18px}
  .row{padding:8px 12px;background:#0f172a;border-left:3px solid #334155;border-radius:6px;margin:6px 0;display:flex;gap:12px;align-items:center}
  .row .status{margin-left:auto;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
  .embed{background:#0b1220;padding:10px 14px;border-radius:8px;font-family:Menlo,monospace;font-size:12px;color:#7dd3fc;word-break:break-all}
  svg.trend{width:100%;height:80px;background:#0f172a;border-radius:8px}
  svg.trend polyline{fill:none;stroke:${sev.color};stroke-width:2}
</style></head><body>
  <h1>${esc(health.merchant_id)} <span class="muted">${esc(health.url || '')}</span></h1>
  <div class="muted">Last checked ${lastAgoMin} min ago · ${esc(health.archetype || 'unknown archetype')} · auto-refresh 60s</div>

  <div class="hero">
    <div><div class="score">${health.score}<span class="of100">/100</span></div><div class="label">Sanity score</div></div>
    <div><div class="sev">● ${sev.label}</div>${impact}</div>
  </div>

  <div class="panel">
    <div class="label">Recent flow runs</div>
    ${flows || '<div class="muted">No flow data yet.</div>'}
  </div>

  ${histPoints ? `<div class="panel">
    <div class="label">Score trend (last ${(health.trend?.score_history||[]).length} runs)</div>
    <svg class="trend" viewBox="0 0 100 100" preserveAspectRatio="none">
      <polyline points="${histPoints}"/>
    </svg>
  </div>` : ''}

  <div class="panel">
    <div class="label">Embed this badge on your storefront</div>
    <p>
      <img src="${esc(badgeUrl)}" alt="sanity" style="vertical-align:middle"/>
      <code style="margin-left:12px;color:#94a3b8">&lt;img src="${esc(badgeUrl)}"&gt;</code>
    </p>
    <div class="muted">Or link: <a style="color:#7dd3fc" href="${esc(host)}/health/${esc(health.merchant_id)}/page.html">${esc(host)}/health/${esc(health.merchant_id)}/page.html</a></div>
  </div>
</body></html>`;
}

// ---- Utilities -------------------------------------------------------------
function sanitize(s) { return String(s).replace(/[^a-z0-9._-]/gi, '_'); }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

module.exports = {
  recordRun, computeScore, severityLabel,
  loadLatest, loadHistory, listSites,
  platformHealth, buildHealthResponse,
  renderBadgeSVG, renderMerchantPage,
};
