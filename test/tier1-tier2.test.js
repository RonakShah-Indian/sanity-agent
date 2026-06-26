'use strict';

/**
 * Unit tests for Tier-1/Tier-2 modules: telemetry evaluation, visual diff
 * (with synthetic fingerprints), third-party probes (mocked), remote-browser
 * capability building, and the canary gate decision.
 *
 * No network, no real browser — pure functions only.
 */

const assert = require('assert');
const { evaluateTelemetry } = require('../src/telemetry');
const { compareFingerprints } = require('../src/visual');
const { correlateFailureToProvider } = require('../src/probes');
const { buildBrowserStackCaps } = require('../src/remote-browser');
const { gate } = require('../src/canary-gate');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}\n   ${e.message}`); }
}

// --- telemetry ---------------------------------------------------------------
test('evaluateTelemetry → ok when clean', () => {
  const r = evaluateTelemetry({ counts: { consoleErrors: 0, pageErrors: 0, badResponses: 0 }, vitals: null });
  assert.strictEqual(r.severity, 'ok');
});
test('evaluateTelemetry → high when page errors exist', () => {
  const r = evaluateTelemetry({ counts: { consoleErrors: 0, pageErrors: 2, badResponses: 0 } });
  assert.strictEqual(r.severity, 'high');
  assert.ok(r.findings.some(f => f.kind === 'pageerror'));
});
test('evaluateTelemetry → medium for LCP regression', () => {
  const r = evaluateTelemetry({ counts: {}, vitals: { lcp: 5000, cls: 0, inp: 50 } }, { lcpMs: 2500 });
  assert.strictEqual(r.severity, 'medium');
  assert.ok(r.findings.some(f => f.kind === 'vitals.lcp'));
});

// --- visual ------------------------------------------------------------------
test('compareFingerprints → identical buffers return 0% diff', () => {
  const a = Buffer.alloc(100, 128);
  assert.strictEqual(compareFingerprints(a, Buffer.from(a)).diffPercent, 0);
});
test('compareFingerprints → fully different buffers return ~100% diff', () => {
  const a = Buffer.alloc(100, 0);
  const b = Buffer.alloc(100, 255);
  assert.ok(compareFingerprints(a, b).diffPercent >= 0.99);
});
test('compareFingerprints → length mismatch flagged as incomparable', () => {
  const r = compareFingerprints(Buffer.alloc(10), Buffer.alloc(20));
  assert.strictEqual(r.comparable, false);
});

// --- probes correlation -----------------------------------------------------
test('correlateFailureToProvider → returns Razorpay when checkout failed AND Razorpay degraded', () => {
  const probe = { any_degraded: true, providers: {
    razorpay: { label: 'Razorpay', status: 'major', description: 'Payment delays' },
    stripe:   { label: 'Stripe',   status: 'operational' },
  }};
  const out = correlateFailureToProvider('checkout', probe);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].provider, 'razorpay');
});
test('correlateFailureToProvider → no match when only unrelated provider is degraded', () => {
  const probe = { any_degraded: true, providers: { algolia: { status: 'major' } } };
  const out = correlateFailureToProvider('checkout', probe);
  assert.deepStrictEqual(out, []);
});

// --- BrowserStack caps -------------------------------------------------------
test('buildBrowserStackCaps → real mobile device', () => {
  const caps = buildBrowserStackCaps({ name: 'iphone-test', device: 'iPhone 14', os_version: '16' });
  assert.strictEqual(caps.device, 'iPhone 14');
  assert.strictEqual(caps.realMobile, 'true');
  assert.strictEqual(caps.os_version, '16');
});
test('buildBrowserStackCaps → desktop browser matrix', () => {
  const caps = buildBrowserStackCaps({ name: 'safari-mac', browser: 'Safari', browser_version: '17', os: 'OS X', os_version: 'Sonoma' });
  assert.strictEqual(caps.browser, 'Safari');
  assert.strictEqual(caps.os, 'OS X');
  assert.strictEqual(caps.os_version, 'Sonoma');
});
test('buildBrowserStackCaps → reads BROWSERSTACK_* from env (placeholders pass through)', () => {
  process.env.BROWSERSTACK_USERNAME = 'test-user';
  const caps = buildBrowserStackCaps({ name: 'x', browser: 'Chrome' });
  assert.strictEqual(caps['browserstack.username'], 'test-user');
  delete process.env.BROWSERSTACK_USERNAME;
});

// --- canary gate -------------------------------------------------------------
test('gate → allow when nothing changed', () => {
  const same = { results: [{ site: 'a', status: 'passed' }], summary: { patterns: { patterns: [] } } };
  const v = gate(same, same);
  assert.strictEqual(v.decision, 'allow');
});
test('gate → block on passed→failed regression', () => {
  const base    = { results: [{ site: 'a', status: 'passed' }], summary: { patterns: { patterns: [] } } };
  const current = { results: [{ site: 'a', status: 'failed' }], summary: { patterns: { patterns: [] } } };
  const v = gate(current, base);
  assert.strictEqual(v.decision, 'block');
  assert.ok(v.reasons.some(r => r.kind === 'regression.status'));
});
test('gate → block on NEW critical pattern in canary', () => {
  const base    = { results: [], summary: { patterns: { patterns: [] } } };
  const current = { results: [], summary: { patterns: { patterns: [
    { flow: 'add_to_cart', dimension: 'themeVersion', value: 'v3.2', severity: 'critical', headline: '5/5 ...' }
  ] } } };
  const v = gate(current, base);
  assert.strictEqual(v.decision, 'block');
  assert.ok(v.reasons.some(r => r.kind === 'regression.new-pattern'));
});
test('gate → block on platform-wide impact growth ≥ 1.5×', () => {
  const base    = { results: [], summary: { impact: { total_realised_per_hour: 10000 }, patterns: { patterns: [] } } };
  const current = { results: [], summary: { impact: { total_realised_per_hour: 30000 }, patterns: { patterns: [] } } };
  const v = gate(current, base);
  assert.strictEqual(v.decision, 'block');
  assert.ok(v.reasons.some(r => r.kind === 'regression.impact'));
});

console.log(failed === 0 ? '\nTIER-1/TIER-2 TESTS PASSED ✅' : `\n${failed} test(s) failed ❌`);
process.exit(failed ? 1 : 0);
