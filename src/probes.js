'use strict';

/**
 * Third-party dependency probes — Razorpay, Stripe, Algolia, Shopify Pay,
 * CDN providers, etc. Every commerce merchant depends on a constellation of
 * these. If one is degraded, blameless detection lets engineering point at
 * the right vendor instead of chasing internal phantom bugs.
 *
 *   "Cart failed on 6 merchants — but Razorpay is reporting elevated 5xx for
 *    the last 18 minutes. Probably their problem, not ours."
 *
 * Each probe just times an unauthenticated request to the provider's status
 * page (or a documented health endpoint). Read-only, no secrets.
 */

const DEFAULT_PROVIDERS = [
  { id: 'razorpay',    label: 'Razorpay',     statusUrl: 'https://status.razorpay.com/api/v2/status.json',   shape: 'statuspage' },
  { id: 'stripe',      label: 'Stripe',       statusUrl: 'https://www.stripe-status.com/api/v2/status.json', shape: 'statuspage' },
  { id: 'cloudflare',  label: 'Cloudflare',   statusUrl: 'https://www.cloudflarestatus.com/api/v2/status.json', shape: 'statuspage' },
  { id: 'cloudinary',  label: 'Cloudinary',   statusUrl: 'https://status.cloudinary.com/api/v2/status.json', shape: 'statuspage' },
  { id: 'algolia',     label: 'Algolia',      statusUrl: 'https://status.algolia.com/api/v2/status.json',    shape: 'statuspage' },
  { id: 'aws',         label: 'AWS',          statusUrl: 'https://health.aws.amazon.com/health/api/health',  shape: 'ping' },
];

async function runProbes(providers = DEFAULT_PROVIDERS, { timeoutMs = 5000 } = {}) {
  const out = {};
  await Promise.all(providers.map(async (p) => {
    out[p.id] = await probe(p, timeoutMs);
  }));
  return {
    generatedAt: new Date().toISOString(),
    providers: out,
    any_degraded: Object.values(out).some(p => p.status !== 'operational' && p.status !== 'unknown'),
  };
}

async function probe(p, timeoutMs) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(p.statusUrl, { signal: ctrl.signal, headers: { 'user-agent': 'sanity-agent/1.0' } });
    const latencyMs = Date.now() - t0;
    if (!r.ok) return { label: p.label, status: 'unreachable', latencyMs, http: r.status };
    if (p.shape === 'statuspage') {
      const body = await r.json();
      const indicator = body?.status?.indicator || 'unknown';   // 'none' | 'minor' | 'major' | 'critical'
      const description = body?.status?.description || null;
      return {
        label: p.label, latencyMs,
        status: indicator === 'none' ? 'operational' : indicator,
        description,
      };
    }
    return { label: p.label, status: 'operational', latencyMs };
  } catch (e) {
    return { label: p.label, status: 'unknown', error: String(e.message || e), latencyMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide whether a degraded provider likely caused a flow failure. Heuristic,
 * not perfect — but enough to redirect blame in the right direction.
 */
function correlateFailureToProvider(failedFlowKey, probeResult) {
  if (!probeResult?.any_degraded) return null;
  const offenders = Object.entries(probeResult.providers).filter(([, v]) => v.status !== 'operational' && v.status !== 'unknown');
  const flowToProviders = {
    checkout:     ['razorpay', 'stripe'],
    add_to_cart:  ['cloudflare'],
    search_product: ['algolia', 'cloudflare'],
    sign_in:      ['cloudflare'],
  };
  const candidates = flowToProviders[failedFlowKey] || [];
  return offenders
    .filter(([id]) => candidates.includes(id))
    .map(([id, v]) => ({ provider: id, label: v.label, status: v.status, description: v.description || null }));
}

module.exports = { runProbes, correlateFailureToProvider, DEFAULT_PROVIDERS };
