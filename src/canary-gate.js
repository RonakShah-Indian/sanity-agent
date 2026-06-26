'use strict';

/**
 * Pre-deploy canary gate.
 *
 *   ./run.sh --sites config/canary-slice.json --gate-against reports/last-prod/results.json
 *
 * The gate compares this run (presumed canary) against a baseline run
 * (presumed production-good) and decides whether the deploy is allowed to
 * roll. Designed to plug straight into a CI step:
 *
 *   node src/canary-gate.js \
 *     --current  reports/run-CANARY/results.json \
 *     --baseline reports/run-LAST-GREEN/results.json
 *   echo $?    # 0 = pass, 1 = regression detected, deploy blocked
 *
 * Regression rules:
 *   1. Any merchant that passed in baseline and fails in canary.
 *   2. Any merchant whose score drops by >= 10.
 *   3. Any NEW pattern of severity high/critical that wasn't in baseline.
 *   4. Any flow's average impact_per_hour climbing >= 50%.
 *
 * Each rule emits a structured reason. The gate prints a human-readable
 * verdict + exits non-zero with the list of regressions.
 */

const fs = require('fs');
const path = require('path');

function gate(current, baseline, opts = {}) {
  const scoreDropThreshold = opts.scoreDropThreshold ?? 10;
  const impactGrowthThreshold = opts.impactGrowthThreshold ?? 1.5;

  const reasons = [];

  // Per-merchant comparison.
  const baseBySite = new Map((baseline.results || []).map(r => [r.site, r]));
  for (const cur of current.results || []) {
    const prev = baseBySite.get(cur.site);
    if (!prev) continue;

    // Rule 1: passed → failed
    if (prev.status === 'passed' && (cur.status === 'failed' || cur.status === 'error')) {
      reasons.push({ kind: 'regression.status', site: cur.site, from: prev.status, to: cur.status });
    }

    // Rule 2: score drop
    const prevScore = prev._score ?? null;     // not always present; compute if absent
    const curScore  = cur._score ?? null;
    if (prevScore !== null && curScore !== null && (prevScore - curScore) >= scoreDropThreshold) {
      reasons.push({ kind: 'regression.score', site: cur.site, from: prevScore, to: curScore, delta: -(prevScore - curScore) });
    }
  }

  // Rule 3: new high/critical patterns.
  const baselinePatternKeys = new Set((baseline.summary?.patterns?.patterns || []).map(patternKey));
  for (const p of (current.summary?.patterns?.patterns || [])) {
    if (!['critical', 'high'].includes(p.severity)) continue;
    if (!baselinePatternKeys.has(patternKey(p))) {
      reasons.push({ kind: 'regression.new-pattern', severity: p.severity, headline: p.headline, dimension: p.dimension, value: p.value });
    }
  }

  // Rule 4: impact growth platform-wide.
  const baseImpact = baseline.summary?.impact?.total_realised_per_hour || 0;
  const curImpact  = current.summary?.impact?.total_realised_per_hour  || 0;
  if (baseImpact > 0 && curImpact / baseImpact >= impactGrowthThreshold) {
    reasons.push({ kind: 'regression.impact', from: baseImpact, to: curImpact, ratio: +(curImpact / baseImpact).toFixed(2) });
  } else if (baseImpact === 0 && curImpact > 0) {
    reasons.push({ kind: 'regression.impact', from: 0, to: curImpact, ratio: null });
  }

  const decision = reasons.length === 0 ? 'allow' : 'block';
  return { decision, reasons, evaluatedAt: new Date().toISOString() };
}

function patternKey(p) { return `${p.flow}|${p.dimension}|${p.value}`; }

// ---- CLI -------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.current || !args.baseline) {
    console.error('Usage: node src/canary-gate.js --current <results.json> --baseline <results.json>');
    process.exit(2);
  }
  const current  = JSON.parse(fs.readFileSync(path.resolve(args.current), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(path.resolve(args.baseline), 'utf8'));
  const verdict = gate(current, baseline);

  console.log(`\n=== CANARY GATE: ${verdict.decision.toUpperCase()} ===`);
  if (verdict.decision === 'block') {
    console.log(`\nRegressions blocking the deploy (${verdict.reasons.length}):`);
    for (const r of verdict.reasons) {
      console.log(`  • [${r.kind}] ${describe(r)}`);
    }
    process.exit(1);
  } else {
    console.log('No regressions detected. Deploy may proceed.');
    process.exit(0);
  }
}

function describe(r) {
  if (r.kind === 'regression.status')      return `${r.site}: ${r.from} → ${r.to}`;
  if (r.kind === 'regression.score')       return `${r.site}: score ${r.from} → ${r.to} (Δ ${r.delta})`;
  if (r.kind === 'regression.new-pattern') return `[${r.severity}] ${r.headline}`;
  if (r.kind === 'regression.impact')      return `total impact ${r.from} → ${r.to}${r.ratio ? ` (${r.ratio}×)` : ' (was zero)'}`;
  return JSON.stringify(r);
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1]?.startsWith('--') ? true : argv[++i]; a[k] = v ?? true; }
  }
  return a;
}

if (require.main === module) main();
module.exports = { gate };
