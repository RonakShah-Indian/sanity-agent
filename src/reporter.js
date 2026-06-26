'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Reporter
 * --------
 * Emits three artifacts from a run:
 *  - results.json  : machine-readable full detail
 *  - junit.xml     : so the agent plugs into any CI as a quality gate
 *  - report.html   : a self-contained dashboard (no external deps) for humans
 */
class Reporter {
  constructor(outDir) { this.outDir = outDir; fs.mkdirSync(outDir, { recursive: true }); }

  write(run) {
    const json = path.join(this.outDir, 'results.json');
    const xml = path.join(this.outDir, 'junit.xml');
    const html = path.join(this.outDir, 'report.html');
    fs.writeFileSync(json, JSON.stringify(run, null, 2));
    fs.writeFileSync(xml, this._junit(run));
    fs.writeFileSync(html, this._html(run));
    return { json, xml, html };
  }

  _junit(run) {
    const cases = [];
    for (const r of run.results) {
      for (const f of r.flows || []) {
        const failed = f.status === 'failed';
        cases.push(
          `    <testcase classname="${esc(r.site)}" name="${esc(f.flow)}" time="${((r.durationMs||0)/1000).toFixed(2)}">` +
          (failed ? `\n      <failure message="${esc(f.failedStep?.error || 'failed')}"/>\n    </testcase>` : `</testcase>`)
        );
      }
      if (r.status === 'error') {
        cases.push(`    <testcase classname="${esc(r.site)}" name="run"><error message="${esc(r.error)}"/></testcase>`);
      }
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="sanity-agent" tests="${cases.length}" failures="${run.summary.failed}" errors="${run.summary.errored}" time="${((run.summary.durationMs||0)/1000).toFixed(2)}">\n${cases.join('\n')}\n</testsuite>\n`;
  }

  _html(run) {
    const s = run.summary;
    const rows = run.results.map(r => {
      const flows = (r.flows || []).map(f => {
        const c = { passed: '#16a34a', degraded: '#d97706', failed: '#dc2626', quarantined: '#9333ea' }[f.status] || '#6b7280';
        const vp = f.viewport ? ` <span class="vp">${esc(f.viewport)}</span>` : '';
        const persona = f.persona ? ` <span class="persona-tag">${esc(f.persona)}</span>` : '';
        return `<span class="pill" style="background:${c}1a;color:${c};border:1px solid ${c}55">${esc(f.flow)}: ${f.status}${persona}${vp}</span>`;
      }).join(' ');
      const impact = renderSiteImpact(r);
      const personaPanel = renderPersonaFindings(r.personaFindings);
      const telemetryPanel = renderTelemetry(r.telemetry, r.visual, r.third_party_culprits, r.transport);
      const videosPanel = renderVideos(r.videos);
      const sc = { passed: '#16a34a', degraded: '#d97706', failed: '#dc2626', error: '#dc2626', deferred: '#6b7280' }[r.status] || '#6b7280';
      const loc = r.locale ? `${r.locale.lang}${r.locale.currency ? ' · ' + r.locale.currency : ''}` : '—';
      const prof = r.profile ? `${r.profile.learnedIntents} learned · conf ${r.profile.avgConfidence}` : '—';
      const biz = r.business ? `<b>${esc(r.business.label)}</b><div class="muted">${r.business.archetype} · ${r.business.confidence} · ${r.business.method}${r.tier ? ' · ' + r.tier : ''}</div>` : '—';
      const tickets = (r.flows || []).flatMap(f => f.steps || []).filter(st => st.remediation)
        .map(st => {
          const t = st.remediation.ticket || {};
          const snap = t.snapshot || {};
          const narrative = t.narrative ? `<div class="narrative">📖 <b>What the agent actually saw:</b> ${esc(t.narrative)}</div>` : '';
          const where = (snap.url || snap.title) ? `<div class="muted">on ${esc(snap.title || '')} <a style="color:#7dd3fc" href="${esc(snap.url)}">${esc(snap.url)}</a></div>` : '';
          const propose = st.remediation.proposedFix?.candidate ? `<br><code>proposed: ${esc(st.remediation.proposedFix.candidate)} (needs approval)</code>` : '';
          return `<div class="ticket"><b>${esc(t.title)}</b>${where}<br><span class="muted">${esc(t.diagnosis || '')}</span>${narrative}${propose}</div>`;
        }).join('');
      const diff = renderDiff(r.diff);
      const content = renderContent(r.flows);
      return `<tr>
        <td><b>${esc(r.site)}</b><div class="muted">${esc(r.url || '')}</div></td>
        <td><span class="status" style="color:${sc}">●</span> ${r.status}</td>
        <td>${biz}</td>
        <td>${loc}</td>
        <td>${flows}</td>
        <td>${impact}</td>
        <td class="muted">${prof}</td>
        <td>${((r.durationMs||0)/1000).toFixed(1)}s</td>
      </tr>${telemetryPanel ? `<tr><td colspan="8" class="telerow">${telemetryPanel}</td></tr>` : ''}${videosPanel ? `<tr><td colspan="8" class="telerow">${videosPanel}</td></tr>` : ''}${personaPanel ? `<tr><td colspan="8" class="personarow">${personaPanel}</td></tr>` : ''}${diff ? `<tr><td colspan="8" class="diffrow">${diff}</td></tr>` : ''}${content ? `<tr><td colspan="8" class="contentrow">${content}</td></tr>` : ''}${tickets ? `<tr><td colspan="8" class="tickets">${tickets}</td></tr>` : ''}`;
    }).join('\n');

    const pct = s.total ? Math.round((s.passed / s.total) * 100) : 0;
    return `<!doctype html><html><head><meta charset="utf-8"><title>Sanity Agent Report</title>
<style>
  :root{font-family:-apple-system,Segoe UI,Roboto,sans-serif}
  body{margin:0;background:#0f172a;color:#e2e8f0;padding:32px}
  h1{margin:0 0 4px;font-size:22px}.sub{color:#94a3b8;margin-bottom:24px;font-size:13px}
  .cards{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:24px}
  .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:16px 20px;min-width:120px}
  .card .n{font-size:28px;font-weight:700}.card .l{color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:12px;overflow:hidden}
  th,td{text-align:left;padding:12px 14px;border-bottom:1px solid #334155;font-size:13px;vertical-align:top}
  th{background:#0f172a;color:#94a3b8;text-transform:uppercase;font-size:11px;letter-spacing:.04em}
  .muted{color:#94a3b8;font-size:12px}.status{font-size:16px}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;margin:2px 2px}
  .vp{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:6px;background:rgba(255,255,255,.08);font-size:10px;letter-spacing:.02em}
  .impact-bad{color:#fca5a5;font-weight:600}
  .persona-tag{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:6px;background:rgba(168,85,247,.18);color:#c4b5fd;font-size:10px;letter-spacing:.02em}
  .personarow{background:#1a1233}
  .persona-panel{padding:8px 12px}
  .persona-block{background:#0f172a;border:1px solid #312e81;border-radius:8px;padding:10px 12px;margin:6px 0;font-size:12px}
  .persona-h{font-size:13px;margin-bottom:6px}
  .persona-name{font-weight:700;color:#c4b5fd}
  .persona-finding{padding:4px 8px;margin:3px 0;background:rgba(220,38,38,.08);border-left:3px solid #dc2626;border-radius:4px}
  .patterns-panel{background:linear-gradient(135deg,#3f1d2e,#1a0e1a);border:1px solid #7f1d1d;border-radius:14px;padding:16px 22px;margin-bottom:18px}
  .pat{background:rgba(15,23,42,.6);border-left:4px solid #dc2626;border-radius:8px;padding:10px 14px;margin:8px 0}
  .pat-h{font-size:14px;font-weight:600;margin-bottom:4px}
  .pat-sev{display:inline-block;padding:1px 8px;border-radius:99px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;margin-right:8px;font-weight:700}
  .telerow{background:#101820}
  .tele-panel{padding:8px 12px;font-size:12px}
  .tele-row{padding:4px 0}
  .impact-panel{background:linear-gradient(135deg,#1e293b,#0f172a);border:1px solid #334155;border-radius:14px;padding:18px 22px;margin-bottom:24px}
  .impact-headline{display:flex;gap:48px;align-items:flex-end;margin-bottom:14px}
  .ih-n{font-size:32px;font-weight:800;color:#fca5a5;letter-spacing:-.02em}
  .ih-l{color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
  .impact-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
  .bd{background:rgba(15,23,42,.5);border:1px solid #334155;border-radius:10px;padding:10px 14px}
  .bd-h{font-size:11px;text-transform:uppercase;color:#94a3b8;letter-spacing:.06em;margin-bottom:6px}
  .bd-row{display:flex;justify-content:space-between;padding:3px 0;font-size:13px;border-bottom:1px solid #1e293b}
  .bd-row:last-child{border-bottom:none}
  .tickets{background:#172033}.ticket{padding:8px 10px;margin:6px 0;background:#0f172a;border-left:3px solid #dc2626;border-radius:6px;font-size:12px}
  .narrative{margin-top:6px;padding:6px 10px;background:#1e293b;border-left:3px solid #d97706;border-radius:4px;color:#fde68a;font-size:12px;line-height:1.4}
  .diffrow{background:#13243b}
  .contentrow{background:#10241c}
  .diff{padding:6px 10px;font-size:12px}
  .diff .dh{font-weight:700;margin-bottom:4px}
  .chg{padding:3px 8px;margin:3px 0;border-radius:6px;background:#0f172a}
  .sev-high{border-left:3px solid #dc2626}.sev-medium{border-left:3px solid #d97706}.sev-low{border-left:3px solid #3b82f6}.sev-info{border-left:3px solid #6b7280}
  code{background:#0b1220;padding:1px 6px;border-radius:4px;color:#7dd3fc}
  .bar{height:8px;background:#334155;border-radius:99px;overflow:hidden;margin-top:8px}
  .bar>div{height:100%;background:#16a34a;width:${pct}%}
</style></head><body>
  <h1>Autonomous Sanity Agent — Run Report</h1>
  <div class="sub">${esc(s.generatedAt)} · ${s.total} sites · concurrency ${s.concurrency} · ${(s.durationMs/1000).toFixed(1)}s wall · ${s.throughputPerMin}/min throughput</div>
  <div class="cards">
    <div class="card"><div class="n">${pct}%</div><div class="l">Pass rate</div><div class="bar"><div></div></div></div>
    <div class="card"><div class="n" style="color:#16a34a">${s.passed}</div><div class="l">Passed</div></div>
    <div class="card"><div class="n" style="color:#d97706">${s.degraded}</div><div class="l">Degraded</div></div>
    <div class="card"><div class="n" style="color:#dc2626">${s.failed}</div><div class="l">Failed</div></div>
    <div class="card"><div class="n" style="color:#dc2626">${s.errored}</div><div class="l">Errored</div></div>
    <div class="card"><div class="n" style="color:#6b7280">${s.deferred}</div><div class="l">Deferred</div></div>
  </div>
  ${renderPatternsSummary(s.patterns)}
  ${renderImpactSummary(s.impact)}
  ${renderThirdParty(s.third_party)}
  <table><thead><tr><th>Site</th><th>Status</th><th>Core business</th><th>Locale</th><th>Flows</th><th>Impact / hr</th><th>Learned profile</th><th>Time</th></tr></thead>
  <tbody>${rows}</tbody></table>
</body></html>`;
  }
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderContent(flows) {
  const findings = (flows || []).flatMap(f => f.contentFindings || []);
  if (!findings.length) return '';
  const sevColor = { high: '#dc2626', medium: '#d97706', low: '#3b82f6', warning: '#d97706', info: '#16a34a' };
  const items = findings.map(f =>
    `<div class="chg sev-${f.severity === 'warning' ? 'medium' : f.severity}">${esc(f.note)}${f.examples ? `<div class="muted">e.g. ${f.examples.map(esc).join(', ')}</div>` : ''}</div>`
  ).join('');
  const worst = findings.some(f => f.severity === 'high') ? 'high' : findings.some(f => f.severity === 'medium' || f.severity === 'warning') ? 'medium' : 'info';
  return `<div class="diff"><span class="dh" style="color:${sevColor[worst]}">⊞ Content validation — ${findings.length} check(s)</span>${items}</div>`;
}

function renderDiff(d) {
  if (!d) return '';
  if (d.firstRun) return `<div class="diff"><span class="dh" style="color:#60a5fa">⟐ Deployment diff:</span> first run — baseline established, no comparison yet.</div>`;
  if (!d.changeCount) return `<div class="diff"><span class="dh" style="color:#16a34a">⟐ Deployment diff:</span> no changes vs baseline (${esc(d.baselineAt?.slice(0,16))}).</div>`;
  const sevColor = { high: '#dc2626', medium: '#d97706', low: '#3b82f6', none: '#6b7280' }[d.severity] || '#6b7280';
  const items = d.changes.map(c =>
    `<div class="chg sev-${c.severity}">${esc(c.note)}${c.examples ? `<div class="muted">e.g. ${c.examples.map(esc).join(', ')}</div>` : ''}</div>`
  ).join('');
  return `<div class="diff"><span class="dh" style="color:${sevColor}">⟐ Deployment diff — ${d.changeCount} change(s), severity ${d.severity}</span> (vs ${esc(d.baselineAt?.slice(0,16))})${items}</div>`;
}

function renderTelemetry(telemetry, visual, culprits, transport) {
  if (!telemetry?.length && !visual && !culprits?.length && !transport) return '';
  const tele = (telemetry || []).map(t => {
    const sev = { high: '#dc2626', medium: '#d97706', ok: '#16a34a' }[t.severity] || '#6b7280';
    const vit = t.vitals
      ? `<span class="muted">vitals — LCP ${t.vitals.lcp ?? '?'}ms · CLS ${t.vitals.cls ?? '?'} · INP ${t.vitals.inp ?? '?'}ms</span>`
      : '';
    const findings = (t.findings || []).map(f => `<span class="pill" style="background:${sev}1a;color:${sev};border:1px solid ${sev}55">${esc(f.kind)}: ${esc(f.detail)}</span>`).join(' ');
    return `<div class="tele-row"><b>${esc(t.variant)}</b> · ${vit} ${findings}</div>`;
  }).join('');
  const vis = visual ? Object.entries(visual).map(([k, v]) => {
    if (v.error) return `<div class="muted">visual ${esc(k)}: ${esc(v.error)}</div>`;
    if (v.baseline === 'created') return `<div class="muted">visual ${esc(k)}: baseline created</div>`;
    const color = v.regressed ? '#dc2626' : '#16a34a';
    return `<div style="color:${color}">visual ${esc(k)}: diff ${(v.diffPercent*100).toFixed(2)}% ${v.regressed ? '⚠ regression' : 'within threshold'}</div>`;
  }).join('') : '';
  const blame = (culprits || []).length ? `<div class="muted" style="margin-top:6px">⚠ Possible third-party cause: ${culprits.map(c => esc(c.label) + ' (' + esc(c.status) + ')').join(', ')}</div>` : '';
  const tx = transport ? `<div class="muted" style="font-size:11px">transport: ${esc(transport)}</div>` : '';
  return `<div class="tele-panel">${tele}${vis}${blame}${tx}</div>`;
}

function renderVideos(videos) {
  if (!videos || !Object.keys(videos).length) return '';
  const items = Object.entries(videos).map(([k, p]) =>
    `<div class="bd-row"><span>${esc(k)}</span><a href="file://${esc(p)}" style="color:#7dd3fc">${esc(p.split('/').pop())}</a></div>`).join('');
  return `<div class="bd" style="margin:6px 0">
    <div class="bd-h">🎬 Recorded videos (open with QuickTime / VLC)</div>
    ${items}
  </div>`;
}

function renderThirdParty(tp) {
  if (!tp || !tp.providers) return '';
  const rows = Object.entries(tp.providers).map(([id, v]) => {
    const color = v.status === 'operational' ? '#16a34a' : (v.status === 'unknown' ? '#6b7280' : '#dc2626');
    return `<div class="bd-row"><span><b>${esc(v.label || id)}</b> <span class="muted">${v.latencyMs}ms</span></span><span style="color:${color}">● ${esc(v.status)}</span></div>`;
  }).join('');
  return `<div class="bd" style="margin-bottom:18px">
    <div class="bd-h">Third-party dependencies${tp.any_degraded ? ' — ⚠ degradation detected' : ''}</div>
    ${rows}
  </div>`;
}

function renderPatternsSummary(p) {
  if (!p || !Array.isArray(p.patterns) || p.patterns.length === 0) return '';
  const sevColor = { critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#3b82f6' };
  const items = p.patterns.map(pat => {
    const c = sevColor[pat.severity] || '#6b7280';
    const lift = pat.lift !== null ? ` <span class="muted">— ${pat.lift}× baseline rate</span>` : '';
    const sites = pat.affected_sites.slice(0, 8).join(', ') + (pat.affected_sites.length > 8 ? `, +${pat.affected_sites.length - 8} more` : '');
    return `<div class="pat" style="border-left-color:${c}">
      <div class="pat-h"><span class="pat-sev" style="background:${c}22;color:${c};border:1px solid ${c}77">${esc(pat.severity)}</span> ${esc(pat.headline)}${lift}</div>
      <div class="muted">Affected: ${esc(sites)}</div>
    </div>`;
  }).join('');
  return `<div class="patterns-panel">
    <div class="bd-h">⚠ Cross-merchant patterns (${p.patterns.length}) — ${p.merchants_in_window} merchant(s) in window</div>
    ${items}
    <div class="muted" style="margin-top:8px">These are likely <b>platform-side</b> regressions — affecting many merchants on the same archetype / theme / region simultaneously. Triage at the platform layer, not the merchant layer.</div>
  </div>`;
}

function renderPersonaFindings(personaFindings) {
  if (!Array.isArray(personaFindings) || personaFindings.length === 0) return '';
  const rows = personaFindings.map(pf => {
    const headerColor = pf.findings.length === 0 ? '#16a34a' : '#dc2626';
    const headerLabel = pf.findings.length === 0 ? 'passed validators' : `${pf.findings.length} finding(s)`;
    const items = pf.findings.length === 0
      ? '<div class="muted">All persona validators passed.</div>'
      : pf.findings.map(f => `<div class="persona-finding"><b>${esc(f.kind)}</b> — ${esc(f.detail)}</div>`).join('');
    return `<div class="persona-block">
      <div class="persona-h"><span class="persona-name">${esc(pf.persona)}</span> on <span class="vp">${esc(pf.viewport)}</span> <span class="muted">(nav ${pf.navMs}ms)</span> <span style="float:right;color:${headerColor}">● ${headerLabel}</span></div>
      ${items}
    </div>`;
  }).join('');
  return `<div class="persona-panel"><div class="bd-h">Persona shoppers</div>${rows}</div>`;
}

function renderSiteImpact(r) {
  const bi = r.business_impact;
  if (!bi) return '<span class="muted">—</span>';
  const { formatMoney } = require('./impact');
  const realised = bi.realised_impact_per_hour;
  if (!realised) return '<span class="muted">—</span>';
  return `<div class="impact-bad">${formatMoney(realised, bi.currency)}<span class="muted"> /hr lost</span></div>`;
}

function renderImpactSummary(impact) {
  if (!impact || !impact.total_realised_per_hour) return '';
  const { formatMoney } = require('./impact');
  const byA = Object.entries(impact.by_archetype || {}).filter(([, v]) => v > 0);
  const byR = Object.entries(impact.by_region   || {}).filter(([, v]) => v > 0);
  const offenders = (impact.top_offenders || []).slice(0, 5);

  const renderBreakdown = (title, entries) => entries.length === 0 ? '' :
    `<div class="bd"><div class="bd-h">${title}</div>${entries.map(([k, v]) =>
      `<div class="bd-row"><span>${esc(k)}</span><b>${formatMoney(v, impact.currency)}</b></div>`).join('')}</div>`;

  const offenderRows = offenders.length === 0 ? '' :
    `<div class="bd"><div class="bd-h">Top offenders</div>${offenders.map(o =>
      `<div class="bd-row"><span>${esc(o.site)} <span class="muted">(${esc(o.archetype)})</span></span><b>${formatMoney(o.impact_per_hour, impact.currency)}</b></div>`).join('')}</div>`;

  return `<div class="impact-panel">
    <div class="impact-headline">
      <div><div class="ih-n">${formatMoney(impact.total_realised_per_hour, impact.currency)}</div><div class="ih-l">Realised loss / hr</div></div>
    </div>
    <div class="impact-grid">${renderBreakdown('By archetype', byA)}${renderBreakdown('By region', byR)}${offenderRows}</div>
  </div>`;
}

module.exports = { Reporter };
