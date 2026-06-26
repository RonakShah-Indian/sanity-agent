#!/usr/bin/env node
'use strict';

/**
 * Long-running entry point.
 *
 * Boots the deploy-trigger HTTP webhook (POST :PORT/deploy) AND the
 * version-poll fallback against config/sites.json. Every triggered run is
 * funneled back through the same Orchestrator + Reporter + BugReporter the
 * one-shot CLI uses, so behavior is identical.
 *
 * Usage:
 *   node src/serve.js                                 # defaults: port 8787, poll 60s
 *   node src/serve.js --port 9000 --interval 30000
 *   PORT=9000 POLL_INTERVAL_MS=30000 node src/serve.js
 *
 * Env (optional):
 *   DEPLOY_SECRET       HMAC secret for webhook signature verification
 *   ANTHROPIC_API_KEY   enables LLM rungs (same as one-shot mode)
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { Orchestrator } = require('./orchestrator');
const { Reporter } = require('./reporter');
const { BugReporter } = require('./bugreporter');
const { DeployTrigger } = require('./trigger');
const { discover } = require('./discovery');
const { reconcile } = require('./reconciler');
const health = require('./health');
const { handleDashboardRoute } = require('./dashboard');
const { createStorage } = require('./storage');

const root = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1]?.startsWith('--') ? true : argv[++i]; a[k] = v ?? true; }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = +(args.port || process.env.PORT || 8787);
  const pollMs = +(args.interval || process.env.POLL_INTERVAL_MS || 60_000);
  const discoveryConfigPath = args.discovery || process.env.DISCOVERY_CONFIG || null;
  const sitesPath = path.resolve(args.sites || 'config/sites-active.json');

  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/default.json'), 'utf8'));
  const logger = { info: console.log, warn: console.warn, debug: process.env.DEBUG ? console.log : undefined };

  // If a discovery config exists, prime sites-active.json before booting.
  let sites = [];
  let discoveryCfg = null;
  if (discoveryConfigPath) {
    discoveryCfg = JSON.parse(fs.readFileSync(path.resolve(discoveryConfigPath), 'utf8'));
    logger.info(`[serve] discovery config: ${discoveryConfigPath}`);
  }
  // Fall back to the requested static path if no active list exists yet.
  if (!fs.existsSync(sitesPath) && !discoveryCfg) {
    sites = JSON.parse(fs.readFileSync(path.resolve(args.sites || 'config/sites.json'), 'utf8'));
  } else if (fs.existsSync(sitesPath)) {
    sites = JSON.parse(fs.readFileSync(sitesPath, 'utf8'));
  }

  logger.info(`[serve] starting. sites=${sites.length} llm=${process.env.ANTHROPIC_API_KEY ? 'on' : 'off (heuristic)'} port=${port} pollMs=${pollMs}`);

  let alertsConfig = {};
  try { alertsConfig = JSON.parse(fs.readFileSync(path.join(root, 'config/alerts.json'), 'utf8')); } catch { /* no alerts config = no-op */ }

  const orch = new Orchestrator({
    config:         { ...config, alerts: alertsConfig },
    profileDir:     path.join(root, 'profiles'),
    baselineDir:    path.join(root, 'baselines'),
    historyDir:     path.join(root, 'history'),
    visualDir:      path.join(root, 'visual-baselines'),
    alertStateDir:  path.join(root, 'alerts-state'),
    dashboardUrl:   process.env.SANITY_DASHBOARD_URL || `http://localhost:${port}`,
    logger,
  });

  const historyDir = path.join(root, 'history');
  const storage = createStorage({ root, logger });

  // Single execution path shared by webhook + poll + discovery triggers.
  const onTrigger = async (sitesOverride, meta) => {
    const targets = sitesOverride || sites;
    const planned = DeployTrigger.planTiers(targets, meta.changedSites);
    const startedAt = Date.now();
    logger.info(`[serve] run via ${meta.trigger}: full=${planned.filter(s => s.tier === 'full').length} smoke=${planned.filter(s => s.tier === 'smoke').length}`);

    const run = await orch.runAll(planned, { timeBudgetMs: meta.deadlineMs });
    const outDir = path.join(root, 'reports', `run-${startedAt}`);
    const files = new Reporter(outDir).write(run);
    const bugDryRun = (process.env.BUG_DRY_RUN || 'true').toLowerCase() !== 'false';
    await new BugReporter({ outDir, adapters: ['jira', 'slack', 'linear', 'webhook'],
      project: 'QA', dryRun: bugDryRun, defectRepo: storage.defects, logger }).build(run);
    // history append + pattern detection now happen inside Orchestrator.runAll().

    logger.info(`[serve] run done in ${Date.now() - startedAt}ms — ${JSON.stringify(run.summary)}`);
    logger.info(`[serve] reports: ${files.html}`);
    return run;
  };

  const trigger = new DeployTrigger({ onTrigger, logger });

  // Unified router: trigger handles POST /deploy; health.* handles GET /health/*.
  const server = http.createServer((req, res) => {
    if (trigger.handleHttp(req, res)) return;
    if (handleDashboardRoute(req, res, { historyDir, defectRepo: storage.defects })) return;
    if (handleHealthRoute(req, res, { historyDir, logger })) return;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  server.listen(port, () => {
    logger.info(`[serve] HTTP listening on :${port}`);
    logger.info(`         POST /deploy                    (deploy webhook)`);
    logger.info(`         GET  /health                    (platform aggregate)`);
    logger.info(`         GET  /health/:id                (merchant JSON)`);
    logger.info(`         GET  /health/:id/badge.svg      (embeddable badge)`);
    logger.info(`         GET  /health/:id/page.html      (merchant status page)`);
    logger.info(`         GET  /patterns                  (cross-merchant pattern detection)`);
    logger.info(`         GET  /dashboard                 (multi-page operator dashboard)`);
  });

  trigger.startPolling(sites, pollMs);

  // ---- Phase 1: continuous discovery + auto-baseline new merchants ----
  let discoveryTimer = null;
  if (discoveryCfg) {
    const discoveryInterval = +(discoveryCfg.__behavior__?.intervalMs || 5 * 60 * 1000);
    const activePath = path.join(root, 'config/sites-active.json');
    const archiveDir = path.join(root, 'profiles/_archive');
    const profileDir = path.join(root, 'profiles');

    const runDiscovery = async () => {
      try {
        const found = await discover(discoveryCfg, { logger });
        const diff = reconcile(sites, found, { activeListPath: activePath, archiveDir, profileDir });
        sites = found;   // hot-swap the active list
        logger.info(`[serve] discovery: +${diff.added.length} ~${diff.changed.length} -${diff.removed.length} =${diff.unchanged.length} (total ${diff.total})`);

        // New merchants → immediate baseline. Changed merchants → re-baseline.
        const toBaseline = [...diff.added, ...diff.changed.map(c => c.to)];
        if (toBaseline.length) {
          logger.info(`[serve] auto-baseline ${toBaseline.length} merchant(s)...`);
          await onTrigger(toBaseline, { trigger: 'discovery', changedSites: toBaseline.map(s => s.id), deadlineMs: 5 * 60 * 1000 });
        }
      } catch (e) {
        logger.warn?.(`[serve] discovery failed: ${e.message}`);
      }
    };

    // Prime once on boot, then on interval.
    runDiscovery();
    discoveryTimer = setInterval(runDiscovery, discoveryInterval);
    logger.info(`[serve] discovery loop every ${discoveryInterval / 1000}s`);
  }

  const shutdown = (sig) => {
    logger.info(`[serve] ${sig} received, shutting down...`);
    trigger.stop();
    if (discoveryTimer) clearInterval(discoveryTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ---- Phase 4: /health/* routes -------------------------------------------
// Read-only, no auth (tenant-facing). Returns JSON / SVG / HTML based on path.
function handleHealthRoute(req, res, { historyDir, logger }) {
  // Phase 5: /patterns — cross-merchant pattern detection (separate route).
  if (req.method === 'GET' && req.url.startsWith('/patterns')) {
    try {
      const { detectPatterns } = require('./patterns');
      const u = new URL(req.url, 'http://x');
      const windowMs = +(u.searchParams.get('windowMs')) || undefined;
      const out = detectPatterns(historyDir, { windowMs });
      return send(res, 200, 'application/json', JSON.stringify(out, null, 2));
    } catch (e) {
      logger?.warn?.(`[patterns] route error: ${e.message}`);
      return send(res, 500, 'text/plain', 'internal error');
    }
  }
  if (req.method !== 'GET' || !req.url.startsWith('/health')) return false;
  try {
    const u = new URL(req.url, 'http://x');
    const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');   // ["health", ":id"?, ":sub"?]

    // /health  → platform aggregate
    if (parts.length === 1 && parts[0] === 'health') {
      const agg = health.platformHealth(historyDir);
      return send(res, 200, 'application/json', JSON.stringify(agg, null, 2));
    }

    const id = decodeURIComponent(parts[1] || '');
    const sub = parts[2] || '';
    if (!id) return send(res, 400, 'text/plain', 'missing merchant id');

    const data = health.buildHealthResponse(id, historyDir);
    if (!data) return send(res, 404, 'application/json', JSON.stringify({ error: 'merchant unknown — no history yet', merchant_id: id }));

    // /health/:id              → JSON
    if (!sub) return send(res, 200, 'application/json', JSON.stringify(data, null, 2));

    // /health/:id/badge.svg    → SVG (short cache for the badge)
    if (sub === 'badge.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=60' });
      return res.end(health.renderBadgeSVG(data));
    }

    // /health/:id/page.html    → merchant status page
    if (sub === 'page.html') {
      const host = `http://${req.headers.host || 'localhost'}`;
      return send(res, 200, 'text/html', health.renderMerchantPage(data, host));
    }

    return send(res, 404, 'text/plain', 'not found');
  } catch (e) {
    logger?.warn?.(`[health] route error: ${e.message}`);
    return send(res, 500, 'text/plain', 'internal error');
  }
}

function send(res, code, type, body) {
  res.writeHead(code, { 'content-type': type });
  res.end(body);
  return true;
}

main().catch(e => { console.error(e); process.exit(1); });
