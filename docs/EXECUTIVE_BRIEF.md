# Quality Intelligence for Fynd — Executive Brief

*Ronak Shah · Director of QA candidate · one-page read*

---

**The idea in one sentence.** An AI-native quality layer that runs sanity tests
on *any* storefront the platform powers — with no test written per site — and
reports what changed within **5 minutes of every deployment**.

**Why it matters to Fynd specifically.** Fynd is one platform powering thousands
of brand storefronts. Every platform deploy raises the same question — *did this
break checkout on any of 1,000 storefronts?* — that per-site test scripts cannot
answer at scale. This system answers it automatically, and the same capability
becomes a **brand-onboarding accelerator**: a new storefront gets sanity coverage
on day one, for free.

---

### What makes it work (one design choice)

Instead of scripting each site, flows describe **intent** ("add the first product
to cart and verify the count went up"). A resolver figures out the actual
elements at runtime via a strategy ladder — learned memory → accessibility roles
→ localized text → heuristics → an LLM vision fallback. Whatever works is cached,
so the system **learns** each site and **self-heals** when a site changes. Cost
stays flat as the number of sites grows; an LLM is the rare fallback, not the
default.

### What it delivers

| Capability | Outcome |
|---|---|
| Cross-site, script-free testing | Covers any storefront, including brand-new ones |
| Business classification | Tailors the test plan — B2B leads with auth, q-commerce with cart, SaaS skips checkout |
| Deployment diffing | Reports exactly what a deploy changed vs the last healthy baseline |
| 5-minute deploy gate | Webhook-triggered, tiered execution — typical deploy (50 changed sites) verifies in ~2 minutes; full 1,000-site sweep ~10 minutes at 50 concurrency |
| Autonomous remediation | Self-heal → retry → quarantine → ticket → **approval-gated** fix proposal |

### The numbers (design targets, derivation in SCALE.md §7)

- **~2 min** for a 50-changed-sites deploy sweep at 50 concurrency (the realistic deploy gate path).
- **~10 min** wall-clock for a full 1,000-site sweep at 50 concurrency; **~2 min** when 100 concurrent browsers are available.
- **~$2** *compute* per full 1,000-site sweep at spot pricing. Excludes BrowserStack real-device contract and LLM token cost on cold-start fleets (steady state is ~0 LLM calls because the profile cache wins).
- **End-to-end validated** on **4 commerce sites** — the 3 Fynd assignment sites (`pizzahut.com.my`, `sephora.in`, `shopnexusone.com`) plus `nykaa.com` added live as a worked onboarding exercise — **8/8 critical flows green in 217s, all 4 sites status `passed`**. **Not yet load-tested above 4 sites** — the throughput numbers above are projected from the per-site model in `SCALE.md`.

### The boundary I drew (deliberately)

Auto-remediation is autonomous for detect / diagnose / heal / ticket. It
**proposes** test-side fixes but requires approval before trusting them, and it
**never** patches site code unattended. A QA agent that silently rewrites tests
or claims unattended code fixes is a liability — it can mask a real regression as
a "heal." The defensible claim is autonomous detection and proposal, with gated
promotion of anything that redefines "correct."

---

### Where I'd take it (first 90 days)

1. **30 days** — deploy gate on the top-20 highest-traffic storefronts; establish baselines.
2. **60–90 days** — scale to 1,000 storefronts; wire into the release pipeline as a can-i-deploy-style signal; live dashboard + alerting.
3. **The org** — quality engineers own it as a product; brand onboarding includes auto-sanity; QA is measured on escape rate and cycle time, not test count.

**The thesis:** quality as an engineering function that makes Fynd ship *faster
and more reliably* — not a gate at the end.

*Full deck: `Quality_Intelligence_Fynd.pptx` · Architecture + design: `docs/` · Working code + prototype: this repository.*
