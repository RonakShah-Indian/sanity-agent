'use strict';

/**
 * PageClassifier — Phase 2's "what kind of page is this?" labeler.
 *
 * Cheap heuristics first, AI as the exception (the design's rule). Each signal
 * contributes a weighted score per candidate page type; the top score wins.
 * If the lead is narrow and an LLM is available, a tie-break call may be made.
 *
 * Page types (matches the design's expected sitemap shape):
 *   home · search · category · product · login · register · cart · checkout ·
 *   account · static (anything else)
 */

const SIGNALS = [
  // Strongest signals first; lighter heuristics last.
  { type: 'checkout', test: ({ url, body, hasForm }) =>
      /\/(checkout|payment|order\/?(review|confirm)?)/i.test(url) ||
      (hasForm && /credit\s?card|cvv|card number|expiry/i.test(body)) ? 3 : 0 },

  { type: 'cart', test: ({ url, body }) =>
      /\/(cart|bag|basket)\b/i.test(url) ? 3
      : /your (cart|bag|basket)|shopping (cart|bag)/i.test(body) ? 1 : 0 },

  { type: 'login', test: ({ url, body, hasPasswordField }) =>
      /\/(login|signin|sign-in|auth)/i.test(url) || hasPasswordField ? 3
      : /sign in|log in|forgot password/i.test(body) ? 1 : 0 },

  { type: 'register', test: ({ url, body }) =>
      /\/(register|signup|sign-up|join)/i.test(url) ? 3
      : /create (an? )?account|sign up/i.test(body) ? 1 : 0 },

  { type: 'product', test: ({ url, schemaTypes, hasPriceText, hasAddToCartCta }) => {
      let s = 0;
      if (/\/(product|products|item|p|dp)\//i.test(url)) s += 3;
      if (schemaTypes.includes('Product')) s += 3;
      if (hasAddToCartCta) s += 2;
      if (hasPriceText) s += 1;
      return s;
    } },

  { type: 'category', test: ({ url, body, productLinkCount }) => {
      let s = 0;
      if (/\/(category|categories|collection|collections|shop|browse|c|sections)\b/i.test(url)) s += 2;
      if (productLinkCount >= 6) s += 2;
      if (/showing \d+ (of |results)|filter by/i.test(body)) s += 1;
      return s;
    } },

  { type: 'search', test: ({ url, body, productLinkCount }) => {
      let s = 0;
      if (/\/(search|results)\?/i.test(url) || /[?&]q=/i.test(url)) s += 3;
      if (/\d+ results|no results found/i.test(body)) s += 1;
      if (productLinkCount >= 4) s += 1;
      return s;
    } },

  { type: 'account', test: ({ url }) =>
      /\/(account|profile|orders|my-?(account|orders))/i.test(url) ? 2 : 0 },

  { type: 'home', test: ({ url, isRoot }) => isRoot || url.replace(/\/$/, '').split('/').length <= 3 ? 1 : 0 },
];

/**
 * Score the page and return the best-fit type along with the signal map.
 * The `signals` object is what's been extracted from the page (see
 * extractSignals in sitemap-crawler.js).
 */
function classify(signals) {
  const scores = {};
  for (const { type, test } of SIGNALS) {
    const v = test(signals);
    if (v > 0) scores[type] = (scores[type] || 0) + v;
  }
  // Pick top score; fall back to 'static' if everything is zero.
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { type: 'static', confidence: 0, scores };
  const [topType, topScore] = ranked[0];
  const second = ranked[1]?.[1] || 0;
  const confidence = +Math.min(1, (topScore - second + 1) / 4).toFixed(2);
  return { type: topType, confidence, scores };
}

module.exports = { classify, SIGNALS };
