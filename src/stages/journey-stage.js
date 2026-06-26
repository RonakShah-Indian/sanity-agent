'use strict';

const { AgentStage } = require('../pipeline/agent-stage');
const { FLOWS } = require('../intents');
const { plan: planFromSitemap, assignPriority } = require('../discovery/journey-planner');

/**
 * JourneyStage (Phase 3) — generate prioritized journeys for this site.
 *
 * Two modes, picked at runtime:
 *
 *   SITEMAP MODE (when DiscoveryStage produced ctx.sitemap):
 *     The JourneyPlanner filters FLOWS by which page types the crawler found
 *     on this site, AND prepends a navigate step to the discovered entry-URL
 *     for each flow that has one (e.g., sign_in → /auth/login). This is the
 *     design's "abstract step templates bound to discovered pages".
 *
 *   ARCHETYPE MODE (fallback, no sitemap):
 *     The classifier's archetype plan picks the flow set, just like before.
 *
 * Site config can override either mode with an explicit `flows` array.
 *
 * Output on the RunContext:
 *   ctx.plan      — ordered flow keys (used by ExecutionStage)
 *   ctx.journeys  — full Journey records with priority + steps
 *   ctx.tier      — full | smoke
 */
class JourneyStage extends AgentStage {
  get name() { return 'journey-generation'; }
  get required() { return true; }

  async execute(ctx, site) {
    if (!ctx.isFirstVariant) return;

    let journeys;
    // When the site has BOTH explicit flows AND a discovered sitemap, we use
    // the explicit flows AS THE PLAN but bind each one to a discovered entry
    // URL from the sitemap (the design's "abstract step templates bound to
    // discovered pages" promise, with manual scoping).
    if (site.flows && site.flows.length && ctx.sitemap) {
      const fullPlan = planFromSitemap(ctx.sitemap, ctx._weights || {});
      const byKey = Object.fromEntries(fullPlan.map(j => [j.key, j]));
      journeys = site.flows.map(key => byKey[key] || toJourneyFromFlow(key, ctx._weights || {}));
      ctx._planningMode = 'explicit-override + sitemap-binding';
      const boundEntries = journeys.map(j => j._entryUrl ? `${j.key}→${j._entryUrl}` : j.key).join(', ');
      ctx.logger.info?.(`[journey] discovery-bound plan: ${boundEntries}`);
    } else if (site.flows && site.flows.length) {
      // Explicit override, no discovery — use static flow templates as-is.
      journeys = site.flows.map(key => toJourneyFromFlow(key, ctx._weights));
      ctx._planningMode = 'explicit-override';
    } else if (ctx.sitemap) {
      // SITEMAP MODE — bind to discovered pages.
      journeys = planFromSitemap(ctx.sitemap, ctx._weights || {});
      ctx._planningMode = 'sitemap-driven';
      ctx.logger.info?.(`[journey] sitemap-driven plan from ${ctx.sitemap.stats.totalCrawled} pages → ${journeys.map(j => j.key).join(', ')}`);
    } else {
      // ARCHETYPE MODE — fall back to the classifier's plan.
      const archetypePlan = ctx._archetypePlan || ['search_product', 'add_to_cart', 'checkout'];
      journeys = archetypePlan.map(key => toJourneyFromFlow(key, ctx._weights || {}));
      ctx._planningMode = 'archetype-driven';
    }

    // Smoke-tier trims to the single highest-weight critical flow.
    if (site.smokeOnly) {
      journeys = journeys
        .filter(j => j.critical)
        .sort((a, b) => (b._weight || 0) - (a._weight || 0))
        .slice(0, 1);
      ctx.tier = 'smoke';
    } else {
      ctx.tier = site.tier || 'full';
    }

    // Site config can completely override the step list for any flow via
    // `flowSteps: { <flowKey>: [...steps] }`. This is the explicit-scripting
    // escape hatch for sites whose journey is too custom for the generic
    // flows (e.g. specific URL sequences, hover-required interactions).
    if (site.flowSteps) {
      for (const j of journeys) {
        if (Array.isArray(site.flowSteps[j.key])) {
          j.steps = site.flowSteps[j.key];
          j._customSteps = true;
        }
      }
    }

    ctx.journeys = journeys;
    ctx.plan = journeys.map(j => j.key);
    ctx.journeySteps = Object.fromEntries(journeys.map(j => [j.key, j.steps]));
  }
}

function toJourneyFromFlow(flowKey, weights) {
  const flow = FLOWS[flowKey];
  if (!flow) throw new Error(`Unknown flow: ${flowKey}`);
  const weight = weights[flowKey] || 0;
  return {
    key: flowKey, name: flow.name,
    priority: assignPriority(flowKey, weight),
    critical: !!flow.critical, steps: flow.steps, _weight: weight,
  };
}

module.exports = { JourneyStage };
