'use strict';

const http = require('http');
const crypto = require('crypto');

/**
 * DeployTrigger
 * -------------
 * Turns "a deployment happened" into "run sanity and report within 5 minutes."
 * Two trigger models (both demonstrated):
 *
 *   A. WEBHOOK  - the deploy pipeline POSTs to /deploy {sites?, version, changed?}
 *      Primary path. Lowest latency: run starts the instant deploy finishes.
 *   B. POLL     - periodically GET a version endpoint per site; when the version
 *      string changes vs last-seen, enqueue that site. Fallback for sites whose
 *      pipeline can't call us.
 *
 * The 5-MINUTE BUDGET is enforced by a TIERED plan, not by brute force:
 *   - changed sites (from the deploy payload) -> FULL sanity plan
 *   - everything else                          -> P0 SMOKE only (1-2 critical steps)
 * You cannot run full checkout on 1000 sites in 5 min, but you CAN smoke all
 * 1000 and run full flows on the handful a deploy actually touched. See SCALE.md.
 */
class DeployTrigger {
  constructor({ onTrigger, secret = process.env.DEPLOY_SECRET, logger = console }) {
    this.onTrigger = onTrigger;   // async (sites, meta) => runResult
    this.secret = secret;
    this.logger = logger;
    this._lastSeenVersion = new Map();
    this._pollTimer = null;
  }

  // ---- Model A: webhook ----
  // Returns true if the request was handled (so a composing router can fall
  // through to other routes when it isn't a deploy POST).
  handleHttp(req, res) {
    if (req.method !== 'POST' || !req.url.startsWith('/deploy')) return false;
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      if (this.secret && !this._verify(req, body)) { res.writeHead(401); return res.end('bad signature'); }
      let payload; try { payload = JSON.parse(body || '{}'); } catch { res.writeHead(400); return res.end('bad json'); }
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: true, at: new Date().toISOString() }));
      const meta = { trigger: 'webhook', version: payload.version, changedSites: payload.changed || [], deadlineMs: 5 * 60 * 1000 };
      this.logger.info?.(`[deploy] webhook v=${payload.version} changed=${(payload.changed||[]).length}`);
      try { await this.onTrigger(payload.sites || null, meta); } catch (e) { this.logger.warn?.(`[deploy] run failed: ${e.message}`); }
    });
    return true;
  }

  listen(port = 8787) {
    const server = http.createServer((req, res) => {
      if (!this.handleHttp(req, res)) { res.writeHead(404); res.end('not found'); }
    });
    server.listen(port, () => this.logger.info?.(`[deploy] webhook listening on :${port}/deploy`));
    return server;
  }

  _verify(req, body) {
    const sig = req.headers['x-signature'] || '';
    const mac = crypto.createHmac('sha256', this.secret).update(body).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig.padEnd(mac.length)), Buffer.from(mac));
  }

  // ---- Model B: poll fallback ----
  startPolling(sites, intervalMs = 60000) {
    const check = async () => {
      const changed = [];
      for (const site of sites) {
        if (!site.versionUrl) continue;
        try {
          const v = await fetch(site.versionUrl).then(r => r.text()).then(t => t.trim().slice(0, 64));
          const prev = this._lastSeenVersion.get(site.id);
          if (prev !== undefined && prev !== v) changed.push(site.id);
          this._lastSeenVersion.set(site.id, v);
        } catch (e) { this.logger.debug?.(`[poll] ${site.id} version check failed: ${e.message}`); }
      }
      if (changed.length) {
        this.logger.info?.(`[poll] version change on ${changed.length} site(s): ${changed.join(', ')}`);
        await this.onTrigger(sites, { trigger: 'poll', changedSites: changed, deadlineMs: 5 * 60 * 1000 });
      }
    };
    this._pollTimer = setInterval(check, intervalMs);
    check(); // prime last-seen versions immediately
    this.logger.info?.(`[deploy] polling ${sites.length} site(s) every ${intervalMs/1000}s`);
  }

  stop() { if (this._pollTimer) clearInterval(this._pollTimer); }

  /**
   * Build the tiered work list for a deploy event.
   * changed sites -> full plan; others -> smoke. Keeps 1000 sites within budget.
   */
  static planTiers(sites, changedSites) {
    const changed = new Set(changedSites || []);
    return sites.map(s => ({
      ...s,
      tier: changed.has(s.id) ? 'full' : 'smoke',
      // smoke = the single highest-weight critical flow only (filled per-archetype at runtime)
      smokeOnly: !changed.has(s.id),
    }));
  }
}

module.exports = { DeployTrigger };
