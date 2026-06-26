'use strict';

/**
 * ContentValidator
 * ----------------
 * Checks not just "does the journey work" but "is the content on the page
 * actually correct." Each check is labelled by how reliable it is, because
 * honesty about confidence matters more than a long list of shaky checks.
 *
 *  RELIABLE (low false-alarm):
 *    - images_present : every product card has an <img> that actually loaded
 *                       (naturalWidth > 0), not a broken link or blank placeholder
 *    - price_present  : every product card shows a parseable price
 *    - cards_complete : every product card has title + price + image (none missing)
 *    - price_consistency : the price on the listing matches the price on the
 *                          product detail page for the same item
 *
 *  BEST-EFFORT (can false-alarm; reported as 'warning', never a hard fail):
 *    - image_consistency : the listing image looks like the detail-page image
 *                          (compared by normalized src/filename, NOT pixels —
 *                          a pixel diff would be noisy and is deliberately avoided)
 *    - new_products : products present now that weren't in the last baseline
 *                     (informational — "new" is not a defect, just surfaced)
 *
 * The validator returns findings with severity so the report and bug filer can
 * treat a missing image (high) differently from a "new product" note (info).
 */
class ContentValidator {
  constructor({ page, logger = console } = {}) {
    this.page = page;
    this.logger = logger;
  }

  /**
   * Scan the current (listing/category) page for product cards and validate them.
   * Returns { scanned, findings:[{check, severity, note, examples?}], products:[...] }
   */
  async validateListing({ maxProducts = 40 } = {}) {
    const products = await this.page.evaluate((max) => {
      // Heuristic: find product cards by common e-commerce patterns.
      const cardSel = [
        '[class*="product" i]', '[data-test*="product" i]',
        '[class*="card" i]', 'article', 'li[class*="item" i]',
      ].join(',');
      const cards = Array.from(document.querySelectorAll(cardSel)).slice(0, max);
      const seen = new Set();
      const out = [];
      for (const c of cards) {
        // must look like a product: has an image AND some price-ish text nearby
        const img = c.querySelector('img');
        const text = (c.innerText || '').trim();
        const priceMatch = text.match(/(?:₹|RM|\$|€|£|Rs\.?)\s?\d[\d,]*(?:\.\d{1,2})?/);
        if (!img && !priceMatch) continue;
        // de-dupe by rough signature
        const sig = (text.slice(0, 30) + (img?.src || '')).slice(0, 80);
        if (seen.has(sig)) continue; seen.add(sig);

        const titleEl = c.querySelector('h1,h2,h3,h4,[class*="title" i],[class*="name" i],a[href]');
        out.push({
          title: (titleEl?.innerText || '').trim().slice(0, 60) || null,
          priceText: priceMatch ? priceMatch[0] : null,
          priceValue: priceMatch ? parseFloat(priceMatch[0].replace(/[^\d.]/g, '')) : null,
          imgSrc: img?.src || null,
          imgLoaded: img ? (img.complete && img.naturalWidth > 0) : false,
          imgAlt: img?.getAttribute('alt') || null,
          href: c.querySelector('a[href]')?.href || null,
        });
      }
      return out;
    }, maxProducts);

    const findings = [];
    const n = products.length;

    if (n === 0) {
      findings.push({ check: 'cards_complete', severity: 'medium', note: 'No product cards detected on this page — listing may be empty or structured unusually.' });
      return { scanned: 0, findings, products };
    }

    // --- RELIABLE checks ---
    const noImg = products.filter(p => !p.imgSrc);
    const brokenImg = products.filter(p => p.imgSrc && !p.imgLoaded);
    const noPrice = products.filter(p => p.priceValue == null);

    if (brokenImg.length) findings.push({
      check: 'images_present', severity: 'high',
      note: `${brokenImg.length}/${n} product image(s) did NOT load (broken link or blank placeholder).`,
      examples: brokenImg.slice(0, 5).map(p => p.title || p.imgSrc),
    });
    if (noImg.length) findings.push({
      check: 'images_present', severity: 'high',
      note: `${noImg.length}/${n} product card(s) have no image at all.`,
      examples: noImg.slice(0, 5).map(p => p.title || '(untitled)'),
    });
    if (noPrice.length) findings.push({
      check: 'price_present', severity: 'high',
      note: `${noPrice.length}/${n} product card(s) show no parseable price.`,
      examples: noPrice.slice(0, 5).map(p => p.title || '(untitled)'),
    });

    const complete = products.filter(p => p.title && p.priceValue != null && p.imgLoaded).length;
    findings.push({
      check: 'cards_complete', severity: complete === n ? 'info' : 'medium',
      note: `${complete}/${n} product cards are complete (title + loaded image + price).`,
    });

    return { scanned: n, findings, products };
  }

  /**
   * Open a product's detail page and confirm the price matches the listing,
   * and (best-effort) the image looks like the same one.
   * RELIABLE: price match.  BEST-EFFORT: image match (filename compare, no pixels).
   */
  async validateDetailConsistency(listingProduct) {
    if (!listingProduct?.href) return null;
    const findings = [];
    try {
      await this.page.goto(listingProduct.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await this.page.waitForTimeout(600);
      const detail = await this.page.evaluate(() => {
        const body = (document.body?.innerText || '');
        const pm = body.match(/(?:₹|RM|\$|€|£|Rs\.?)\s?\d[\d,]*(?:\.\d{1,2})?/);
        const img = document.querySelector('[class*="product" i] img, [class*="gallery" i] img, main img, img');
        return {
          priceValue: pm ? parseFloat(pm[0].replace(/[^\d.]/g, '')) : null,
          priceText: pm ? pm[0] : null,
          imgSrc: img?.src || null,
          imgLoaded: img ? (img.complete && img.naturalWidth > 0) : false,
        };
      });

      // RELIABLE: price consistency listing -> detail
      if (listingProduct.priceValue != null && detail.priceValue != null) {
        if (Math.abs(listingProduct.priceValue - detail.priceValue) > 0.01) {
          findings.push({
            check: 'price_consistency', severity: 'high',
            note: `Price mismatch for "${listingProduct.title || 'product'}": listing ${listingProduct.priceText} vs detail ${detail.priceText}.`,
          });
        } else {
          findings.push({ check: 'price_consistency', severity: 'info', note: `Price consistent (${detail.priceText}) for "${listingProduct.title || 'product'}".` });
        }
      }

      // BEST-EFFORT: image consistency by filename, never pixels (avoids false alarms)
      if (listingProduct.imgSrc && detail.imgSrc) {
        const f1 = fileStem(listingProduct.imgSrc), f2 = fileStem(detail.imgSrc);
        if (f1 && f2 && f1 !== f2) findings.push({
          check: 'image_consistency', severity: 'warning',
          note: `Listing and detail images differ for "${listingProduct.title || 'product'}" (listing: ${f1}, detail: ${f2}). May be intentional (angle/variant) — review.`,
        });
      }
      if (detail.imgSrc && !detail.imgLoaded) findings.push({
        check: 'images_present', severity: 'high',
        note: `Detail-page image failed to load for "${listingProduct.title || 'product'}".`,
      });
    } catch (e) {
      findings.push({ check: 'price_consistency', severity: 'low', note: `Could not open detail page to verify (${e.message}).` });
    }
    return findings;
  }

  /**
   * Compare current product set against a previous baseline list of titles.
   * INFORMATIONAL only — a new product is not a defect, just surfaced for review.
   */
  detectNewProducts(currentProducts, baselineTitles = []) {
    if (!baselineTitles.length) return null;
    const base = new Set(baselineTitles.map(t => (t || '').toLowerCase().trim()));
    const isNew = currentProducts.filter(p => p.title && !base.has(p.title.toLowerCase().trim()));
    if (!isNew.length) return null;
    return {
      check: 'new_products', severity: 'info',
      note: `${isNew.length} product(s) appear new vs the last baseline.`,
      examples: isNew.slice(0, 6).map(p => p.title),
    };
  }
}

function fileStem(url) {
  try {
    const last = new URL(url).pathname.split('/').pop() || '';
    return last.split('?')[0].replace(/\.(jpg|jpeg|png|webp|avif|gif)$/i, '').slice(0, 40) || null;
  } catch { return null; }
}

module.exports = { ContentValidator };
