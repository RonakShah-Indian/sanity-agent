'use strict';

/**
 * Phase 3 — Shopper personas.
 *
 * A persona is a *modifier* on the existing flow library, not a new flow.
 * It tells the agent: "run the same critical flows, but with THIS shopper's
 * query, on THIS viewport, and assert THESE additional facts when done."
 *
 * Same flow library. Same resolver ladder. Same learned profiles. The
 * persona axis only affects the run *context*. Cheap to add, but it's
 * the difference between "checkout passed" and "checkout passed for
 * budget shoppers; gift buyers can't find gift wrap; B2B reorder fails
 * because bulk pricing is broken."
 *
 * Validators that ship today:
 *   mustSee     : every string in the list must appear in page text  (AND)
 *   mustSeeAny  : at least one string must appear                    (OR)
 *   mustNotSee  : none of these strings may appear
 *   maxLoadMs   : page goto duration must be ≤ this
 *
 * Extending is trivial — add a key to PERSONAS or to a site-local override.
 */

const PERSONAS = {
  budget_hunter: {
    label: 'Budget hunter (mobile, value-seeker)',
    viewport: 'iphone-14',
    query: 'sale',
    validators: {
      mustSeeAny: ['sale', 'off', 'discount', 'deal'],
      mustNotSee: ['premium members only', 'exclusive to vip'],
      maxLoadMs: 6000,
    },
  },
  gift_buyer: {
    label: 'Gift buyer (desktop, deliberate)',
    viewport: 'desktop-1440',
    query: 'gift',
    validators: {
      mustSeeAny: ['gift', 'present', 'wrap'],
      maxLoadMs: 8000,
    },
  },
  b2b_reorder: {
    label: 'B2B reorder (desktop, bulk)',
    viewport: 'desktop-1440',
    query: 'bulk',
    validators: {
      mustSeeAny: ['quantity', 'bulk', 'wholesale', 'reorder', 'min order'],
      maxLoadMs: 8000,
    },
  },
  genz_mobile: {
    label: 'Gen-Z mobile (fast, social-pay)',
    viewport: 'pixel-7',
    validators: {
      mustSeeAny: ['UPI', 'BNPL', 'pay later', 'wallet', 'paytm', 'phonepe'],
      maxLoadMs: 4000,
    },
  },
  first_time: {
    label: 'First-time visitor (no account, no history)',
    viewport: 'desktop-1440',
    validators: {
      maxLoadMs: 6000,
    },
  },
};

/**
 * Resolve a site's persona list to concrete persona configs.
 * Sites can name built-in personas as strings, or inline a full object to
 * override / extend. The persona's `viewport` is matched by name against
 * the site's `viewports` catalog; if not found, the persona's own viewport
 * spec or the default desktop is used.
 */
function resolvePersonas(site) {
  if (!Array.isArray(site.personas) || site.personas.length === 0) return [];
  const viewportCatalog = new Map((site.viewports || []).map(v => [v.name || v.device, v]));

  return site.personas.map(entry => {
    const ref = typeof entry === 'string' ? { name: entry } : { ...entry };
    const base = ref.name && PERSONAS[ref.name] ? PERSONAS[ref.name] : {};
    const merged = {
      name: ref.name || base.label || 'unnamed-persona',
      label: ref.label || base.label || ref.name || 'persona',
      viewport: ref.viewport || base.viewport || null,
      query: ref.query || base.query || null,
      validators: { ...(base.validators || {}), ...(ref.validators || {}) },
    };
    // Resolve viewport reference: if it's a string, look it up in the site's catalog.
    if (typeof merged.viewport === 'string') {
      merged.viewportConfig = viewportCatalog.get(merged.viewport) || { name: merged.viewport, device: merged.viewport };
    } else if (merged.viewport && typeof merged.viewport === 'object') {
      merged.viewportConfig = merged.viewport;
    } else {
      merged.viewportConfig = { name: 'desktop', viewport: { width: 1280, height: 800 } };
    }
    return merged;
  });
}

/**
 * Apply a persona's validators against a Playwright page after flows run.
 * Returns an array of findings; an empty array means everything passed.
 *
 * Each finding: { kind, status: 'failed'|'warning', detail }
 */
async function applyValidators(page, persona, runMetrics) {
  const findings = [];
  const v = persona.validators || {};

  let bodyText = '';
  if (v.mustSee?.length || v.mustSeeAny?.length || v.mustNotSee?.length) {
    try {
      bodyText = (await page.locator('body').innerText({ timeout: 2000 })).toLowerCase();
    } catch {
      findings.push({ kind: 'page-unreachable', status: 'failed', detail: 'could not read body text for content validators' });
      return findings;
    }
  }

  if (v.mustSee?.length) {
    const missing = v.mustSee.filter(t => !bodyText.includes(t.toLowerCase()));
    if (missing.length) findings.push({ kind: 'mustSee', status: 'failed', detail: `missing required terms: ${missing.join(', ')}` });
  }
  if (v.mustSeeAny?.length) {
    const any = v.mustSeeAny.some(t => bodyText.includes(t.toLowerCase()));
    if (!any) findings.push({ kind: 'mustSeeAny', status: 'failed', detail: `none of these terms present: ${v.mustSeeAny.join(', ')}` });
  }
  if (v.mustNotSee?.length) {
    const banned = v.mustNotSee.filter(t => bodyText.includes(t.toLowerCase()));
    if (banned.length) findings.push({ kind: 'mustNotSee', status: 'failed', detail: `banned terms present: ${banned.join(', ')}` });
  }
  if (Number.isFinite(v.maxLoadMs) && runMetrics?.navMs > v.maxLoadMs) {
    findings.push({ kind: 'maxLoadMs', status: 'failed', detail: `nav ${runMetrics.navMs}ms > budget ${v.maxLoadMs}ms` });
  }

  return findings;
}

module.exports = { PERSONAS, resolvePersonas, applyValidators };
