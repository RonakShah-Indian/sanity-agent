#!/usr/bin/env node
'use strict';

/**
 * profile-rollback — undo a bad self-heal.
 *
 * The agent's resolver caches every successful selector resolution into
 * `profiles/<site>__<viewport>.json`. When the resolver self-heals onto the
 * WRONG element (silent pass: flow passes, business metrics regress), the
 * recovery is to delete the bad cached entry so the ladder re-resolves on the
 * next run.
 *
 * Usage:
 *   node src/profile-rollback.js --site <site-id> [--viewport <vp>] [--intent <intent>]
 *
 * Examples:
 *   # Drop ONE intent's cached selector (most surgical):
 *   node src/profile-rollback.js --site sephora-india --intent add_to_cart
 *
 *   # Drop ALL cached selectors for a site/viewport (full re-learn):
 *   node src/profile-rollback.js --site sephora-india
 *
 *   # Target a non-default viewport:
 *   node src/profile-rollback.js --site sephora-india --viewport iphone-14 --intent search_box
 *
 * The pre-edit profile is backed up to `profiles/<site>__<vp>.json.bak.<ts>`
 * so a mistaken rollback can be reverted with a single `mv`. Backups are
 * never auto-deleted — prune the `profiles/` dir manually.
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    args[key] = val;
  }
  return args;
}

function usage(code = 0) {
  const msg = `
Usage: node src/profile-rollback.js --site <site-id> [--viewport <vp>] [--intent <intent>] [--dry-run]

Options:
  --site      REQUIRED. Site id matching profiles/<site>__<vp>.json.
  --viewport  Viewport name. Defaults to 'desktop'.
  --intent    Specific intent to drop (e.g. add_to_cart, search_box, cart_link).
              Omit to drop ALL intents for the site (full re-learn next run).
  --dry-run   Print what would change, don't write.
  --root      Repo root. Defaults to cwd.
`;
  process.stderr.write(msg);
  process.exit(code);
}

const args = parseArgs(process.argv);
if (!args.site || args.help) usage(args.help ? 0 : 2);

const root = args.root || process.cwd();
const viewport = args.viewport || 'desktop';
const profilePath = path.join(root, 'profiles', `${args.site}__${viewport}.json`);

if (!fs.existsSync(profilePath)) {
  console.error(`[rollback] no profile found: ${profilePath}`);
  process.exit(3);
}

const before = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const intents = before.intents || before; // tolerate flat or {intents:{}} layout

if (args.intent && !intents[args.intent]) {
  console.error(`[rollback] intent "${args.intent}" not present in ${profilePath}; nothing to do`);
  console.error(`[rollback] available intents: ${Object.keys(intents).join(', ') || '(none)'}`);
  process.exit(0);
}

const after = JSON.parse(JSON.stringify(before));
const afterIntents = after.intents || after;
const droppedKeys = [];
if (args.intent) {
  droppedKeys.push(args.intent);
  delete afterIntents[args.intent];
} else {
  droppedKeys.push(...Object.keys(afterIntents));
  if (after.intents) after.intents = {};
  else Object.keys(after).forEach(k => delete after[k]);
}

console.log(`[rollback] site=${args.site} viewport=${viewport}`);
console.log(`[rollback] dropping intent(s): ${droppedKeys.join(', ') || '(none)'}`);
for (const k of droppedKeys) {
  const entry = intents[k];
  if (entry) {
    console.log(`           - ${k}: was strategy=${entry.strategy || '?'}, confidence=${entry.confidence ?? '?'}, lastSeen=${entry.lastSeenAt || entry.lastUsedAt || '?'}`);
  }
}

if (args['dry-run']) {
  console.log('[rollback] --dry-run: not writing.');
  process.exit(0);
}

// Back up the original, then write the rolled-back profile.
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${profilePath}.bak.${ts}`;
fs.writeFileSync(backupPath, JSON.stringify(before, null, 2));
fs.writeFileSync(profilePath, JSON.stringify(after, null, 2));
console.log(`[rollback] backed up to: ${backupPath}`);
console.log(`[rollback] wrote: ${profilePath}`);
console.log(`[rollback] next run will re-resolve the dropped intent(s) via Rungs 2..5.`);
