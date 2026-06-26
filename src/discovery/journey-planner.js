'use strict';

const { FLOWS } = require('../intents');

/**
 * JourneyPlanner — Phase 3 of the design.
 *
 * Takes a sitemap (produced by DiscoveryStage) and a business archetype
 * (produced by ClassificationStage) and emits a prioritized list of Journey
 * records whose requirements are satisfied by the discovered pages.
 *
 * This is the design's "abstract step templates bound to the pages Discovery
 * found" — instead of running the same 4 flows on every site, we run only
 * the journeys that make sense for THIS site, and we point them at the right
 * entry-URLs.
 *
 * Each FLOWS entry has an implicit dependency on page types. We declare those
 * here (alongside the flow lib, not inside it, so intents.js stays focused).
 *
 *   sign_in           → requires a login page
 *   search_product    → no specific requirement (search box is usually global)
 *   add_to_cart       → requires a product (or category to find one)
 *   checkout          → requires a cart page (checkout page is a bonus)
 *   browse_add_to_cart → requires a product or category page reachable from
 *                        the landing URL (food/quick-commerce style menus)
 *   food_order        → requires the same (location-gated menu)
 */

const REQUIREMENTS = {
  sign_in:            { needs: ['login'],    entry: 'login' },
  search_product:     { needs: [],            entry: null },
  // Phase 3 wires add_to_cart / browse_add_to_cart to a DISCOVERED product
  // URL when one exists. Bypasses search-results race conditions and
  // homepage-only inline-add gating: the agent navigates directly to a
  // known-good PDP the crawler found, then runs the standard add steps.
  add_to_cart:        { needs: ['product'],   entry: 'product' },
  checkout:           { needs: ['cart'],      entry: 'cart' },
  browse_add_to_cart: { needs: ['product'],   entry: 'product' },
  food_order:         { needs: [],            entry: null },
};

/** Priority assignment — revenue path is P0, search/UX is P1, rest P2.
 *  Mirrors the design's PriorityEngine. */
const REVENUE_PATH = new Set(['checkout', 'add_to_cart', 'sign_in', 'food_order', 'browse_add_to_cart']);
function assignPriority(flowKey, archetypeWeight) {
  if (REVENUE_PATH.has(flowKey)) return 'P0';
  if ((archetypeWeight ?? 0) >= 0.5) return 'P1';
  return 'P2';
}

/**
 * Produce a list of Journey records that this site's sitemap supports.
 *
 * @param {object} sitemap         — from DiscoveryStage; { pages: [{type, url}, ...] }
 * @param {object} archetypeWeights — from ClassificationStage; per-flow weights
 * @param {string[]} explicitFlows — site config override (skip planning entirely if set)
 * @returns {object[]} ordered journey records
 */
function plan(sitemap, archetypeWeights = {}, explicitFlows = null) {
  // Site config can pin an explicit set; planner respects that.
  if (explicitFlows && explicitFlows.length) {
    return explicitFlows.map(key => toJourney(key, archetypeWeights, null));
  }

  if (!sitemap || !Array.isArray(sitemap.pages) || sitemap.pages.length === 0) return [];

  const typeCounts = sitemap.pages.reduce((m, p) => { m[p.type] = (m[p.type] || 0) + 1; return m; }, {});
  const firstByType = sitemap.pages.reduce((m, p) => { if (!m[p.type]) m[p.type] = p.url; return m; }, {});

  // Try every FLOWS entry; keep ones whose dependencies are met.
  const journeys = [];
  for (const flowKey of Object.keys(FLOWS)) {
    const req = REQUIREMENTS[flowKey];
    if (!req) continue;                                       // unknown flow, skip
    const needsMet = req.needs.every(t => (typeCounts[t] || 0) > 0);
    if (!needsMet) continue;
    journeys.push(toJourney(flowKey, archetypeWeights, req.entry ? firstByType[req.entry] : null));
  }

  // Order by priority (P0 first) then by archetype weight.
  return journeys.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority.localeCompare(b.priority);
    return (b._weight || 0) - (a._weight || 0);
  });
}

function toJourney(flowKey, weights, entryUrl) {
  const flow = FLOWS[flowKey];
  if (!flow) throw new Error(`Unknown flow: ${flowKey}`);
  const weight = weights[flowKey] || 0;
  const priority = assignPriority(flowKey, weight);

  // When the sitemap gave us a direct entry URL for this flow (e.g. /login for
  // sign_in), prepend a navigate step so we don't have to hunt for the entry
  // point on the homepage. This is the actual "bind step templates to pages
  // discovered" mechanic from the design.
  const steps = entryUrl
    ? [{ action: 'navigate', url: entryUrl, note: `direct-to-${flowKey}-entry from sitemap` }, ...flow.steps]
    : flow.steps;

  return {
    key: flowKey,
    name: flow.name,
    priority,
    critical: !!flow.critical,
    steps,
    _weight: weight,
    _entryUrl: entryUrl,
  };
}

module.exports = { plan, assignPriority, REQUIREMENTS };
