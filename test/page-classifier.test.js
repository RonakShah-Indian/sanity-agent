'use strict';

/**
 * Unit tests for the Phase 2 PageClassifier. Pure function — no browser needed.
 * Each test seeds a `signals` object and asserts the classifier picks the right type.
 */

const assert = require('assert');
const { classify } = require('../src/discovery/page-classifier');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}\n   ${e.message}`); }
}

const baseSignals = {
  url: 'https://example.com/',
  body: '', links: [], productLinkCount: 0,
  hasForm: false, hasPasswordField: false, hasAddToCartCta: false, hasPriceText: false,
  schemaTypes: [], isRoot: false,
};

// --- Strong URL signals ----------------------------------------------------
test('checkout page identified by URL', () => {
  const r = classify({ ...baseSignals, url: 'https://example.com/checkout/payment' });
  assert.strictEqual(r.type, 'checkout');
});

test('cart page identified by URL', () => {
  const r = classify({ ...baseSignals, url: 'https://example.com/cart' });
  assert.strictEqual(r.type, 'cart');
});

test('login page identified by URL', () => {
  const r = classify({ ...baseSignals, url: 'https://example.com/auth/login' });
  assert.strictEqual(r.type, 'login');
});

test('login page identified by password field even without URL hint', () => {
  const r = classify({ ...baseSignals, url: 'https://example.com/x', hasPasswordField: true });
  assert.strictEqual(r.type, 'login');
});

test('product page identified by schema.org Product + URL', () => {
  const r = classify({
    ...baseSignals,
    url: 'https://example.com/product/cool-thing',
    schemaTypes: ['Product'], hasAddToCartCta: true, hasPriceText: true,
  });
  assert.strictEqual(r.type, 'product');
  assert.ok(r.confidence >= 0.5);
});

test('product page identified by add-to-cart CTA even without product URL', () => {
  const r = classify({
    ...baseSignals,
    url: 'https://example.com/items/xyz',
    hasAddToCartCta: true, hasPriceText: true, schemaTypes: ['Product'],
  });
  assert.strictEqual(r.type, 'product');
});

test('category page identified by many product links', () => {
  const r = classify({
    ...baseSignals,
    url: 'https://example.com/collection/women',
    productLinkCount: 24, body: 'Showing 100 results',
  });
  assert.strictEqual(r.type, 'category');
});

test('search results page identified by ?q= and result text', () => {
  const r = classify({
    ...baseSignals,
    url: 'https://example.com/search?q=lipstick',
    productLinkCount: 12, body: '142 results found',
  });
  assert.strictEqual(r.type, 'search');
});

test('homepage identified by root URL', () => {
  const r = classify({ ...baseSignals, url: 'https://example.com/', isRoot: true });
  assert.strictEqual(r.type, 'home');
});

test('static page fallback when no signals fire', () => {
  const r = classify({ ...baseSignals, url: 'https://example.com/about/terms' });
  assert.strictEqual(r.type, 'static');
  assert.strictEqual(r.confidence, 0);
});

test('confidence reflects margin over second-place type', () => {
  const r = classify({
    ...baseSignals,
    url: 'https://example.com/cart',         // strong cart match (3)
    productLinkCount: 24,                    // category-ish (2)
  });
  assert.strictEqual(r.type, 'cart');
  assert.ok(r.confidence > 0);
});

console.log(failed === 0 ? '\nPAGE-CLASSIFIER TESTS PASSED ✅' : `\n${failed} test(s) failed ❌`);
process.exit(failed ? 1 : 0);
