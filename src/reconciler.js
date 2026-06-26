'use strict';

/**
 * Reconciler
 * ----------
 * Diff a freshly-discovered merchant list against the currently-active list,
 * then act on the deltas. Pure-functionally returns the diff; optionally
 * applies side effects (persist active list, archive removed merchants).
 *
 * The "act on it" part — running a baseline for new merchants, re-baselining
 * changed ones — is left to the caller (typically src/serve.js), so this
 * module stays test-friendly and the trigger model stays explicit.
 */

const fs = require('fs');
const path = require('path');

function reconcile(currentList, discoveredList, opts = {}) {
  const cur = new Map((currentList || []).map(s => [s.id, s]));
  const next = new Map((discoveredList || []).map(s => [s.id, s]));

  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (const [id, entry] of next) {
    const prev = cur.get(id);
    if (!prev) { added.push(entry); continue; }
    if (hasMeaningfulChange(prev, entry)) changed.push({ from: prev, to: entry });
    else unchanged.push(entry);
  }
  for (const [id, entry] of cur) {
    if (!next.has(id)) removed.push(entry);
  }

  // Side effects (opt-in).
  if (opts.activeListPath) {
    fs.mkdirSync(path.dirname(opts.activeListPath), { recursive: true });
    fs.writeFileSync(opts.activeListPath, JSON.stringify([...next.values()], null, 2));
  }
  if (opts.archiveDir && removed.length) {
    fs.mkdirSync(opts.archiveDir, { recursive: true });
    for (const r of removed) archiveProfiles(r.id, opts.profileDir, opts.archiveDir);
  }

  return { added, removed, changed, unchanged, total: next.size };
}

// "Meaningful" = anything the agent's behavior depends on. Cosmetic fields
// (description, region tag) don't trigger a re-baseline.
function hasMeaningfulChange(prev, next) {
  const keys = ['url', 'themeVersion', 'versionUrl', 'locale', 'flows', 'viewports'];
  for (const k of keys) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) return true;
  }
  return false;
}

function archiveProfiles(siteId, profileDir, archiveDir) {
  if (!profileDir || !fs.existsSync(profileDir)) return;
  for (const f of fs.readdirSync(profileDir)) {
    if (!f.startsWith(siteId) || !f.endsWith('.json')) continue;
    const src = path.join(profileDir, f);
    const dst = path.join(archiveDir, `${Date.now()}__${f}`);
    try { fs.renameSync(src, dst); } catch { /* ignore */ }
  }
}

module.exports = { reconcile };
