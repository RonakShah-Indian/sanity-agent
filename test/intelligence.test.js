'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { BusinessClassifier, ARCHETYPES } = require('../src/classifier');
const { DiffEngine } = require('../src/diff');
const { DeployTrigger } = require('../src/trigger');

// fake page whose evaluate() returns a scripted signal blob
function pageWith(signals) {
  return { async evaluate() { return signals; } };
}

(async () => {
  // --- Classifier: B2B wholesale ---
  {
    const c = new BusinessClassifier();
    const res = await c.classify(pageWith({
      text: 'wholesale bulk moq minimum order gst distributor buyer business account', schemaTypes: '',
      hasCart: true, hasPrice: true, hasLogin: true, hasSearch: true, title: 'uniket b2b',
    }));
    assert.strictEqual(res.archetype, 'b2b_wholesale', `expected b2b, got ${res.archetype}`);
    assert.strictEqual(res.plan[0], 'sign_in', 'b2b plan should lead with sign_in');
    console.log('✓ Classifier identifies B2B wholesale + auth-first plan');
  }

  // --- Classifier: SaaS console (no cart) ---
  {
    const c = new BusinessClassifier();
    const res = await c.classify(pageWith({
      text: 'dashboard api docs pricing console integrations free trial sign up', schemaTypes: '',
      hasCart: false, hasPrice: false, hasLogin: true, hasSearch: false, title: 'fynd platform console',
    }));
    assert.strictEqual(res.archetype, 'saas_console', `expected saas, got ${res.archetype}`);
    assert.ok(!res.plan.includes('checkout'), 'saas plan should skip checkout');
    console.log('✓ Classifier identifies SaaS console + skips cart/checkout');
  }

  // --- Classifier: quick commerce ---
  {
    const c = new BusinessClassifier();
    const res = await c.classify(pageWith({
      text: 'delivery in 10 minutes grocery fresh pincode instant eta', schemaTypes: '',
      hasCart: true, hasPrice: true, hasLogin: true, hasSearch: true, title: 'fynd quick',
    }));
    assert.strictEqual(res.archetype, 'quick_commerce', `expected quick_commerce, got ${res.archetype}`);
    console.log('✓ Classifier identifies quick commerce');
  }

  // --- DiffEngine: first run then regression ---
  {
    const dir = path.join(__dirname, '_tmp_baselines');
    fs.rmSync(dir, { recursive: true, force: true });
    const de = new DiffEngine(dir);

    const fp1 = DiffEngine.fingerprint({
      siteId: 'shopX', locale: { lang: 'en', currency: 'USD' }, archetype: 'fashion_retail',
      flows: [{ key: 'add_to_cart', status: 'passed' }], elements: [{ role: 'button', text: 'Add to cart' }, { role: 'link', text: 'Login' }],
      timings: { add_to_cart: 3000 },
    });
    let d1 = de.diff(de.loadBaseline('shopX'), fp1);
    assert.ok(d1.firstRun, 'first run flagged');
    de.maybeUpdateBaseline('shopX', fp1, 'passed');

    // second run: flow regressed, an element removed, perf slower, currency changed
    const fp2 = DiffEngine.fingerprint({
      siteId: 'shopX', locale: { lang: 'en', currency: 'EUR' }, archetype: 'fashion_retail',
      flows: [{ key: 'add_to_cart', status: 'failed' }], elements: [{ role: 'link', text: 'Login' }],
      timings: { add_to_cart: 6000 },
    });
    const d2 = de.diff(de.loadBaseline('shopX'), fp2);
    assert.strictEqual(d2.severity, 'high', 'should be high severity');
    const types = d2.changes.map(c => c.type);
    assert.ok(types.includes('flow-status'), 'detects flow regression');
    assert.ok(types.includes('structure-removed'), 'detects removed element');
    assert.ok(types.includes('perf-regression'), 'detects perf regression');
    assert.ok(types.includes('currency-change'), 'detects currency change');
    // failing run must NOT overwrite the good baseline
    assert.strictEqual(de.maybeUpdateBaseline('shopX', fp2, 'failed'), false, 'bad run should not become baseline');
    console.log('✓ DiffEngine detects flow/structure/perf/currency deltas + protects baseline');

    fs.rmSync(dir, { recursive: true, force: true });
  }

  // --- Tiered planning: changed sites = full, others = smoke ---
  {
    const sites = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const tiered = DeployTrigger.planTiers(sites, ['b']);
    assert.strictEqual(tiered.find(s => s.id === 'b').tier, 'full');
    assert.strictEqual(tiered.find(s => s.id === 'a').tier, 'smoke');
    assert.ok(tiered.find(s => s.id === 'a').smokeOnly);
    console.log('✓ Tiered planning: changed→full, rest→smoke (keeps 1000 in 5-min budget)');
  }

  console.log('\nALL CLASSIFIER + DIFF + TRIGGER TESTS PASSED ✅');
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
