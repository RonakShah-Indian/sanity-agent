'use strict';

/**
 * Alerter — event extraction, dedup, Slack payload shape.
 * Stubs `global.fetch` so no real network ever fires from this test.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { Alerter } = require('../src/alerter');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}\n   ${e.message}`); }
}
async function atest(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}\n   ${e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanity-alerter-'));

const samplePattern = {
  flow: 'add_to_cart',
  dimension: 'themeVersion',
  value: 'lifestyle-v3.2',
  severity: 'critical',
  failure_rate: 1.0,
  platform_baseline_rate: 0.278,
  lift: 3.6,
  affected_sites: ['a','b','c','d','e'],
  headline: '5/5 merchants on theme "lifestyle-v3.2" failed add_to_cart (100%)',
};

function mkRun(opts = {}) {
  return {
    summary: {
      patterns: { patterns: opts.patterns || [samplePattern] },
      impact:   { total_realised_per_hour: opts.impact || 0, currency: 'INR', by_archetype: { fashion_retail: opts.impact || 0 } },
    },
    results: [],
  };
}

// --- Event extraction --------------------------------------------------------

test('extracts critical pattern events', () => {
  const a = new Alerter({ stateDir: fs.mkdtempSync(path.join(tmp, 'd-')), logger: { warn(){}, debug(){}, info(){} } });
  const events = a._extractEvents(mkRun());
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].kind, 'pattern');
  assert.strictEqual(events[0].severity, 'critical');
});

test('skips patterns below minSeverity', () => {
  const a = new Alerter({ config: { minSeverity: 'critical' }, stateDir: fs.mkdtempSync(path.join(tmp, 'd-')), logger: { warn(){}, debug(){} } });
  const medium = { ...samplePattern, severity: 'medium' };
  const events = a._extractEvents(mkRun({ patterns: [medium] }));
  assert.strictEqual(events.length, 0);
});

test('extracts platform-impact event when threshold crossed', () => {
  const a = new Alerter({ config: { impactAlertThreshold: 1000 }, stateDir: fs.mkdtempSync(path.join(tmp, 'd-')), logger: { warn(){}, debug(){} } });
  const events = a._extractEvents(mkRun({ patterns: [], impact: 50000 }));
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].kind, 'impact');
});

// --- Dedup ------------------------------------------------------------------

test('suppresses re-pages within cooldown window', () => {
  const d = fs.mkdtempSync(path.join(tmp, 'd-'));
  const a = new Alerter({ config: { cooldownMs: 60_000 }, stateDir: d, logger: { warn(){}, debug(){}, info(){} } });
  const ev = { kind: 'pattern', key: 'pattern|x|y|z', severity: 'critical', payload: samplePattern };
  a._markAlerted(ev);
  assert.strictEqual(a._recentlyAlerted(ev), true);
});

test('does not suppress after cooldown elapses', () => {
  const d = fs.mkdtempSync(path.join(tmp, 'd-'));
  const a = new Alerter({ config: { cooldownMs: 1 }, stateDir: d, logger: { warn(){}, debug(){}, info(){} } });
  const ev = { kind: 'pattern', key: 'pattern|x|y|z', severity: 'critical', payload: samplePattern };
  a._markAlerted(ev);
  // Backdate the marker file to force expiry.
  const p = path.join(d, 'pattern_x_y_z.json');
  fs.writeFileSync(p, JSON.stringify({ key: ev.key, lastAlerted: new Date(Date.now() - 100_000).toISOString() }));
  assert.strictEqual(a._recentlyAlerted(ev), false);
});

// --- Slack payload shape ----------------------------------------------------

test('Slack payload includes headline, lift, affected count', () => {
  const a = new Alerter({ stateDir: fs.mkdtempSync(path.join(tmp, 'd-')), logger: { warn(){}, debug(){} } });
  const ev = { kind: 'pattern', key: 'k', severity: 'critical', payload: samplePattern };
  const body = a._buildSlackPayload(ev, { dashboardUrl: 'http://host' });
  assert.ok(body.text.includes(samplePattern.headline));
  const blob = JSON.stringify(body);
  assert.ok(blob.includes('3.6')); // lift
  assert.ok(blob.includes('a, b, c, d, e')); // first 5 affected
  assert.ok(blob.includes('http://host/dashboard.html'));
});

// --- End-to-end: alertOnRun with stubbed fetch ------------------------------

atest('alertOnRun POSTs to Slack and marks dedup state', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };

  const d = fs.mkdtempSync(path.join(tmp, 'd-'));
  process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
  const a = new Alerter({
    config: { slack: { webhookUrlEnv: 'SLACK_WEBHOOK_URL' } },
    stateDir: d,
    logger: { warn(){}, debug(){}, info(){} },
  });

  const out = await a.alertOnRun(mkRun(), { dashboardUrl: 'http://x' });
  assert.strictEqual(out.sent, 1);
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.startsWith('https://hooks.slack.com/'));

  // Second call with the same event → suppressed by dedup, no POST.
  const out2 = await a.alertOnRun(mkRun(), { dashboardUrl: 'http://x' });
  assert.strictEqual(out2.sent, 0);
  assert.strictEqual(out2.suppressed, 1);
  assert.strictEqual(calls.length, 1);

  delete process.env.SLACK_WEBHOOK_URL;
  global.fetch = originalFetch;
});

atest('alertOnRun is a no-op when no channels configured', async () => {
  const a = new Alerter({ stateDir: fs.mkdtempSync(path.join(tmp, 'd-')), logger: { warn(){}, debug(){}, info(){} } });
  const out = await a.alertOnRun(mkRun());
  assert.strictEqual(out.sent, 0);
});

(async () => {
  await new Promise(r => setImmediate(r));
  console.log(failed === 0 ? '\nALERTER TESTS PASSED ✅' : `\n${failed} test(s) failed ❌`);
  process.exit(failed ? 1 : 0);
})();
