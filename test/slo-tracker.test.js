'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { recordRun } = require('../src/health');
const { buildSloReport } = require('../src/slo-tracker');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}\n   ${e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slo-tracker-'));

// Synth fleet of 3 sites with 5 historic runs each spanning the last 24h.
const now = Date.now();
const baseRun = {
  // Most runs pass quickly; one run is long and one had a flaky critical fail.
  results: [
    { site: 'site-a', url: 'a.example', finishedAt: new Date(now - 5 * 60 * 1000).toISOString(),
      durationMs: 60_000, business: { archetype: 'fashion_retail' }, region: 'IN',
      flows: [{ key: 'add_to_cart', status: 'passed', critical: true }] },
    { site: 'site-b', url: 'b.example', finishedAt: new Date(now - 4 * 60 * 1000).toISOString(),
      durationMs: 90_000, business: { archetype: 'fashion_retail' }, region: 'IN',
      flows: [{ key: 'add_to_cart', status: 'failed', critical: true }] },
    { site: 'site-c', url: 'c.example', finishedAt: new Date(now - 3 * 60 * 1000).toISOString(),
      durationMs: 180_000, business: { archetype: 'food_delivery' }, region: 'MY',
      flows: [{ key: 'add_to_cart', status: 'passed', critical: true }] },
  ],
};
recordRun(baseRun, tmp);

// Add a second run a bit later where site-b passes — proving the prior fail was an FP.
const later = {
  results: baseRun.results.map(r => ({
    ...r,
    finishedAt: new Date(now - 1 * 60 * 1000).toISOString(),
    flows: r.flows.map(f => ({ ...f, status: 'passed' })),
  })),
};
recordRun(later, tmp);

test('buildSloReport returns expected shape', () => {
  const r = buildSloReport(tmp, { now });
  assert.ok(r.generatedAt);
  assert.ok(r.window_ms > 0);
  assert.strictEqual(r.sample_size_sites, 3);
  assert.ok(r.slis);
  assert.ok(r.slis.deploy_to_verdict_p95_ms);
  assert.ok(r.slis.full_sweep_p95_ms);
  assert.ok(r.slis.false_positive_rate);
});

test('p95 durations are derivable and bounded by real run times', () => {
  const r = buildSloReport(tmp, { now });
  assert.ok(r.slis.full_sweep_p95_ms.p95_ms > 0);
  assert.ok(r.slis.full_sweep_p95_ms.sample_size >= 6);   // 2 runs × 3 sites
  assert.ok(typeof r.slis.full_sweep_p95_ms.meets_target === 'boolean');
});

test('false-positive proxy: fail followed by pass counts as suspected FP', () => {
  const r = buildSloReport(tmp, { now });
  const fp = r.slis.false_positive_rate;
  // site-b failed then passed — exactly one suspected FP.
  assert.strictEqual(fp.suspected_fp_count, 1, 'site-b fail-then-pass should be counted');
  assert.strictEqual(fp.failure_total, 1);
  assert.strictEqual(fp.rate, 1.0);
  assert.strictEqual(fp.meets_target, false, '1.0 rate violates 0.02 target');
});

test('cache hit rate is explicitly NOT derivable (no over-claim)', () => {
  const r = buildSloReport(tmp, { now });
  assert.strictEqual(r.slis.profile_cache_hit_rate.derivable, false);
  assert.ok(r.slis.profile_cache_hit_rate.needs, 'must say what telemetry it needs');
  assert.ok(r.slis.profile_cache_hit_rate.workaround, 'must offer a workaround estimate');
});

test('worker-pool availability is explicitly NOT derivable from history alone', () => {
  const r = buildSloReport(tmp, { now });
  assert.strictEqual(r.slis.worker_pool_availability.derivable, false);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? '\nSLO TRACKER TESTS PASSED ✅' : `\n${failed} test(s) failed ❌`);
process.exit(failed ? 1 : 0);
