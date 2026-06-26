# Autonomous Sanity Agent for Fynd — One-Page Brief

**Author:** Ronak Shah (Director of QA candidate) · **Date:** 2026-06-25

## The problem

Fynd powers thousands of brand storefronts. Every platform deploy raises the
same question — *did we just break checkout on any of them?* — that per-site
test scripts cannot answer at scale. The maintenance trap: 1,000 scripts to
write, 1,000 to keep alive across UI tweaks. Cost grows linearly with site
count; the team can't.

## The approach (one design choice)

Instead of scripts per site, flows describe **intent** (*"add the first
product to cart and verify the count went up"*). A 6-rung resolver maps
intent → real element at runtime: cached profile → ARIA role → localized
text → heuristic → LLM vision, with Rung 0 as the per-site escape hatch when
a site fights the resolver. Whatever rung wins is cached, so the system
**learns** each site and **self-heals** when sites change.

## What's actually built (measured, not asserted)

| Capability | Status |
|---|---|
| 10 design phases shipped | Discovery → Classification → Journey → Execution → Validation → Visual → Self-heal → Learning → Reporting → Production (Docker + CI) |
| End-to-end demo | **4 commerce sites, 8/8 critical flows green in 233s** (pizzahut.com.my, sephora.in, shopnexusone.com, nykaa.com) |
| Test discipline | **126 tests, 16 suites, all green** — including a hard-mode PatternAnalyzer precision benchmark (median 1.00, worst-seed 0.67 across 10 RNG seeds) |
| Bug reporting | Real POST adapters for Jira/Slack/Linear/Webhook — env-gated, dry-run by default, flip `BUG_DRY_RUN=false` to ship live |
| Operations | SLO instrumentation (`src/slo-tracker.js`), profile-rollback CLI for bad self-heals, full Operations chapter (PLAYBOOK §12) |
| New-site onboarding | **nykaa.com added live in ~25 minutes** across 4 escalation iterations — no JavaScript, ~28 lines of JSON. Worked example in PLAYBOOK §6 |

## Honest about what's not done

- 1,000-site / 2-minute headline is a **design target with the math written
  out**, not a measured result. The throughput model assumes ~12s/site warm;
  observed is ~58s/site on the 4-site demo (headed mode, anti-bot warm-ups).
  Two pieces of work before this becomes a production SLA — a headless
  warm-cache benchmark on ~20 sites, and a 50–100 site staging load test.
- SQS/Kafka worker pool is **designed, not built**. Current orchestrator is
  in-process async with bounded concurrency.
- PatternAnalyzer is **calibrated on synthetic data only**; production trust
  requires two weeks of observed precision on a real fleet before paging.
- BrowserStack real-device matrix needs credentials wired.

## What a CTO would do with this

1. **Hire and ship the prototype** for the top-20 storefronts in week 1
2. Run the **2-week PatternAnalyzer observation window** in parallel to
   measure observed precision on a real fleet
3. Wire the **headless warm-cache benchmark** on 50–100 staging sites to
   validate the throughput model
4. Only then **promote to a deploy gate** for the full 1,000+ tenant fleet —
   the math is sound; the load test is the missing proof

## Key cost numbers (compute only — excludes BrowserStack, LLM cold-start)

- ~$2 per full 1,000-site sweep at spot pricing (12s warm assumption)
- ~$0 LLM steady state — the profile cache wins after the first run
- $0 per-site test maintenance — JSON config only when a site fights the
  resolver

---

**Read order if you have 15 minutes:**
1. `docs/EXECUTIVE_BRIEF.md` (60s read)
2. `docs/PLAYBOOK.md §1` (what it is, what costs config), `§4` (the 6-rung
   ladder), `§6` (nykaa case study), `§12` (Ops + SLOs)
3. `reports/run-1782397895689/report.html` (live demo report — open in browser)
4. `node test/patterns-precision.test.js` (run the precision benchmark yourself)

**Full operator guide:** `docs/PLAYBOOK.md` (~900 lines, 11 Mermaid diagrams)
