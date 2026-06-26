'use strict';

const fs = require('fs');
const path = require('path');

/**
 * BugReporter
 * -----------
 * Converts the agent's findings (failed flows + remediation tickets + deploy
 * diffs) into ready-to-file issue payloads for a management tool, and optionally
 * POSTs them to live APIs.
 *
 * Design: a thin ADAPTER per destination so the same finding can target Jira,
 * Slack, Linear, or a generic webhook. The ADAPTER renders the exact payload
 * each API expects. POST_ADAPTERS knows how to ship that payload to the actual
 * endpoint when credentials are supplied.
 *
 * Behavior:
 *   dryRun: true   (default) — payloads written to bug-payloads.json, nothing
 *                              POSTed. Safe for CI runs and demos.
 *   dryRun: false             — payloads written AND POSTed live. Requires
 *                              env vars: JIRA_BASE_URL/JIRA_EMAIL/JIRA_TOKEN,
 *                              SLACK_WEBHOOK_URL, LINEAR_API_KEY/LINEAR_TEAM_ID,
 *                              WEBHOOK_URL — only the adapters you've configured
 *                              actually fire; the rest stay dry by virtue of
 *                              missing creds (logged, not thrown).
 */
class BugReporter {
  constructor({ outDir, adapters = ['jira'], project = 'QA', dryRun = true, defectRepo = null, logger = console, fetcher = null }) {
    this.outDir = outDir;
    this.adapters = adapters;
    this.project = project;
    this.dryRun = dryRun;
    this.defectRepo = defectRepo;   // Phase 8 persistence — upsert findings by dedupeKey
    this.logger = logger;
    // Allow tests to inject a fake fetch; default to global fetch (Node 18+).
    this.fetch = fetcher || (typeof fetch !== 'undefined' ? fetch.bind(null) : null);
    fs.mkdirSync(outDir, { recursive: true });
  }

  /** Walk a run, extract findings, build payloads per adapter,
   *  upsert into defect store, optionally POST to live destinations. */
  async build(run) {
    const findings = this._extractFindings(run);
    const out = { generatedAt: new Date().toISOString(), dryRun: this.dryRun, count: findings.length, payloads: {}, posted: {} };
    for (const a of this.adapters) {
      out.payloads[a] = findings.map(f => ADAPTERS[a](f, this.project));
    }
    fs.writeFileSync(path.join(this.outDir, 'bug-payloads.json'), JSON.stringify(out, null, 2));

    // Persist defects (dedupe-by-key) — re-runs UPDATE existing rows.
    let newCount = 0, updateCount = 0;
    if (this.defectRepo) {
      for (const f of findings) {
        try {
          const { isNew } = this.defectRepo.upsert({
            siteId:     f.site,
            dedupeKey:  f.dedupeKey,
            title:      f.title,
            severity:   f.severity,
            diagnosis:  f.diagnosis,
            narrative:  f.narrative || null,
            journey:    f.flow,
            jiraRef:    null,
            payload:    f,
          });
          if (isNew) newCount++; else updateCount++;
        } catch (e) {
          this.logger.warn?.(`[bugs] persist failed for ${f.dedupeKey}: ${e.message}`);
        }
      }
    }

    if (this.dryRun) {
      const persistMsg = this.defectRepo ? ` · persisted ${newCount} new / ${updateCount} updated` : '';
      this.logger.info?.(`[bugs] ${findings.length} finding(s) → ${this.adapters.join(', ')} payloads written (dry-run, not posted)${persistMsg}`);
      return out;
    }

    // Live mode — POST each payload through its adapter. Per-adapter creds in
    // env vars; missing creds skip that adapter (logged, not thrown).
    for (const a of this.adapters) {
      const poster = POST_ADAPTERS[a];
      if (!poster) { this.logger.warn?.(`[bugs] no POST adapter for ${a}, skipping`); continue; }
      out.posted[a] = [];
      for (const payload of out.payloads[a]) {
        try {
          const result = await poster(payload, { fetch: this.fetch, logger: this.logger });
          out.posted[a].push({ dedupeKey: payload._dedupeKey, ok: result.ok, status: result.status, ref: result.ref || null });
        } catch (e) {
          out.posted[a].push({ dedupeKey: payload._dedupeKey, ok: false, error: e.message });
          this.logger.warn?.(`[bugs] ${a} POST failed for ${payload._dedupeKey}: ${e.message}`);
        }
      }
    }
    // Re-write with posted status appended.
    fs.writeFileSync(path.join(this.outDir, 'bug-payloads.json'), JSON.stringify(out, null, 2));
    const totalPosted = Object.values(out.posted).reduce((n, arr) => n + arr.filter(r => r.ok).length, 0);
    this.logger.info?.(`[bugs] ${findings.length} finding(s) — ${totalPosted} POSTed live across ${this.adapters.join(', ')}`);
    return out;
  }

  _extractFindings(run) {
    const findings = [];
    for (const r of run.results || []) {
      // 1. hard flow failures with a remediation ticket
      for (const f of r.flows || []) {
        for (const st of f.steps || []) {
          if (st.remediation) {
            findings.push({
              kind: 'flow-failure',
              site: r.site, url: r.url, business: r.business?.label,
              flow: f.flow, step: st.action, intent: st.intent,
              severity: st.remediation.ticket.severity || (f.critical ? 'high' : 'medium'),
              title: st.remediation.ticket.title,
              diagnosis: st.remediation.ticket.diagnosis,
              narrative: st.remediation.ticket.narrative,
              proposedFix: st.remediation.proposedFix,
              dedupeKey: `${r.site}:${f.flow}:${st.intent || st.action}`,
            });
          }
        }
      }
      // 2. high-severity deployment regressions (diff)
      if (r.diff && r.diff.severity === 'high') {
        for (const c of r.diff.changes.filter(c => c.severity === 'high')) {
          findings.push({
            kind: 'deploy-regression',
            site: r.site, url: r.url, business: r.business?.label,
            severity: 'high',
            title: `[Deploy regression] ${r.site}: ${c.type}`,
            diagnosis: c.note,
            dedupeKey: `${r.site}:diff:${c.type}`,
          });
        }
      }
      // 3. high-severity content-validation issues (broken images, price mismatch)
      for (const f of r.flows || []) {
        for (const cf of f.contentFindings || []) {
          if (cf.severity === 'high') {
            findings.push({
              kind: 'content-defect',
              site: r.site, url: r.url, business: r.business?.label,
              severity: 'high',
              title: `[Content] ${r.site}: ${cf.check} issue`,
              diagnosis: cf.note + (cf.examples ? ` e.g. ${cf.examples.join(', ')}` : ''),
              dedupeKey: `${r.site}:content:${cf.check}`,
            });
          }
        }
      }
    }
    return findings;
  }
}

// ---- Adapters: one function per destination, each returns that API's payload ----
const ADAPTERS = {
  // Jira Cloud REST v3 createIssue payload (ADF description)
  jira: (f, project) => ({
    _endpoint: 'POST /rest/api/3/issue',
    _dedupeKey: f.dedupeKey,   // search by this label before creating, to avoid dupes
    fields: {
      project: { key: project },
      issuetype: { name: 'Bug' },
      summary: f.title.slice(0, 240),
      labels: ['qa-agent', `site-${slug(f.site)}`, f.kind],
      priority: { name: { high: 'High', medium: 'Medium', low: 'Low' }[f.severity] || 'Medium' },
      description: {
        type: 'doc', version: 1,
        content: [
          adfPara(`Site: ${f.site} (${f.business || 'unknown'})  —  ${f.url || ''}`),
          adfPara(`Detected by the autonomous QA agent on the ${f.flow || f.kind} journey.`),
          adfHeading('Diagnosis'), adfPara(f.diagnosis || '—'),
          ...(f.proposedFix?.candidate ? [
            adfHeading('Proposed fix (requires human approval)'),
            adfPara(`${f.proposedFix.type}: ${f.proposedFix.candidate}`),
          ] : []),
          adfHeading('Reproduction'),
          adfPara(`Flow: ${f.flow || '-'} · Step: ${f.step || '-'} · Intent: ${f.intent || '-'}`),
        ],
      },
    },
  }),

  // Slack Block Kit message
  slack: (f) => ({
    _endpoint: 'POST chat.postMessage',
    _dedupeKey: f.dedupeKey,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `🐞 ${f.severity.toUpperCase()}: ${f.site}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*${f.title}*\n${f.diagnosis || ''}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${f.business || ''} · ${f.flow || f.kind} · <${f.url}|open site>` }] },
    ],
  }),

  // Linear GraphQL issueCreate input
  linear: (f) => ({
    _endpoint: 'mutation issueCreate',
    _dedupeKey: f.dedupeKey,
    input: {
      title: f.title.slice(0, 240),
      description: `**Site:** ${f.site}\n**Diagnosis:** ${f.diagnosis}\n**Repro:** ${f.flow}/${f.step}`,
      priority: { high: 1, medium: 2, low: 3 }[f.severity] || 2,
      labelIds: ['qa-agent'],
    },
  }),

  // Generic webhook (Teams, custom, etc.)
  webhook: (f) => ({
    _endpoint: 'POST {WEBHOOK_URL}',
    _dedupeKey: f.dedupeKey,
    body: { source: 'qa-agent', site: f.site, severity: f.severity, title: f.title, diagnosis: f.diagnosis, url: f.url, flow: f.flow },
  }),
};

function adfPara(text) { return { type: 'paragraph', content: [{ type: 'text', text: String(text) }] }; }
function adfHeading(text) { return { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text }] }; }
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-'); }

// ---- POST adapters: ship a payload to its real API. Skipped (logged) when ----
// ---- the required env vars are missing. Each returns { ok, status, ref }.  ----
const POST_ADAPTERS = {
  // Jira Cloud REST v3 — Basic auth with email:api-token.
  async jira(payload, { fetch, logger }) {
    const base = process.env.JIRA_BASE_URL;
    const email = process.env.JIRA_EMAIL;
    const token = process.env.JIRA_TOKEN;
    if (!base || !email || !token) {
      logger?.info?.('[bugs] jira POST skipped (set JIRA_BASE_URL, JIRA_EMAIL, JIRA_TOKEN)');
      return { ok: false, status: 0, ref: null, skipped: 'missing-creds' };
    }
    const auth = Buffer.from(`${email}:${token}`).toString('base64');
    const res = await fetch(`${base.replace(/\/+$/, '')}/rest/api/3/issue`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ fields: payload.fields }),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, ref: body.key || null };
  },

  // Slack incoming webhook — single URL, no auth header needed.
  async slack(payload, { fetch, logger }) {
    const url = process.env.SLACK_WEBHOOK_URL;
    if (!url) {
      logger?.info?.('[bugs] slack POST skipped (set SLACK_WEBHOOK_URL)');
      return { ok: false, status: 0, ref: null, skipped: 'missing-creds' };
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks: payload.blocks }),
    });
    return { ok: res.ok, status: res.status, ref: null };
  },

  // Linear GraphQL — Authorization header is the API key directly.
  async linear(payload, { fetch, logger }) {
    const key = process.env.LINEAR_API_KEY;
    const teamId = process.env.LINEAR_TEAM_ID;
    if (!key || !teamId) {
      logger?.info?.('[bugs] linear POST skipped (set LINEAR_API_KEY, LINEAR_TEAM_ID)');
      return { ok: false, status: 0, ref: null, skipped: 'missing-creds' };
    }
    const query = `mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }`;
    const input = { ...payload.input, teamId };
    delete input.labelIds; // labelIds need real IDs; omit so user can set them per-team
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Authorization': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { input } }),
    });
    const body = await res.json().catch(() => ({}));
    const issue = body?.data?.issueCreate?.issue;
    return { ok: !!issue, status: res.status, ref: issue?.identifier || null };
  },

  // Generic webhook (Teams, custom, etc.) — JSON POST to WEBHOOK_URL.
  async webhook(payload, { fetch, logger }) {
    const url = process.env.WEBHOOK_URL;
    if (!url) {
      logger?.info?.('[bugs] webhook POST skipped (set WEBHOOK_URL)');
      return { ok: false, status: 0, ref: null, skipped: 'missing-creds' };
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload.body),
    });
    return { ok: res.ok, status: res.status, ref: null };
  },
};

module.exports = { BugReporter, ADAPTERS, POST_ADAPTERS };
