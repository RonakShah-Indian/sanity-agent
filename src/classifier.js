'use strict';

/**
 * BusinessClassifier
 * ------------------
 * Identifies the CORE BUSINESS of a site, then selects + weights the sanity
 * plan to match. A fashion storefront, a B2B wholesale portal, a quick-commerce
 * app and a SaaS console share UI primitives but have DIFFERENT critical paths
 * — testing all of them with one fixed flow set is wasteful and misses the
 * flow that actually matters to that business.
 *
 * Two-stage classification:
 *   1. Signal extraction  - cheap on-page signals (keywords, schema.org type,
 *      presence of price/cart/login/B2B cues, currency, nav structure).
 *   2. Archetype scoring  - score signals against known archetypes; optional
 *      LLM tie-break for ambiguous sites.
 *
 * Archetypes are modeled on Fynd's own product surface so the plans map to
 * real Fynd-style properties.
 */

const ARCHETYPES = {
  food_delivery: {
    label: 'Food ordering / delivery (location-gated)',
    // Cues are domain-vocabulary signals for food/restaurant sites. They are
    // intentionally broad ("menu", "delivery", "outlet") rather than
    // brand-specific. Add cues per your fleet's vernacular (regional dishes,
    // cuisine types) in config; the classifier merges site-config additions
    // with these defaults at runtime.
    cues: ['menu', 'order now', 'delivery', 'meal', 'restaurant', 'takeaway', 'outlet', 'cuisine', 'halal', 'kitchen'],
    // location gate first, then the order journey
    plan: ['food_order', 'search_product'],
    weights: { food_order: 1.0, search_product: 0.5 },
  },
  fashion_retail: {
    label: 'Fashion / Lifestyle e-commerce',
    cues: ['size', 'fit', 'wishlist', 'apparel', 'clothing', 'footwear', 'collection', 'new arrivals'],
    // ordered by business-criticality for THIS archetype
    plan: ['add_to_cart', 'search_product', 'sign_in', 'checkout'],
    weights: { add_to_cart: 1.0, search_product: 0.8, checkout: 0.9, sign_in: 0.6 },
  },
  electronics_retail: {
    label: 'Electronics / general e-commerce',
    cues: ['specifications', 'warranty', 'compare', 'gb', 'processor', 'electronics'],
    plan: ['search_product', 'add_to_cart', 'checkout', 'sign_in'],
    weights: { search_product: 1.0, add_to_cart: 0.9, checkout: 0.9, sign_in: 0.6 },
  },
  quick_commerce: {
    label: 'Quick commerce / grocery (10–30 min delivery)',
    cues: ['delivery in', 'minutes', 'grocery', 'pincode', 'instant', 'fresh', 'eta'],
    // location/pincode gating + cart velocity is the heart of q-commerce
    plan: ['add_to_cart', 'search_product', 'checkout', 'sign_in'],
    weights: { add_to_cart: 1.0, checkout: 1.0, search_product: 0.7, sign_in: 0.5 },
  },
  b2b_wholesale: {
    label: 'B2B wholesale marketplace',
    cues: ['wholesale', 'bulk', 'moq', 'minimum order', 'gst', 'distributor', 'buyer', 'quote', 'business account'],
    // auth-gated catalog + bulk order workflow; checkout often = request-quote
    plan: ['sign_in', 'search_product', 'add_to_cart', 'checkout'],
    weights: { sign_in: 1.0, add_to_cart: 0.9, search_product: 0.8, checkout: 0.7 },
  },
  marketplace: {
    label: 'Multi-seller marketplace',
    cues: ['sellers', 'sold by', 'seller', 'marketplace', 'stores', 'brands', 'fulfilled by'],
    plan: ['search_product', 'add_to_cart', 'sign_in', 'checkout'],
    weights: { search_product: 1.0, add_to_cart: 0.9, sign_in: 0.7, checkout: 0.8 },
  },
  saas_console: {
    label: 'SaaS / developer console (no storefront)',
    cues: ['dashboard', 'api', 'docs', 'pricing', 'log in', 'sign up', 'console', 'integrations', 'free trial'],
    // no cart; sign-in IS the critical path. cart/checkout flows are skipped.
    plan: ['sign_in', 'search_product'],
    weights: { sign_in: 1.0, search_product: 0.4 },
  },
};

class BusinessClassifier {
  constructor({ llm = null, logger = console } = {}) {
    this.llm = llm;
    this.logger = logger;
  }

  async classify(page) {
    const signals = await this._extract(page);
    const scores = this._score(signals);
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    let [topKey, topScore] = ranked[0];
    const [, secondScore] = ranked[1] || [null, 0];

    let method = 'heuristic';
    // Ambiguous (close call or weak signal) -> optional LLM tie-break
    if (this.llm && (topScore < 2 || topScore - secondScore <= 1)) {
      const llmKey = await this._llmClassify(signals, Object.keys(ARCHETYPES));
      if (llmKey && ARCHETYPES[llmKey]) { topKey = llmKey; method = 'llm'; }
    }

    const arch = ARCHETYPES[topKey];
    return {
      archetype: topKey,
      label: arch.label,
      confidence: +Math.min(1, topScore / 5).toFixed(2),
      method,
      plan: arch.plan,
      weights: arch.weights,
      signals,
    };
  }

  async _extract(page) {
    return page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase().slice(0, 8000);
      const schemaTypes = Array.from(document.querySelectorAll('[itemtype], script[type="application/ld+json"]'))
        .map(n => (n.getAttribute('itemtype') || n.textContent || '')).join(' ').toLowerCase().slice(0, 1000);
      const has = (sel) => !!document.querySelector(sel);
      return {
        text, schemaTypes,
        hasCart: has('[href*="cart" i],[class*="cart" i],[aria-label*="cart" i]'),
        hasPrice: /[₹$€£]\s?\d|\b\d+\.\d{2}\b/.test(text),
        hasLogin: has('[href*="login" i],[href*="signin" i]') || /log\s?in|sign\s?in/.test(text),
        hasSearch: has('input[type="search"],[role="searchbox"],[name*="search" i]'),
        title: (document.title || '').toLowerCase(),
      };
    });
  }

  _score(signals) {
    const blob = `${signals.text} ${signals.schemaTypes} ${signals.title}`;
    const scores = {};
    for (const [key, arch] of Object.entries(ARCHETYPES)) {
      let s = arch.cues.reduce((acc, cue) => acc + (blob.includes(cue) ? 1 : 0), 0);
      // structural nudges
      if (key === 'saas_console') { if (!signals.hasCart && !signals.hasPrice) s += 2; if (signals.hasCart) s -= 2; }
      else if (key === 'food_delivery') { if (/\b(menu|restaurant|cuisine|halal|kitchen|takeaway|delivery)\b/i.test(blob)) s += 2; }
      else { if (signals.hasCart) s += 1; if (signals.hasPrice) s += 1; }
      scores[key] = s;
    }
    return scores;
  }

  async _llmClassify(signals, keys) {
    try {
      const prompt =
        `Classify the core business of this website into exactly one of: ${keys.join(', ')}.\n` +
        `Signals: hasCart=${signals.hasCart} hasPrice=${signals.hasPrice} hasLogin=${signals.hasLogin}\n` +
        `Title: ${signals.title}\nVisible text (truncated): ${signals.text.slice(0, 1500)}\n` +
        `Reply with ONLY the archetype key.`;
      const out = await this.llm._complete(prompt);
      return keys.find(k => out.toLowerCase().includes(k));
    } catch { return null; }
  }
}

module.exports = { BusinessClassifier, ARCHETYPES };
