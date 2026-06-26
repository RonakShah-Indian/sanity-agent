'use strict';

/**
 * DiscoverySource
 * ---------------
 * Turn "which merchants exist on the platform" into a live list of sanity
 * targets — no human curates a sites.json. Each source returns the same
 * shape the orchestrator already understands ({ id, url, ... }), so the
 * pipeline downstream stays unchanged.
 *
 * Three sources ship out of the box:
 *
 *   - static    : an existing JSON file (back-compat)
 *   - sitemap   : the platform's sitemap.xml. Most multi-tenant commerce
 *                 platforms emit one URL per merchant — that's the cheapest,
 *                 highest-fidelity source you'll ever get for free.
 *   - tenant-api: a JSON endpoint that lists tenants. This is the plug-in
 *                 point for Fynd's real internal API; the contract is
 *                 documented inline below.
 *
 * Multiple sources merge by id (later sources override earlier). Failures
 * are non-fatal — a flaky source returns [] and the prior list is kept.
 */

const fs = require('fs');
const path = require('path');

async function discover(config, { logger = console } = {}) {
  const all = new Map();    // id -> entry
  for (const src of config.sources || []) {
    try {
      const entries = await runSource(src, { logger });
      for (const e of entries) {
        if (!e.id || !e.url) continue;
        all.set(e.id, { ...all.get(e.id), ...e });
      }
      logger.info?.(`[discovery] ${src.type}: +${entries.length}`);
    } catch (e) {
      logger.warn?.(`[discovery] ${src.type} failed: ${e.message}`);
    }
  }
  return [...all.values()];
}

function runSource(src, ctx) {
  switch (src.type) {
    case 'static':     return fromStaticFile(src);
    case 'sitemap':    return fromSitemap(src, ctx);
    case 'tenant-api': return fromTenantAPI(src, ctx);
    default:           throw new Error(`Unknown discovery source: ${src.type}`);
  }
}

// --- static ------------------------------------------------------------------

async function fromStaticFile(src) {
  const data = JSON.parse(fs.readFileSync(path.resolve(src.path), 'utf8'));
  return Array.isArray(data) ? data.filter(e => e.id && e.url) : [];
}

// --- sitemap -----------------------------------------------------------------
// Recursively expands sitemap-index files to their child sitemaps, then
// extracts <loc> URLs. Optional storePathPattern filters to merchant pages.

async function fromSitemap(src, { logger } = {}) {
  const seenSitemaps = new Set();
  const urls = [];
  await walk(src.url);
  const pattern = src.storePathPattern ? new RegExp(src.storePathPattern, 'i') : null;
  const idFrom = src.idFrom || 'last-path-segment';

  const out = urls
    .filter(u => !pattern || pattern.test(u))
    .map(u => ({ id: deriveId(u, idFrom), url: u, source: 'sitemap' }))
    .filter(e => e.id);

  // Dedupe by id.
  const dedup = new Map();
  for (const e of out) dedup.set(e.id, e);
  return [...dedup.values()].slice(0, src.maxEntries || 500);

  async function walk(url) {
    if (seenSitemaps.has(url) || seenSitemaps.size > 50) return;
    seenSitemaps.add(url);
    let body;
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      body = await r.text();
    } catch (e) {
      logger?.debug?.(`[discovery.sitemap] skip ${url}: ${e.message}`);
      return;
    }
    // Sitemap-index: walk children.
    const childMatches = [...body.matchAll(/<sitemap>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/sitemap>/gi)];
    if (childMatches.length) {
      for (const m of childMatches) await walk(m[1].trim());
      return;
    }
    // Urlset: collect URLs.
    for (const m of body.matchAll(/<url>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/url>/gi)) {
      urls.push(m[1].trim());
    }
  }
}

function deriveId(url, mode) {
  try {
    const u = new URL(url);
    if (mode === 'host') return u.host.replace(/^www\./, '').replace(/[^a-z0-9._-]/gi, '_');
    const seg = u.pathname.split('/').filter(Boolean).pop() || u.host;
    return seg.toLowerCase().replace(/[^a-z0-9._-]/gi, '_').slice(0, 64);
  } catch { return null; }
}

// --- tenant-api --------------------------------------------------------------
// Contract — what your tenant-list endpoint should return:
//
//   GET <baseUrl>            (with optional Authorization: Bearer <apiKey>)
//   ->  [
//         { "id": "merchant-slug", "url": "https://merchant.example.com",
//           "active": true, "themeVersion": "v3.2", "region": "IN",
//           "credentials": {...}? }   // any agent-friendly extras
//         ...
//       ]
//
// `active: false` filters them out. Anything else passes through to the
// agent unchanged. This is the integration point for Fynd's internal API
// — drop in the right URL + key and you're done.

async function fromTenantAPI(src, { logger } = {}) {
  if (!src.baseUrl) throw new Error('tenant-api: baseUrl required');
  const apiKey = resolveEnv(src.apiKey);
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const r = await fetch(src.baseUrl, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = await r.json();
  const list = Array.isArray(body) ? body : (body.tenants || body.data || []);
  return list
    .filter(t => t.active !== false)
    .map(t => ({ ...t, source: 'tenant-api' }))
    .filter(e => e.id && e.url);
}

function resolveEnv(v) {
  if (!v) return null;
  return v.replace(/^\$\{([A-Z_][A-Z0-9_]*)\}$/i, (_, k) => process.env[k] || '');
}

module.exports = { discover };
