'use strict';

/**
 * Phase 8 — Repository contract tests. Both the file and (when available) the
 * SQLite backend MUST behave identically against the same interface. This
 * test exercises FileLocatorMemoryRepo + FileRunHistoryRepo directly; the
 * SqlBackend equivalents are tested via the same scenarios when better-sqlite3
 * is installed (skipped silently otherwise).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { FileLocatorMemoryRepo, FileRunHistoryRepo } = require('../src/storage/repositories');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}\n   ${e.message}`); }
}

function runRepoTests(label, makeRepos) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanity-storage-'));
  const { mem, hist } = makeRepos(tmp);

  test(`${label}: remember+recall stores and retrieves a selector`, () => {
    mem.remember('site-a', 'search_box', 'input#q', 'role');
    const r = mem.recall('site-a', 'search_box');
    assert.ok(r);
    assert.strictEqual(r.selector, 'input#q');
    assert.strictEqual(r.strategy, 'role');
    assert.ok(r.confidence >= 0.5);
  });

  test(`${label}: re-remembering same selector increases confidence + hits`, () => {
    mem.remember('site-a', 'search_box', 'input#q', 'role');
    mem.remember('site-a', 'search_box', 'input#q', 'role');
    const r = mem.recall('site-a', 'search_box');
    assert.ok(r.confidence > 0.8);
    assert.ok(r.hits >= 2);
  });

  test(`${label}: demote reduces confidence and eventually evicts`, () => {
    mem.remember('site-a', 'cart_link', 'a.cart', 'role');
    mem.demote('site-a', 'cart_link');
    mem.demote('site-a', 'cart_link');
    mem.demote('site-a', 'cart_link');
    const r = mem.recall('site-a', 'cart_link');
    assert.strictEqual(r, null);   // evicted at confidence 0
  });

  test(`${label}: setLocale + summary work`, () => {
    mem.setLocale('site-a', 'en-IN');
    const s = mem.summary('site-a');
    assert.strictEqual(s.siteId, 'site-a');
    assert.strictEqual(s.locale, 'en-IN');
    assert.ok(s.learnedIntents >= 1);
  });

  test(`${label}: runHistory append + loadLatest`, () => {
    hist.append({ ts: new Date().toISOString(), site: 'site-a', status: 'passed', score: 100, flows: [{ key: 'sign_in', status: 'passed' }] });
    const r = hist.loadLatest('site-a');
    assert.ok(r);
    assert.strictEqual(r.status, 'passed');
    assert.strictEqual(r.score, 100);
  });

  test(`${label}: loadHistory returns multiple records`, () => {
    hist.append({ ts: new Date().toISOString(), site: 'site-a', status: 'failed', score: 80, flows: [] });
    const hs = hist.loadHistory('site-a');
    assert.ok(hs.length >= 2);
  });

  test(`${label}: listSites enumerates the sites we touched`, () => {
    hist.append({ ts: new Date().toISOString(), site: 'site-b', status: 'passed', score: 100, flows: [] });
    const sites = hist.listSites().sort();
    assert.ok(sites.includes('site-a'));
    assert.ok(sites.includes('site-b'));
  });
}

// --- Run against the file backend (always available) ---
runRepoTests('file', (tmp) => ({
  mem: new FileLocatorMemoryRepo(path.join(tmp, 'profiles')),
  hist: new FileRunHistoryRepo(path.join(tmp, 'history')),
}));

// --- Run against the SQLite backend (if better-sqlite3 is installed) ---
try {
  const Database = require('better-sqlite3');
  const { SqlLocatorMemoryRepo, SqlRunHistoryRepo } = require('../src/storage/sql-backend');
  runRepoTests('sqlite', () => {
    const db = new Database(':memory:');
    return { mem: new SqlLocatorMemoryRepo(db), hist: new SqlRunHistoryRepo(db) };
  });
} catch (e) {
  console.log('⊘ sqlite backend not installed — skipping (run `npm install better-sqlite3` to enable)');
}

console.log(failed === 0 ? '\nSTORAGE TESTS PASSED ✅' : `\n${failed} test(s) failed ❌`);
process.exit(failed ? 1 : 0);
