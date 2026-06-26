'use strict';

/**
 * Phase 4 — health scoring + history persistence + response shape.
 * Pure-function unit tests; the HTTP layer is exercised by the live smoke
 * test (run via the shell, not here).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const {
  computeScore, severityLabel,
  recordRun, loadLatest, loadHistory,
  platformHealth, buildHealthResponse,
  renderBadgeSVG, renderMerchantPage,
} = require('../src/health');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}\n   ${e.message}`); }
}

// --- scoring -----------------------------------------------------------------

test('clean run scores 100', () => {
  assert.strictEqual(computeScore({ status: 'passed', flows: [{ status: 'passed' }] }), 100);
});
test('one critical failed flow → 80', () => {
  assert.strictEqual(computeScore({ flows: [{ status: 'failed', critical: true }] }), 80);
});
test('one non-critical failed flow → 90', () => {
  assert.strictEqual(computeScore({ flows: [{ status: 'failed', critical: false }] }), 90);
});
test('error status floors to 0', () => {
  assert.strictEqual(computeScore({ status: 'error' }), 0);
});
test('persona findings deduct from score', () => {
  const r = { flows: [{ status: 'passed' }], personaFindings: [{ findings: [{ status: 'failed' }, { status: 'failed' }] }] };
  assert.strictEqual(computeScore(r), 92);
});

test('severityLabel buckets correctly', () => {
  assert.strictEqual(severityLabel(95).label, 'healthy');
  assert.strictEqual(severityLabel(80).label, 'degraded');
  assert.strictEqual(severityLabel(50).label, 'unhealthy');
  assert.strictEqual(severityLabel(10).label, 'critical');
});

// --- history persistence -----------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanity-health-'));

test('recordRun writes one JSONL line per merchant result', () => {
  const run = {
    results: [
      { site: 'merchant-a', url: 'https://a.test', status: 'passed', finishedAt: '2026-06-23T19:00:00.000Z',
        flows: [{ key: 'sign_in', status: 'passed', critical: true }],
        business: { archetype: 'fashion_retail' }, business_impact: { realised_impact_per_hour: 0, currency: 'INR' },
        region: 'IN', personaFindings: [] },
      { site: 'merchant-b', url: 'https://b.test', status: 'failed', finishedAt: '2026-06-23T19:00:01.000Z',
        flows: [{ key: 'checkout', status: 'failed', critical: true }],
        business: { archetype: 'electronics' }, business_impact: { realised_impact_per_hour: 5000, currency: 'INR' },
        region: 'IN', personaFindings: [] },
    ],
  };
  recordRun(run, tmp);
  const a = loadLatest('merchant-a', tmp);
  const b = loadLatest('merchant-b', tmp);
  assert.strictEqual(a.score, 100);
  assert.strictEqual(b.score, 80);
  assert.strictEqual(b.business_impact_per_hour, 5000);
});

test('subsequent runs append to history (not overwrite)', () => {
  const run2 = { results: [{ site: 'merchant-a', status: 'degraded', finishedAt: '2026-06-23T19:05:00.000Z',
    flows: [{ key: 'sign_in', status: 'degraded' }], business: { archetype: 'fashion_retail' } }] };
  recordRun(run2, tmp);
  const hist = loadHistory('merchant-a', tmp);
  assert.strictEqual(hist.length, 2);
  assert.strictEqual(hist[1].status, 'degraded');
});

// --- response shape ---------------------------------------------------------

test('buildHealthResponse returns the public-API shape', () => {
  const resp = buildHealthResponse('merchant-a', tmp);
  assert.ok(resp);
  assert.strictEqual(resp.merchant_id, 'merchant-a');
  assert.ok(['healthy','degraded','unhealthy','critical'].includes(resp.severity));
  assert.ok(Array.isArray(resp.flows));
  assert.ok(resp.trend);
  assert.ok(Array.isArray(resp.trend.score_history));
});

test('unknown merchant returns null', () => {
  assert.strictEqual(buildHealthResponse('does-not-exist', tmp), null);
});

test('platformHealth aggregates buckets, scores, impact', () => {
  const agg = platformHealth(tmp);
  assert.strictEqual(agg.total, 2);
  assert.ok(agg.score_avg > 0 && agg.score_avg <= 100);
  assert.strictEqual(agg.realised_impact_per_hour, 5000);
});

// --- renderers ---------------------------------------------------------------

test('badge SVG includes the score and is valid XML-ish', () => {
  const data = buildHealthResponse('merchant-a', tmp);
  const svg = renderBadgeSVG(data);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes(`${data.score}/100`));
  assert.ok(svg.endsWith('</svg>'));
});

test('merchant page HTML mentions the merchant and the badge URL', () => {
  const data = buildHealthResponse('merchant-a', tmp);
  const html = renderMerchantPage(data, 'http://example');
  assert.ok(html.includes('merchant-a'));
  assert.ok(html.includes('badge.svg'));
  assert.ok(html.includes(String(data.score)));
});

console.log(failed === 0 ? '\nHEALTH TESTS PASSED ✅' : `\n${failed} test(s) failed ❌`);
process.exit(failed ? 1 : 0);
