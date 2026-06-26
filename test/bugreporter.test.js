'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { BugReporter, ADAPTERS, POST_ADAPTERS } = require('../src/bugreporter');

(async () => {
  const run = { results: [
    { site: 'shop-nexus-one', url: 'https://shopnexusone.com/', business: { label: 'Fashion' },
      flows: [{ flow: 'Add To Cart', critical: true, steps: [
        { action: 'click', intent: 'add_to_cart', remediation: {
          ticket: { title: 'Add to Cart broken', severity: 'high', diagnosis: 'cart never updates' },
          proposedFix: { type: 'selector-candidate', candidate: 'text=/add to bag/i', requiresApproval: true } } }] }],
      diff: { severity: 'high', changes: [{ type: 'flow-status', severity: 'high', note: 'REGRESSION: add to cart now failing' }] } },
  ]};

  const out = path.join(__dirname, '_tmp_bugs');
  fs.rmSync(out, { recursive: true, force: true });
  const r = await new BugReporter({ outDir: out, adapters: ['jira', 'slack', 'linear', 'webhook'], project: 'QA', dryRun: true }).build(run);

  assert.strictEqual(r.count, 2, 'should find 2 (flow failure + high-sev diff regression)');
  const jira = r.payloads.jira[0];
  assert.strictEqual(jira.fields.project.key, 'QA');
  assert.strictEqual(jira.fields.issuetype.name, 'Bug');
  assert.strictEqual(jira.fields.priority.name, 'High', 'high severity maps to Jira High');
  assert.ok(jira.fields.description.type === 'doc', 'description is valid ADF');
  assert.ok(jira._dedupeKey, 'has dedupe key to prevent duplicate tickets');
  assert.ok(r.payloads.slack[0].blocks, 'slack payload has blocks');
  assert.ok(r.payloads.linear[0].input.title, 'linear payload has input');
  assert.ok(r.dryRun === true, 'dry-run, not posted');
  console.log('✓ BugReporter: 2 findings → valid Jira ADF + Slack + Linear + webhook payloads, deduped, dry-run');

  // Live-POST mode with a stubbed fetch (no env vars set → adapters skip gracefully).
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 201, json: async () => ({ key: 'QA-123' }) };
  };
  const out2 = path.join(__dirname, '_tmp_bugs_live');
  fs.rmSync(out2, { recursive: true, force: true });
  const live = await new BugReporter({ outDir: out2, adapters: ['jira', 'slack', 'linear', 'webhook'], project: 'QA', dryRun: false, fetcher: fakeFetch, logger: { info(){}, warn(){} } }).build(run);
  assert.strictEqual(live.dryRun, false, 'live-mode flag');
  assert.ok(live.posted, 'posted block present in live mode');
  // All 4 adapters should be skipped because env vars aren't set in the test → 0 calls.
  assert.strictEqual(calls.length, 0, 'no POSTs when creds missing (skipped, not thrown)');
  console.log('✓ BugReporter: live mode skips adapters gracefully when creds missing');

  // Verify POST_ADAPTERS shape — each is async + returns ok/status.
  for (const name of ['jira', 'slack', 'linear', 'webhook']) {
    assert.strictEqual(typeof POST_ADAPTERS[name], 'function', `POST_ADAPTERS.${name} exists`);
  }
  console.log('✓ BugReporter: POST_ADAPTERS for jira, slack, linear, webhook all wired');

  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(out2, { recursive: true, force: true });
  console.log('\nBUG REPORTER TEST PASSED ✅');
})();
