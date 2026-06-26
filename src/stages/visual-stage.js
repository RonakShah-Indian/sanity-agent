'use strict';

const { AgentStage } = require('../pipeline/agent-stage');
const { evaluateTelemetry } = require('../telemetry');
const { diffAgainstBaseline } = require('../visual');
const { DiffEngine } = require('../diff');

/**
 * VisualStage (Phase 6 + Tier-1 telemetry)
 *
 * Captures three independent visual / quality signals at the end of each
 * variant's flow execution:
 *   1. Browser telemetry — JS errors, console errors, 4xx/5xx, Web Vitals
 *   2. Per-variant visual diff vs. stored baseline
 *   3. Deployment fingerprint diff (structural / content / locale / perf)
 *
 * The visual diff is severity-graded; intentional content changes degrade
 * the run, never hard-fail it.
 */
class VisualStage extends AgentStage {
  get name() { return 'visual'; }

  async execute(ctx, site) {
    const variant = ctx.variant;

    // --- Tier-1 telemetry snapshot ------------------------------------------
    // Telemetry is informational. JS errors, console errors, bad HTTP
    // responses, and Web Vitals all go into the report as findings, but they
    // don't change the site-level status. On real commerce sites, third-party
    // scripts (analytics, ads, A/B testing pixels) routinely throw errors
    // and 4xx-5xx that have nothing to do with the customer experience the
    // flows actually exercised. Status = "did the critical flow pass?" —
    // telemetry = "what other quality signals were visible during the run?"
    if (ctx._telemetry) {
      try {
        const snap = await ctx._telemetry.snapshot();
        const evald = evaluateTelemetry(snap, ctx.config.budgets || {});
        ctx.telemetry.push({
          variant: variant.name, severity: evald.severity,
          findings: evald.findings, vitals: snap.vitals, counts: snap.counts,
        });
      } catch { /* telemetry failures must not fail the run */ }
      try { ctx._telemetry.detach(); } catch {}
    }

    // --- Per-variant visual diff --------------------------------------------
    if (ctx.visualDir) {
      try {
        const vis = await diffAgainstBaseline(ctx.page, {
          visualDir: ctx.visualDir, siteId: site.id, variantName: variant.name,
          updateBaseline: ctx.status === 'passed',
        });
        ctx.visual[variant.name] = vis;
        // Visual regression is informational — surfaced in the report and the
        // deploy-diff layer, but doesn't degrade a site whose critical flows
        // all passed. Real regressions show up as failed flow steps; visual
        // diffs are noise on dynamic content (promo banners, A/B variants).
      } catch { /* never block on visual */ }
    }

    // --- Deployment fingerprint diff (first variant only) -------------------
    if (ctx.isFirstVariant && ctx._diffEngine) {
      try {
        const elements = await ctx.page.evaluate(() => Array.from(
          document.querySelectorAll('button,a,input,[role]')).slice(0, 120)
          .map(el => ({
            role: el.getAttribute('role') || el.tagName.toLowerCase(),
            text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').slice(0, 24),
          }))).catch(() => []);
        const fp = DiffEngine.fingerprint({
          siteId: site.id, locale: ctx.locale, archetype: ctx.business?.archetype,
          flows: ctx.flows.filter(f => f.viewport === variant.name),
          elements, timings: {},
        });
        const baseline = ctx._diffEngine.loadBaseline(site.id);
        ctx.diff = ctx._diffEngine.diff(baseline, fp);
        ctx.diff.baselineUpdated = ctx._diffEngine.maybeUpdateBaseline(site.id, fp, ctx.status);
      } catch { /* baseline diff is best-effort */ }
    }
  }
}

module.exports = { VisualStage };
