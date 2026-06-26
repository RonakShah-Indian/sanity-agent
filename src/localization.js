'use strict';

/**
 * Localization
 * ------------
 * Detects the site's primary language so the resolver matches the right
 * synonyms first, and so reports can group by locale.
 *
 * Signals (cheap, in priority order):
 *   1. <html lang="..">            - authoritative when present
 *   2. og:locale / content-language meta
 *   3. currency + script sniffing on visible text (fallback)
 *
 * The synonym dictionary in intents.js already carries multiple languages,
 * so detection is about ORDERING and reporting, not gating — an undetected
 * locale still works, just slightly slower (tries more synonyms).
 */
async function detectLocale(page) {
  const fromDom = await page.evaluate(() => {
    const html = document.documentElement.getAttribute('lang');
    const meta = document.querySelector('meta[property="og:locale"]')?.content
              || document.querySelector('meta[http-equiv="content-language"]')?.content
              || document.querySelector('meta[name="language"]')?.content;
    const text = (document.body?.innerText || '').slice(0, 4000);
    return { html, meta, text };
  });

  let lang = normalize(fromDom.html) || normalize(fromDom.meta);
  let source = lang ? (fromDom.html ? 'html-lang' : 'meta') : null;

  if (!lang) {
    lang = sniffFromText(fromDom.text);
    source = lang ? 'text-sniff' : 'unknown';
    lang = lang || 'en';
  }

  // currency hint (useful for checkout assertions + region grouping)
  const currency = sniffCurrency(fromDom.text);
  return { lang, source, currency };
}

function normalize(v) {
  if (!v) return null;
  return String(v).toLowerCase().split(/[-_]/)[0].trim() || null;
}

// Extremely lightweight script/keyword sniff — not a full NLP detector,
// just enough to bias synonym ordering when no lang attribute exists.
function sniffFromText(text) {
  if (/[\u0900-\u097F]/.test(text)) return 'hi';          // Devanagari
  if (/[\u0600-\u06FF]/.test(text)) return 'ar';          // Arabic
  if (/[\u4E00-\u9FFF]/.test(text)) return 'zh';          // CJK
  const t = text.toLowerCase();
  if (/\b(carrito|comprar|iniciar sesión|buscar)\b/.test(t)) return 'es';
  if (/\b(panier|acheter|connexion|rechercher)\b/.test(t)) return 'fr';
  if (/\b(warenkorb|kaufen|anmelden|suchen)\b/.test(t)) return 'de';
  if (/\b(carrinho|comprar|entrar|pesquisar)\b/.test(t)) return 'pt';
  return null;
}

function sniffCurrency(text) {
  if (/₹|\bINR\b/.test(text)) return 'INR';
  if (/€|\bEUR\b/.test(text)) return 'EUR';
  if (/£|\bGBP\b/.test(text)) return 'GBP';
  if (/\$|\bUSD\b/.test(text)) return 'USD';
  return null;
}

module.exports = { detectLocale };
