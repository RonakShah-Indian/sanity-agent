'use strict';

/**
 * Phase 2 — impact scoring unit tests (pure functions, no I/O).
 */

const assert = require('assert');
const { loadDefaults, scoreSite, aggregateImpact, formatMoney } = require('../src/impact');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}\n   ${e.message}`); }
}

const D = loadDefaults();

// --- Helpers ---------------------------------------------------------------
const flow = (key, status) => ({ key, flow: key, status });
const mkSite = (over = {}) => ({
  site: over.site || 'merchant-x',
  status: over.status || 'failed',
  business: { archetype: over.archetype || 'fashion_retail' },
  flows: over.flows || [flow('add_to_cart', 'failed')],
  region: over.region || 'IN',
  ...over,
});

// --- Tests -----------------------------------------------------------------

test('scores a fashion_retail add_to_cart failure realistically', () => {
  const r = scoreSite(mkSite(), D);
  // 500 v/h * 0.10 attemptRate * 1500 AOV * 0.95 severity ≈ 71,250
  assert.strictEqual(r.business_impact.realised_impact_per_hour, 71250);
  assert.strictEqual(r.business_impact.currency, 'INR');
  assert.strictEqual(r.business_impact.inputs.archetype, 'fashion_retail');
});

test('per-site traffic override beats the archetype median', () => {
  const r = scoreSite(mkSite({ traffic_per_hour: 5000 }), D);
  // 5000 * 0.10 * 1500 * 0.95 = 712,500
  assert.strictEqual(r.business_impact.realised_impact_per_hour, 712500);
  assert.strictEqual(r.business_impact.basis.trafficSource, 'site-override');
});

test('per-site AOV override beats the archetype median', () => {
  const r = scoreSite(mkSite({ aov: 6000 }), D);
  // 500 * 0.10 * 6000 * 0.95 = 285,000
  assert.strictEqual(r.business_impact.realised_impact_per_hour, 285000);
  assert.strictEqual(r.business_impact.basis.aovSource, 'site-override');
});

test('archetype-specific funnel override is applied (quick_commerce add_to_cart)', () => {
  const r = scoreSite(mkSite({ archetype: 'quick_commerce' }), D);
  // 1200 traffic * 0.15 attemptRate * 600 aov * 0.95 severity = 102,600
  assert.strictEqual(r.business_impact.realised_impact_per_hour, 102600);
});

test('degraded flow contributes half impact', () => {
  const r = scoreSite(mkSite({ flows: [flow('add_to_cart', 'degraded')] }), D);
  assert.strictEqual(r.business_impact.realised_impact_per_hour, Math.round(71250 / 2));
});

test('passed flow contributes zero realised but populates at_risk', () => {
  const r = scoreSite(mkSite({ flows: [flow('add_to_cart', 'passed'), flow('checkout', 'failed')] }), D);
  assert.strictEqual(r.business_impact.realised_impact_per_hour > 0, true);
  assert.strictEqual(r.business_impact.at_risk_impact_per_hour > 0, true);
});

test('worst-status rollup across viewports', () => {
  // Same flow key, two viewport rows — desktop passes, mobile fails. Should score as failed.
  const r = scoreSite(mkSite({ flows: [flow('add_to_cart', 'passed'), flow('add_to_cart', 'failed')] }), D);
  assert.strictEqual(r.business_impact.realised_impact_per_hour, 71250);
});

test('aggregateImpact groups by archetype and region', () => {
  const results = [
    scoreSite(mkSite({ site: 'a', archetype: 'fashion_retail', region: 'IN' }), D),
    scoreSite(mkSite({ site: 'b', archetype: 'fashion_retail', region: 'US' }), D),
    scoreSite(mkSite({ site: 'c', archetype: 'quick_commerce', region: 'IN' }), D),
  ];
  const agg = aggregateImpact(results, D);
  assert.ok(agg.total_realised_per_hour > 0);
  assert.ok(Object.keys(agg.by_archetype).includes('fashion_retail'));
  assert.ok(Object.keys(agg.by_archetype).includes('quick_commerce'));
  assert.ok(Object.keys(agg.by_region).includes('IN'));
  assert.ok(Object.keys(agg.by_region).includes('US'));
  assert.strictEqual(agg.top_offenders.length, 3);
});

test('formatMoney scales correctly (₹1.5 Cr, ₹50K, ₹4.20 L, etc.)', () => {
  assert.strictEqual(formatMoney(15000000, 'INR'), '₹1.50 Cr');
  assert.strictEqual(formatMoney(420000, 'INR'), '₹4.20 L');
  assert.strictEqual(formatMoney(50000, 'INR'), '₹50.0K');
  assert.strictEqual(formatMoney(500, 'INR'), '₹500');
  assert.strictEqual(formatMoney(0, 'INR'), '0 INR');
});

console.log(failed === 0 ? '\nIMPACT TESTS PASSED ✅' : `\n${failed} test(s) failed ❌`);
process.exit(failed ? 1 : 0);
