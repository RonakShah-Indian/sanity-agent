'use strict';

/**
 * Phase 5 — cross-merchant pattern detection.
 * Pure-functional: seed a temp historyDir, run detection, assert.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { recordRun } = require('../src/health');
const { detectPatterns } = require('../src/patterns');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}\n   ${e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanity-patterns-'));

// --- Helpers: synthesize a fleet of merchants & a "run" payload ---

function fakeResult(id, opts) {
  return {
    site: id,
    url: `https://${id}.example`,
    status: opts.failedFlows?.length ? 'failed' : 'passed',
    finishedAt: new Date().toISOString(),
    business: { archetype: opts.archetype },
    region: opts.region,
    themeVersion: opts.themeVersion || null,
    flows: [
      ...(opts.passedFlows || []).map(k => ({ key: k, status: 'passed' })),
      ...(opts.failedFlows || []).map(k => ({ key: k, status: 'failed', critical: true })),
    ],
    personaFindings: [],
  };
}

// Fleet: 10 fashion merchants (5 on lifestyle-v3.2, 5 on lifestyle-v3.1),
//        5 electronics, 3 quick_commerce.
// Simulated regression: all 5 lifestyle-v3.2 merchants failed add_to_cart.
// Everyone else passed everything.
const fleet = [
  ...Array.from({ length: 5 }, (_, i) => fakeResult(`fash-v32-${i}`, {
    archetype: 'fashion_retail', region: 'IN', themeVersion: 'lifestyle-v3.2',
    passedFlows: ['sign_in', 'search_product', 'checkout'],
    failedFlows: ['add_to_cart'],
  })),
  ...Array.from({ length: 5 }, (_, i) => fakeResult(`fash-v31-${i}`, {
    archetype: 'fashion_retail', region: 'IN', themeVersion: 'lifestyle-v3.1',
    passedFlows: ['sign_in', 'search_product', 'checkout', 'add_to_cart'],
  })),
  ...Array.from({ length: 5 }, (_, i) => fakeResult(`elec-${i}`, {
    archetype: 'electronics', region: 'IN',
    passedFlows: ['sign_in', 'search_product', 'checkout', 'add_to_cart'],
  })),
  ...Array.from({ length: 3 }, (_, i) => fakeResult(`qc-${i}`, {
    archetype: 'quick_commerce', region: 'US',
    passedFlows: ['sign_in', 'search_product', 'checkout', 'add_to_cart'],
  })),
];
recordRun({ results: fleet }, tmp);

const out = detectPatterns(tmp, { windowMs: 60 * 60 * 1000 });

// --- Tests -----------------------------------------------------------------

test('returns metadata: window + merchant count', () => {
  assert.strictEqual(out.merchants_in_window, fleet.length);
  assert.ok(out.window_ms === 3_600_000);
  assert.ok(Array.isArray(out.patterns));
});

test('detects the themeVersion = lifestyle-v3.2 regression', () => {
  const p = out.patterns.find(x => x.dimension === 'themeVersion' && x.value === 'lifestyle-v3.2');
  assert.ok(p, 'expected a themeVersion pattern for lifestyle-v3.2');
  assert.strictEqual(p.flow, 'add_to_cart');
  assert.strictEqual(p.affected_count, 5);
  assert.strictEqual(p.total_in_dimension, 5);
  assert.strictEqual(p.failure_rate, 1.0);
  assert.ok(p.lift >= 2.0, `expected lift >= 2.0, got ${p.lift}`);
  assert.strictEqual(p.severity, 'critical');
});

test('the themeVersion pattern is more specific than the archetype pattern (de-dup)', () => {
  // After de-dup, the archetype=fashion pattern should be DROPPED in favour of themeVersion.
  const archPat = out.patterns.find(x => x.dimension === 'archetype' && x.value === 'fashion_retail');
  assert.strictEqual(archPat, undefined, 'archetype-only pattern should be deduped in favour of themeVersion');
});

test('does NOT flag flows where only a tiny fraction failed', () => {
  // sign_in had 0 failures across the fleet.
  const noisePat = out.patterns.find(x => x.flow === 'sign_in');
  assert.strictEqual(noisePat, undefined);
});

test('headline is human-readable', () => {
  const p = out.patterns[0];
  assert.ok(/\d+\/\d+ merchants/.test(p.headline));
});

test('respects minAffected threshold', () => {
  const strict = detectPatterns(tmp, { minAffected: 10 });
  assert.strictEqual(strict.patterns.length, 0);
});

test('respects minRate threshold', () => {
  // If we demand 100% but the cluster is at 100%, it should still surface.
  const tight = detectPatterns(tmp, { minRate: 1.0 });
  const p = tight.patterns.find(x => x.dimension === 'themeVersion');
  assert.ok(p);
});

test('empty historyDir returns no patterns', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sanity-patterns-empty-'));
  const r = detectPatterns(empty);
  assert.strictEqual(r.merchants_in_window, 0);
  assert.strictEqual(r.patterns.length, 0);
});

console.log(failed === 0 ? '\nPATTERNS TESTS PASSED ✅' : `\n${failed} test(s) failed ❌`);
process.exit(failed ? 1 : 0);
