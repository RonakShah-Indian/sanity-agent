# Scaling to 1,000+ Sites — Design & Cost Model

> ⚠ **Measured vs modeled — read this first.**
>
> The throughput numbers in this document (12s/site warm, 14s/site full, 50
> concurrency → ~10 min for 1,000 sites) are a **design model**, not load-test
> output. The model has *not* been validated above 3 sites.
>
> **Measured today:** 233 seconds for 4 commerce sites end-to-end
> in headed mode = ~59 s/site (5× the model's warm assumption). The gap comes
> from headed-mode rendering overhead, anti-bot warm-up navigation (Pizza Hut
> MY needs a 4 s homepage settle), explicit `assert_cart_not_empty` cart-URL
> roundtrips, and run-stage telemetry the model elides. A pure headless,
> profile-warm run on a fashion-archetype site is expected to land closer to
> the 12 s number, but that benchmark hasn't been done.
>
> The numbers below describe **what would happen if** the per-site time
> matches the model. The two pieces of work before any of this becomes a
> production claim:
>
> 1. **Headless warm-cache benchmark** on 10–20 sites. Confirms the
>    per-site model number on real production-shape sites.
> 2. **Staging fleet load test** at 50–100 sites with the actual queue +
>    worker pool wired up. Confirms the wall-clock claim.
>
> Until then, treat the throughput claims here as **the math we'd defend at
> the whiteboard** — useful for architecture decisions, not yet a promised
> SLA. PLAYBOOK §12.1 SLOs are likewise marked "aspirational on day one."

---

The single most important property of this system: **a site is an independent
unit of work.** No site's test depends on another's. That makes the workload
*embarrassingly parallel* — scaling becomes a throughput-and-cost optimization,
not an algorithmic one.

---

## 1. The execution model

```
                         ┌─────────────────────────────┐
   sites.json / API ───► │   Queue  (SQS / Kafka topic) │
                         └──────────────┬──────────────┘
                                        │  pull
        ┌───────────────┬───────────────┼───────────────┬───────────────┐
        ▼               ▼               ▼               ▼               ▼
   ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
   │ Worker  │ ... │ Worker  │ ... │ Worker  │ ... │ Worker  │ ... │ Worker  │   (autoscaled
   │ (N browsers)  │         │     │         │     │         │     │         │    containers)
   └────┬────┘     └────┬────┘     └────┬────┘     └────┬────┘     └────┬────┘
        │ profile r/w    │               │               │               │
        ▼                ▼               ▼               ▼               ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │           Profile store (Redis/DynamoDB)  +  Results store (S3/DB)     │
   └──────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
                          Reporter → HTML / JUnit / dashboard
                                        │
                                        ▼
                      Alerting (Slack/PagerDuty) on critical-flow regressions
```

In this repo the queue + workers are an **in-memory bounded pool**
(`orchestrator.js`). The per-site logic (`agent.js`) is identical to what a
containerized worker would run — so "scale up" means swap the queue backend and
run more worker replicas. **Nothing in the site logic changes.**

---

## 2. The time math

Assume, per site (4 flows, headless, warm profile after first run):

| State            | Per-site wall time | Why                                            |
|------------------|--------------------|------------------------------------------------|
| Cold (first ever)| ~25–40 s           | full strategy-ladder resolution, maybe LLM rung|
| Warm (learned)   | ~8–15 s            | profile fast-path hits rung 1 for most intents |

This is the payoff of the self-learning layer: **steady-state runs are ~3× faster**
because resolution collapses to a cached-selector replay.

**Throughput** = `concurrency / per_site_time`.

For 1,000 warm sites at 12 s each:

| Workers × browsers (total concurrency) | Wall-clock for 1,000 sites |
|----------------------------------------|----------------------------|
| 10                                     | ~20 min                    |
| 25                                     | ~8 min                     |
| 50                                     | ~4 min                     |
| 100                                    | ~2 min                     |

A modest fleet (25–50 concurrent browsers, i.e. ~6–12 containers at 4 browsers
each) clears 1,000 sites in **under 10 minutes** — the assignment's "do it in
time" bar. The `timeBudgetMs` cap guarantees a bounded run: anything not reached
is reported as `deferred`, never silently dropped.

---

## 3. The cost math

Two cost centers: **compute** and **LLM tokens.**

**Compute.** A 4-vCPU / 8 GB container runs ~4 concurrent headless Chromium
comfortably. 1,000 warm sites ≈ 1,000 × 12 s = 200 browser-minutes ÷ 4 per
container = 50 container-minutes. At commodity spot pricing (~$0.04/container-min)
that's **~$2 per full 1,000-site sweep.** Run it 4×/day = pennies.

**LLM tokens — the cost lever that matters.** The LLM rung is the *fallback*,
not the default. Because rungs 1–4 (profile, role, text, heuristic) resolve the
large majority of elements, the LLM is invoked only on genuinely novel/ambiguous
elements. Empirically that should be:

- **First-ever crawl of a site:** maybe 1–3 LLM calls (the hard intents).
- **Warm steady state:** ~0 LLM calls (everything served from profile).

So LLM cost is a **one-time learning tax per site**, not a per-run cost. This is
the core economic argument: *learning amortizes the expensive reasoning.* Cap it
with a per-run LLM-call budget so a pathological site can't run up a bill.

---

## 4. What changes at scale (and what doesn't)

| Concern              | Demo (this repo)        | Production at 1,000+                          |
|----------------------|-------------------------|-----------------------------------------------|
| Queue                | in-memory array         | SQS / Kafka, with retries + DLQ               |
| Workers              | async tasks in 1 process| autoscaled K8s/ECS replicas                   |
| Profile store        | JSON files              | Redis (hot) + DynamoDB/Postgres (durable)     |
| Results              | local JSON/HTML         | S3 + a queryable DB powering a live dashboard |
| Scheduling           | manual CLI run          | cron / event-driven (deploy hook, nightly)    |
| Secrets/credentials  | in sites.json (demo)    | Vault / Secrets Manager, injected per-run     |
| Browser pool         | Playwright local        | Playwright + a Grid, or BrowserStack          |
| Per-site logic       | **agent.js**            | **agent.js — unchanged**                      |

The last row is the design win: the unit of work is portable.

---

## 5. Reliability at scale

- **Per-domain rate limiting** (`perDomainDelay`) avoids hammering a target and
  tripping WAFs/bot protection — essential when many sites share a CDN/host.
- **Bounded retries + exponential backoff**, then **quarantine** so one flaky
  site can't redden the whole fleet or block the gate.
- **Time budget** guarantees a run always terminates with a complete report.
- **Idempotent + isolated**: each site gets a fresh browser context; no shared
  cookies/state. Re-running is always safe.
- **Confidence decay** in the profile means a site that quietly changes its UI
  is re-learned automatically rather than failing forever on a stale selector.

---

## 6. The honest boundary on "fixes the issues"

Auto-remediation is layered, and each layer is scoped to what automation can do
*responsibly*:

1. **Self-heal** — re-resolve broken selectors. Fully autonomous; this is safe
   because a wrong heal just fails the assertion, it doesn't damage anything.
2. **Retry + quarantine** — fully autonomous; bounded and reversible.
3. **Auto-ticket** — fully autonomous; produces a diagnosed, reproducible bug
   report. Writing a ticket is safe.
4. **Fix proposal** — the system proposes a **test-side** fix (e.g. a new
   selector candidate) and **requires human/PR-gate approval** before it's
   trusted. It does **not** patch the target site's source code unattended.

That boundary is deliberate. A QA agent that silently rewrites selectors *or*
claims to push code fixes to production without review is a liability, not a
feature — it can mask real regressions as "heals" and erode trust in the suite.
The defensible claim is: **autonomous detection, diagnosis, healing, and
proposal; gated promotion of anything that changes what "correct" means.**

---

## 7. Deploy-triggered runs: reporting within 5 minutes of 1,000 sites

The requirement "report within 5 minutes of any new deployment" is met by a
**tiered execution model**, not by trying to run everything fully. Brute force
fails the math; tiering passes it.

### The trigger
- **Webhook (primary):** the deploy pipeline POSTs `{version, changed:[...]}` to
  `/deploy`. The agent ACKs in <100ms (so it never blocks the pipeline) and runs
  asynchronously. Latency from deploy-finish to run-start is effectively zero.
- **Poll (fallback):** for sites whose pipeline can't call us, the agent polls a
  per-site `versionUrl`; a changed version string enqueues that site.

### The 5-minute math
A deployment touches a *known, small* set of services — not all 1,000 sites. So:

| Tier   | Which sites                  | Plan                    | Per-site time |
|--------|------------------------------|-------------------------|---------------|
| FULL   | the `changed` sites (e.g. 5–50) | archetype's full plan  | ~10–15 s      |
| SMOKE  | the other ~950–995 sites     | single highest-weight P0 flow | ~4–6 s |

Worst-case budget check, 1,000 sites, 50 changed:
- Full:  50 × 14 s = 700 browser-s
- Smoke: 950 × 5 s = 4,750 browser-s
- Total ≈ 5,450 browser-s ÷ 50 concurrency = **~110 s wall ≈ under 2 minutes.**

Even smoking **all 1,000** (no `changed` hint) at 5 s = 5,000 browser-s ÷ 50 =
**100 s**. The 5-minute SLA holds with comfortable headroom; the `deadlineMs`
budget guarantees a report is emitted on time, with any unreached site marked
`deferred` and picked up on the next cycle.

### Why tiering is correct, not a shortcut
A deploy can only break what it changed — plus shared dependencies. Full-testing
the changed services catches direct regressions; smoke-testing the rest catches
shared-dependency blast radius (a broken auth service, a CDN change) via each
site's single most critical flow. That's the same risk-based logic a good
release gate uses: spend the expensive checks where change actually happened.
