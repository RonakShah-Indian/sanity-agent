'use strict';

// Proves the core logic without a real browser by injecting a fake Playwright-like page.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SemanticResolver } = require('../src/resolver');
const { SiteProfile } = require('../src/profile');
const { Reporter } = require('../src/reporter');

// ---- Minimal fake locator/page that mimics the slice of Playwright we use ----
function fakeLocator(usable, { clickable = true } = {}) {
  return {
    first() { return this; },
    async count() { return usable ? 1 : 0; },
    async isVisible() { return usable; },
    async click() { if (!clickable) throw new Error('not clickable'); },
    async fill() {},
    async press() {},
    async innerText() { return '1'; },
  };
}

function makeFakePage(world) {
  // world maps a "query signature" -> usable?  We keep it simple: control by flags.
  return {
    _world: world,
    getByRole(role, opts) { return fakeLocator(world.roleHit && role === world.roleHit.role); },
    getByText() { return fakeLocator(world.textHit); },
    getByPlaceholder() { return fakeLocator(false); },
    getByLabel() { return fakeLocator(false); },
    locator(sel) {
      // profile selector replay: honor world.profileWorks
      if (sel.includes('data-agent-idx')) return fakeLocator(world.llmHit);
      if (world.profileSelector && sel === world.profileSelector) return fakeLocator(world.profileWorks);
      return fakeLocator(false);
    },
    async evaluate() { return [{ idx: 0, tag: 'button', role: 'button', text: 'Add to cart', type: '', visible: true }]; },
    async waitForTimeout() {},
  };
}

(async () => {
  const tmp = path.join(__dirname, '_tmp_profiles');
  fs.rmSync(tmp, { recursive: true, force: true });

  // --- Test 1: resolves via ROLE when no profile exists, then LEARNS it ---
  {
    const profile = new SiteProfile('test1', tmp);
    const page = makeFakePage({ roleHit: { role: 'button' } });
    const r = new SemanticResolver({ page, profile });
    const hit = await r.resolve('add_to_cart');
    assert.strictEqual(hit.strategy, 'role', 'should resolve by role');
    assert.ok(profile.recall('add_to_cart'), 'should have learned the selector');
    console.log('✓ Test 1: resolves by role + writes to profile (self-learning)');
  }

  // --- Test 2: PROFILE fast-path is used on the second run ---
  {
    const profile = new SiteProfile('test2', tmp);
    const sel = 'role=button';
    await profile.remember('add_to_cart', sel, 'role');
    const page = makeFakePage({ profileSelector: sel, profileWorks: true });
    const r = new SemanticResolver({ page, profile });
    const hit = await r.resolve('add_to_cart');
    assert.strictEqual(hit.strategy, 'profile', 'should use learned profile first');
    console.log('✓ Test 2: uses learned profile on subsequent run (fast path)');
  }

  // --- Test 3: SELF-HEAL — cached selector breaks, falls back + re-learns ---
  {
    const profile = new SiteProfile('test3', tmp);
    const staleSel = '#old-add-btn';
    await profile.remember('add_to_cart', staleSel, 'role');
    // profile selector now broken; role still works -> should heal
    const page = makeFakePage({ profileSelector: staleSel, profileWorks: false, roleHit: { role: 'button' } });
    const r = new SemanticResolver({ page, profile });
    const hit = await r.resolve('add_to_cart');
    assert.strictEqual(hit.strategy, 'role', 'should heal by re-resolving via role');
    console.log('✓ Test 3: self-heals when cached selector goes stale');
  }

  // --- Test 4: LLM fallback rung fires when everything else misses ---
  {
    const profile = new SiteProfile('test4', tmp);
    const page = makeFakePage({ llmHit: true }); // role/text all miss
    const fakeLLM = { async pickElement() { return 0; } };
    const r = new SemanticResolver({ page, profile, llm: fakeLLM });
    const hit = await r.resolve('add_to_cart');
    assert.strictEqual(hit.strategy, 'llm-vision', 'should fall through to LLM vision');
    console.log('✓ Test 4: LLM-vision fallback resolves when heuristics miss');
  }

  // --- Test 5: Reporter emits html/json/junit from a synthetic run ---
  {
    const run = {
      summary: { total: 2, passed: 1, degraded: 0, failed: 1, errored: 0, deferred: 0, durationMs: 5400, concurrency: 3, throughputPerMin: 22.2, generatedAt: new Date().toISOString() },
      results: [
        { site: 'siteA', url: 'https://a.com', status: 'passed', durationMs: 2600,
          locale: { lang: 'en', currency: 'USD' }, profile: { learnedIntents: 4, avgConfidence: 0.82 },
          flows: [{ flow: 'Add To Cart', status: 'passed', steps: [] }] },
        { site: 'siteB', url: 'https://b.es', status: 'failed', durationMs: 2800,
          locale: { lang: 'es', currency: 'EUR' }, profile: { learnedIntents: 2, avgConfidence: 0.4 },
          flows: [{ flow: 'Sign In', status: 'failed', failedStep: { error: 'no password field' },
            steps: [{ action: 'type', intent: 'password_field', remediation: {
              ticket: { title: '[Sanity] Sign In failed at "type" (password_field)', diagnosis: 'Password field not found; likely behind a 2-step email-first form.' },
              proposedFix: { candidate: 'text=/contraseña/i', requiresApproval: true } } }] }] },
      ],
    };
    const out = path.join(__dirname, '_tmp_report');
    const files = new Reporter(out).write(run);
    assert.ok(fs.existsSync(files.html) && fs.existsSync(files.xml) && fs.existsSync(files.json));
    const xml = fs.readFileSync(files.xml, 'utf8');
    assert.ok(xml.includes('<failure'), 'junit should record the failure');
    console.log('✓ Test 5: reporter emits html + json + junit (CI-gate ready)');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nALL CORE LOGIC TESTS PASSED ✅');
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
