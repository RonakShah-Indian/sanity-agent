#!/usr/bin/env node
'use strict';

/**
 * Per-site page crawler CLI. Standalone — opens a Playwright browser, crawls
 * one site's pages with bounded BFS, classifies each, prints + saves a sitemap.
 *
 *   node src/discover-pages.js --url https://example.com [--max 25] [--depth 2]
 *
 * Output:
 *   sitemaps/<host>.json   — full sitemap JSON
 *   stdout                 — by-type histogram + first 10 pages
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { crawl } = require('./discovery/sitemap-crawler');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1]?.startsWith('--') ? true : argv[++i];
      a[k] = v ?? true;
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error('Usage: node src/discover-pages.js --url <baseUrl> [--max 25] [--depth 2]');
    process.exit(2);
  }
  const baseUrl = args.url;
  const maxPages = +(args.max || 25);
  const maxDepth = +(args.depth || 2);
  const host = new URL(baseUrl).host.replace(/[^a-z0-9._-]/gi, '_');

  const browser = await chromium.launch({ headless: process.env.SANITY_HEADED !== '1' });
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);

  const logger = { info: console.log, warn: console.warn, debug: process.env.DEBUG ? console.log : undefined };
  const sitemap = await crawl(page, { baseUrl, siteId: host, maxDepth, maxPages, logger });
  await browser.close();

  const root = path.resolve(__dirname, '..');
  const outDir = path.join(root, 'sitemaps');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${host}.json`);
  fs.writeFileSync(outFile, JSON.stringify(sitemap, null, 2));

  console.log('\n=== SITEMAP SUMMARY ===');
  console.log(`  base:          ${sitemap.baseUrl}`);
  console.log(`  pages crawled: ${sitemap.stats.totalCrawled}`);
  console.log(`  by type:       ${JSON.stringify(sitemap.stats.byType)}`);
  console.log(`  duration:      ${sitemap.stats.durationMs} ms`);
  console.log(`  output:        ${outFile}`);
  console.log('\nFirst 10 pages:');
  sitemap.pages.slice(0, 10).forEach(p => {
    console.log(`  [${p.type.padEnd(9)}] d=${p.depth} conf=${p.confidence}  ${p.url}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
