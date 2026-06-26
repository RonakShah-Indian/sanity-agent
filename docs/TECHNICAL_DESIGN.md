# Technical Design — Quality Intelligence Layer

*Engineering depth behind the vision deck. Audience: CTO / senior engineering.*

This document explains the design decisions, the trade-offs accepted, and the
path from the working prototype to a platform capability. Diagrams referenced
live in `docs/diagrams/`.

---

## 1. Problem statement

Test a large, heterogeneous fleet of e-commerce-style sites for core-flow health
— **sign-in, search, add-to-cart, checkout** — such that:

1. it works across sites with **no per-site JavaScript** (declarative JSON
   config is the documented escape hatch when a site fights semantic
   resolution),
2. it **learns** each site and **self-heals** when sites change,
3. it identifies each site's **core business** and tailors the plan,
4. it reports the **difference** a deployment introduced,
5. it returns a verdict **within 5 minutes of a deploy**, at **1,000+ site** scale,
6. it runs **end-to-end with no manual intervention** and remediates what it can.

The binding constraint is (1): the moment you accept per-site scripts, (5) and
(6) become economically impossible at scale. Every other decision follows from
refusing per-site scripts.

See `diagrams/01-inversion.svg` for the core conceptual move.

---

## 2. Architecture overview

`diagrams/02-system.svg` is the full picture. Six layers:

1. **Trigger** (`trigger.js`) — deploy webhook (primary) + version poll (fallback).
2. **Tiered planner** — changed sites → full plan; others → P0 smoke.
3. **Scale layer** (`orchestrator.js`) — bounded-concurrency worker pool; in
   production, an SQS/Kafka queue feeding autoscaled worker containers.
4. **SiteAgent pipeline** (`agent.js`) — the per-site unit of work: launch →
   detect locale → classify business → resolve+run flows → remediate → diff →
   persist. **Identical at 5 sites or 5,000** — this portability is the scale property.
5. **Shared state** — profile store (learned selectors + confidence) and baseline
   store (last-healthy fingerprints for diffing).
6. **Outputs** — HTML dashboard, JUnit XML (CI gate), regression alerting.

---

## 3. Key design decisions and trade-offs

### 3.1 Semantic resolution over per-site selectors
**Decision:** flows reference abstract *intents*; a strategy ladder resolves to
real elements at runtime (`resolver.js`).

The ladder, cheapest/most-robust first: **(optional Rung 0: site-config selector
override as an escape hatch)** → learned profile → ARIA role+name → localized
text → structural heuristic → LLM vision fallback. The diagram in
`diagrams/01-inversion.svg` shows the five semantic strategies; the override
rung is a per-site exception used only when a site's UI fights the resolver
(see `overrides.selectors` in `config/template-site.json`).

**Trade-off accepted:** a first-ever crawl is slower (the ladder walks several
rungs, possibly invoking the LLM) in exchange for (a) zero per-site code, (b)
working on unseen sites, and (c) flat cost as the fleet grows. Steady-state runs
are ~3× faster because resolution collapses to a cached-selector replay.

**Why accessibility-first:** ARIA roles are simultaneously the most stable signal
*and* the most localization-tolerant — a role doesn't change when the site's
language does. This is why the localization requirement is largely "free."

### 3.2 Learning and healing as one mechanism
**Decision:** every successful resolution is cached to a per-site profile with a
confidence score (`profile.js`). The next run starts at the cache. A cached
selector that fails is demoted and the ladder re-resolves.

That single mechanism *is* both self-learning (cache the win) and self-healing
(stale cache → re-resolve → re-cache). Confidence decay means a site that quietly
changes its UI is re-learned automatically rather than failing forever.

**Trade-off:** a stale-but-not-broken selector can pass once before demotion. We
accept this because the assertion layer still validates the *outcome*, so a wrong
element surfaces as a failed assertion, not a false pass.

### 3.3 Business classification drives the plan
**Decision:** classify each site into an archetype (`classifier.js`) — fashion,
electronics, quick-commerce, B2B wholesale, marketplace, SaaS console — from
on-page signals, with an optional LLM tie-break for ambiguous sites. The
archetype *selects and weights* the flows.

**Why:** a fixed flow set wastes effort and misses the flow that matters. B2B
wholesale is auth-gated, so sign-in leads; a SaaS console has no cart, so
cart/checkout are skipped entirely; quick-commerce lives or dies on cart
velocity. Testing all sites identically is both more expensive and less accurate.

**Trade-off:** misclassification risk. Mitigated by (a) structural nudges
(no-cart + no-price strongly implies SaaS), (b) an LLM tie-break only when the
heuristic margin is thin, and (c) the plan degrading gracefully — an over-broad
plan still tests the right flows, just runs a couple of extra.

### 3.4 Deployment diffing against a protected baseline
**Decision:** every healthy run produces a fingerprint (flow statuses, structural
element set, timings, locale/currency). The next run diffs against the last
**passed** baseline across four dimensions (`diff.js`).

**Why a protected baseline:** a failing run must never become the comparison
point, or you'd compare broken-against-broken. We only overwrite the baseline on
a healthy run, so the diff always answers "what changed since the last time this
was working" — exactly the post-deploy question.

**Trade-off:** structural diffing on raw element sets can be noisy on highly
dynamic pages. Mitigated by comparing role+truncated-text signatures (not exact
DOM), and by severity-ranking so noise lands as "low" while genuine regressions
(a passing flow now failing) land as "high."

### 3.5 The 5-minute SLA via tiering, not brute force
**Decision:** a deploy event runs the *changed* sites on the full plan and
everything else on a single-flow P0 smoke (`trigger.js` `planTiers`).

**The math** (full derivation in `SCALE.md §7`): 1,000 sites, 50 changed →
50×14s + 950×5s = 5,450 browser-seconds ÷ 50 concurrency ≈ **110s wall**. Even
smoking all 1,000 with no change hint is ~100s. A `deadlineMs` budget guarantees
an on-time report; unreached sites are marked `deferred`, never dropped.

**Why this is correct, not a shortcut:** a deploy can only break what it changed
plus shared dependencies. Full-testing the changed services catches direct
regressions; smoke-testing the rest catches shared-dependency blast radius (a
broken auth service, a CDN change) via each site's single most critical flow.
This is the same risk-based logic a good release gate uses.

### 3.6 Remediation scoped to the responsible boundary
Four tiers, each scoped to what automation can do without creating risk:

| Tier | Autonomy | Rationale |
|---|---|---|
| Self-heal | full | a wrong heal just fails the assertion — safe |
| Retry + quarantine | full | bounded, reversible |
| Auto-ticket | full | writing a diagnosed bug report is safe |
| Fix proposal | **gated** | proposes a test-side fix; never patches site code unattended |

The boundary is deliberate (`SCALE.md §6`). Silent test rewriting can mask a real
regression as a "heal"; unattended code-fixing is a liability. The defensible
claim: autonomous detect/diagnose/heal/propose, gated promotion of anything that
changes what "correct" means.

---

## 4. The AI layer — and its guardrails

The LLM appears in two places: the resolver's last rung (locate an element when
heuristics fail) and remediation diagnosis (explain a failure in plain language).

**Guardrails, because this is where overclaiming gets caught:**
- The LLM is a **fallback**, never the default path — most resolutions never reach it.
- The system runs **without an API key** at all: the LLM client degrades to a
  deterministic keyword-scoring heuristic. AI is an accelerant, not a dependency.
- AI-derived selectors are cached at **lower seed confidence** than role/text
  matches, so they're re-validated sooner.
- (Production) AI-authored artifacts run in quarantine and their escape rate is
  tracked **separately** before promotion — the same discipline as a junior
  engineer's PR.

The dangerous failure mode is a hallucinated assertion that passes but tests the
wrong thing — false confidence. The architecture mitigates it by keeping AI on
*element location* (verified immediately by whether the action succeeds) rather
than on *defining correctness*.

---

## 5. Scale and cost

Full model in `SCALE.md`. Headlines:

- **Throughput:** sites are independent → embarrassingly parallel. ~10 minutes
  for a full 1,000-site sweep at 50 concurrency; **the 2-minute number is for
  the 50-changed-sites deploy sweep**, which is the realistic deploy-gate
  workload (see `SCALE.md §7`).
- **Compute:** ~$2 in *spot CPU* per full 1,000-site sweep. Excludes
  BrowserStack real-device matrix (separate contract) and LLM token cost on a
  cold-start fleet (steady state is ~0 because the profile cache wins).
- **Measured today:** 233s for 4 sites (3 Fynd assignment sites + nykaa.com
  added live) end-to-end; throughput numbers above 4 sites are projected from
  the per-site model, not load-tested.
- **LLM:** a one-time per-site learning tax, ~0 in steady state. Bounded by a
  per-run call budget so a pathological site can't run up a bill.
- **Production swap:** in-memory queue → SQS/Kafka; async tasks → autoscaled
  containers; JSON files → Redis + DynamoDB. The per-site logic is unchanged.

---

## 6. From prototype to platform (what's real vs. next)

**Real and tested now:** semantic resolver + ladder, self-learn/heal, business
classifier, deployment diff with protected baseline, tiered planner, 4-tier
remediation, HTML/JUnit/JSON reporting. 10 unit tests pass
(`test/core.test.js`, `test/intelligence.test.js`).

**Demonstrated end-to-end** on **4 commerce sites** — the 3 Fynd assignment
sites (`pizzahut.com.my`, `sephora.in`, `shopnexusone.com`) plus `nykaa.com`
added live as a worked onboarding exercise — **8/8 critical flows green in
233 seconds** on a real machine with Chromium installed. Latest rendered
report: `reports/run-1782397895689/report.html`. See `docs/PLAYBOOK.md §6`
for the case-study of adding the 4th site across 4 escalation iterations.

**Honest gap:** the per-site time is **~58 seconds** on the demo run (233s ÷ 4
sites). The throughput model in `SCALE.md` assumes ~12s warm + ~14s full —
real-world variance, anti-bot waits (Pizza Hut MY and Nykaa both need 4s
homepage warm-ups), and headed-mode rendering pull this higher. Steady-state
warm runs on simpler sites land closer to the SCALE.md number, but the load
test that proves it across 1,000 sites has not been done. The
1,000-site/2-min headline is the **design target with the math fully written
out**, not a measured result.

**Next steps to productionize:**
1. Swap the queue/state backends (SQS/Kafka, Redis/DynamoDB).
2. Add canary/rollback hooks so the gate can *block* a deploy, not just report.
3. Per-archetype smoke-flow tuning against Fynd's real storefront templates.
4. Wire the verdict into the release pipeline (can-i-deploy semantics) + alerting.
5. Secrets via Vault/Secrets Manager; per-tenant credential isolation.

---

## 7. Module map

| Module | Responsibility |
|---|---|
| `trigger.js` | deploy webhook + poll; tiered 5-min planning |
| `orchestrator.js` | concurrency pool, rate limiting, time budget |
| `agent.js` | per-site end-to-end pipeline |
| `classifier.js` | business archetype detection + plan selection |
| `diff.js` | baseline store + 4-dimension deployment diff |
| `resolver.js` | the strategy ladder (cross-site resolution) |
| `profile.js` | per-site learned memory + confidence |
| `runner.js` | flow execution + 4-tier remediation |
| `intents.js` | abstract flows + multilingual synonyms |
| `localization.js` | language + currency detection |
| `llm.js` | LLM fallback with offline heuristic mode |
| `reporter.js` | HTML + JUnit + JSON output |
