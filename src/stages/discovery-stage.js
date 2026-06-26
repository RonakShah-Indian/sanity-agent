'use strict';

const { AgentStage } = require('../pipeline/agent-stage');
const { crawl } = require('../discovery/sitemap-crawler');

/**
 * DiscoveryStage (Phase 2) — per-site page discovery.
 *
 * Runs only when the site asks for it (site.discoverPages = true) and only
 * on the first variant. Crawls a bounded BFS of the site, classifies each
 * page, and attaches the sitemap to ctx.sitemap for later stages (and the
 * dashboard) to consume.
 *
 * Off by default — page-crawling adds 10-30s per site and isn't needed when
 * the journey set is fixed in `intents.js`. Once Phase 3's JourneyAgent
 * generates journeys from the discovered structure, this flips to on.
 */
class DiscoveryStage extends AgentStage {
  get name() { return 'discovery'; }

  async execute(ctx, site) {
    if (!ctx.isFirstVariant) return;
    if (!site.discoverPages) return;       // opt-in

    const opts = site.discovery || {};
    const sitemap = await crawl(ctx.page, {
      baseUrl: site.url,
      siteId: site.id,
      maxDepth: opts.maxDepth ?? 2,
      maxPages: opts.maxPages ?? 25,
      perPageTimeoutMs: opts.perPageTimeoutMs ?? 8000,
      logger: ctx.logger,
    });
    ctx.sitemap = sitemap;
    ctx.logger.info?.(`[discovery] ${site.id}: crawled ${sitemap.stats.totalCrawled} pages — by type: ${JSON.stringify(sitemap.stats.byType)}`);

    // Re-navigate to the homepage so subsequent stages start at the canonical entry point.
    await ctx.page.goto(site.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
}

module.exports = { DiscoveryStage };
