'use strict';

const { classify } = require('./page-classifier');

/**
 * SitemapCrawler — Phase 2 of the design. Bounded BFS over a single site,
 * classifying each page along the way. Output shape:
 *
 *   {
 *     siteId, baseUrl, generatedAt, pages: [
 *       { url, title, type, confidence, depth, scores, signals: {...} },
 *       ...
 *     ],
 *     stats: { totalCrawled, byType: {product: N, category: M, ...}, durationMs }
 *   }
 *
 * Constraints (per the design):
 *   - same-domain only
 *   - bounded by maxDepth and maxPages
 *   - polite: serial within a single tab, light timeouts
 *   - reuses the existing Playwright page (caller provides it)
 */
async function crawl(page, { baseUrl, siteId = 'site', maxDepth = 2, maxPages = 25, perPageTimeoutMs = 8000, logger = console } = {}) {
  const startedAt = Date.now();
  const baseOrigin = new URL(baseUrl).origin;
  const sanitize = (u) => { try { const x = new URL(u, baseUrl); x.hash = ''; return x.toString(); } catch { return null; } };

  const visited = new Set();
  const queue = [{ url: sanitize(baseUrl), depth: 0 }];
  const pages = [];
  const byType = {};

  while (queue.length && pages.length < maxPages) {
    const { url, depth } = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);

    let signals, title;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: perPageTimeoutMs }).catch(() => {});
      signals = await extractSignals(page, url, baseUrl);
      title = signals.title;
    } catch (e) {
      logger.debug?.(`[crawl] ${url}: ${e.message}`);
      continue;
    }

    const cls = classify(signals);
    pages.push({
      url, title, depth,
      type: cls.type, confidence: cls.confidence, scores: cls.scores,
      signals: trimSignals(signals),
    });
    byType[cls.type] = (byType[cls.type] || 0) + 1;
    logger.debug?.(`[crawl] d=${depth} ${cls.type}(${cls.confidence}) ${url}`);

    if (depth < maxDepth) {
      const links = signals.links.slice(0, 50);
      for (const href of links) {
        const u = sanitize(href);
        if (!u || visited.has(u)) continue;
        if (new URL(u).origin !== baseOrigin) continue;     // same-domain only
        // Skip obvious junk early — auth callbacks, file downloads, etc.
        if (/\.(pdf|zip|jpg|jpeg|png|gif|css|js)(\?|$)/i.test(u)) continue;
        if (/\/(api|graphql|webhook)\b/i.test(u)) continue;
        queue.push({ url: u, depth: depth + 1 });
      }
    }
  }

  return {
    siteId, baseUrl, generatedAt: new Date().toISOString(),
    pages,
    stats: { totalCrawled: pages.length, byType, durationMs: Date.now() - startedAt, queueRemaining: queue.length },
  };
}

/**
 * One Playwright evaluation pulls every signal we need to classify the page.
 * Kept as a single call so each crawled page is one round-trip.
 */
async function extractSignals(page, url, baseUrl) {
  const onPage = await page.evaluate(() => {
    const visible = el => el.offsetParent !== null;
    const links = Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href') || '')
      .filter(Boolean);
    const productLinkCount = Array.from(document.querySelectorAll('a'))
      .filter(a => /\/(product|products|item|p|dp)\//i.test(a.getAttribute('href') || '')).length;
    const hasForm = !!document.querySelector('form');
    const hasPasswordField = !!document.querySelector('input[type="password"]');
    const hasAddToCartCta = !!Array.from(document.querySelectorAll('button, a, [role="button"]'))
      .find(b => visible(b) && /add to (cart|bag|basket)|buy now/i.test(b.innerText || ''));
    const hasPriceText = /(₹|\$|€|£|RM\s?|MYR\s?|Rs\.?)\s?\d/.test((document.body.innerText || '').slice(0, 4000));

    // schema.org @type values (handles JSON-LD)
    const schemaTypes = [];
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(el.textContent || '{}');
        const items = Array.isArray(data) ? data : [data];
        for (const it of items) {
          if (it['@type']) schemaTypes.push(...[].concat(it['@type']));
        }
      } catch {}
    }

    return {
      title: document.title || '',
      body: (document.body.innerText || '').slice(0, 4000),
      links,
      productLinkCount,
      hasForm, hasPasswordField, hasAddToCartCta, hasPriceText,
      schemaTypes,
    };
  });

  return { url, isRoot: url.replace(/\/$/, '') === baseUrl.replace(/\/$/, ''), ...onPage };
}

function trimSignals(s) {
  return {
    productLinkCount: s.productLinkCount,
    hasForm: s.hasForm, hasPasswordField: s.hasPasswordField,
    hasAddToCartCta: s.hasAddToCartCta, hasPriceText: s.hasPriceText,
    schemaTypes: s.schemaTypes,
  };
}

module.exports = { crawl, extractSignals };
