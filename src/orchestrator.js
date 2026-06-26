'use strict';

const os = require('os');
const { SiteAgent } = require('./agent');
const { LLMClient } = require('./llm');
const { DiffEngine } = require('./diff');
const path = require('path');
const { loadDefaults, scoreSite, aggregateImpact } = require('./impact');
const health = require('./health');
const { detectPatterns } = require('./patterns');
const { runProbes, correlateFailureToProvider } = require('./probes');
const { Alerter } = require('./alerter');

/**
 * Orchestrator (the scale layer)
 * ------------------------------
 * Sites are independent units of work => embarrassingly parallel. This is a
 * bounded-concurrency worker pool that drains a queue of sites. In production
 * the in-memory queue is swapped for SQS/Kafka and workers become autoscaled
 * containers — the per-site logic (SiteAgent) is unchanged.
 *
 * Controls that matter at 1000+ sites:
 *  - concurrency: cap simultaneous headless browsers (CPU/RAM bound)
 *  - perDomainDelay: politeness / avoid tripping WAFs on the same target
 *  - timeBudgetMs: hard wall-clock cap; unfinished sites are reported, not lost
 *  - shared LLM client: connection reuse + a single rate-limited gateway
 *
 * See docs/SCALE.md for the throughput + cost model.
 */
class Orchestrator {
  constructor({ config, profileDir, baselineDir, historyDir = null, visualDir = null, alertStateDir = null, dashboardUrl = null, logger = console }) {
    this.config = config;
    this.profileDir = profileDir;
    this.historyDir = historyDir;
    this.visualDir = visualDir;
    this.alertStateDir = alertStateDir;
    this.dashboardUrl = dashboardUrl;
    this.logger = logger;
    this.llm = new LLMClient({ logger });
    this.diffEngine = baselineDir ? new DiffEngine(baselineDir) : null;
    this.alerter = alertStateDir
      ? new Alerter({ config: config.alerts || {}, stateDir: alertStateDir, logger })
      : null;
    this.concurrency = config.concurrency || Math.max(2, os.cpus().length - 1);
  }

  async runAll(sites, { timeBudgetMs } = {}) {
    const queue = [...sites];
    const results = [];
    const startedAt = Date.now();
    let active = 0, idx = 0;

    const lastHitByDomain = new Map();

    const worker = async (workerId) => {
      while (queue.length) {
        if (timeBudgetMs && Date.now() - startedAt > timeBudgetMs) {
          this.logger.warn?.(`[w${workerId}] time budget hit, ${queue.length} sites deferred`);
          while (queue.length) results.push({ site: queue.shift().id, status: 'deferred' });
          return;
        }
        const site = queue.shift();
        if (!site) return;

        // per-domain politeness
        const domain = safeDomain(site.url);
        const since = Date.now() - (lastHitByDomain.get(domain) || 0);
        const wait = (this.config.perDomainDelay || 0) - since;
        if (wait > 0) await sleep(wait);
        lastHitByDomain.set(domain, Date.now());

        active++; idx++;
        this.logger.info?.(`[w${workerId}] (${idx}/${sites.length}) ${site.id}`);
        const agent = new SiteAgent({ site, config: this.config, profileDir: this.profileDir, llm: this.llm, diffEngine: this.diffEngine, visualDir: this.visualDir, logger: this.logger });
        try {
          results.push(await agent.run());
        } catch (e) {
          results.push({ site: site.id, url: site.url, status: 'error', error: e.message });
        }
        active--;
      }
    };

    const workers = Array.from({ length: Math.min(this.concurrency, sites.length) }, (_, i) => worker(i + 1));
    await Promise.all(workers);

    // Tier-2 add: third-party probes — run once per orchestrator pass, decorate failures.
    let probeResult = null;
    if (this.config.probes !== false) {
      try { probeResult = await runProbes(); }
      catch (e) { this.logger.debug?.(`[probes] failed: ${e.message}`); }
      if (probeResult) {
        for (const r of results) {
          const failedFlows = (r.flows || []).filter(f => f.status === 'failed').map(f => f.key);
          const culprits = failedFlows.flatMap(k => correlateFailureToProvider(k, probeResult) || []);
          if (culprits.length) r.third_party_culprits = dedup(culprits);
        }
      }
    }

    // Phase 2: business-impact scoring. Pure-functional; failures here are non-fatal.
    let impactDefaults;
    try { impactDefaults = loadDefaults(); }
    catch (e) { this.logger.warn?.(`[impact] defaults missing, skipping scoring: ${e.message}`); }
    if (impactDefaults) {
      for (const r of results) {
        try { scoreSite(r, impactDefaults); } catch (e) { this.logger.debug?.(`[impact] ${r.site}: ${e.message}`); }
      }
    }

    const summary = summarize(results, Date.now() - startedAt, this.concurrency);
    if (impactDefaults) summary.impact = aggregateImpact(results, impactDefaults);
    if (probeResult)    summary.third_party = probeResult;

    // Phase 4: append per-merchant history line so /health/* endpoints have fresh data.
    // Phase 5: detect cross-merchant patterns from accumulated history.
    if (this.historyDir) {
      try { health.recordRun({ results }, this.historyDir); }
      catch (e) { this.logger.warn?.(`[history] recordRun failed: ${e.message}`); }
      try { summary.patterns = detectPatterns(this.historyDir); }
      catch (e) { this.logger.warn?.(`[patterns] detection failed: ${e.message}`); }
    }

    // Phase-6: alert on critical events. Best-effort; failures never fail the run.
    if (this.alerter) {
      try { summary.alerts = await this.alerter.alertOnRun({ summary, results }, { dashboardUrl: this.dashboardUrl }); }
      catch (e) { this.logger.warn?.(`[alerter] failed: ${e.message}`); }
    }

    return { summary, results };
  }
}

function summarize(results, durationMs, concurrency) {
  const by = (s) => results.filter(r => r.status === s).length;
  return {
    total: results.length,
    passed: by('passed'), degraded: by('degraded'),
    failed: by('failed'), errored: by('error'), deferred: by('deferred'),
    durationMs, concurrency,
    throughputPerMin: +(results.length / (durationMs / 60000) || 0).toFixed(1),
    generatedAt: new Date().toISOString(),
  };
}

function safeDomain(u) { try { return new URL(u).hostname; } catch { return u; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function dedup(arr) { const seen = new Set(); return arr.filter(x => { const k = JSON.stringify(x); if (seen.has(k)) return false; seen.add(k); return true; }); }

module.exports = { Orchestrator };
