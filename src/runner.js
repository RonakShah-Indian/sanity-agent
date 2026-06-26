'use strict';

const { SemanticResolver } = require('./resolver');
const { ContentValidator } = require('./validator');
const { FLOWS } = require('./intents');

// When `type` fails because the field is hidden, try the registered trigger
// intent first (click it, then re-resolve the field). One generic recovery
// pattern that covers a lot of real storefronts.
const TYPE_TRIGGERS = {
  search_box:  'search_trigger',
  location_input: 'location_trigger',
};

/**
 * FlowRunner
 * ----------
 * Executes a flow's abstract steps on a page via the SemanticResolver, with a
 * layered AUTO-REMEDIATION model. Each tier is honest about how far automation
 * can responsibly go:
 *
 *  Tier 1  SELF-HEAL          re-resolve broken selectors (built into resolver)
 *  Tier 2  RETRY + QUARANTINE bounded retries w/ backoff; mark persistently
 *                             flaky steps quarantined so they don't block.
 *  Tier 3  AUTO-TICKET        on a hard failure, produce a structured bug
 *                             report w/ LLM diagnosis + repro + evidence.
 *  Tier 4  FIX-PROPOSAL       suggest a fix — scoped to TEST-SIDE fixes the
 *                             system can verify (e.g. a new selector candidate,
 *                             a wait adjustment). We do NOT claim to patch the
 *                             site's own code unattended; we propose, a human
 *                             (or a gated PR bot) approves. This boundary is
 *                             deliberate and defensible.
 */
class FlowRunner {
  constructor({ page, profile, llm, config, site = null, logger = console }) {
    this.page = page;
    this.profile = profile;
    this.llm = llm;
    this.config = config;
    this.site = site;
    this.overrides = site?.overrides || null;
    this.logger = logger;
    this.resolver = new SemanticResolver({ page, profile, llm, overrides: this.overrides, logger });
    this.validator = new ContentValidator({ page, logger });
    this.contentFindings = [];   // collected across the flow for the report
  }

  async runFlow(flowKey, ctx, opts = {}) {
    const flow = FLOWS[flowKey];
    // Phase 3 (sitemap-driven journeys): the planner can supply an augmented
    // step list (e.g., a navigate-to-/login prepended). Fall back to the
    // static FLOWS entry when no override is supplied.
    const steps = opts.stepsOverride || flow.steps;
    const result = { flow: flow.name, key: flowKey, critical: flow.critical, steps: [], status: 'passed' };
    const memory = {};

    for (const step of steps) {
      const stepRes = await this._runStepWithRemediation(flowKey, flow, step, ctx, memory);
      result.steps.push(stepRes);
      if (stepRes.status === 'failed' && !step.soft) {
        result.status = 'failed';
        result.failedStep = stepRes;
        break; // stop the flow at the first hard failure
      }
      if (stepRes.status === 'quarantined') result.status = result.status === 'failed' ? 'failed' : 'degraded';
    }
    if (this.contentFindings.length) result.contentFindings = this.contentFindings.slice();
    return result;
  }

  async _runStepWithRemediation(flowKey, flow, step, ctx, memory) {
    const maxRetries = this.config.retries ?? 2;
    let attempt = 0, lastErr;

    while (attempt <= maxRetries) {
      try {
        await this._executeStep(step, ctx, memory);
        return { ...describe(step), status: 'passed', attempts: attempt + 1, healed: attempt > 0 };
      } catch (e) {
        lastErr = e;
        attempt += 1;
        this.logger.debug?.(`[retry] ${flowKey}.${step.action} attempt ${attempt}: ${e.message}`);
        await this.page.waitForTimeout(300 * attempt); // backoff; resolver self-heals on re-resolve
      }
    }

    // Soft steps never fail the flow (e.g. "open login menu" that may not exist)
    if (step.soft) return { ...describe(step), status: 'skipped', reason: lastErr?.message };

    // Tier 2 -> Tier 3/4: persistent failure. Decide quarantine vs hard fail.
    const history = this.profile.recall(step.intent);
    const flaky = history && history.misses >= (this.config.quarantineAfter ?? 3);

    const remediation = await this._remediate(flowKey, flow, step, lastErr);
    return {
      ...describe(step),
      status: flaky ? 'quarantined' : 'failed',
      attempts: attempt,
      error: lastErr?.message,
      remediation,
    };
  }

  // ---- step execution ----
  async _executeStep(step, ctx, memory) {
    switch (step.action) {
      case 'navigate':
        await this.page.goto(interp(step.url, ctx), { waitUntil: 'domcontentloaded' });
        await this.page.waitForTimeout(step.afterWaitMs ?? 800);
        break;

      case 'hover': {
        // Real mouse-hover via Playwright CDP. Triggers CSS :hover and JS
        // onMouseEnter handlers (programmatic dispatch can't do this).
        // Targets either a registered intent OR a raw CSS selector.
        const sel = step.selector ||
          (step.intent ? null : 'a[href*="/product/" i]:visible, a[href*="/products/" i]:visible, ' +
                                '[class*="product-card" i]:visible, [class*="product-tile" i]:visible');
        let loc;
        if (step.intent) {
          ({ locator: loc } = await this.resolver.resolve(step.intent));
        } else {
          loc = this.page.locator(sel).first();
        }
        await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        await loc.hover({ timeout: 3000 });
        await this.page.waitForTimeout(step.afterWaitMs ?? 800);
        break;
      }

      case 'click': {
        const { locator } = await this.resolver.resolve(step.intent);
        // Try a real click; if the element is detached/overlaid, fall back to
        // a forced click. Many storefronts have cookie banners / sticky drawers
        // that intercept the first pointer event.
        try {
          await locator.click({ timeout: 5000 });
        } catch (e) {
          await locator.click({ timeout: 4000, force: true }).catch(() => { throw e; });
        }
        // Some clicks navigate (eg checkout button → /checkout/...), some don't.
        // Wait briefly for navigation if it's coming.
        await Promise.race([
          this.page.waitForLoadState('domcontentloaded'),
          this.page.waitForTimeout(2000),
        ]).catch(() => {});
        break;
      }

      case 'wait': {
        await this.page.waitForTimeout(step.ms || 1000);
        break;
      }

      case 'navigate_to_cart': {
        // Reach the actual cart PAGE — not a drawer. Some sites (Sephora) have
        // a bag icon that opens a slide-out panel rather than navigating; in
        // those cases we MUST use the configured cart URL.
        const here = new URL(this.page.url());
        const cartUrl = this.overrides?.cartUrl
          ? (this.overrides.cartUrl.startsWith('http')
              ? this.overrides.cartUrl
              : `${here.protocol}//${here.host}${this.overrides.cartUrl}`)
          : null;
        if (cartUrl) {
          await this.page.goto(cartUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
          await this.page.waitForTimeout(800);
        } else {
          // No configured URL — fall back to clicking the cart_link icon and
          // hope it actually navigates (works on the majority of sites).
          try {
            const { locator } = await this.resolver.resolve('cart_link');
            await locator.click({ timeout: 4000 }).catch(() => {});
            await this.page.waitForLoadState('domcontentloaded').catch(() => {});
          } catch { /* no cart link found — assert_url will catch it */ }
        }
        await this._dismissOverlays();
        break;
      }

      case 'enter_pincode': {
        // Many Indian commerce sites (Myntra, Tira, Ajio, Nexus) gate the
        // Add-to-Cart CTA behind a delivery-pincode check. If a pincode input
        // is visible on this PDP, fill it and submit the check button.
        // Soft step — no input = silently skip.
        let pinInput = null;
        try { ({ locator: pinInput } = await this.resolver.resolve('pincode_input')); }
        catch { return; }
        if (!pinInput) return;

        const pin = this.site?.pincode || ctx.pincode || step.value || '110001';
        try {
          await pinInput.fill(String(pin), { timeout: 3000 });
        } catch { return; }

        // Try the explicit check/apply button; fall back to Enter.
        try {
          const { locator: btn } = await this.resolver.resolve('pincode_check_button');
          await btn.click({ timeout: 3000 }).catch(() => {});
        } catch {
          await pinInput.press('Enter').catch(() => {});
        }
        await this.page.waitForTimeout(1500);
        return;
      }

      case 'click_until_cart_changes': {
        // STEP 0 — detect pre-purchase gate, but use it as context not as a
        // hard stop. On store-gated sites the CLICK works server-side — the
        // agent just can't see a visual cart-badge update. Two prior bugs
        // bracket this: aggressive retries added duplicate items silently;
        // overly cautious pre-checks bailed before the first click.
        // The right answer is: click ONCE, then let assert_cart_not_empty do
        // the real verification by navigating to the cart URL.
        // Sites can opt out of gate-detection when their flow is configurator-
        // based (combo modals that pop AFTER the first click — gate detection
        // would short-circuit them) via `overrides.skipGateDetection: true`.
        const gate = this.overrides?.skipGateDetection ? null : await this._detectPrePurchaseGate();
        const gatedMode = !!gate;
        if (gatedMode) this.logger.info?.(`[heal] gate detected (${gate}) — single-click mode, no retries`);

        // STEP 1 — dismiss overlays (promos, "download app", consent banners).
        await this._dismissOverlays();
        // STEP 2 — hover-to-reveal: many sites (Sephora, Myntra, Tira) hide
        // the inline Add-to-Bag CTA on product cards until you hover. If the
        // add_to_cart target isn't visible right now, hover over the first
        // product card on the page and try again.
        await this._hoverToRevealAddButton();
        // STEP 3 — fill combo/configurator slots (max 2, not 4 — anything
        // beyond that on a "first product" PDP is almost always a no-op chain).
        // Skip in gated mode to avoid silent duplicate-item additions.
        if (!gatedMode) await this._fillRequiredSlots(2);

        // Gated sites: ONE attempt, no retries, no _tryAnotherProduct cycling.
        // Normal sites: full self-heal up to maxAttempts.
        const maxAttempts = gatedMode ? 1 : (step.maxAttempts || 2);
        const triedSelectors = new Set();
        const cartBefore = await this._readCartBaseline();
        let lastErr = null;
        let alreadyTriedAnotherProduct = false;     // hard cap — at most ONE product swap per flow

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          let hit;
          try {
            hit = await this.resolver.resolve(step.intent);
          } catch (e) {
            lastErr = e;
            break;
          }
          if (triedSelectors.has(hit.selector)) {
            // Same selector picked twice — demote so a different rung wins next.
            this.profile.demote(step.intent);
            continue;
          }
          triedSelectors.add(hit.selector);
          this.logger.debug?.(`[heal] add_to_cart attempt ${attempt + 1}: ${hit.strategy} → ${hit.selector}`);

          // Re-dismiss overlays before EVERY click — sites pop new alerts
          // (cart-add toasts, login prompts) between attempts.
          await this._dismissOverlays();
          // Re-check the gate too — a previous click may have triggered a
          // login modal or "no store selected" prompt that wasn't there before.
          // Respect the same skipGateDetection override for mid-flow checks.
          // Configurator-based flows (combo modals, build-your-own boxes) trigger
          // a gate prompt AS PART OF the expected interaction — bailing here would
          // short-circuit the legitimate next-step (select inside modal).
          if (!this.overrides?.skipGateDetection) {
            const midFlowGate = await this._detectPrePurchaseGate();
            if (midFlowGate) { lastErr = new Error(`pre-purchase gate appeared: ${midFlowGate}`); break; }
          }

          try { await hit.locator.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {}); } catch {}
          // Three-stage click: normal → forced → JS-evaluate (bypasses overlays).
          // The last stage is the key for sites whose promo modals can't be
          // dismissed via close-button patterns — calling el.click() in the
          // page context fires the React handler without traversing the
          // pointer-event chain that the overlay intercepts.
          let clicked = false;
          try { await hit.locator.click({ timeout: 4000 });          clicked = true; } catch {}
          if (!clicked) try { await hit.locator.click({ timeout: 3000, force: true }); clicked = true; } catch {}
          if (!clicked) try { await hit.locator.evaluate(el => el.click()); clicked = true; } catch {}
          if (!clicked) { lastErr = new Error(`could not click ${hit.selector}`); this.profile.demote(step.intent); continue; }

          await this.page.waitForTimeout(1200);

          // Some sites pop a "you saved X — YAYYY!" celebratory modal AFTER a
          // successful add. The modal is itself proof the click registered.
          // Check for the success signal BEFORE dismissing the modal — that
          // way "the modal is here" counts as "the add worked".
          if (await this._cartActuallyAdded(cartBefore)) {
            this.logger.debug?.(`[heal] add_to_cart succeeded via ${hit.strategy}`);
            await this._dismissOverlays();   // clean up the success modal
            return;
          }

          // No success signal yet. The click may have triggered a blocking
          // promo modal that PREVENTS the add from completing (some sites
          // require the modal to be dismissed before the cart write commits).
          // Dismiss overlays + give it another moment + recheck.
          await this._dismissOverlays();
          await this.page.waitForTimeout(800);
          if (await this._cartActuallyAdded(cartBefore)) {
            this.logger.debug?.(`[heal] add_to_cart succeeded after modal dismissal`);
            return;
          }

          // Configurator detection: if the click opened a modal/drawer, fill
          // any required slots inside it, then click the final "Add Combo"
          // / "Add to Cart" button INSIDE the modal.
          if (await this._configuratorModalOpen()) {
            this.logger.debug?.(`[heal] click opened a combo configurator — filling slots`);
            await this._fillRequiredSlots(4);
            // Now click the final-add button inside the modal.
            if (await this._clickFinalAddInModal()) {
              await this.page.waitForTimeout(1500);
              if (await this._cartActuallyAdded(cartBefore)) {
                this.logger.debug?.(`[heal] combo configurator: cart updated after final-add`);
                return;
              }
            }
          }

          // Click looked like a no-op. BUT: some sites (food delivery with
          // store gating, B2B with login walls) accept the cart-add server-side
          // even when the visible cart badge can't update. Don't keep clicking
          // — duplicate-item pile-ups come from looping on a click that DID
          // work but whose visual signal is suppressed. Fail honestly instead.
          lastErr = new Error(`clicked ${hit.selector} but no cart change detected`);
          this.profile.demote(step.intent);

          // Bail-out: on the final attempt, ONE more shot via a different
          // product if we haven't already done so. Hard cap = 1 product swap
          // per flow run. Skipped in gated mode (a swap can't unblock a gate).
          if (!gatedMode && attempt === maxAttempts - 1 && !alreadyTriedAnotherProduct) {
            alreadyTriedAnotherProduct = true;
            if (await this._tryAnotherProduct()) {
              attempt = -1;
              triedSelectors.clear();
              continue;
            }
          }
          await this.page.waitForTimeout(500);
        }

        // No visible cart-change signal detected. DON'T throw — `assert_cart_not_empty`
        // is the next step and IT navigates to the cart URL to do the real
        // verification. Visual signals are unreliable (store-gated sites
        // suppress them; some sites pop a celebratory modal that we may have
        // already dismissed; some sites have no badge at all). The cart URL
        // never lies. Let it be the judge.
        this.logger.info?.(`[heal] no visual cart-change signal; deferring verification to assert_cart_not_empty`);
        return;
      }

      case 'assert_cart_not_empty': {
        // Most reliable cart verification: navigate to the cart URL and check
        // that *something product-like* is visible. Works on every platform
        // we've seen because the cart page is the cart page.
        try {
          const t = await this.resolver.resolve('cart_link');
          await t.locator.click({ timeout: 4000 }).catch(() => {});
          await this.page.waitForLoadState('domcontentloaded').catch(() => {});
        } catch {
          // No cart link found — try a configured cart URL, then a generic /cart.
          const here = new URL(this.page.url());
          const cartUrl = this.overrides?.cartUrl
            ? (this.overrides.cartUrl.startsWith('http') ? this.overrides.cartUrl : `${here.protocol}//${here.host}${this.overrides.cartUrl}`)
            : `${here.protocol}//${here.host}/cart`;
          await this.page.goto(cartUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        }
        await this.page.waitForTimeout(1200);

        // 1. Empty-cart sentinel? If yes, fail immediately.
        const emptyTexts = [
          'text=/your (cart|bag|basket) is empty/i',
          'text=/no items in (your )?(cart|bag|basket)/i',
          'text=/cart is empty/i',
          'text=/start shopping/i',
        ];
        for (const sel of emptyTexts) {
          const empty = await this.page.locator(sel).first().isVisible({ timeout: 600 }).catch(() => false);
          if (empty) throw new Error('cart page renders an "empty cart" message — add-to-cart did not stick');
        }

        // 2. Positive: a product row / line item / image is in the cart.
        const itemPatterns = [
          '[class*="cart" i] [class*="item" i]',
          '[class*="line-item" i]',
          '[data-test*="cart-item" i]',
          '[data-testid*="cart-item" i]',
          '[class*="cart" i] img:visible',
          'tr[class*="item" i]',
          '[class*="bag" i] [class*="item" i]',
          'main img:visible + *:has-text(/\\$|₹|£|€/)',   // image next to price
        ];
        for (const sel of itemPatterns) {
          const ok = await this.page.locator(sel).first().isVisible({ timeout: 800 }).catch(() => false);
          if (ok) return;
        }

        // 2b. Item-count text signals (covers carts that hide rows behind a
        // pre-purchase gate but still display the count — e.g. food sites that
        // show an "Added Items (2)" header while a "No Delivery Address"
        // overlay obscures the actual line items).
        // Use innerText regex (cross-element) rather than text= CSS (single-node).
        try {
          const bodyText = await this.page.evaluate(() => document.body?.innerText || '').catch(() => '');
          const positiveSignals = [
            /added\s+items?\s*\(\s*[1-9]\d*\s*\)/i,
            /\b(cart|bag|basket)\s*\(\s*[1-9]\d*\s*\)/i,
            /\b[1-9]\d*\s+item(s)?\b/i,
            /sub[\s-]?total[:\s]/i,
            /order\s+summary/i,
            /your\s+(cart|bag|basket)\s+contains/i,
          ];
          for (const re of positiveSignals) {
            if (re.test(bodyText)) return;
          }
        } catch { /* fallthrough */ }

        // 3. Shopify shops expose /cart.js — last-resort programmatic check.
        try {
          const here = new URL(this.page.url());
          const r = await this.page.request.get(`${here.protocol}//${here.host}/cart.js`, { timeout: 3000 });
          if (r.ok()) {
            const body = await r.json().catch(() => null);
            if (body && Number.isFinite(body.item_count) && body.item_count > 0) return;
          }
        } catch { /* not Shopify */ }

        throw new Error('cart page shows no items — add-to-cart did not stick');
      }

      case 'type': {
        // Real-site auto-recovery sequence:
        //   1. Try to resolve the intent normally.
        //   2. If the resolved target is not fillable (eg the LLM picked a
        //      "Open search" button when no input exists yet), treat IT as
        //      the trigger: click it, then re-resolve. Also handle resolver
        //      throws / invisible elements by trying the registered trigger.
        //   3. Last-resort: navigate to /search?q=… for search_box intents.
        let locator = null, resolveErr = null;
        try { ({ locator } = await this.resolver.resolve(step.intent)); }
        catch (e) { resolveErr = e; }

        const fillable = locator ? await this._isFillable(locator) : false;

        // CASE A: resolver gave us a non-input (eg a button). Use it as the trigger.
        if (locator && !fillable) {
          await locator.click({ timeout: 3000 }).catch(() => {});
          await this.page.waitForTimeout(700);
          // Demote it so future resolutions don't re-pick the button.
          this.profile.demote(step.intent);
          locator = null;
          try { ({ locator } = await this.resolver.resolve(step.intent)); } catch { /* ignore */ }
        }

        // CASE B: nothing or invisible — try the named trigger intent.
        if (!locator || !(await this._isVisibleSoon(locator))) {
          const triggerIntent = TYPE_TRIGGERS[step.intent];
          if (triggerIntent) {
            try {
              const t = await this.resolver.resolve(triggerIntent);
              await t.locator.click({ timeout: 3000 });
              await this.page.waitForTimeout(700);
              ({ locator } = await this.resolver.resolve(step.intent));
            } catch { /* fall through */ }
          }
        }

        // CASE C: URL-based search fallback (Shopify / Magento / Woo).
        // Sites with client-side-only search can disable this via overrides.noUrlSearch
        // (some SPAs serve a 404 on /search?q= and we must NOT navigate there).
        const allowUrlSearch = !this.overrides?.noUrlSearch;
        if (allowUrlSearch && (!locator || !(await this._isFillable(locator))) && step.intent === 'search_box' && step.submit) {
          const url = await this._searchByUrl(interp(step.value, ctx));
          if (url) {
            await this.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
            return;
          }
        }

        if (!locator || !(await this._isFillable(locator))) {
          throw resolveErr || new Error(`${step.intent}: no fillable target found, no recovery worked`);
        }
        await locator.fill(interp(step.value, ctx), { timeout: 5000 });
        if (step.submit) {
          const startUrl = this.page.url();
          await locator.press('Enter').catch(() => {});
          // Wait for ANY of: URL change, product cards rendered, search-results
          // marker visible. domcontentloaded alone fires too fast on SPAs.
          await Promise.race([
            this.page.waitForFunction(
              (u) => location.href !== u, startUrl,
              { timeout: 5000 }),
            this.page.waitForSelector(
              'a[href*="/product/" i], a[href*="/products/" i], [class*="product-card" i], [class*="search-result" i]',
              { state: 'attached', timeout: 5000 }),
            this.page.waitForLoadState('networkidle', { timeout: 5000 }),
          ]).catch(() => {});
          // If still on the same URL AND no product cards appeared, try
          // clicking an adjacent search-submit button as a last resort.
          if (this.page.url() === startUrl) {
            const submitBtn = this.page.locator(
              'button[type="submit"]:visible, button[aria-label*="search" i]:visible, ' +
              'form button:has-text(/^\\s*(search|go|find)\\s*$/i):visible'
            ).first();
            if (await submitBtn.count().catch(() => 0)) {
              await submitBtn.click({ timeout: 2000 }).catch(() => {});
              await this.page.waitForLoadState('domcontentloaded').catch(() => {});
            }
          }
        } else {
          await this.page.waitForLoadState('domcontentloaded').catch(() => {});
        }
        break;
      }

      case 'set_location': {
        // Multi-stage location selection used by location-gated food/quick-commerce
        // sites (any service where the menu/catalog is hidden until an address
        // is set):
        //
        //   1. Initial location trigger ("Get accurate menu", "Set delivery")
        //   2. (Optional) intermediate "Add address" / "Search manually" button
        //      that REVEALS the input after the trigger navigates
        //   3. Type the address with REAL keystrokes — Google Places autocomplete
        //      doesn't fire on programmatic .value = "..." sets
        //   4. Click first autocomplete suggestion (.pac-item for Google Places,
        //      role=option for native, various class patterns for custom)
        //   5. (Optional) "Confirm" / "Set as delivery" button to commit
        const value = interp(step.value, ctx);

        // STAGE 1 — find the input. Try direct, then trigger, then intermediate.
        let locator = null;
        try { ({ locator } = await this.resolver.resolve(step.intent)); } catch {}
        if (!locator || !(await this._isVisibleSoon(locator))) {
          try {
            const t = await this.resolver.resolve('location_trigger');
            await t.locator.click({ timeout: 3000 });
            await this.page.waitForTimeout(1200);
          } catch { /* might already be on the localization page */ }

          // STAGE 2 — intermediate reveal button. After the trigger navigates
          // to a localization page, the search input might be hidden behind
          // an "Add address (details)" / "Search location" / "Enter manually"
          // button. Loose text match — these labels vary by site.
          const reveal = this.page.locator(
            'button:has-text(/add address|enter (your )?address|search (your )?location|search manually|enter manually|add (your )?delivery/i):visible, ' +
            '[role="button"]:has-text(/add address|enter address|search location/i):visible'
          ).first();
          if (await reveal.count().catch(() => 0)) {
            await reveal.click({ timeout: 2500 }).catch(() => {});
            await this.page.waitForTimeout(1000);
          }

          try { ({ locator } = await this.resolver.resolve(step.intent)); } catch {}
        }
        if (!locator || !(await this._isVisibleSoon(locator))) {
          throw new Error('set_location: could not find an address input after trigger / reveal');
        }

        // STAGE 3 — REAL keystrokes. Google Places listens for keydown/keyup
        // events; programmatic .fill() / .value= don't trigger it.
        await locator.click({ timeout: 3000 }).catch(() => {});
        await locator.fill('').catch(() => {});                     // clear
        await locator.type(value, { delay: 60 });                   // real keystrokes
        await this.page.waitForTimeout(1800);                       // let Places respond

        // STAGE 4 — first autocomplete suggestion. Google Places uses .pac-item;
        // most other sites use one of the patterns below.
        const suggestionSelectors = [
          '.pac-item:visible',
          '[role="option"]:visible',
          '[class*="suggestion" i]:visible',
          '[class*="autocomplete" i] li:visible',
          '[class*="dropdown" i] li:visible',
          'ul[role="listbox"] li:visible',
        ];
        let pickedSuggestion = false;
        for (const sel of suggestionSelectors) {
          const opt = this.page.locator(sel).first();
          if (await opt.count().catch(() => 0)) {
            await opt.click({ timeout: 3000 }).catch(() => {});
            pickedSuggestion = true;
            await this.page.waitForTimeout(900);
            break;
          }
        }
        if (!pickedSuggestion) await locator.press('Enter').catch(() => {});

        // STAGE 5 — Confirm / Set-as-delivery button (some sites need it).
        const confirmBtn = this.page.locator(
          'button:has-text(/^\\s*(confirm|set (as )?(delivery|location|address)|continue|done|proceed)\\s*$/i):visible'
        ).first();
        if (await confirmBtn.count().catch(() => 0)) {
          await confirmBtn.click({ timeout: 2500 }).catch(() => {});
        }

        await this.page.waitForLoadState('domcontentloaded').catch(() => {});
        await this.page.waitForTimeout(1500);
        break;
      }

      case 'assert_menu': {
        // Three independent signals, any one of which counts as "menu rendered":
        //   1. Visible product anchors (structural, class-name-independent)
        //   2. Pattern match for menu/category regions in DOM
        //   3. URL shape transition (most reliable, no DOM needed)
        await this.page.waitForLoadState('domcontentloaded').catch(() => {});
        await this.page.waitForTimeout(1200);

        // (1) Real anchors that point at products are the strongest signal.
        const productLinks = await this.page.locator(
          'a[href*="/product"]:visible, a[href*="/products"]:visible, a[href*="/menu"]:visible, ' +
          'a[href*="/item"]:visible, a[href*="/dish"]:visible, a[href*="/category"]:visible'
        ).count().catch(() => 0);
        if (productLinks >= 2) return;

        // (2) Pattern-based DOM check (class names / data attributes).
        const patterns = [
          '[class*="menu" i] [class*="item" i]',
          '[class*="category" i] [class*="card" i]',
          '[class*="product" i]:visible',
          '[data-test*="menu" i]:visible',
          '[data-testid*="menu" i]:visible',
          'main [class*="grid" i] article',
          'main [class*="list" i] [class*="card" i]',
          'h1:has-text(/menu|categor/i)',
          'main img:visible',
        ];
        for (const sel of patterns) {
          const ok = await this.page.locator(sel).first().isVisible({ timeout: 800 }).catch(() => false);
          if (ok) return;
        }

        // (3) URL transitioned to a recognizable menu/order route.
        if (/menu|order|catalog|categor|restaurant|store|products?/i.test(this.page.url())) return;

        throw new Error('menu/category region not detected after location set');
      }

      case 'select_variant': {
        // Generic variant picker — three phases of escalating leniency.
        // Soft step (skipped silently if no variants are present).
        const variantSelectors = [
          '[role="radio"]:not([disabled]):not([aria-disabled="true"]):visible',
          'input[type="radio"]:not([disabled]):visible + label:visible',
          'select[name*="size" i]:visible, select[name*="variant" i]:visible, select[name*="color" i]:visible, select[name*="shade" i]:visible',
          '[class*="swatch" i]:not([disabled]):not([aria-disabled="true"]):visible',
          '[class*="variant" i] button:not([disabled]):visible',
          '[class*="size" i] button:not([disabled]):not([class*="selected" i]):visible',
          '[class*="shade" i] button:not([disabled]):visible',
          '[class*="color" i] button:not([disabled]):visible',
          '[data-variant-id]:visible, [data-option-value]:visible, [data-swatch]:visible',
        ];

        const isSoldOutEl = async (loc) => {
          // Sold-out detection across THREE axes:
          //   (a) text content (own + closest ancestor)
          //   (b) class names of the element AND any descendant
          //   (c) standard disabled / aria-disabled attributes
          try {
            return await loc.evaluate(el => {
              const matchText = /sold out|out of stock|notify me|unavailable/i;
              const matchClass = /oos|sold-?out|out-?of-?stock|unavailable|disabled-/i;
              const anc = el.closest('li,div,label,a') || el;
              if (matchText.test((anc.innerText || el.innerText || '').slice(0, 120))) return true;
              if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return true;
              if (matchClass.test(el.className?.toString() || '')) return true;
              for (const d of el.querySelectorAll('*')) {
                if (matchClass.test(d.className?.toString() || '')) return true;
              }
              return false;
            });
          } catch { return false; }
        };

        const tryPick = async (loc) => {
          try {
            const tag = (await loc.evaluate(el => el.tagName.toLowerCase()).catch(() => '')) || '';
            if (tag === 'select') {
              await loc.evaluate(el => {
                const opts = Array.from(el.options).filter(o => o.value && !/select|choose|pick/i.test(o.text));
                if (opts.length) { el.value = opts[0].value; el.dispatchEvent(new Event('change', { bubbles: true })); }
              }).catch(() => {});
            } else {
              await loc.scrollIntoViewIfNeeded({ timeout: 800 }).catch(() => {});
              try { await loc.click({ timeout: 3000 }); }
              catch { await loc.click({ timeout: 2000, force: true }).catch(() => {}); }
            }
            await this.page.waitForTimeout(400);
            return true;
          } catch { return false; }
        };

        // Phase 1: structured / classed variant pickers.
        for (const sel of variantSelectors) {
          const links = this.page.locator(sel);
          const count = await links.count().catch(() => 0);
          for (let i = 0; i < Math.min(count, 8); i++) {
            const loc = links.nth(i);
            if (await isSoldOutEl(loc)) continue;
            if (await tryPick(loc)) return;
          }
        }

        // Phase 2: ANY element (button, div, span, role=button) whose visible
        // text is a size label — alpha (S/M/L/XL/XS/XXL/XXXL) OR numeric
        // (2-46 for clothing, also handles XS-XXL+ and FREE). Catches React
        // SPAs whose size tiles are <div>s without semantic class names.
        const candidates = this.page.locator(
          'button:visible, [role="button"]:visible, [role="radio"]:visible, ' +
          'div[class*="size" i]:visible, div[class*="variant" i]:visible, ' +
          'div[class*="box" i]:visible, div[class*="option" i]:visible, ' +
          'label[class*="size" i]:visible, li[class*="size" i]:visible'
        );
        const total = Math.min(await candidates.count().catch(() => 0), 40);
        for (let i = 0; i < total; i++) {
          const el = candidates.nth(i);
          try {
            const fullText = ((await el.innerText({ timeout: 200 }).catch(() => '')) || '').trim();
            // Some sites stack sublabels under the size ("S\nSold out", "M\nAvailable"),
            // so match the FIRST non-empty line, not the whole text.
            const firstLine = fullText.split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
            if (!/^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|FREE(?:\s*SIZE)?|[2-9]|[1-4]\d|46)$/i.test(firstLine)) continue;
            if (await isSoldOutEl(el)) continue;
            if (await tryPick(el)) return;
          } catch { /* try next */ }
        }
        return;
      }

      case 'validate_content': {
        // Scan the current listing for image/price/completeness issues.
        const res = await this.validator.validateListing({ maxProducts: step.maxProducts || 40 });
        memory.lastProducts = res.products;
        // record findings (these don't fail the flow unless explicitly critical)
        for (const f of res.findings) this.contentFindings.push(f);
        // price + image consistency on a sample of products (reliable check)
        const sample = (res.products || []).filter(p => p.href).slice(0, step.sampleSize || 2);
        const listingUrl = this.page.url();
        for (const prod of sample) {
          const cf = await this.validator.validateDetailConsistency(prod);
          if (cf) cf.forEach(f => this.contentFindings.push(f));
          await this.page.goto(listingUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        }
        // a high-severity content finding (broken images / price mismatch) fails the step
        const hard = this.contentFindings.find(f => f.severity === 'high');
        if (hard && !step.soft) throw new Error(`content validation: ${hard.note}`);
        break;
      }

      case 'open_first_product': {
        // Early-exit 1: when the landing URL is ALREADY a product detail page
        // (per site config), there's no listing → no product card → no click
        // needed. The site told us to start on a PDP; respect that.
        if (await this._isProductDetailPage('')) {
          return;
        }
        // Early-exit 2: when the page already has a visible add_to_cart target
        // (inline-add pages — food menus, deal grids — where every card has its
        // own Add button), skip the PDP step entirely. Scroll briefly first so
        // intersection-observer-rendered items below the fold come into view
        // before we resolve.
        for (const y of [400, 900]) {
          await this.page.evaluate((sy) => window.scrollTo(0, sy), y).catch(() => {});
          await this.page.waitForTimeout(300);
        }
        await this.page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
        await this.page.waitForTimeout(300);
        try {
          const { locator } = await this.resolver.resolve('add_to_cart');
          if (locator && (await locator.count().catch(() => 0)) > 0
              && (await locator.isVisible({ timeout: 600 }).catch(() => false))) {
            this.logger.debug?.(`[open_first_product] add_to_cart already on page — skipping PDP step`);
            return;
          }
        } catch { /* not resolvable here — continue with normal PDP navigation */ }
        // SPA pages frequently hydrate / lazy-load below the fold. Scroll
        // through the page to trigger intersection-observers AND reveal
        // additional product cards that only render once they enter the
        // viewport (common on listing pages and recommendation widgets).
        await this.page.waitForTimeout(400);
        for (const y of [400, 800, 1200, 600, 0]) {
          await this.page.evaluate((sy) => window.scrollTo(0, sy), y).catch(() => {});
          await this.page.waitForTimeout(250);
        }
        await this.page.waitForSelector(
          'a[href*="/products/" i], a[href*="/product/" i], a[href*="/p/" i]',
          { state: 'attached', timeout: 6000 }
        ).catch(() => {});
        // Self-healing: try each candidate selector AND verify we actually
        // landed on a product detail page. If a click navigated SOMEWHERE
        // (not a search/category URL), accept it — better than no progress.
        const candidates = [
          'a[href*="/products/" i]',
          'a[href*="/product/" i]',
          'a[href*="/p/" i]',
          'a[href*="/item/" i]',
          '[data-test*="product" i] a',
          '[data-testid*="product" i] a',
          '[class*="product-card" i] a',
          '[class*="product-tile" i] a',
          '.product a',
          '[class*="product" i] a:not([class*="filter" i]):not([class*="sort" i]):not([class*="brand" i])',
          'main [class*="card" i] a[href]',
          'main article a[href]',
        ];
        const startUrl = this.page.url();
        let landed = false;

        // Prefer products that DON'T look like combos / bundles / deals.
        // These usually require sub-selection and trip add-to-cart silently.
        const COMBO_RE = /combo|bundle|deal\b|meal\b|family pack|set\b|build your|create your|customi[sz]e/i;
        // Recommendation widgets (DY, Algolia, "you may like" carousels) often
        // contain /product/ hrefs but click-navigation from them is unreliable
        // (Sephora's `.dy-recommendation-product1` is the canonical example).
        const WIDGET_RE = /dy-recommendation|swiper|carousel|recommend|you-may|related|sponsor|widget/i;

        for (const sel of candidates) {
          const links = this.page.locator(sel);
          const count = await links.count().catch(() => 0);
          // Collect candidate metadata so we can:
          //   • SKIP widgets (carousel/recommendation tiles)
          //   • prefer cards with TEXT
          //   • push combos to the end
          const items = [];
          for (let i = 0; i < Math.min(count, 12); i++) {
            const card = links.nth(i);
            const text = (await card.innerText({ timeout: 300 }).catch(() => '')).slice(0, 100).trim();
            const href = await card.getAttribute('href').catch(() => '') || '';
            // Walk ancestors looking for widget-class — skip if matched.
            const inWidget = await card.evaluate((el, reSrc) => {
              const re = new RegExp(reSrc, 'i');
              let n = el; while (n && n !== document.body) {
                if (re.test(n.className?.toString?.() || '')) return true;
                n = n.parentElement;
              }
              return false;
            }, WIDGET_RE.source).catch(() => false);
            if (inWidget) continue;
            items.push({ i, card, text, href, isCombo: COMBO_RE.test(`${text} ${href}`), hasText: text.length > 3 });
          }
          // Sort: (1) hasText first, (2) non-combo first, (3) original order
          items.sort((a, b) => {
            if (a.hasText !== b.hasText) return a.hasText ? -1 : 1;
            if (a.isCombo !== b.isCombo) return a.isCombo ? 1 : -1;
            return a.i - b.i;
          });

          for (const { card, text, href } of items.slice(0, 4)) {
            try {
              await card.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
              await card.click({ timeout: 5000 });
              await this.page.waitForLoadState('domcontentloaded').catch(() => {});
              await this.page.waitForTimeout(1200);     // SPA hydration buffer
              if (await this._isProductDetailPage(startUrl)) { landed = true; break; }
              const here = this.page.url();
              if (here !== startUrl && !/\/(search|collection|category|catalog|listing|results|browse|all)\b/i.test(here)) {
                landed = true; break;
              }
              this.logger.debug?.(`[open_first_product] click did not reach a PDP (text="${text.slice(0,30)}", href="${href.slice(0,40)}") — backing up`);
              await this.page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
              await this.page.waitForTimeout(600);
            } catch { /* try next */ }
          }
          if (landed) break;
        }
        if (!landed) throw new Error('could not open a product detail page');
        break;
      }

      case 'read_cart_count':
        memory[step.store] = await this._cartCount();
        break;

      case 'assert_count_increase': {
        const after = await this._cartCount();
        const before = memory[step.from];
        // Happy path: precise count read on both sides.
        if (after !== null && before !== null && after > before) break;
        // Soft fallback: the cart state visibly changed even if we couldn't read a count.
        if (await this._cartChangedSoftly(before, after)) break;
        throw new Error(`cart-add not confirmed (count: ${before ?? '?'} → ${after ?? '?'}; no success signal; not on cart URL)`);
      }

      case 'assert_results': {
        const ok = await this.page.locator(
          '[class*="product" i], [data-test*="product" i], [class*="result" i], article'
        ).first().isVisible().catch(() => false);
        if (!ok) throw new Error('no search results region detected');
        break;
      }

      case 'assert_url':
        if (!step.match.test(this.page.url())) throw new Error(`url ${this.page.url()} !~ ${step.match}`);
        break;

      case 'assert_no_error': {
        const err = await this.page.locator('[role="alert"], .error, [class*="error" i]')
          .filter({ hasText: /invalid|incorrect|error|failed|wrong/i }).first()
          .isVisible().catch(() => false);
        if (err) throw new Error('visible auth/error banner after submit');
        break;
      }

      case 'assert_no_payment_charge':
        // Safety assertion: we must never trigger a real charge in sanity tests.
        if (/payment-success|order-confirmed|thank-you/i.test(this.page.url()))
          throw new Error('SAFETY: flow advanced past payment boundary');
        break;

      default:
        throw new Error(`unknown action: ${step.action}`);
    }
  }

  async _cartCount() {
    // Try multiple cart-badge patterns. Return null (unknown) instead of 0 when
    // we can't confidently read it — that lets the assert_count_increase step
    // fall back to soft signals instead of failing the flow on an unreadable counter.
    const candidates = [
      '[data-test*="cart-count" i]',
      '[data-testid*="cart-count" i]',
      '[data-test*="bag-count" i]',
      '[class*="cart" i] [class*="count" i]',
      '[class*="cart" i] [class*="badge" i]',
      '[class*="bag" i] [class*="count" i]',
      '[class*="basket" i] [class*="count" i]',
      '[aria-label*="cart" i] [class*="count" i]',
      'a[href*="cart" i] [class*="count" i]',
      'a[href*="cart" i] sup',
      'a[href*="cart" i]',
      '[aria-label*="cart" i]',
      'button[aria-label*="cart" i]',
    ];
    for (const sel of candidates) {
      try {
        const txt = await this.page.locator(sel).first().innerText({ timeout: 600 });
        const m = (txt || '').match(/\d+/);
        if (m) return parseInt(m[0], 10);
      } catch { /* try next */ }
    }
    return null;
  }

  async _cartChangedSoftly(before, after) {
    // Strong signal: cart-bound URL
    if (/\/(cart|bag|basket|checkout)/i.test(this.page.url())) return true;

    // Strong signal: a "view bag" / "go to cart" / "proceed to checkout" CTA
    // appeared (these only show up post-add).
    const postAddCtas = [
      'a:has-text(/view (cart|bag|basket)/i):visible',
      'a:has-text(/go to (cart|bag|basket|checkout)/i):visible',
      'button:has-text(/proceed to (checkout|payment)/i):visible',
      'a:has-text(/checkout/i):visible',
    ];
    for (const sel of postAddCtas) {
      if (await this.page.locator(sel).first().isVisible({ timeout: 800 }).catch(() => false)) return true;
    }

    // Toast / inline success message — covers explicit confirmations AND the
    // celebratory "you saved Rs. X / yayyy / thank you" promo modals that
    // some sites pop up AS A RESULT of a successful add (shop-nexus-one's
    // "You will save Rs. 500 — YAYYY!" pattern lives in this bucket).
    const positive = [
      'text=/added.*to.*(cart|bag|basket)/i',
      'text=/(cart|bag).*updated/i',
      'text=/successfully.*(added|carted)/i',
      'text=/in your (cart|bag|basket)/i',
      'text=/item added/i',
      // Celebratory success modals — almost always mean the add went through.
      // Match "you will save Rs. 500" / "you save ₹500" / "save $50" — both
      // textual ("Rs.") and symbolic (₹/$/€/£) currency forms.
      'text=/you (will )?save.*(?:[₹\\$€£]|Rs\\.?)\\s*\\d/i',
      'text=/yayyy+|great choice|congratulations|thanks for adding|nice pick|item added/i',
      'text=/(\\d+\\s*item|\\d+\\s*product) (added|in (your )?bag)/i',
      '[role="status"]:has-text(/added|cart|bag/i)',
      '[role="alert"]:has-text(/added|cart|bag/i)',
      '[class*="toast" i]:has-text(/added|cart|bag/i)',
      '[class*="notification" i]:has-text(/added|cart|bag/i)',
      '[class*="success" i]:has-text(/added|cart|bag/i)',
      // Promo-celebration modals that pop on successful adds
      '[role="dialog"]:has-text(/you (will )?save|yayyy|added to/i)',
      '[class*="modal" i]:has-text(/you (will )?save|yayyy|added to/i)',
    ];
    for (const sel of positive) {
      if (await this.page.locator(sel).first().isVisible({ timeout: 1200 }).catch(() => false)) return true;
    }

    // Numeric count rose (even if we couldn't read "before")
    if (after !== null && (before === null || after > before)) return true;

    // Mini-cart / cart drawer slid in
    const mini = await this.page.locator(
      '[class*="minicart" i]:visible, [class*="mini-cart" i]:visible, ' +
      '[class*="cart-drawer" i]:visible, [class*="cartDrawer" i]:visible, ' +
      '[data-test*="mini-cart" i]:visible, [data-testid*="mini-cart" i]:visible, ' +
      '[class*="sidecart" i]:visible, [class*="side-cart" i]:visible'
    ).first().isVisible({ timeout: 800 }).catch(() => false);
    if (mini) return true;

    // Last-resort: cart endpoint started returning a non-empty body. Cheap probe.
    return await this._cartProbeSaysNonEmpty();
  }

  async _cartProbeSaysNonEmpty() {
    try {
      const here = new URL(this.page.url());
      const origin = `${here.protocol}//${here.host}`;
      // Shopify exposes /cart.js as JSON with item_count
      const r = await this.page.request.get(`${origin}/cart.js`, { timeout: 2500 });
      if (r.ok()) {
        const body = await r.json().catch(() => null);
        if (body && Number.isFinite(body.item_count) && body.item_count > 0) return true;
      }
    } catch { /* not a Shopify shop, ignore */ }
    return false;
  }

  // ---- Self-healing helpers ----

  // True if the current URL is a product-detail page (PDP), not a category /
  // search / brand listing. Used by open_first_product to verify it clicked a
  // real product and not, say, a brand chip.
  async _isProductDetailPage(originalUrl) {
    try {
      const here = this.page.url();
      if (here === originalUrl) return false;

      // Strong exclusion: search / category / collection / listing URLs are NOT PDPs.
      if (/\/(search|collection|category|categories|catalog|listing|results|browse|all)\b/i.test(here)) return false;

      // Strong inclusion: a product-slug-looking URL wins.
      if (/\/(product|products|p|item|dp)\//i.test(here)) return true;

      // Dismiss overlays so an occluded CTA can be found.
      await this._dismissOverlays();
      const hasCta = await this.page.locator(
        'button:has-text(/add to (cart|bag|basket)/i):visible, ' +
        '[role="button"]:has-text(/add to (cart|bag|basket)/i):visible'
      ).first().isVisible({ timeout: 800 }).catch(() => false);
      if (hasCta) return true;

      // Stricter product-shape: a single prominent price (not a price list),
      // a clear h1, AND a main image. Category pages typically have many prices.
      const productShape = await this.page.evaluate(() => {
        const text = (document.body.innerText || '').slice(0, 4000);
        const priceMatches = text.match(/(₹|\$|€|£|RM\s?|MYR\s?|INR\s?|Rs\.?)\s?\d{1,7}(\.\d+)?/g) || [];
        const hasOneMainPrice = priceMatches.length > 0 && priceMatches.length <= 6;  // PDPs: ~1-6 (price, was, EMI). Categories: dozens.
        const h1 = document.querySelector('main h1, h1');
        const hasShortHeading = h1 && (h1.innerText || '').trim().length > 4 && (h1.innerText || '').trim().length < 120;
        const bigImage = Array.from(document.querySelectorAll('main img, img'))
          .find(img => img.offsetParent !== null && img.naturalWidth > 280);
        return hasOneMainPrice && hasShortHeading && !!bigImage;
      }).catch(() => false);
      return productShape;
    } catch { return false; }
  }

  // Capture a "before" snapshot of the cart state across multiple signals.
  // Used to detect *any* change after an add-to-cart click.
  async _readCartBaseline() {
    const count = await this._cartCount();
    let shopifyCount = null;
    try {
      const here = new URL(this.page.url());
      const r = await this.page.request.get(`${here.protocol}//${here.host}/cart.js`, { timeout: 1500 });
      if (r.ok()) {
        const body = await r.json().catch(() => null);
        if (body && Number.isFinite(body.item_count)) shopifyCount = body.item_count;
      }
    } catch { /* not Shopify */ }
    return { count, shopifyCount };
  }

  // After clicking add-to-cart, did the cart actually update?
  // Strict signals: count INCREASED (best evidence the click did something).
  // Lenient signal: cart has items NOW even if it had items before (handles
  // the persistent-cart-from-prior-run case — the desired end state is "cart
  // is non-empty", not "we caused the change").
  async _cartActuallyAdded(before) {
    // 1. Shopify /cart.js — most reliable when available.
    try {
      const here = new URL(this.page.url());
      const r = await this.page.request.get(`${here.protocol}//${here.host}/cart.js`, { timeout: 1800 });
      if (r.ok()) {
        const body = await r.json().catch(() => null);
        if (body && Number.isFinite(body.item_count)) {
          if (before.shopifyCount !== null && body.item_count > before.shopifyCount) return true;
          if (before.shopifyCount === null && body.item_count > 0) return true;
          // If count was already >= 1 and is now >= 1, accept it — the cart
          // is in the right end state regardless of whether THIS click added.
          if (before.shopifyCount !== null && before.shopifyCount >= 1 && body.item_count >= 1) return true;
          // Shopify said count is 0 and unchanged → click really was a no-op.
          if (before.shopifyCount !== null && body.item_count === 0) return false;
        }
      }
    } catch { /* fall through */ }

    // 2. Cart-count badge.
    const nowCount = await this._cartCount();
    if (before.count !== null && nowCount !== null && nowCount > before.count) return true;
    if (before.count === null && nowCount !== null && nowCount > 0) return true;
    // Lenient: cart was already populated and is still populated.
    if (before.count !== null && before.count >= 1 && nowCount !== null && nowCount >= 1) return true;

    // 3. Visible positive confirmation (toast / drawer / cart-bound URL).
    return await this._cartChangedSoftly(before.count, nowCount);
  }

  async _configuratorModalOpen() {
    // True if a dialog/drawer/modal is currently visible with combo-builder UI.
    try {
      return await this.page.locator(
        '[role="dialog"]:visible, [class*="modal" i]:visible, [class*="drawer" i]:visible, ' +
        '[class*="customis" i]:visible, [class*="customiz" i]:visible, [class*="builder" i]:visible'
      ).first().isVisible({ timeout: 600 });
    } catch { return false; }
  }

  // After combo slots are filled, find the final "Add Combo / Add to Cart"
  // button INSIDE the open modal and click it.
  async _clickFinalAddInModal() {
    const finalAddSelectors = [
      '[role="dialog"]:visible button:has-text(/^\\s*(add combo|add to (cart|bag|basket)|add item|done|confirm|add)\\s*-?\\s*(RM|₹|\\$|€|£)?\\s*[\\d.]*\\s*$/i):not([disabled]):visible',
      '[class*="modal" i]:visible button:has-text(/^\\s*(add combo|add to (cart|bag|basket)|done|confirm)\\s/i):not([disabled]):visible',
      '[class*="drawer" i]:visible button:has-text(/add combo|add to (cart|bag)/i):not([disabled]):visible',
      '[class*="builder" i]:visible button:has-text(/^\\s*(add|done|confirm)\\s/i):not([disabled]):visible',
      'button:has-text(/^\\s*add combo\\s/i):not([disabled]):visible',
    ];
    for (const sel of finalAddSelectors) {
      const btn = this.page.locator(sel).first();
      if (await btn.count().catch(() => 0)) {
        try {
          await btn.scrollIntoViewIfNeeded({ timeout: 800 }).catch(() => {});
          await btn.click({ timeout: 3500 });
          return true;
        } catch { /* try next */ }
      }
    }
    return false;
  }

  // Combo / configurator slot filler. Many sites (food combos, beauty bundles,
  // build-your-own boxes) gate the Add-to-Cart CTA on empty "Select X" /
  // "Choose your shade" / "Pick one" placeholders being filled. For each
  // visible slot prompt, click it (opens a modal), then click the first
  // product-like option inside, then continue.
  //
  // The slot-noun vocabulary below is intentionally generic across e-commerce
  // verticals (food, fashion, beauty, electronics). Override via site config
  // `overrides.slotNouns: [...]` if a site uses very domain-specific words.
  async _fillRequiredSlots(maxSlots = 4) {
    const slotNouns = (this.overrides?.slotNouns || [
      'item', 'product', 'shade', 'colour', 'color', 'size', 'flavour', 'flavor',
      'option', 'variant', 'topping', 'side', 'dish', 'add[\\s-]?on',
    ]).join('|');
    const slotPatterns = [
      `button:has-text(/^\\s*select (a |an |your )?(${slotNouns})\\s*$/i):visible`,
      `[role="button"]:has-text(/select (a |an |your )?(${slotNouns})/i):visible`,
      `div:has-text(/select (a |an |your )?(${slotNouns})/i):visible[class*="slot" i]`,
      '[class*="slot" i]:has-text(/select|choose|pick/i):visible',
      '[class*="placeholder" i]:has-text(/select|choose|pick/i):visible',
      'button:has-text(/^\\s*(add|choose|pick)\\s+(an item|a side|a topping|a drink|a dessert)/i):visible',
    ];
    let filled = 0;
    const seenTexts = new Set();
    for (let pass = 0; pass < maxSlots; pass++) {
      let acted = false;
      for (const sel of slotPatterns) {
        const slots = this.page.locator(sel);
        const count = await slots.count().catch(() => 0);
        for (let i = 0; i < Math.min(count, 4); i++) {
          const slot = slots.nth(i);
          const text = ((await slot.innerText({ timeout: 200 }).catch(() => '')) || '').slice(0, 80).trim();
          if (seenTexts.has(text)) continue;     // already tried this slot
          seenTexts.add(text);
          try {
            await slot.scrollIntoViewIfNeeded({ timeout: 800 }).catch(() => {});
            await slot.click({ timeout: 2500 }).catch(() => {});
            await this.page.waitForTimeout(900);
            // A modal/drawer/picker should have opened. Pick the first
            // product-like option inside.
            if (await this._pickFromOpenPicker()) {
              filled++;
              acted = true;
              break;
            }
            // Picker didn't yield — close anything we may have opened.
            await this.page.keyboard.press('Escape').catch(() => {});
          } catch { /* try next */ }
        }
        if (acted) break;
      }
      if (!acted) break;     // no more slots to fill
    }
    return filled;
  }

  // After a slot is clicked, a modal/drawer/listing is usually open with
  // product options. Pick the first sensible one, then wait for the modal
  // to close. Returns true if a selection was made.
  async _pickFromOpenPicker() {
    const optionPatterns = [
      // First, look inside any visible modal/drawer
      '[role="dialog"]:visible button:has-text(/select|choose|add|pick this/i):visible',
      '[role="dialog"]:visible [class*="product" i] button:visible',
      '[role="dialog"]:visible [class*="product" i] a:visible',
      '[class*="modal" i]:visible button:has-text(/select|choose|add|pick this/i):visible',
      '[class*="drawer" i]:visible button:has-text(/select|choose|add|pick this/i):visible',
      // Bottom-sheet / overlay patterns
      '[class*="overlay" i]:visible [class*="product" i] a:visible',
      '[class*="overlay" i]:visible [class*="card" i] button:visible',
      // Generic: any newly-visible product card
      'main [class*="product" i] button:has-text(/select|choose|add|pick/i):visible',
    ];
    for (const sel of optionPatterns) {
      const opts = this.page.locator(sel);
      const count = await opts.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 3); i++) {
        try {
          await opts.nth(i).click({ timeout: 2000 });
          await this.page.waitForTimeout(900);
          // Wait briefly for the modal to close.
          await this.page.locator('[role="dialog"]:visible, [class*="modal" i]:visible')
            .first().waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});
          return true;
        } catch { /* try next */ }
      }
    }
    return false;
  }

  // Try opening a DIFFERENT product if the current one's add-to-cart isn't
  // working (e.g. combo deals that require sub-selection, out-of-stock items,
  // login-gated PDPs). Goes back to the previous listing/menu page and tries
  // the next candidate. Returns true if a new product was opened successfully.
  async _tryAnotherProduct() {
    try {
      // Go back in history if we navigated forward (Playwright preserves it).
      const before = this.page.url();
      await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 4000 }).catch(() => {});
      await this.page.waitForTimeout(600);
      const after = this.page.url();
      if (after === before) return false;     // couldn't go back
      const COMBO_RE = /combo|bundle|deal\b|meal\b|family pack|set\b|build your|create your|customi[sz]e/i;
      const candidates = [
        'a[href*="/products/" i]', 'a[href*="/product/" i]', 'a[href*="/p/" i]',
        '[class*="product-card" i] a', 'main article a[href]',
      ];
      for (const sel of candidates) {
        const links = this.page.locator(sel);
        const count = await links.count().catch(() => 0);
        // Build candidate list; skip the FIRST item (already tried) and combos.
        const tryList = [];
        for (let i = 1; i < Math.min(count, 8); i++) {
          const card = links.nth(i);
          const text = (await card.innerText({ timeout: 300 }).catch(() => '')).slice(0, 100);
          const href = await card.getAttribute('href').catch(() => '') || '';
          tryList.push({ card, isCombo: COMBO_RE.test(`${text} ${href}`) });
        }
        tryList.sort((a, b) => (a.isCombo === b.isCombo) ? 0 : (a.isCombo ? 1 : -1));
        for (const { card } of tryList.slice(0, 4)) {
          try {
            await card.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
            await card.click({ timeout: 3500 });
            await this.page.waitForLoadState('domcontentloaded').catch(() => {});
            await this.page.waitForTimeout(700);
            if (this.page.url() !== after) {
              await this._dismissOverlays();
              return true;
            }
          } catch { /* try next */ }
        }
      }
      return false;
    } catch { return false; }
  }

  // Generic overlay/promo/consent dismisser. Up to 3 layers because some
  // sites stack them. Cheap, idempotent — fine to call before any
  // click-bound step.
  /**
   * Detect a pre-purchase gate that makes ANY add-to-cart click a no-op.
   * Returns a short reason string when one is detected; null otherwise.
   *
   * The agent should fail fast (no looping) when one of these is true:
   *   • the page shows "No Store Selected" / "Select store" / "Find a store"
   *   • the page shows "Sign in to add to cart" / login wall
   *   • all variants on the page are sold out (no enabled size/color)
   *
   * This is generic: each match is a substring on body text, not a per-site
   * selector. Stops duplicate-item pile-ups on store-gated sites cold.
   */
  async _detectPrePurchaseGate() {
    try {
      const txt = (await this.page.locator('body').innerText({ timeout: 1000 })).slice(0, 8000);
      if (/no store selected|select (a )?store to|please select (your )?store|find (a )?(store|hut|restaurant)/i.test(txt)
          && /accurate menu|see menu|view menu|to (order|continue)/i.test(txt)) {
        return 'no store selected (store-gated)';
      }
      if (/sign in (to (continue|add|order|checkout))|please log in (to|first)|login required/i.test(txt)) {
        return 'login required';
      }
      // All-sold-out detection: every variant on the page has "sold out" near it.
      if (/all (sizes|variants|options) (are )?(sold out|out of stock)/i.test(txt)) {
        return 'all variants sold out';
      }
      return null;
    } catch { return null; }
  }

  /**
   * Hover-to-reveal — many e-commerce sites hide the inline Add-to-Bag/
   * Quick-Add CTA on product cards until the user hovers. If add_to_cart
   * isn't visible right now, hover over the first product card on the page
   * and give the UI a moment to render the CTA.
   *
   * Sephora India, Myntra, Tira, Ajio all use this pattern on listing pages.
   * On a real PDP the button is always visible, so the hover is a no-op there.
   */
  async _hoverToRevealAddButton() {
    try {
      const { locator } = await this.resolver.resolve('add_to_cart');
      if (await locator.isVisible({ timeout: 500 }).catch(() => false)) return;
    } catch { /* not resolvable yet — try the hover */ }

    // Hover ANY visible product card — for the hover-to-reveal pattern,
    // recommendation-widget cards (DY, Algolia, "you may also like" carousels)
    // ARE legitimate products, not noise. Sephora's `/search?q=lipstick` is
    // ENTIRELY DY widgets — skipping them leaves nothing to hover. The
    // widget-skip filter still applies to open_first_product (PDP navigation),
    // where it matters.
    const card = this.page.locator(
      'a[href*="/product/" i]:visible, a[href*="/products/" i]:visible, ' +
      '[class*="product-card" i]:visible, [class*="product-tile" i]:visible'
    ).first();
    if (await card.count().catch(() => 0) === 0) return;

    try {
      await card.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      await card.hover({ timeout: 2000 });
      await this.page.waitForTimeout(800);
      this.logger.debug?.('[heal] hovered over product card to reveal inline Add button');
    } catch { /* hover failed — continue */ }
  }

  async _dismissOverlays() {
    // Catches ALL the common overlay-dismiss patterns I've seen in the wild:
    //   • <button aria-label="close">
    //   • <button> with "no thanks / maybe later / ×" text
    //   • DIVs with "close" / "popupClose" in their class (and an SVG child)   ← shop-nexus-one's pattern
    //   • Elements containing "Download App" / "Get app" prompts (vendor-neutral)
    const closeSelectors = [
      'button[aria-label*="close" i]:visible',
      'button[aria-label*="dismiss" i]:visible',
      'button[aria-label*="no thanks" i]:visible',
      'button:has-text(/no thanks|maybe later|continue browsing|continue to (site|web)|×|✕/i):visible',
      '[class*="close" i] button:visible',
      '[class*="modal" i] button[class*="close" i]:visible',
      '[class*="promo" i] button:has-text(/close|×|✕|skip/i):visible',
      '[class*="popup" i] [aria-label*="close" i]:visible',
      // Div / span / svg-wrapper close-buttons (shop-nexus-one's "download app" popup uses this)
      'div[class*="popupClose" i]:visible',
      'div[class*="popup-close" i]:visible',
      'span[class*="close-icon" i]:visible',
      '[class*="downloadApp" i] [class*="close" i]:visible',
      '[class*="download-app" i] [class*="close" i]:visible',
      // Cross-button containing SVG cross icon
      '[role="button"][aria-label*="close" i]:visible',
      // Top-right X icons inside modals/dialogs — extremely common pattern
      '[role="dialog"]:visible svg[class*="close" i]',
      '[class*="modal" i]:visible svg[class*="close" i]',
      // Bare X-text close controls (× ✕ Close)
      'button:has-text(/^\\s*[×✕✖]\\s*$/):visible',
      '[role="button"]:has-text(/^\\s*[×✕✖]\\s*$/):visible',
      // Generic "no-text icon button" inside a dialog top-right area
      // (most common close-icon pattern — small, no visible text, has svg)
      '[role="dialog"]:visible button:not(:has-text(/\\w/)):visible',
      '[class*="modal" i]:visible button:not(:has-text(/\\w/)):visible',
    ];
    for (let layer = 0; layer < 4; layer++) {
      let dismissed = false;
      for (const sel of closeSelectors) {
        const btn = this.page.locator(sel).first();
        if (await btn.count().catch(() => 0)) {
          if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
            await btn.click({ timeout: 1500, force: true }).catch(() => {});
            dismissed = true;
            await this.page.waitForTimeout(250);
            break;
          }
        }
      }
      // Also try the Escape key — works for many native modals.
      await this.page.keyboard.press('Escape').catch(() => {});
      if (!dismissed) break;
    }
  }

  async _isVisibleSoon(locator, timeoutMs = 800) {
    try { return await locator.isVisible({ timeout: timeoutMs }); }
    catch { return false; }
  }

  // Fillable = visible AND the underlying element is a text-ish input/textarea/contenteditable.
  // Catches the case where the LLM rung picks a button or link for an input intent.
  async _isFillable(locator) {
    if (!locator) return false;
    if (!(await this._isVisibleSoon(locator))) return false;
    try {
      const ok = await locator.evaluate(el => {
        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'textarea') return true;
        if (tag === 'input') {
          const t = (el.getAttribute('type') || 'text').toLowerCase();
          return ['text', 'search', 'email', 'tel', 'url', 'number', 'password', ''].includes(t);
        }
        if (el.isContentEditable) return true;
        return false;
      });
      return !!ok;
    } catch { return false; }
  }

  /**
   * Build a /search?q=… URL for the current site, if its platform supports it.
   * Returns null if nothing recognizable. Empirically, this works on virtually
   * every Shopify / Magento / WooCommerce / BigCommerce storefront.
   */
  async _searchByUrl(query) {
    try {
      const here = new URL(this.page.url());
      const origin = `${here.protocol}//${here.host}`;
      const q = encodeURIComponent(query || '');
      // Order matters: try the most-common pattern first.
      const candidates = [
        `${origin}/search?q=${q}`,        // Shopify, WooCommerce
        `${origin}/catalogsearch/result?q=${q}`,   // Magento 2
        `${origin}/search?search=${q}`,
        `${origin}/?s=${q}&post_type=product`,     // WP/WooCommerce
      ];
      // Smoke each one cheaply via HEAD; first that returns a 2xx wins.
      for (const url of candidates) {
        try {
          const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
          if (r.ok || (r.status >= 200 && r.status < 400)) return url;
        } catch { /* try next */ }
      }
      return candidates[0];   // Best-effort: Shopify is overwhelmingly the most common.
    } catch { return null; }
  }

  // ---- Tier 3 + Tier 4: diagnose, ticket, propose fix ----
  async _remediate(flowKey, flow, step, err) {
    // Rich page snapshot for the LLM narrator: visible interactive elements
    // PLUS URL, title, and a small slice of visible body text (catches modals,
    // toasts, "Choose your shade" prompts the agent didn't see).
    const snapshot = await this.page.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && el.offsetParent !== null;
      };
      const interactives = Array.from(document.querySelectorAll('button,a,input,select,textarea,[role]'))
        .filter(visible).slice(0, 80)
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          type: el.getAttribute('type') || '',
          text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').slice(0, 60).trim(),
          disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
        }))
        .filter(e => e.text || e.role);
      const modals = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal" i]:not([class*="modal-trigger" i])'))
        .filter(visible).slice(0, 3)
        .map(el => (el.innerText || '').slice(0, 200).trim());
      return {
        url: location.href,
        title: document.title,
        bodyText: (document.body.innerText || '').slice(0, 800),
        interactives,
        modals,
      };
    }).catch(() => ({ url: '', title: '', bodyText: '', interactives: [], modals: [] }));

    // Old-style brief diagnosis (still produced for the bug ticket title).
    const diagnosis = await this.llm.diagnose({ flow: flow.name, step, error: err?.message, domDigest: snapshot.interactives });

    // Phase-6 (option C): narrated failure — "what's actually on the page right now."
    const narrative = await this._narrateFailure(flow, step, err, snapshot);

    const proposal = this._proposeFix(step, snapshot.interactives);

    return {
      ticket: {
        title: `[Sanity] ${flow.name} failed at "${step.action}" (${step.intent || '-'})`,
        severity: flow.critical ? 'high' : 'medium',
        diagnosis,
        narrative,                       // NEW: human-readable "what I saw" paragraph
        snapshot: { url: snapshot.url, title: snapshot.title, modals: snapshot.modals },
        repro: { flow: flowKey, step },
      },
      proposedFix: proposal,
    };
  }

  // Ask the LLM to look at the failure context and explain WHAT was on the
  // page when the step failed. Drives the "the agent caught and explained the
  // bug" half of the demo story.
  async _narrateFailure(flow, step, err, snapshot) {
    if (!this.llm?.enabled) {
      // Fallback when no LLM is available: hand-roll a useful description.
      const has = (re) => re.test(snapshot.bodyText || '');
      const hints = [];
      if (has(/empty/i)) hints.push('the page mentions "empty" — likely an empty cart');
      if (has(/select\s+(your\s+)?(size|shade|variant|colou?r)/i)) hints.push('a variant picker is required');
      if (snapshot.modals.length) hints.push('a modal/dialog is open');
      if (snapshot.interactives.find(i => i.disabled && /add|cart|bag/i.test(i.text))) hints.push('the add-to-cart button appears disabled');
      return hints.length
        ? `Page state: ${snapshot.title} (${snapshot.url}). Hints: ${hints.join('; ')}.`
        : `Page state: ${snapshot.title} (${snapshot.url}). No obvious blocker pattern detected.`;
    }
    try {
      const prompt =
        `You are diagnosing why an automated sanity test step failed. Look at the page state ` +
        `and explain in 1-2 SHORT sentences what's ACTUALLY on the page that explains why this step couldn't complete. ` +
        `Don't speculate beyond what you see. Don't restate the error.\n\n` +
        `Step that failed: ${JSON.stringify(step)}\nError: ${err?.message}\n` +
        `Page: ${snapshot.title} (${snapshot.url})\n` +
        `Visible interactive elements (top 30): ${JSON.stringify(snapshot.interactives.slice(0, 30))}\n` +
        `Open modals: ${JSON.stringify(snapshot.modals)}\n` +
        `Visible body text (first 600 chars): ${(snapshot.bodyText || '').slice(0, 600)}\n`;
      return await this.llm._complete(prompt);
    } catch (e) {
      return `(LLM narration unavailable: ${e.message})`;
    }
  }

  _proposeFix(step, domDigest) {
    if (!step.intent) return null;
    // Suggest the closest interactive element by text as a new selector candidate.
    const guess = domDigest.find(e => /cart|login|sign|search|checkout|email|password/i.test(e.text));
    return {
      type: 'selector-candidate',
      intent: step.intent,
      candidate: guess ? `text=/${guess.text.trim().slice(0, 20)}/i` : null,
      action: 'Add candidate to site profile after one human-approved verification run.',
      requiresApproval: true,
    };
  }
}

function describe(step) { return { action: step.action, intent: step.intent || null, note: step.note || null }; }
function interp(tmpl, ctx) {
  return String(tmpl).replace(/\{\{([\w.]+)\}\}/g, (_, p) => p.split('.').reduce((o, k) => (o || {})[k], ctx) ?? '');
}

module.exports = { FlowRunner };
