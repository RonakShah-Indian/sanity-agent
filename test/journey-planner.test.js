'use strict';

/**
 * Unit tests for Phase 3 JourneyPlanner. Pure function — no browser needed.
 * Each test seeds a synthetic sitemap and asserts the planner picks the right
 * journeys, with the right priorities, and binds entry-URLs where applicable.
 */

const assert = require('assert');
const { plan, assignPriority } = require('../src/discovery/journey-planner');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}\n   ${e.message}`); }
}

const mkPage = (type, url) => ({ type, url, depth: 1, confidence: 1, scores: {}, signals: {} });

const fullSitemap = {
  siteId: 'shop', baseUrl: 'https://shop.example', generatedAt: '2026-06-24',
  pages: [
    mkPage('home',     'https://shop.example/'),
    mkPage('search',   'https://shop.example/search'),
    mkPage('category', 'https://shop.example/c/men'),
    mkPage('product',  'https://shop.example/product/sneakers'),
    mkPage('login',    'https://shop.example/auth/login'),
    mkPage('cart',     'https://shop.example/cart'),
    mkPage('checkout', 'https://shop.example/checkout'),
  ],
  stats: { totalCrawled: 7, byType: { home:1, search:1, category:1, product:1, login:1, cart:1, checkout:1 } },
};

// --- Tests ----------------------------------------------------------------

test('full sitemap → produces sign_in, search_product, add_to_cart, checkout', () => {
  const journeys = plan(fullSitemap, { search_product: 0.8, add_to_cart: 1.0, checkout: 0.9, sign_in: 0.6 });
  const keys = journeys.map(j => j.key);
  assert.ok(keys.includes('sign_in'));
  assert.ok(keys.includes('search_product'));
  assert.ok(keys.includes('add_to_cart'));
  assert.ok(keys.includes('checkout'));
});

test('revenue-path journeys are P0; search is P1; everything else P2', () => {
  const journeys = plan(fullSitemap, { search_product: 0.8 });
  const byKey = Object.fromEntries(journeys.map(j => [j.key, j.priority]));
  assert.strictEqual(byKey.checkout, 'P0');
  assert.strictEqual(byKey.add_to_cart, 'P0');
  assert.strictEqual(byKey.sign_in, 'P0');
  assert.strictEqual(byKey.search_product, 'P1');     // weight 0.8 ≥ 0.5
});

test('sign_in journey gets the discovered /auth/login URL prepended', () => {
  const journeys = plan(fullSitemap, {});
  const signIn = journeys.find(j => j.key === 'sign_in');
  assert.ok(signIn);
  assert.strictEqual(signIn._entryUrl, 'https://shop.example/auth/login');
  assert.strictEqual(signIn.steps[0].action, 'navigate');
  assert.strictEqual(signIn.steps[0].url, 'https://shop.example/auth/login');
});

test('checkout journey gets the discovered /cart URL prepended', () => {
  const journeys = plan(fullSitemap, {});
  const co = journeys.find(j => j.key === 'checkout');
  assert.strictEqual(co.steps[0].action, 'navigate');
  assert.strictEqual(co.steps[0].url, 'https://shop.example/cart');
});

test('no login page found → no sign_in journey', () => {
  const sitemap = { ...fullSitemap, pages: fullSitemap.pages.filter(p => p.type !== 'login'),
                    stats: { ...fullSitemap.stats, byType: { ...fullSitemap.stats.byType, login: 0 } } };
  const journeys = plan(sitemap, {});
  assert.ok(!journeys.find(j => j.key === 'sign_in'));
});

test('no cart page found → no checkout journey', () => {
  const sitemap = { ...fullSitemap, pages: fullSitemap.pages.filter(p => p.type !== 'cart'),
                    stats: { ...fullSitemap.stats, byType: { ...fullSitemap.stats.byType, cart: 0 } } };
  const journeys = plan(sitemap, {});
  assert.ok(!journeys.find(j => j.key === 'checkout'));
});

test('no product page found → no add_to_cart journey', () => {
  const sitemap = { ...fullSitemap, pages: fullSitemap.pages.filter(p => p.type !== 'product'),
                    stats: { ...fullSitemap.stats, byType: { ...fullSitemap.stats.byType, product: 0 } } };
  const journeys = plan(sitemap, {});
  assert.ok(!journeys.find(j => j.key === 'add_to_cart'));
});

test('explicit override bypasses sitemap and uses the provided keys', () => {
  const journeys = plan(fullSitemap, {}, ['sign_in', 'checkout']);
  assert.deepStrictEqual(journeys.map(j => j.key), ['sign_in', 'checkout']);
});

test('empty/null sitemap returns []', () => {
  assert.deepStrictEqual(plan(null, {}), []);
  assert.deepStrictEqual(plan({ pages: [] }, {}), []);
});

test('output is sorted P0 → P1 → P2', () => {
  const journeys = plan(fullSitemap, { search_product: 0.8 });
  const priorities = journeys.map(j => j.priority);
  for (let i = 1; i < priorities.length; i++) {
    assert.ok(priorities[i - 1] <= priorities[i],
      `out-of-order priorities: ${priorities.join(', ')}`);
  }
});

test('assignPriority basics', () => {
  assert.strictEqual(assignPriority('checkout', 0), 'P0');
  assert.strictEqual(assignPriority('add_to_cart', 0), 'P0');
  assert.strictEqual(assignPriority('search_product', 0.8), 'P1');
  assert.strictEqual(assignPriority('search_product', 0.2), 'P2');
});

console.log(failed === 0 ? '\nJOURNEY-PLANNER TESTS PASSED ✅' : `\n${failed} test(s) failed ❌`);
process.exit(failed ? 1 : 0);
