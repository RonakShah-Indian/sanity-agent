#!/usr/bin/env node
'use strict';

/**
 * One-shot discovery + reconciliation.
 *
 *   node src/discover.js --config config/discovery.example.json
 *   node src/discover.js --sitemap https://www.example.com/sitemap.xml --pattern '/store/'
 *
 * Writes the merged, reconciled list to config/sites-active.json and prints
 * the diff. Run this from cron or call it periodically inside serve.js.
 */

const fs = require('fs');
const path = require('path');
const { discover } = require('./discovery');
const { reconcile } = require('./reconciler');

const root = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1]?.startsWith('--') ? true : argv[++i]; a[k] = v ?? true; }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let config;
  if (args.config) {
    config = JSON.parse(fs.readFileSync(path.resolve(args.config), 'utf8'));
  } else if (args.sitemap) {
    config = { sources: [{ type: 'sitemap', url: args.sitemap, storePathPattern: args.pattern, maxEntries: args.max ? +args.max : 200 }] };
  } else {
    console.error('Need --config <file> or --sitemap <url> [--pattern <regex>]');
    process.exit(2);
  }

  const logger = { info: console.log, warn: console.warn, debug: process.env.DEBUG ? console.log : undefined };
  const activePath = path.join(root, 'config/sites-active.json');
  const archiveDir = path.join(root, 'profiles/_archive');
  const profileDir = path.join(root, 'profiles');

  let currentList = [];
  try { currentList = JSON.parse(fs.readFileSync(activePath, 'utf8')); } catch { /* first run */ }

  const discovered = await discover(config, { logger });
  const diff = reconcile(currentList, discovered, { activeListPath: activePath, archiveDir, profileDir });

  console.log(`\n=== RECONCILIATION ===`);
  console.log(`  active total: ${diff.total}`);
  console.log(`  + added:      ${diff.added.length}${diff.added.length ? '  e.g. ' + diff.added.slice(0,3).map(e=>e.id).join(', ') : ''}`);
  console.log(`  ~ changed:    ${diff.changed.length}${diff.changed.length ? '  e.g. ' + diff.changed.slice(0,3).map(e=>e.to.id).join(', ') : ''}`);
  console.log(`  - removed:    ${diff.removed.length}${diff.removed.length ? '  e.g. ' + diff.removed.slice(0,3).map(e=>e.id).join(', ') : ''}`);
  console.log(`  = unchanged:  ${diff.unchanged.length}`);
  console.log(`\nActive list written: ${activePath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
