# Autonomous Sanity Agent

> **A continuous QA platform for multi-tenant commerce.**
> Auto-discovers every merchant. Tests every flow on real devices. Reports failures in *rupees*, not red ✗.
> Detects cross-merchant patterns no individual merchant can see. Gates deploys before bad ones ship.

```
┌────────────────────────────────────────────────────────────────────┐
│  Discovery → Sanity run → Telemetry & Visual diff → Impact score → │
│  Health/Patterns API → Canary gate → (loop)                        │
└────────────────────────────────────────────────────────────────────┘
```

Not a test runner. A **nervous system** for a commerce platform.

> 📖 **For operators & contributors:** [`docs/PLAYBOOK.md`](docs/PLAYBOOK.md) is
> the single source for architecture diagrams, adding sites, self-heal flow,
> bug-report adapters, and viewing reports.

---

## Try it in 60 seconds

```bash
make all          # setup (Node + Playwright) → tests → live demo on the 4 commerce sites
make help         # list every target
make fynd-demo    # run against the 4 commerce sites in config/fynd-assignment-sites.json
make status       # what's on disk
```

What `make all` actually does:

1. `./setup.sh` — checks Node ≥ 18, runs `npm install`, downloads Playwright Chromium (idempotent, ~30s first time, ~2s warm).
2. `npm test --silent` — 126 unit tests across 16 suites (includes PatternAnalyzer precision benchmark + SLO tracker), no browser, ~5s.
3. `./run.sh --sites config/fynd-assignment-sites.json` — end-to-end live run against the 4 commerce sites (3 Fynd assignment + nykaa.com worked example).

---

## What it does — the five-phase platform

| Phase | Capability | Headline |
|---|---|---|
| **0** Foundation | 6-rung resolver ladder + per-site learning + self-heal | `src/resolver.js`, `src/profile.js` — no per-site JavaScript; declarative JSON config only when a site needs a pinned selector or custom step order |
| **1** Auto-discovery | Tenant directory **is** the test list | New merchant signs up → baseline within minutes, no human in the loop |
| **2** Impact scoring | Failures reported in **₹**, not red ✗ | *"₹81 L/hour realised loss across 5 sites"* — engineering meets finance |
| **3** Personas | Same flows × shopper segments | *"Checkout works for budget shoppers; gift buyers can't find gift wrap"* |
| **4** Health-as-a-Service | Tenant-facing JSON + SVG badge + status page | Every merchant has `/health/:id` + a footer badge they brag about |
| **5** Cross-merchant patterns | Multi-tenant intelligence no merchant has alone | *"5 of 5 merchants on theme v3.2 failed add_to_cart. **Platform bug.**"* |

Plus a Tier-1/Tier-2 detection layer that runs on top of every flow:

| Capability | Catches |
|---|---|
| **Browser telemetry** | uncaught JS errors, console errors, 4xx/5xx network responses |
| **Web Vitals** | LCP / CLS / INP / FCP / TTFB regressions vs budgets |
| **Visual diff** | CSS / layout regressions invisible to functional tests |
| **Third-party probes** | *"Cart broken on 6 merchants — Razorpay is reporting major outage"* |
| **Real-device matrix** | BrowserStack Automate: real iPhone 14, real Safari@macOS, real Edge@Win11 |
| **Canary gate** | Block deploys on status regression / score drop / new critical pattern / ≥1.5× impact growth |

---

## Architecture

```
                  ┌────────────────┐
                  │ DiscoverySource│  static / sitemap / tenant-api
                  └────────┬───────┘
                           │ list of merchants
                  ┌────────▼───────┐
                  │   Reconciler   │  added / changed / removed
                  └────────┬───────┘
                           │
        ┌──────────────────▼──────────────────┐
        │            Orchestrator             │  bounded-concurrency pool, time budget
        └──────────────────┬──────────────────┘
                           │  one SiteAgent per merchant
        ┌──────────────────▼──────────────────┐
        │   SiteAgent (per-merchant lifecycle)│
        │   • localization + classification   │
        │   • for each (viewport × persona):  │
        │       remote-browser → Playwright   │  local / BrowserStack / custom-CDP
        │       FlowRunner via SemanticResolver
        │       telemetry + visual diff       │
        │   • diff vs baseline                │
        └──────────────────┬──────────────────┘
                           │  results[]
        ┌──────────────────▼──────────────────┐
        │  Impact scoring · Pattern detection │  per-site + platform-wide
        │  Health recording (history/*.jsonl) │
        │  Third-party probes correlation     │
        └──────────────────┬──────────────────┘
                           │
        ┌──────────────────▼──────────────────┐
        │  Reporter (HTML/JSON/JUnit)         │
        │  BugReporter (Jira/Slack/Linear/WH) │
        │  HTTP API (/health, /patterns, ...) │  ← serve.js
        └─────────────────────────────────────┘
```

The semantic resolver in detail:

```
intent → [ 1. profile cache  → 2. ARIA role  → 3. localized text  →
           4. heuristics     → 5. LLM vision ]
                  └─── whatever rung succeeds is cached to profile  ←  self-learning
                  └─── if cached selector breaks, demote + re-walk ladder  ←  self-healing
```

---

## CLIs

| Command | What it does |
|---|---|
| `./setup.sh` | First-time install (idempotent) |
| `./run.sh [--sites <file>] [--concurrency N] [--time MS]` | One-shot sanity run; writes a report; exits non-zero on critical failure |
| `./serve.sh [--port N] [--discovery <file>]` | Long-running daemon: webhook + version poller + discovery + health API |
| `./discover.sh [--config <file> \| --sitemap <url>]` | One-shot discovery + reconciliation; writes `config/sites-active.json` |
| `node src/canary-gate.js --current ... --baseline ...` | Compare two reports; exits 1 on regression (CI gate) |

Everything is also wired into `package.json` scripts (`npm start`, `npm run serve`, `npm run discover`, `npm test`, `npm run gate`) and the `Makefile` (`make help` for the full list).

## HTTP endpoints (when `./serve.sh` is running)

```
POST /deploy                        — deploy webhook
GET  /health                        — platform aggregate (CTO dashboard JSON)
GET  /health/:merchant_id           — per-merchant JSON
GET  /health/:merchant_id/badge.svg — embeddable status badge
GET  /health/:merchant_id/page.html — auto-refreshing merchant status page
GET  /patterns                      — cross-merchant pattern detection
```

---

## Adding things — what to edit for what

| Goal | Edit |
|---|---|
| Add a site (manual) | `config/sites.json` (or your own JSON) |
| Stop hand-curating sites entirely | `config/discovery.example.json` → `./serve.sh --discovery <file>` |
| Run on iPhone + iPad + 1440 desktop | `viewports` field on the site |
| Test on real Safari + real iOS | `remote: "browserstack"` on the site + viewport caps |
| Test per shopper segment | `personas` field on the site (defaults in `src/personas.js`) |
| Find platform-wide regressions | `GET /patterns` (or read `summary.patterns` in the report) |
| Add a new UI element type | `INTENT_LIBRARY` in `src/intents.js` |
| Add a new flow | `FLOWS` in `src/intents.js` |
| Add a business archetype | `ARCHETYPES` in `src/classifier.js` |
| Add a language | `L` dictionary in `src/intents.js` |
| Tune impact assumptions | `config/impact.defaults.json` |
| Tune retries / timeouts / concurrency | `config/default.json` |

Full operator guide in **[`docs/PLAYBOOK.md`](docs/PLAYBOOK.md)** — architecture diagrams, adding sites, self-heal flow, bug-report adapters, dashboards.

---

## Optional: enable the LLM rungs

The agent runs in **fully deterministic heuristic mode** by default. The LLM is a *fallback* — for ambiguous classifications and for the last resolver rung when selectors are unfamiliar.

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env.local   # auto-sourced by run.sh / serve.sh
```

Same code path; just lights up rungs 4–5 of the resolver and the classifier tie-break. Steady-state cost stays near zero because of the per-site learned profile cache.

---

## Layout

```
src/
  index.js          one-shot CLI entry
  serve.js          long-running daemon (webhook + poller + discovery + HTTP API)
  agent.js          end-to-end run for ONE site (variant loop: viewports × personas)
  orchestrator.js   bounded-concurrency worker pool, impact/patterns aggregation
  resolver.js       the 5-rung semantic resolver ladder
  profile.js        per-(site, variant) learned memory
  runner.js         flow execution + 4-tier remediation
  classifier.js     business archetype detection + tailored plan
  intents.js        abstract flows + UI intents + localized synonyms
  localization.js   <html lang> + currency + script detection
  llm.js            LLM client with heuristic fallback
  reporter.js       HTML + JUnit + JSON renderer
  bugreporter.js    Jira/Slack/Linear/Webhook payload generator (dry-run by default)
  trigger.js        deploy webhook + version-poll fallback
  diff.js           structural / content / locale / performance fingerprint diff
  validator.js      content / consistency checks
  discovery.js      pluggable discovery sources (static, sitemap, tenant-api)         [Phase 1]
  reconciler.js     diff added/changed/removed against active list                    [Phase 1]
  impact.js         per-site + platform-wide ₹-impact scoring                         [Phase 2]
  personas.js       shopper personas + post-flow validators                           [Phase 3]
  health.js         per-merchant score, history, badge SVG, status page HTML          [Phase 4]
  patterns.js       cross-merchant pattern detection with nested-dedup                [Phase 5]
  telemetry.js      JS errors, console errors, HTTP 4xx/5xx, Web Vitals               [Tier-1]
  visual.js         per-variant screenshot fingerprint + baseline diff (Sharp)        [Tier-1]
  probes.js         third-party status checks + failure correlation                   [Tier-2]
  remote-browser.js local / BrowserStack / custom-CDP launcher (mobile + desktop)     [Tier-2]
  canary-gate.js    deploy-blocking CLI: status / score / pattern / impact rules      [Tier-2]
  discover.js       one-shot discovery CLI                                            [Phase 1]

test/                  unit-test suites — npm test, ~3s, no browser needed
config/                JSON configs: sites, defaults, discovery, impact, template
docs/                  PLAYBOOK.md, ASSIGNMENT.md, EXECUTIVE_BRIEF.md, SCALE.md, TECHNICAL_DESIGN.md
Makefile               `make help` for all the convenience targets
cron.example           paste-into-crontab snippets for scheduled runs
```

---

## Honest design choices worth calling out

- **Runs without an API key.** The LLM is a *fallback*, not the default. Steady-state runs are near-zero cost because the resolver caches what works.
- **Accessibility-first resolution.** ARIA roles are both the most robust strategy *and* the most localization-tolerant — roles don't change when the language does.
- **Learning amortizes the expensive reasoning.** LLM calls are a one-time per-site learning tax. After that, every run is free.
- **The "auto-fix" boundary is intentional** (`docs/SCALE.md §6`): autonomous detect/diagnose/heal/propose, but any code change is approval-gated.
- **History is JSONL.** At 1000-merchant scale it becomes a real datastore — but the read API stays the same. Today's file-backed `history/*.jsonl` is the demo storage; tomorrow's `tenants_health` table swaps in with zero code change downstream.

---

## Status

| Phase | Done? | Tests | Live-verified |
|---|:--:|---|---|
| 0 — Foundation | ✓ | core | yes |
| 1 — Discovery | ✓ | discovery, page-classifier | yes — live sitemaps |
| 2 — Impact scoring | ✓ | impact | yes — ₹ numbers on real runs |
| 3 — Personas | ✓ | personas | yes |
| 4 — Health-as-a-Service | ✓ | health | yes — all endpoints round-tripped |
| 5 — Cross-merchant patterns | ✓ | patterns | yes — synthetic 18-merchant fleet |
| 6 — Journey planner | ✓ | journey-planner | yes |
| 7 — Bug reporting + adapters | ✓ | bugreporter, alerter | yes — Jira/Slack/Linear/Webhook payloads |
| 8 — Persistence (file + SQLite) | ✓ | storage, intelligence | yes |
| 9 — Dashboard | ✓ | (rendered HTML) | yes — `/dashboard/*` routes |
| 10 — Production (Docker + CI) | ✓ | tier1-tier2, validator | yes — Dockerfile + GHA workflow |

**126 tests, 126 passing across 16 suites.** ~7,500 LOC across `src/`. Verified
end-to-end on **4 commerce sites** (3 Fynd assignment sites + nykaa-india
added as a worked onboarding exercise): **8/8 critical flows green in 233s**.
PatternAnalyzer precision (hard mode, 10-seed sweep, 15% noise): median 1.00,
worst-seed 0.67 (see `docs/PLAYBOOK.md §12.5`). Adding the 4th site
(nykaa-india) took ~25 min across 4 iterations of the escalation ladder
documented in PLAYBOOK §6 — no JavaScript written, ~28 lines of declarative
JSON config.

## What's still open

| Item | Why it matters |
|---|---|
| Time-correlation patterns | *"Checkout fails every day at 9 PM IST"* |
| RUM-replay against canary | Real customer sessions as test corpus — the moat |
| `presetCookies` per site | Cookie-warm sites that gate on store/session before any nav (e.g. Pizza Hut MY without a homepage warm-up) |
| Live POST to Jira/Slack/Linear | Payloads are exact; flip `dryRun:false` + add creds |
| BrowserStack real-device adapter | Real iPhone/Safari/Edge runs; needs BS credentials |

See [`docs/PLAYBOOK.md`](docs/PLAYBOOK.md) for *how* to extend; the table above is *what's worth adding*.
