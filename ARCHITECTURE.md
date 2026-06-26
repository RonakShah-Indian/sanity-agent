# Architecture

> **For the full operational guide** (Mermaid diagrams, adding sites,
> self-heal flow, bug reports, viewing reports), see
> [`docs/PLAYBOOK.md`](docs/PLAYBOOK.md). This file is the
> condensed architectural reference.

This codebase implements the platform described in the design docs, adapted
to the existing Node toolchain. Where the design references Java + Spring
Boot, we use Node + composable modules — the *concepts* (agent pipeline,
strategy ladder, layered services, learning persistence) are identical.

---

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│ Orchestration       src/orchestrator.js, src/serve.js,       │
│                     src/index.js — REST endpoints, scheduler,│
│                     parallel pool, deploy webhook            │
├──────────────────────────────────────────────────────────────┤
│ Agent pipeline      src/pipeline/run-coordinator.js          │
│                     src/stages/*.js — one stage per concern  │
│                     DiscoveryStage → ClassificationStage →   │
│                     JourneyStage → ExecutionStage →          │
│                     ValidationStage → VisualStage →          │
│                     LearningStage                            │
├──────────────────────────────────────────────────────────────┤
│ Shared services     src/resolver.js   (ElementFinder)        │
│                     src/runner.js     (ActionExecutor)       │
│                     src/llm.js        (LLM abstraction)      │
│                     src/reporter.js   (ReportingEngine)      │
│                     src/remote-browser.js (BrowserController)│
├──────────────────────────────────────────────────────────────┤
│ Learning &          src/profile.js   (LocatorMemory)         │
│ persistence         src/health.js    (RunHistory, JSONL)     │
│                     src/patterns.js  (PatternAnalyzer)       │
│                     src/diff.js      (DeploymentBaseline)    │
└──────────────────────────────────────────────────────────────┘
```

`profile.js` and `health.js` are file-backed today; both expose interfaces
(`recall/remember/demote`, `recordRun/loadHistory/listSites`) that swap to a
PostgreSQL/JPA implementation behind the same contract — when persistence
becomes Phase 8 work.

---

## The pipeline per the design

Seven stages, executed in order per (site, variant). Each implements the
`AgentStage` contract in `src/pipeline/agent-stage.js`:

| Design Phase | Stage module | Wraps | Status |
|---|---|---|---|
| P2 Discovery (tenant) | `src/discovery.js` + `src/discover.js` | static / sitemap / tenant-api sources | implemented |
| P2 Discovery (per-site) | `src/discovery/{sitemap-crawler,page-classifier}.js` + `src/stages/discovery-stage.js` + `src/discover-pages.js` CLI | bounded BFS crawl, PageClassifier (10 page types), schema.org-aware, JSON sitemap output | implemented |
| P3 Classification + Journey | `stages/classification-stage.js`, `stages/journey-stage.js` | `classifier.js` + `intents.js`, formal PriorityEngine assigns P0/P1/P2 | implemented |
| P4 Execution | `stages/execution-stage.js` | `runner.js` (FlowRunner) + `resolver.js` (ElementFinder ladder) | implemented |
| P5 Validation | `stages/validation-stage.js` | `validator.js` (content) + `personas.js` (persona validators) | implemented |
| P6 Visual | `stages/visual-stage.js` | `telemetry.js` (Tier-1) + `visual.js` + `diff.js` (baseline) | implemented |
| P7 Self-Heal | (built into Rung 0 + Rung 1 of `resolver.js`) | `profile.js` LocatorMemory + demote/recall | implemented |
| P8 Learning + Persistence | `stages/learning-stage.js` + `orchestrator.js` (batch) + `storage/{repositories,sql-backend}.js` | repo pattern (file + SQLite); `profile.js` + `health.js` delegate; same interface, swappable backend | implemented |
| P9 Reporting + Dashboard | `reporter.js`, `bugreporter.js`, `dashboard/index.js` | HTML/JUnit/JSON reports, Jira/Slack/Linear/Webhook payloads, badge SVG, AND a multi-page interactive dashboard (overview / sites / per-site drill-down / patterns / defects) | implemented |
| P10 Production | `Dockerfile`, `docker-compose.yml`, `.github/workflows/test.yml`, `serve.sh`, `canary-gate.js` | parallel pool, per-domain rate limit, deploy webhook, containerized deployment, CI on every PR | implemented |

---

## ElementFinder ladder (the differentiator)

`src/resolver.js` implements the 5-rung ladder verbatim from the design's
Phase 4.

```
Rung 0  →  site.overrides.selectors[intent]   (per-site escape hatch)
Rung 1  →  learned profile cache              (fast path + self-heal entry)
Rung 2  →  ARIA role + accessible name        (most stable / localization-tolerant)
Rung 3  →  localized text / placeholder / label
Rung 4  →  structural CSS heuristic
Rung 5  →  LLM-vision (offline fallback: keyword-overlap heuristic)
```

Whatever rung succeeds is cached. A cached selector that breaks is demoted
and eventually evicted — healing *is* re-learning.

---

## Domain model (matches the design's PostgreSQL tables)

The Node code uses plain objects + JSONL persistence today. Shapes line up
1:1 with the design's table model — adding a `pg` library + Sequelize/Prisma
migrations becomes mechanical:

| Design table | Node analogue |
|---|---|
| `site` | site config entry in `config/*.json` |
| `discovered_page` | results of `src/discovery.js` (currently in-memory) |
| `journey` | `ctx.journeys` from `JourneyStage`, persisted into the run record |
| `run` | one row per object in `reports/run-*/results.json` |
| `step_result` | the `flows[].steps[]` array inside a run |
| `locator_memory` | `profiles/<site>__<variant>.json` |
| `defect` | output of `bugreporter.js` (`bug-payloads.json`) |
| `baseline` | `baselines/<site>.json` |
| `knowledge` | `history/<site>.jsonl` + computed patterns |

---

## How the architecture supports the design's "< 30 min onboarding"

The promise is the same as the design: no per-site **JavaScript** (per-site
declarative JSON config is the explicit escape hatch when a site fights the
resolver). Onboarding =
1. add a config entry → minutes
2. discovery / classification / journey-gen runs automatically
3. first run resolves elements via the ladder + seeds locator memory

The `make help` targets surface this end-to-end: `make fynd-demo` and
`make fynd-demo-headed` exercise the full pipeline against the 3 assignment
sites; `make discover-pages URL=...` runs the per-site crawler standalone.

---

## What's still designed-not-coded

| Item | Where it would live |
|---|---|
| (none open in design-doc scope — all 10 phases now have an implementation in this repo) | — |

The intelligence parts (resolver ladder, self-heal, classification, validation,
patterns, alerter, narration) are **all implemented and tested**. What remains
is conventional engineering — wrapping the existing logic in different I/O
contracts.
