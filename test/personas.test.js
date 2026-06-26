'use strict';

/**
 * Phase 3 — persona resolution + validator unit tests (no browser).
 */

const assert = require('assert');
const { PERSONAS, resolvePersonas, applyValidators } = require('../src/personas');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}\n   ${e.message}`); }
}
async function atest(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}\n   ${e.message}`); }
}

// --- resolvePersonas ---------------------------------------------------------

test('resolves built-in persona names', () => {
  const out = resolvePersonas({ personas: ['budget_hunter', 'gift_buyer'] });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].name, 'budget_hunter');
  assert.strictEqual(out[0].query, 'sale');
  assert.ok(out[0].validators.maxLoadMs);
});

test('inline persona objects override built-ins', () => {
  const out = resolvePersonas({
    personas: [{ name: 'budget_hunter', query: 'clearance', validators: { maxLoadMs: 3000 } }],
  });
  assert.strictEqual(out[0].query, 'clearance');
  // maxLoadMs gets overridden, but mustSeeAny still inherits from base.
  assert.strictEqual(out[0].validators.maxLoadMs, 3000);
  assert.ok(Array.isArray(out[0].validators.mustSeeAny));
});

test('viewport reference resolves from site catalog', () => {
  const out = resolvePersonas({
    viewports: [{ name: 'desktop-1440', viewport: { width: 1440, height: 900 } }],
    personas: [{ name: 'gift_buyer', viewport: 'desktop-1440' }],
  });
  assert.strictEqual(out[0].viewportConfig.viewport.width, 1440);
});

test('empty/missing personas returns []', () => {
  assert.deepStrictEqual(resolvePersonas({}), []);
  assert.deepStrictEqual(resolvePersonas({ personas: [] }), []);
});

// --- applyValidators (with a mock page) -------------------------------------

function mockPage(text) {
  return { locator: () => ({ innerText: async () => text }) };
}

atest('mustSeeAny passes when at least one term is present', async () => {
  const page = mockPage('Buy now • Pay with UPI or wallet');
  const persona = { validators: { mustSeeAny: ['UPI', 'BNPL'] } };
  const findings = await applyValidators(page, persona, { navMs: 1000 });
  assert.deepStrictEqual(findings, []);
});

atest('mustSeeAny fails when none of the terms are present', async () => {
  const page = mockPage('Buy now • Credit cards accepted');
  const persona = { validators: { mustSeeAny: ['UPI', 'BNPL'] } };
  const findings = await applyValidators(page, persona, { navMs: 1000 });
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].kind, 'mustSeeAny');
});

atest('mustSee fails when even one required term is missing', async () => {
  const page = mockPage('Gift available');
  const persona = { validators: { mustSee: ['gift', 'wrap'] } };
  const findings = await applyValidators(page, persona, { navMs: 1000 });
  assert.strictEqual(findings.length, 1);
  assert.ok(findings[0].detail.includes('wrap'));
});

atest('mustNotSee fires when banned terms are present', async () => {
  const page = mockPage('Out of stock — premium members only');
  const persona = { validators: { mustNotSee: ['premium members only'] } };
  const findings = await applyValidators(page, persona, { navMs: 1000 });
  assert.strictEqual(findings.length, 1);
});

atest('maxLoadMs fires when nav exceeds budget', async () => {
  const page = mockPage('any content');
  const persona = { validators: { maxLoadMs: 3000 } };
  const findings = await applyValidators(page, persona, { navMs: 5500 });
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].kind, 'maxLoadMs');
});

atest('combined validators: gift_buyer on a site missing gift wrap', async () => {
  const page = mockPage('Welcome to the store. Buy now.');
  const persona = PERSONAS.gift_buyer;
  const findings = await applyValidators(page, persona, { navMs: 4000 });
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].kind, 'mustSeeAny');
});

(async () => {
  // The atest helpers are async; give them time to register.
  await new Promise(r => setImmediate(r));
  console.log(failed === 0 ? '\nPERSONA TESTS PASSED ✅' : `\n${failed} test(s) failed ❌`);
  process.exit(failed ? 1 : 0);
})();
