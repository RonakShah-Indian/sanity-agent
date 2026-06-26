'use strict';

/**
 * Unit tests for the Phase 1 discovery + reconciler — no network, no browser.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { reconcile } = require('../src/reconciler');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}\n   ${e.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanity-test-'));
const profileDir = path.join(tmp, 'profiles');
const archiveDir = path.join(tmp, 'archive');
const activePath = path.join(tmp, 'sites-active.json');
fs.mkdirSync(profileDir, { recursive: true });

// Seed two profile files for the about-to-be-removed merchant.
fs.writeFileSync(path.join(profileDir, 'gone__desktop.json'), '{}');
fs.writeFileSync(path.join(profileDir, 'gone__iphone-14.json'), '{}');

const current = [
  { id: 'keeper', url: 'https://keeper.example' },
  { id: 'changing', url: 'https://old-host.example' },
  { id: 'gone', url: 'https://gone.example' },
];
const discovered = [
  { id: 'keeper', url: 'https://keeper.example' },
  { id: 'changing', url: 'https://new-host.example' },           // url changed
  { id: 'newcomer', url: 'https://newcomer.example' },           // added
];

const diff = reconcile(current, discovered, { activeListPath: activePath, archiveDir, profileDir });

test('detects added merchants', () => {
  assert.strictEqual(diff.added.length, 1);
  assert.strictEqual(diff.added[0].id, 'newcomer');
});
test('detects changed merchants (meaningful field)', () => {
  assert.strictEqual(diff.changed.length, 1);
  assert.strictEqual(diff.changed[0].to.id, 'changing');
});
test('detects removed merchants', () => {
  assert.strictEqual(diff.removed.length, 1);
  assert.strictEqual(diff.removed[0].id, 'gone');
});
test('keeps unchanged merchants out of the action list', () => {
  assert.strictEqual(diff.unchanged.length, 1);
  assert.strictEqual(diff.unchanged[0].id, 'keeper');
});
test('persists the active list', () => {
  const written = JSON.parse(fs.readFileSync(activePath, 'utf8'));
  assert.strictEqual(written.length, 3);
  assert.deepStrictEqual(written.map(s => s.id).sort(), ['changing', 'keeper', 'newcomer']);
});
test('archives profiles for removed merchants', () => {
  assert.ok(!fs.existsSync(path.join(profileDir, 'gone__desktop.json')), 'desktop profile should be moved');
  assert.ok(!fs.existsSync(path.join(profileDir, 'gone__iphone-14.json')), 'iphone profile should be moved');
  const archived = fs.readdirSync(archiveDir);
  assert.strictEqual(archived.length, 2, `expected 2 archived files, got ${archived.length}`);
  assert.ok(archived.every(f => f.includes('gone__')), 'archived files should retain the id prefix');
});
test('cosmetic-only changes are not flagged', () => {
  const a = [{ id: 'x', url: 'https://x', note: 'old description' }];
  const b = [{ id: 'x', url: 'https://x', note: 'new description' }];
  const d = reconcile(a, b);
  assert.strictEqual(d.changed.length, 0);
  assert.strictEqual(d.unchanged.length, 1);
});

console.log(failed === 0 ? '\nDISCOVERY TESTS PASSED ✅' : `\n${failed} test(s) failed ❌`);
process.exit(failed ? 1 : 0);
