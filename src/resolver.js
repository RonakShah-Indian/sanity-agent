'use strict';

/**
 * SemanticResolver
 * -----------------
 * The heart of the system. Given an abstract intent (e.g. "add_to_cart")
 * it resolves to a real element on an arbitrary site WITHOUT a hand-written
 * selector per site.
 *
 * It walks a STRATEGY LADDER, cheapest + most stable first:
 *   1. Learned profile     - a selector that worked before on THIS site (self-learning)
 *   2. Accessibility/role  - ARIA roles + accessible names (most stable, localization-friendly)
 *   3. Semantic text       - label/text/placeholder matching across locales (synonym dictionary)
 *   4. Heuristics          - structural cues (e.g. button near a price, input of type=password)
 *   5. LLM-vision fallback - ask a model to read the rendered page and point to the element
 *
 * Whatever rung succeeds is written back to the site profile, so the next run
 * starts at rung 1. A previously-cached selector that breaks triggers a walk
 * back down the ladder + a profile update = SELF-HEALING.
 */

const { INTENT_LIBRARY } = require('./intents');

class SemanticResolver {
  constructor({ page, profile, llm = null, overrides = null, logger = console }) {
    this.page = page;
    this.profile = profile;        // SiteProfile instance (learned memory)
    this.llm = llm;                // optional LLMClient for the vision fallback
    this.overrides = overrides;    // optional per-site selector overrides (Rung 0)
    this.logger = logger;
  }

  /**
   * Resolve an intent to a Playwright Locator + metadata on how it was found.
   * Returns { locator, strategy, selector } or throws ResolutionError.
   */
  async resolve(intent, opts = {}) {
    const spec = INTENT_LIBRARY[intent];
    if (!spec) throw new Error(`Unknown intent: ${intent}`);

    const ladder = [
      () => this._fromOverride(intent),     // Rung 0 — site-specific override (highest priority)
      () => this._fromProfile(intent),
      () => this._byRole(spec),
      () => this._bySemanticText(spec),
      () => this._byHeuristic(spec),
      () => this._byLLMVision(intent, spec),
    ];

    let lastErr;
    for (const rung of ladder) {
      try {
        const hit = await rung();
        if (hit && (await this._isUsable(hit.locator))) {
          // Self-learning: remember what worked (unless it came from profile already)
          if (hit.strategy !== 'profile') {
            await this.profile.remember(intent, hit.selector, hit.strategy);
          }
          return hit;
        }
      } catch (e) {
        lastErr = e;
      }
    }
    throw new ResolutionError(intent, lastErr);
  }

  // --- Rung 0: site-supplied selector override (highest priority) ---
  // Per-site config can pin a selector for an intent (escape hatch for sites
  // with custom/exotic UIs that defeat semantic resolution).
  async _fromOverride(intent) {
    const sel = this.overrides?.selectors?.[intent];
    if (!sel) return null;
    const locator = this.page.locator(sel).first();
    if (await this._isUsable(locator)) {
      return { locator, strategy: 'override', selector: sel };
    }
    return null;
  }

  // --- Rung 1: learned memory (fast path + self-heal entry point) ---
  async _fromProfile(intent) {
    const learned = this.profile.recall(intent);
    if (!learned) return null;
    const locator = this.page.locator(learned.selector).first();
    if (await this._isUsable(locator)) {
      return { locator, strategy: 'profile', selector: learned.selector };
    }
    // Cached selector no longer works -> demote it, fall through to re-resolve (HEAL)
    this.profile.demote(intent);
    this.logger.debug?.(`[heal] cached selector stale for ${intent}, re-resolving`);
    return null;
  }

  // --- Rung 2: accessibility roles + accessible name (most robust) ---
  async _byRole(spec) {
    for (const r of spec.roles || []) {
      for (const name of spec.names || [null]) {
        const locator = name
          ? this.page.getByRole(r, { name, exact: false }).first()
          : this.page.getByRole(r).first();
        if (await this._isUsable(locator)) {
          const selector = name ? `role=${r}[name=/${escapeRe(name)}/i]` : `role=${r}`;
          return { locator, strategy: 'role', selector };
        }
      }
    }
    return null;
  }

  // --- Rung 3: localized text / placeholder / label matching ---
  async _bySemanticText(spec) {
    for (const phrase of spec.names || []) {
      // try button/link text, placeholders, labels, aria-labels
      const candidates = [
        this.page.getByText(new RegExp(escapeRe(phrase), 'i')).first(),
        this.page.getByPlaceholder(new RegExp(escapeRe(phrase), 'i')).first(),
        this.page.getByLabel(new RegExp(escapeRe(phrase), 'i')).first(),
        this.page.locator(`[aria-label*="${phrase}" i]`).first(),
      ];
      for (const locator of candidates) {
        if (await this._isUsable(locator)) {
          return { locator, strategy: 'semantic-text', selector: `text~=/${escapeRe(phrase)}/i` };
        }
      }
    }
    return null;
  }

  // --- Rung 4: structural heuristics specific to the intent ---
  async _byHeuristic(spec) {
    if (!spec.heuristic) return null;
    const locator = await spec.heuristic(this.page);
    if (locator && (await this._isUsable(locator))) {
      return { locator, strategy: 'heuristic', selector: spec.heuristicName || 'heuristic' };
    }
    return null;
  }

  // --- Rung 5: LLM reads the rendered page and points to the element ---
  async _byLLMVision(intent, spec) {
    if (!this.llm) return null;
    // Collect a compact DOM digest of interactive elements (cheap, no screenshot needed)
    const digest = await this.page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, a, input, [role], [onclick]'));
      return els.slice(0, 200).map((el, i) => {
        el.setAttribute('data-agent-idx', i);
        const r = el.getBoundingClientRect();
        return {
          idx: i, tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').slice(0, 60),
          type: el.getAttribute('type') || '',
          visible: r.width > 0 && r.height > 0,
        };
      }).filter(e => e.visible);
    });

    const idx = await this.llm.pickElement({ intent, goal: spec.goal, elements: digest });
    if (idx == null) return null;
    const selector = `[data-agent-idx="${idx}"]`;
    const locator = this.page.locator(selector).first();
    if (await this._isUsable(locator)) {
      return { locator, strategy: 'llm-vision', selector };
    }
    return null;
  }

  async _isUsable(locator) {
    try {
      const count = await locator.count();
      if (count === 0) return false;
      return await locator.isVisible();
    } catch {
      return false;
    }
  }
}

class ResolutionError extends Error {
  constructor(intent, cause) {
    super(`Could not resolve intent "${intent}" by any strategy`);
    this.name = 'ResolutionError';
    this.intent = intent;
    this.cause = cause;
  }
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { SemanticResolver, ResolutionError };
