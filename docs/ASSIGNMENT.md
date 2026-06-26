# QA Agent — Fynd Assignment (3 named sites + scaling pattern)

Covers the three sites in the HR brief, each with its real end-to-end journey,
plus the configuration pattern for adding more sites. Built on the autonomous
agent in this repo (semantic resolution, self-learning, self-healing, business
classification, deployment diffing, bug reporting).

---

## 1. The three sites and their critical journeys

Each site is a **different archetype**, so each gets a **different tailored plan**
— the agent classifies the business and selects flows automatically. Config in
`config/fynd-assignment-sites.json`.

### Pizza Hut Malaysia — `pizzahut.com.my`
**Archetype:** food ordering / delivery (location-gated).
**The QA-critical wrinkle:** the server gates `/products*` URLs and the cart on
a `store-id` cookie. A fresh session gets silently redirected to the homepage
unless the agent warms up via the homepage first. The cart page also hides item
rows behind a "No Delivery Address" overlay even when items ARE present.
**Journey (`browse_add_to_cart` + `checkout` flows):**
homepage warm-up → `/products` → `/products/?category_phm=Pizza` → click "+" on
first pizza card → `/cart` → verify items via "Added Items (N)" text → checkout
flow re-verifies cart — **hard stop before payment.**
Key scenarios: anti-bot/session warm-up, cross-element cart verification.

### Sephora India — `sephora.in`
**Archetype:** beauty marketplace.
**The QA-critical wrinkle:** product cards on listing pages hide the "ADD TO
BAG" button until you HOVER. Without a real CDP mouse-hover, the button can't
be clicked.
**Journey (`browse_add_to_cart` + `checkout` flows):**
land on `/products?q=lipstick` → hover first product card → click "ADD TO
BAG" → `/cart/bag` → assert cart not empty → checkout button — **stop at
payment.**
Key scenarios: CDP hover-to-reveal, listing-based add (no PDP needed), bag
update.

### Shop Nexus One — `shopnexusone.com`
**Archetype:** fashion / lifestyle e-commerce (Shopify-class).
**The QA-critical wrinkle:** the checkout button is gated behind a login wall,
so the "checkout" flow is implemented as **cart-verification** (navigate to
`/cart/bag`, assert items) rather than clicking through to the login page.
**Journey (`add_to_cart` + `checkout` flows):**
search → product detail → add to bag → `/cart/bag` → verify items —
the clean baseline path.
Key scenarios: standard add-to-cart handler, cart drawer/page detection, login
gating detected and gracefully reported.

> **Payment safety:** every journey stops at the payment page and asserts it has
> NOT advanced past a payment/confirmation boundary (`assert_no_payment_charge`).
> The agent never submits a real order or payment on a live site.

---

## 2. What the agent does on each site (no manual setup)

1. **Detects locale + currency** (Pizza Hut → MYR, Sephora → INR, etc.).
2. **Classifies the business** and picks the tailored flow plan.
3. **Resolves elements semantically** — no per-site JavaScript. Sites that
   need a pinned selector or specific URL sequence (Pizza Hut MY, Sephora) use
   declarative `overrides.selectors` or `flowSteps` in the site's JSON entry;
   no `.js` file is per-site. The strategy
   ladder (learned profile → ARIA role → localized text → heuristic → LLM
   vision) finds the address box, the menu item, the add-to-cart button on each
   site without bespoke code.
4. **Self-learns** — caches what worked per site; the next run is faster.
5. **Self-heals** — when a site changes and a cached selector breaks, it
   re-resolves and re-learns automatically.
6. **Diffs against the last healthy baseline** — outlines exactly what changed
   since the last good run (flow status, structure, performance, locale).
7. **Remediates** — heal → retry → quarantine → ticket → approval-gated fix
   proposal.
8. **Files bugs** — converts findings into ready-to-post issue payloads.

---

## 3. Bug reporting to Jira (and other tools)

`src/bugreporter.js` turns every finding (failed flow + diagnosis, or a
high-severity deploy regression) into a **ready-to-file issue payload**:

- **Jira** — Cloud REST v3 `POST /rest/api/3/issue` with a valid ADF
  description, priority mapped from severity, labels (`qa-agent`, `site-…`), and
  a **dedupe key** so re-runs update rather than duplicate.
- **Slack** — Block Kit message. **Linear** — `issueCreate` input.
  **Webhook** — generic body for Teams/custom.

**Demo scope:** payloads are generated and written to `bug-payloads.json`
(dry-run, not posted) — see `reports/assignment-demo/jira-preview.png`. Flip
`dryRun:false` and supply a token and the same payloads POST live; the
construction code is shared, so going live is a config change, not a rewrite.

---

## 4. Adding more sites (the scaling pattern)

Adding a site is **one config entry** — no new code, because flows are abstract
and resolution is semantic:

```json
{
  "id": "my-new-store",
  "url": "https://example-store.com/",
  "query": "shoes",
  "flows": ["search_product", "add_to_cart", "checkout"]
}
```

- Omit `flows` entirely and the **business classifier picks the plan** for you.
- For a food/quick-commerce site, add `"address": "..."` and the location gate is
  handled by the `food_order` flow. For session-gated food sites (Pizza Hut MY)
  use `browse_add_to_cart` + `flowSteps` with a homepage warm-up navigation.
- For sites that hide the Add-to-Cart button until hover (Sephora, Tira), drop
  a `{ "action": "hover" }` into the `flowSteps.browse_add_to_cart` step list.
- For a new language, add synonyms to one dictionary in `src/intents.js` — every
  site benefits, nothing else changes.

To run many sites at scale (1,000+), the same config feeds the worker pool
(`orchestrator.js`); deploy-triggered runs use tiered execution to stay within a
5-minute budget. Full model in `docs/SCALE.md`.

---

## 5. Run it

```bash
npm install playwright
npx playwright install chromium

node src/index.js --sites config/fynd-assignment-sites.json --concurrency 3
# → reports/run-<ts>/report.html   (dashboard, per-site + diffs)
# → reports/run-<ts>/bug-payloads.json  (Jira/Slack/Linear/webhook, dry-run)
# → reports/run-<ts>/junit.xml     (CI gate)
# exits non-zero on any critical failure
```

Tests (no browser needed): `node test/core.test.js && node test/intelligence.test.js && node test/bugreporter.test.js`

---

## 6. Honest notes

- The build sandbox blocked the Playwright browser-binary CDN, so the rendered
  report and Jira preview in `reports/assignment-demo/` are representative runs
  proving the pipeline and payload schema. The code runs live against the three
  URLs wherever Chromium is installed.
- The journeys deliberately stop at the payment page on these live sites — the
  agent will never place a real order.
- Selectors/flows are resilient by design, but the first live run against each
  site is also a *learning* run: it resolves via the ladder and caches a profile,
  so the second run is faster and more stable. That is the self-learning loop
  doing its job.
