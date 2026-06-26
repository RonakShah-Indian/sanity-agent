'use strict';

/**
 * Phase 2 — Business-impact scoring.
 *
 * Converts test outcomes ("checkout: failed") into business outcomes
 * ("₹18,000/hour estimated revenue loss on this merchant; ₹4.2 Cr/hour
 * across the platform"). The model is intentionally simple — three knobs:
 *
 *   impact_per_hour  =  traffic_per_hour  ×  attemptRate  ×  aov  ×  severity
 *
 *   - traffic_per_hour:  estimated hourly visitors (per-site override or
 *                        archetype median fallback)
 *   - attemptRate     :  fraction of those visitors who exercise this flow
 *   - aov             :  average order value (per-site override or median)
 *   - severity        :  fraction of those attempts that fail when the flow
 *                        is broken (1.0 = total loss)
 *
 * All defaults live in config/impact.defaults.json — editable without
 * touching code. Per-site fields traffic_per_hour, aov, region, currency
 * override the defaults.
 *
 * This module is pure: no I/O, no fetch, no LLM. Tests run in milliseconds.
 */

const fs = require('fs');
const path = require('path');

function loadDefaults(configPath) {
  const p = configPath || path.resolve(__dirname, '..', 'config/impact.defaults.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function lookupTraffic(site, archetype, defaults) {
  if (Number.isFinite(site.traffic_per_hour)) return site.traffic_per_hour;
  const arch = defaults.archetype_overrides?.[archetype];
  if (arch && Number.isFinite(arch.traffic_per_hour)) return arch.traffic_per_hour;
  return defaults.median_traffic_per_hour;
}

function lookupAOV(site, archetype, defaults) {
  if (Number.isFinite(site.aov)) return site.aov;
  const arch = defaults.archetype_overrides?.[archetype];
  if (arch && Number.isFinite(arch.aov)) return arch.aov;
  return defaults.median_aov;
}

function lookupFunnel(archetype, flowKey, defaults) {
  const def = defaults.funnel?._default?.[flowKey] || { attemptRate: 0, severity: 0 };
  const archEntry = defaults.funnel?.[archetype]?.[flowKey];
  return { ...def, ...(archEntry || {}) };
}

/**
 * Score a single site result. Mutates the result by adding a business_impact
 * field; returns the same result for chaining.
 *
 * Failed flows ⇒ full impact. Degraded flows ⇒ half impact (the soft signal).
 * Passed flows ⇒ zero impact but still listed (so the report shows what's
 * "at risk" should that flow break).
 */
function scoreSite(result, defaults) {
  const archetype = result.business?.archetype || 'unknown';
  const traffic = lookupTraffic(result, archetype, defaults);
  const aov = lookupAOV(result, archetype, defaults);
  const currency = result.currency || defaults.currency || 'INR';

  // Roll up flow status across viewports — worst status per flow key.
  const byFlow = new Map();
  for (const f of result.flows || []) {
    const prev = byFlow.get(f.key) || { status: 'passed' };
    byFlow.set(f.key, { status: worstFlowStatus(prev.status, f.status), key: f.key });
  }

  const per_flow = [];
  let total_failed = 0;
  let total_at_risk = 0;

  for (const [flowKey, info] of byFlow) {
    const { attemptRate, severity } = lookupFunnel(archetype, flowKey, defaults);
    const peak = Math.round(traffic * attemptRate * aov * severity);
    let realised = 0;
    if (info.status === 'failed') realised = peak;
    else if (info.status === 'degraded' || info.status === 'quarantined') realised = Math.round(peak * 0.5);

    per_flow.push({ flow: flowKey, status: info.status, peak_impact_per_hour: peak, realised_impact_per_hour: realised });
    if (realised > 0) total_failed += realised;
    if (info.status === 'passed') total_at_risk += peak;
  }

  result.business_impact = {
    currency,
    realised_impact_per_hour: total_failed,
    at_risk_impact_per_hour: total_at_risk,
    inputs: { traffic_per_hour: traffic, aov, archetype, region: result.region || null },
    basis: {
      trafficSource: Number.isFinite(result.traffic_per_hour) ? 'site-override' : (defaults.archetype_overrides?.[archetype] ? 'archetype-median' : 'global-median'),
      aovSource:     Number.isFinite(result.aov)              ? 'site-override' : (defaults.archetype_overrides?.[archetype] ? 'archetype-median' : 'global-median'),
    },
    per_flow,
  };
  return result;
}

/**
 * Aggregate per-platform numbers across all results. Returns an object that
 * gets attached to run.summary.impact.
 */
function aggregateImpact(results, defaults) {
  const currency = defaults.currency || 'INR';
  let total_realised = 0;
  let total_at_risk = 0;
  const by_archetype = new Map();
  const by_region = new Map();
  const top_offenders = [];

  for (const r of results) {
    const bi = r.business_impact;
    if (!bi) continue;
    total_realised += bi.realised_impact_per_hour;
    total_at_risk += bi.at_risk_impact_per_hour;

    const a = bi.inputs.archetype || 'unknown';
    const reg = bi.inputs.region || 'unknown';
    by_archetype.set(a, (by_archetype.get(a) || 0) + bi.realised_impact_per_hour);
    by_region.set(reg, (by_region.get(reg) || 0) + bi.realised_impact_per_hour);

    if (bi.realised_impact_per_hour > 0) {
      top_offenders.push({ site: r.site, archetype: a, region: reg, impact_per_hour: bi.realised_impact_per_hour });
    }
  }

  top_offenders.sort((a, b) => b.impact_per_hour - a.impact_per_hour);

  return {
    currency,
    total_realised_per_hour: total_realised,
    total_at_risk_per_hour: total_at_risk,
    by_archetype: Object.fromEntries([...by_archetype.entries()].sort((a, b) => b[1] - a[1])),
    by_region:    Object.fromEntries([...by_region.entries()].sort((a, b) => b[1] - a[1])),
    top_offenders: top_offenders.slice(0, 10),
  };
}

const FLOW_RANK = { passed: 0, degraded: 1, quarantined: 1, failed: 2, error: 3 };
function worstFlowStatus(a, b) { return (FLOW_RANK[b] ?? 0) > (FLOW_RANK[a] ?? 0) ? b : a; }

// Format helper for the reporter — locale-aware, currency-aware.
function formatMoney(amount, currency) {
  if (!Number.isFinite(amount) || amount === 0) return `0 ${currency}`;
  const sym = { INR: '₹', USD: '$', EUR: '€', GBP: '£' }[currency] || `${currency} `;
  if (amount >= 1e7) return `${sym}${(amount / 1e7).toFixed(2)} Cr`;
  if (amount >= 1e5) return `${sym}${(amount / 1e5).toFixed(2)} L`;
  if (amount >= 1e3) return `${sym}${(amount / 1e3).toFixed(1)}K`;
  return `${sym}${Math.round(amount).toLocaleString('en-IN')}`;
}

module.exports = { loadDefaults, scoreSite, aggregateImpact, formatMoney };
