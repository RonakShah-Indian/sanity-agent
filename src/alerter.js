'use strict';

/**
 * Alerter — page someone (not the dashboard) when a real P0 is detected.
 *
 * Today the dashboard shows it. This puts it in front of a human. Fires on:
 *
 *   - any `critical` cross-merchant pattern (the unique-to-Fynd signal)
 *   - any `high` pattern (configurable via minSeverity)
 *   - platform-wide realised-impact crossing a money threshold
 *
 * Per-event dedup: each event has a stable key (flow|dimension|value for
 * patterns, "platform-impact" for impact). The alerter records the last-
 * fired timestamp per key in alerts-state/ and suppresses re-pages within
 * the cooldown window. So a regression that persists across runs pages
 * once, not every five minutes.
 *
 * Channels:
 *   - slack:    incoming-webhook URL (recommended; one POST per event)
 *   - webhook:  generic JSON POST to any URL (works for PagerDuty Events v2
 *               and equivalents — just write the payload your endpoint wants)
 *
 * Both channels are best-effort: failures are logged and do not fail the run.
 */

const fs = require('fs');
const path = require('path');

const SEV_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

class Alerter {
  constructor({ config = {}, stateDir, logger = console } = {}) {
    this.config = {
      cooldownMs: 60 * 60 * 1000,        // 1h per-event cooldown
      minSeverity: 'critical',           // only critical patterns by default
      impactAlertThreshold: 1_000_000,   // ₹10 L/hr platform-wide
      ...config,
    };
    this.stateDir = stateDir;
    this.logger = logger;
  }

  /**
   * Inspect a run, emit alerts for new events. Returns { sent, suppressed, errors }.
   */
  async alertOnRun(run, { dashboardUrl } = {}) {
    const events = this._extractEvents(run);
    let sent = 0, suppressed = 0, errors = 0;
    for (const ev of events) {
      if (this._recentlyAlerted(ev)) { suppressed++; continue; }
      try {
        const fired = await this._fire(ev, { dashboardUrl });
        if (fired) { this._markAlerted(ev); sent++; }
      } catch (e) {
        errors++;
        this.logger.warn?.(`[alert] ${ev.key}: ${e.message}`);
      }
    }
    if (sent || suppressed || errors) {
      this.logger.info?.(`[alert] sent=${sent} suppressed=${suppressed} errors=${errors}`);
    }
    return { sent, suppressed, errors, events: events.length };
  }

  _extractEvents(run) {
    const events = [];
    const minRank = SEV_RANK[this.config.minSeverity] ?? SEV_RANK.critical;

    for (const p of run.summary?.patterns?.patterns || []) {
      const rank = SEV_RANK[p.severity] ?? 0;
      if (rank < minRank) continue;
      events.push({
        kind: 'pattern',
        key:  `pattern|${p.flow}|${p.dimension}|${p.value}`,
        severity: p.severity,
        payload: p,
      });
    }

    const impact = run.summary?.impact?.total_realised_per_hour;
    if (Number.isFinite(impact) && impact >= this.config.impactAlertThreshold) {
      events.push({
        kind: 'impact',
        key:  'impact|platform-realised',
        severity: 'high',
        payload: run.summary.impact,
      });
    }

    return events;
  }

  _recentlyAlerted(ev) {
    if (!this.stateDir) return false;
    try {
      const p = path.join(this.stateDir, `${sanitize(ev.key)}.json`);
      if (!fs.existsSync(p)) return false;
      const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
      const ageMs = Date.now() - Date.parse(rec.lastAlerted);
      return ageMs < this.config.cooldownMs;
    } catch { return false; }
  }

  _markAlerted(ev) {
    if (!this.stateDir) return;
    fs.mkdirSync(this.stateDir, { recursive: true });
    const p = path.join(this.stateDir, `${sanitize(ev.key)}.json`);
    fs.writeFileSync(p, JSON.stringify({ key: ev.key, lastAlerted: new Date().toISOString(), severity: ev.severity }, null, 2));
  }

  async _fire(ev, { dashboardUrl } = {}) {
    const webhookUrl = this.config.slack?.webhookUrl || resolveEnv(this.config.slack?.webhookUrlEnv);
    const genericUrl = this.config.webhook?.url || resolveEnv(this.config.webhook?.urlEnv);

    let anyChannelFired = false;
    if (webhookUrl) {
      const body = this._buildSlackPayload(ev, { dashboardUrl });
      const res = await fetch(webhookUrl, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
      if (!res.ok) throw new Error(`slack POST ${res.status}`);
      anyChannelFired = true;
    }
    if (genericUrl) {
      const body = { event: ev.kind, severity: ev.severity, key: ev.key, payload: ev.payload, dashboardUrl, at: new Date().toISOString() };
      const res = await fetch(genericUrl, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
      if (!res.ok) throw new Error(`webhook POST ${res.status}`);
      anyChannelFired = true;
    }
    if (!anyChannelFired) this.logger.debug?.(`[alert] no channels configured for ${ev.key}`);
    return anyChannelFired;
  }

  _buildSlackPayload(ev, { dashboardUrl } = {}) {
    if (ev.kind === 'pattern') {
      const p = ev.payload;
      const blocks = [
        { type: 'header', text: { type: 'plain_text', text: `🚨 ${ev.severity.toUpperCase()}: platform-side regression detected` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*${p.headline}*` } },
        { type: 'section', fields: [
          { type: 'mrkdwn', text: `*Lift:*\n${p.lift}× baseline (${(p.failure_rate*100).toFixed(0)}% vs ${(p.platform_baseline_rate*100).toFixed(0)}%)` },
          { type: 'mrkdwn', text: `*Affected (${p.affected_sites.length}):*\n${p.affected_sites.slice(0,5).join(', ')}${p.affected_sites.length>5?', +'+(p.affected_sites.length-5)+' more':''}` },
          { type: 'mrkdwn', text: `*Flow:*\n\`${p.flow}\`` },
          { type: 'mrkdwn', text: `*Dimension:*\n\`${p.dimension} = ${p.value}\`` },
        ] },
      ];
      if (dashboardUrl) blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'View dashboard' }, url: `${dashboardUrl}/dashboard.html` }, { type: 'button', text: { type: 'plain_text', text: 'View pattern JSON' }, url: `${dashboardUrl}/patterns` }] });
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Detected at ${new Date().toISOString()}` }] });
      return { text: `CRITICAL: ${p.headline}`, blocks };
    }
    if (ev.kind === 'impact') {
      const im = ev.payload;
      const { formatMoney } = require('./impact');
      return {
        text: `Platform-wide impact threshold crossed: ${formatMoney(im.total_realised_per_hour, im.currency)} / hr`,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: `💸 Platform-wide impact alert` } },
          { type: 'section', text: { type: 'mrkdwn', text: `*${formatMoney(im.total_realised_per_hour, im.currency)} / hr* realised across the platform.\nTop archetypes: ${Object.entries(im.by_archetype||{}).slice(0,3).map(([k,v]) => `${k} (${formatMoney(v, im.currency)})`).join(', ')}` } },
        ],
      };
    }
    return { text: `Sanity alert: ${ev.key}` };
  }
}

function sanitize(s) { return String(s).replace(/[^a-z0-9._-]/gi, '_'); }
function resolveEnv(name) { return name ? (process.env[name] || null) : null; }

module.exports = { Alerter };
