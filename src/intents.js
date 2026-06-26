'use strict';

/**
 * INTENT LIBRARY
 * --------------
 * Abstract, site-agnostic descriptions of the elements each flow needs.
 * - roles:  ARIA roles to try (accessibility-first = robust + localization-friendly)
 * - names:  localized synonyms (the localization layer). Add a language => add words here.
 * - heuristic: structural fallback when text/role fail.
 * - goal:   plain-English instruction handed to the LLM fallback.
 *
 * This is the single place you extend to support a new language or a new
 * site convention — the flows and resolver never change.
 */

// Localized synonym sets. Extend per language. (en, es, fr, de, hi, pt shown)
const L = {
  signIn:   ['sign in', 'log in', 'login', 'account', 'my account',
             'iniciar sesión', 'acceder', 'connexion', 'se connecter',
             'anmelden', 'login', 'entrar', 'लॉग इन', 'साइन इन'],
  email:    ['email', 'e-mail', 'username', 'correo', 'correo electrónico',
             'courriel', 'e-mail-adresse', 'benutzername', 'ईमेल'],
  password: ['password', 'pass', 'contraseña', 'mot de passe', 'passwort', 'पासवर्ड'],
  search:   ['search', 'find', 'buscar', 'rechercher', 'suchen', 'खोज', 'pesquisar'],
  addToCart:['add to cart', 'add to bag', 'add to basket', 'buy now',
             'añadir al carrito', 'agregar al carrito', 'ajouter au panier',
             'in den warenkorb', 'कार्ट में जोड़ें', 'adicionar ao carrinho'],
  cart:     ['cart', 'bag', 'basket', 'carrito', 'panier', 'warenkorb', 'कार्ट', 'carrinho'],
  checkout: ['checkout', 'proceed to checkout', 'place order', 'continue to payment',
             'pagar', 'finalizar compra', 'commander', 'passer la commande',
             'zur kasse', 'चेकआउट', 'finalizar'],
};

const INTENT_LIBRARY = {
  search_box: {
    goal: 'the main search input where a shopper types a product query',
    roles: ['searchbox', 'textbox'],
    names: L.search,
    heuristicName: 'input[type=search]',
    heuristic: (page) => page.locator(
      'input[type="search"]:visible, input[name*="search" i]:visible, input[id*="search" i]:visible, ' +
      'input[placeholder*="search" i]:visible, input[placeholder*="find" i]:visible, ' +
      'input[aria-label*="search" i]:visible, [role="searchbox"]:visible'
    ).first(),
  },
  search_trigger: {
    goal: 'the icon or button that opens / expands a hidden search input (magnifier glyph, header search button)',
    roles: ['button', 'link'],
    names: ['search', 'find', 'open search', 'magnifier', 'lookup'],
    heuristic: (page) => page.locator(
      'button[aria-label*="search" i]:visible, a[aria-label*="search" i]:visible, ' +
      '[data-test*="search-toggle" i]:visible, [class*="search" i] button:visible, ' +
      'header button:has(svg[aria-label*="search" i]), button:has-text("Search"):visible'
    ).first(),
  },
  email_field: {
    goal: 'the email or username input on the sign-in form',
    roles: ['textbox'],
    names: L.email,
    heuristicName: 'input[type=email]',
    heuristic: (page) => page.locator('input[type="email"], input[name*="email" i], input[name*="user" i]').first(),
  },
  password_field: {
    goal: 'the password input on the sign-in form',
    roles: ['textbox'],
    names: L.password,
    heuristicName: 'input[type=password]',
    heuristic: (page) => page.locator('input[type="password"]').first(),
  },
  sign_in_button: {
    goal: 'the button or link that opens the login form or submits credentials',
    roles: ['button', 'link'],
    names: L.signIn,
  },
  add_to_cart: {
    goal: 'the primary button on a product page that adds the item to the cart/bag',
    roles: ['button', 'link'],
    names: L.addToCart,
    heuristicName: 'button-near-price',
    heuristic: async (page) => {
      // structural cue: a prominent button containing cart/buy keywords
      return page.locator('button, a').filter({ hasText: /cart|bag|basket|buy|carrito|panier|warenkorb/i }).first();
    },
  },
  cart_link: {
    goal: 'the link/icon that navigates to the cart page',
    roles: ['link', 'button'],
    names: L.cart,
    heuristicName: 'cart-icon',
    heuristic: (page) => page.locator('[href*="cart" i], [href*="basket" i], [aria-label*="cart" i], [data-test*="cart" i]').first(),
  },
  checkout_button: {
    goal: 'the button that proceeds from the cart toward checkout/payment',
    roles: ['button', 'link'],
    names: L.checkout,
  },
  location_input: {
    goal: 'the address / location / pincode input that gates the menu on a food or quick-commerce site. Often opens via a button click first.',
    roles: ['textbox', 'combobox', 'searchbox'],
    names: ['address', 'delivery address', 'location', 'pincode', 'postcode', 'zip', 'zip code',
            'enter your address', 'find food', 'find a store', 'set location', 'deliver to',
            'change location', 'select location', 'enter delivery location'],
    heuristicName: 'address-input',
    heuristic: (page) => page.locator(
      'input[placeholder*="address" i]:visible, input[placeholder*="location" i]:visible, ' +
      'input[placeholder*="pincode" i]:visible, input[placeholder*="zip" i]:visible, ' +
      'input[placeholder*="postal" i]:visible, input[name*="address" i]:visible, ' +
      'input[placeholder*="deliver" i]:visible, input[aria-label*="address" i]:visible, ' +
      'input[aria-label*="location" i]:visible, [data-test*="location-input" i]:visible'
    ).first(),
  },
  pincode_input: {
    goal: 'a delivery pincode / postal code / ZIP input on a product detail page that gates the Add-to-Cart CTA (common on Indian commerce: Myntra, Tira, Ajio, Nexus, etc.)',
    roles: ['textbox', 'searchbox', 'combobox'],
    names: ['pincode', 'pin code', 'postal code', 'zip', 'zip code', 'delivery pincode',
            'check delivery', 'check serviceability', 'enter pincode', 'enter your pincode'],
    heuristicName: 'pincode-input',
    heuristic: (page) => page.locator(
      'input[placeholder*="pincode" i]:visible, input[placeholder*="pin code" i]:visible, ' +
      'input[name*="pincode" i]:visible, input[name*="zipcode" i]:visible, ' +
      'input[name*="postal" i]:visible, input[id*="pincode" i]:visible, ' +
      'input[aria-label*="pincode" i]:visible, input[maxlength="6"]:visible'
    ).first(),
  },
  pincode_check_button: {
    goal: 'the button that submits the entered pincode to check delivery availability (sometimes labelled Check / Apply / Submit)',
    roles: ['button'],
    names: ['check', 'apply', 'submit', 'check delivery', 'check availability', 'check pincode'],
    heuristic: (page) => page.locator(
      'button:has-text(/^(check|apply|submit)$/i):visible, ' +
      'button[class*="pincode" i]:visible, button[aria-label*="pincode" i]:visible'
    ).first(),
  },
  location_trigger: {
    goal: 'the button or banner that opens the location/address modal on a food or quick-commerce site. Examples seen in the wild: "Get accurate menu and pricing", "Set delivery", "Detect my location".',
    roles: ['button', 'link'],
    names: ['set location', 'change location', 'deliver to', 'enter pincode', 'select address',
            'find a restaurant', 'find food near you', 'find your store', 'select your location',
            'get accurate menu', 'get accurate menu and pricing', 'select location',
            'set delivery', 'detect my location', 'choose location'],
    heuristic: (page) => page.locator(
      'button:has-text(/get accurate menu/i):visible, ' +
      'button:has-text(/^\\s*select location\\s*$/i):visible, ' +
      'button:has-text(/^\\s*set delivery\\s*$/i):visible, ' +
      'button:has-text("Location"):visible, button:has-text("Address"):visible, ' +
      'button:has-text("Deliver"):visible, button:has-text("Pincode"):visible, ' +
      '[data-test*="location" i] button:visible, [class*="location" i] button:visible, ' +
      'header [class*="address" i]:visible'
    ).first(),
  },
  delivery_mode: {
    goal: 'the delivery vs pickup / dine-in selector on a food ordering site',
    roles: ['button', 'tab', 'radio'],
    names: ['delivery', 'deliver', 'pickup', 'pick up', 'takeaway', 'self collect', 'dine in'],
  },
  menu_item: {
    goal: 'a selectable menu item / dish card on a food-ordering page',
    roles: ['button', 'link'],
    names: ['add', 'order now', 'customize', 'select', 'order'],
    heuristicName: 'menu-card',
    heuristic: (page) => page.locator('[class*="product" i] a, [class*="menu" i] [class*="item" i], [class*="card" i]').first(),
  },
};

/**
 * FLOWS
 * -----
 * Each flow is an ordered list of abstract steps. Steps reference intents,
 * not selectors. The runner executes them via the resolver.
 *
 * action types: click | type | navigate | assert_visible | assert_url | assert_count_increase
 */
const FLOWS = {
  sign_in: {
    name: 'Sign In',
    critical: true,
    steps: [
      { action: 'click', intent: 'sign_in_button', soft: true, note: 'open login if behind a menu' },
      { action: 'type', intent: 'email_field', value: '{{credentials.email}}' },
      { action: 'type', intent: 'password_field', value: '{{credentials.password}}' },
      { action: 'click', intent: 'sign_in_button' },
      { action: 'assert_no_error', note: 'no visible auth error banner' },
    ],
  },
  search_product: {
    name: 'Search Product',
    critical: true,
    steps: [
      { action: 'type', intent: 'search_box', value: '{{query}}', submit: true },
      { action: 'assert_results', note: 'results region or product cards appear' },
      { action: 'validate_content', soft: true, sampleSize: 2, note: 'images load, prices present + consistent listing→detail' },
    ],
  },
  add_to_cart: {
    name: 'Add To Cart',
    critical: true,
    steps: [
      { action: 'type', intent: 'search_box', value: '{{query}}', submit: true },
      { action: 'open_first_product', note: 'click first product card; verifies we landed on a PDP' },
      { action: 'select_variant', soft: true, note: 'pick first size/shade if PDP has variants' },
      { action: 'enter_pincode', soft: true, note: 'fill pincode if PDP gates add-to-cart on delivery check' },
      { action: 'click_until_cart_changes', intent: 'add_to_cart', maxAttempts: 3,
        note: 'click an add-to-cart candidate, verify cart actually changed; if not, demote and try another' },
      { action: 'assert_cart_not_empty', note: 'final sanity check on the cart page' },
    ],
  },
  browse_add_to_cart: {
    name: 'Browse & Add To Cart',
    critical: true,
    steps: [
      // open_first_product is soft now: some sites (food menu listings, deal
      // grids) have inline "Add" buttons on the listing page itself — no PDP
      // step needed.
      { action: 'open_first_product', soft: true, note: 'open a PDP IF this site uses one; soft because listing-based sites add inline' },
      { action: 'select_variant', soft: true, note: 'pick first size/variant if PDP has them' },
      { action: 'enter_pincode', soft: true, note: 'fill pincode if PDP requires delivery check' },
      { action: 'click_until_cart_changes', intent: 'add_to_cart', maxAttempts: 3 },
      { action: 'assert_cart_not_empty', note: 'verify the item actually landed in the cart' },
    ],
  },
  checkout: {
    name: 'Checkout (up to payment)',
    critical: false,
    steps: [
      // navigate_to_cart prefers site.overrides.cartUrl when available; falls
      // back to clicking the cart_link icon. Cart icons that open a drawer
      // (Sephora) get bypassed in favor of the real cart URL.
      { action: 'navigate_to_cart', note: 'reach the cart PAGE, not a drawer' },
      { action: 'click', intent: 'checkout_button' },
      { action: 'assert_url', match: /checkout|payment|pago|kasse|caisse/i, soft: true,
        note: 'soft because some sites navigate to /cart/<step>/payment instead of literal /checkout' },
      { action: 'assert_no_payment_charge', note: 'stop before any real payment' },
    ],
  },
  food_order: {
    name: 'Food Order (location-gated, up to payment)',
    critical: true,
    steps: [
      { action: 'set_location', intent: 'location_input', value: '{{address}}', note: 'food sites gate the menu behind an address' },
      { action: 'click', intent: 'delivery_mode', soft: true, note: 'choose delivery if prompted' },
      { action: 'assert_menu', note: 'menu/category region appears after location set' },
      { action: 'click', intent: 'menu_item', note: 'open or add first item' },
      { action: 'click', intent: 'add_to_cart', soft: true },
      { action: 'read_cart_count', store: 'before' },
      { action: 'assert_count_increase', of: 'cart', from: 'before', soft: true },
      { action: 'click', intent: 'cart_link', soft: true },
      { action: 'click', intent: 'checkout_button', soft: true },
      { action: 'assert_no_payment_charge', note: 'hard stop before submitting payment' },
    ],
  },
};

module.exports = { INTENT_LIBRARY, FLOWS, L };
