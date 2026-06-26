'use strict';

/**
 * SLO tracker — computes the five SLIs defined in PLAYBOOK §12.1 from the
 * history/ JSONL files that LearningStage already writes. No new persistence.
 *
 * The five SLIs:
 *   1. p95 deploy-to-verdict time      (target: < 5 min)
 *   2. p95 full-fleet sweep time       (target: < 10 min)
 *   3. per-site false-positive rate    (target: < 2%)
 *   4. profile-cache hit rate          (target: > 85%)
 *   5. worker-pool availability        (target: > 99.5%)
 *
 * Some SLIs require richer telemetry than history/ provides today (e.g. SLI
 * #5 needs a separate health-check stream from the worker pool). We compute
 * what's derivable from history; the rest are stubbed with `derivable: false`
 * and the data source they would need.
 */

const { loadHistory, listSites } = require('./health');

/**
 * Build an SLO report from a given historyDir.
 *
 * @param {string} historyDir
 * @param {object} opts
 *   - windowMs     — how far back to look (default 7 days)
 *   - now          — clock injection for tests
 * @returns {object}  SLO report with per-SLI status
 */
function buildSloReport(historyDir, opts = {}) {
  const windowMs = opts.windowMs ?? 7 * 24 * 60 * 60 * 1000;
  const now = opts.now ?? Date.now();
  const cutoff = now - windowMs;

  const sites = listSites(historyDir);
  const allRecords = [];
  for (const id of sites) {
    const hist = loadHistory(id, historyDir, 1000);
    for (const r of hist) {
      const ts = Date.parse(r.ts);
      if (Number.isFinite(ts) && ts >= cutoff) allRecords.push(r);
    }
  }

  return {
    generatedAt: new Date(now).toISOString(),
    window_ms: windowMs,
    sample_size_runs: allRecords.length,
    sample_size_sites: sites.length,
    slis: {
      deploy_to_verdict_p95_ms:  computeP95Duration(allRecords, 'deploy'),
      full_sweep_p95_ms:         computeP95Duration(allRecords, 'full'),
      false_positive_rate:       computeFalsePositiveRate(allRecords),
      profile_cache_hit_rate:    computeCacheHitRate(allRecords),
      worker_pool_availability:  { derivable: false, needs: 'separate worker health-check stream' },
    },
    verdict: null,    // filled below
  };
}

function computeP95Duration(records, kind) {
  // `kind` is 'deploy' (a subset of sites — the changed-only sweep) or 'full'
  // (entire fleet). Today's run records don't tag this — every run is "full"
  // unless explicitly invoked as a deploy sweep. Until that tagging lands,
  // p95 deploy-to-verdict reuses the full-sweep number as a conservative
  // upper bound.
  const durations = records.map(r => r.durationMs).filter(d => Number.isFinite(d) && d > 0);
  if (durations.length === 0) return { derivable: false, reason: 'no runs in window' };
  durations.sort((a, b) => a - b);
  const p95Index = Math.min(durations.length - 1, Math.floor(durations.length * 0.95));
  return {
    p95_ms: durations[p95Index],
    sample_size: durations.length,
    target_ms: kind === 'deploy' ? 5 * 60 * 1000 : 10 * 60 * 1000,
    meets_target: durations[p95Index] <= (kind === 'deploy' ? 5 * 60 * 1000 : 10 * 60 * 1000),
    note: kind === 'deploy' ? 'using full-sweep durations as upper bound until per-deploy tagging lands' : null,
  };
}

function computeFalsePositiveRate(records) {
  // A "false positive" here is a run that flagged a flow failure but the
  // very next run on the same site passed that same flow. Proxy only —
  // real FP rate requires human review. We drop the `critical` filter
  // because recordRun() doesn't preserve that field on historic records;
  // a per-flow lookup against FLOWS would tighten this but adds a coupling.
  const bySite = new Map();
  for (const r of records) {
    if (!bySite.has(r.site)) bySite.set(r.site, []);
    bySite.get(r.site).push(r);
  }
  let suspectedFp = 0;
  let failures = 0;
  for (const list of bySite.values()) {
    list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    for (let i = 0; i < list.length - 1; i++) {
      const cur = list[i], next = list[i + 1];
      const curFailedFlows = new Set((cur.flows || []).filter(f => f.status === 'failed').map(f => f.key));
      if (curFailedFlows.size === 0) continue;
      failures += curFailedFlows.size;
      const nextFailedFlows = new Set((next.flows || []).filter(f => f.status === 'failed').map(f => f.key));
      for (const k of curFailedFlows) {
        if (!nextFailedFlows.has(k)) suspectedFp++;
      }
    }
  }
  if (failures === 0) return { derivable: false, reason: 'no flow failures in window' };
  const rate = suspectedFp / failures;
  return {
    rate: +rate.toFixed(4),
    suspected_fp_count: suspectedFp,
    failure_total: failures,
    target_max: 0.02,
    meets_target: rate <= 0.02,
    note: 'proxy: fail-then-pass on the same flow next run. Real FP rate requires human labels.',
  };
}

function computeCacheHitRate(records) {
  // Cache hit = a resolver step that resolved via Rung 1 (profile cache).
  // Today's run records don't capture per-step strategy granularity at this
  // aggregation; the `_planningMode` is recorded for the journey but not
  // per-resolution. Mark as not-derivable until that telemetry lands.
  return {
    derivable: false,
    needs: 'per-resolution strategy field on step records (currently captured in resolver hits/misses but not aggregated)',
    workaround: 'sum profiles[*].intents[*].hits / (hits + misses) for an estimate; see /dashboard/sites/:id',
  };
}

module.exports = { buildSloReport };
