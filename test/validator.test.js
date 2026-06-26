'use strict';
const assert = require('assert');
const { ContentValidator } = require('../src/validator');

// fake page: validateListing reads via page.evaluate; we script its return.
function listingPage(products) {
  return {
    _url: 'https://shop.example/listing',
    url() { return this._url; },
    async evaluate() { return products; },
    async goto() {},
    async waitForTimeout() {},
  };
}

(async () => {
  // --- All good: images loaded, prices present ---
  {
    const v = new ContentValidator({ page: listingPage([
      { title: 'Shoe A', priceValue: 1999, priceText: '₹1999', imgSrc: 'https://x/a.jpg', imgLoaded: true, href: 'https://x/a' },
      { title: 'Shoe B', priceValue: 2499, priceText: '₹2499', imgSrc: 'https://x/b.jpg', imgLoaded: true, href: 'https://x/b' },
    ]) });
    const res = await v.validateListing();
    assert.strictEqual(res.scanned, 2);
    assert.ok(!res.findings.some(f => f.severity === 'high'), 'no high findings when all good');
    assert.ok(res.findings.some(f => f.check === 'cards_complete' && f.severity === 'info'));
    console.log('✓ Validator: clean listing → all cards complete, no defects');
  }

  // --- Broken image + missing price flagged high ---
  {
    const v = new ContentValidator({ page: listingPage([
      { title: 'Shoe A', priceValue: 1999, priceText: '₹1999', imgSrc: 'https://x/a.jpg', imgLoaded: false, href: null }, // broken img
      { title: 'Shoe B', priceValue: null, priceText: null, imgSrc: 'https://x/b.jpg', imgLoaded: true, href: null },      // no price
    ]) });
    const res = await v.validateListing();
    const checks = res.findings.filter(f => f.severity === 'high').map(f => f.check);
    assert.ok(checks.includes('images_present'), 'flags broken image as high');
    assert.ok(checks.includes('price_present'), 'flags missing price as high');
    console.log('✓ Validator: broken image + missing price → both flagged HIGH');
  }

  // --- Price consistency listing -> detail ---
  {
    const detailPrice = 2999; // differs from listing 1999
    const page = {
      url() { return 'https://shop.example/listing'; },
      async goto() {}, async waitForTimeout() {},
      async evaluate() { return { priceValue: detailPrice, priceText: '₹2999', imgSrc: 'https://x/a.jpg', imgLoaded: true }; },
    };
    const v = new ContentValidator({ page });
    const findings = await v.validateDetailConsistency({ title: 'Shoe A', priceValue: 1999, priceText: '₹1999', imgSrc: 'https://x/a.jpg', href: 'https://x/a' });
    assert.ok(findings.some(f => f.check === 'price_consistency' && f.severity === 'high'), 'flags price mismatch high');
    console.log('✓ Validator: listing ₹1999 vs detail ₹2999 → price mismatch flagged HIGH');
  }

  // --- Image consistency is warning, not failure (best-effort) ---
  {
    const page = {
      url() { return 'https://shop.example/listing'; },
      async goto() {}, async waitForTimeout() {},
      async evaluate() { return { priceValue: 1999, priceText: '₹1999', imgSrc: 'https://x/DIFFERENT.jpg', imgLoaded: true }; },
    };
    const v = new ContentValidator({ page });
    const findings = await v.validateDetailConsistency({ title: 'Shoe A', priceValue: 1999, priceText: '₹1999', imgSrc: 'https://x/a.jpg', href: 'https://x/a' });
    const imgF = findings.find(f => f.check === 'image_consistency');
    assert.ok(imgF && imgF.severity === 'warning', 'image mismatch is a warning, never a hard fail');
    console.log('✓ Validator: differing images → WARNING (best-effort, no false hard-fail)');
  }

  // --- New product detection is informational ---
  {
    const v = new ContentValidator({ page: listingPage([]) });
    const f = v.detectNewProducts([{ title: 'New Sneaker' }, { title: 'Old Boot' }], ['Old Boot']);
    assert.ok(f && f.severity === 'info' && f.examples.includes('New Sneaker'), 'new product is info-only');
    console.log('✓ Validator: new product vs baseline → INFO (surfaced, not a defect)');
  }

  console.log('\nCONTENT VALIDATOR TESTS PASSED ✅');
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
