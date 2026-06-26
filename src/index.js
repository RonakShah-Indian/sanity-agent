#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Orchestrator } = require('./orchestrator');
const { Reporter } = require('./reporter');
const { BugReporter } = require('./bugreporter');
const { createStorage } = require('./storage');

/**
 * Usage:
 *   node src/index.js --sites config/sites.json [--concurrency 4] [--time 600000]
 *
 * Env:
 *   ANTHROPIC_API_KEY  optional; enables LLM vision fallback + rich diagnosis.
 *                      Without it the system runs fully on deterministic heuristics.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(__dirname, '..');
  const sitesPath = path.resolve(args.sites || 'config/sites.json');
  const cfgPath = path.resolve(root, 'config/default.json');

  const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (args.concurrency) config.concurrency = +args.concurrency;
  const sites = JSON.parse(fs.readFileSync(sitesPath, 'utf8'));

  const logger = makeLogger(args.verbose);
  const { LLMClient } = require('./llm');
  const llmBackend = new LLMClient({ logger: { info(){}, debug(){} } }).backend;
  logger.info?.(`Loaded ${sites.length} site(s). LLM backend: ${llmBackend}.`);

  const storage = createStorage({ root, logger });

  const orch = new Orchestrator({
    config:         { ...config, alerts: loadAlertsConfig(root) },
    profileDir:     path.join(root, 'profiles'),
    baselineDir:    path.join(root, 'baselines'),
    historyDir:     path.join(root, 'history'),
    visualDir:      path.join(root, 'visual-baselines'),
    alertStateDir:  path.join(root, 'alerts-state'),
    dashboardUrl:   process.env.SANITY_DASHBOARD_URL || null,
    logger,
  });
  const run = await orch.runAll(sites, { timeBudgetMs: args.time ? +args.time : undefined });

  const outDir = path.join(root, 'reports', `run-${Date.now()}`);
  const files = new Reporter(outDir).write(run);

  // Convert findings into ready-to-file issue payloads (Jira + others), dry-run.
  // ALSO upsert each finding into the persistent defect store (Phase 8) so the
  // dashboard's Defects view has a real queue to display.
  // dryRun honors BUG_DRY_RUN env: set to 'false' to enable live POST (requires per-adapter creds).
  const bugDryRun = (process.env.BUG_DRY_RUN || 'true').toLowerCase() !== 'false';
  const bugs = await new BugReporter({ outDir, adapters: ['jira', 'slack', 'linear', 'webhook'],
    project: 'QA', dryRun: bugDryRun, defectRepo: storage.defects, logger }).build(run);

  logger.info?.('\n=== SUMMARY ===');
  console.log(JSON.stringify(run.summary, null, 2));
  logger.info?.(`\nReports:\n  ${files.html}\n  ${files.json}\n  ${files.xml}`);

  // exit non-zero if any critical failure -> usable as a CI quality gate
  process.exit(run.summary.failed > 0 || run.summary.errored > 0 ? 1 : 0);
}

function loadAlertsConfig(root) {
  const p = path.join(root, 'config/alerts.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1]?.startsWith('--') ? true : argv[++i]; a[k] = v ?? true; }
  }
  return a;
}
function makeLogger(verbose) {
  return {
    info: (...m) => console.log(...m),
    warn: (...m) => console.warn(...m),
    debug: verbose ? (...m) => console.log('[dbg]', ...m) : undefined,
  };
}

main().catch(e => { console.error(e); process.exit(1); });
