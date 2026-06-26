'use strict';

const { AgentStage } = require('../pipeline/agent-stage');
const { SiteProfile } = require('../profile');
const { FlowRunner } = require('../runner');
const { attachTelemetry } = require('../telemetry');

/**
 * ExecutionStage (Phase 4 + Phase 7)
 *
 * Runs the journeys via the FlowRunner, which itself uses the ElementFinder
 * ladder (resolver) + self-heal (profile demote/recall) + behavioural
 * verification (click_until_cart_changes).
 *
 * This stage owns the per-(site, variant) SiteProfile = locator memory.
 * Phase 7's self-heal is built into the resolver and surfaces here as
 * automatic re-resolution + selector demotion on behavioural failure.
 */
class ExecutionStage extends AgentStage {
  get name() { return 'execution'; }
  get required() { return true; }

  async execute(ctx, site) {
    const variant = ctx.variant;
    const profileKey = `${site.id}__${variant.kind === 'persona' ? variant.name : variant.name}`;
    const profile = new SiteProfile(profileKey, ctx.profileDir);
    if (ctx.locale?.lang) profile.setLocale(ctx.locale.lang);

    const telemetry = attachTelemetry(ctx.page);
    ctx._telemetry = telemetry;        // ValidationStage / VisualStage read this

    const runner = new FlowRunner({
      page: ctx.page, profile, llm: ctx.llm, config: ctx.config, site, logger: ctx.logger,
    });
    const flowCtx = {
      credentials: site.credentials || { email: 'test@example.com', password: 'Test1234!' },
      query: (variant.persona?.query) || site.query || 'shirt',
      pincode: site.pincode || '110001',
    };

    const flowKeys = ctx.plan;
    for (const key of flowKeys) {
      if (key !== flowKeys[0]) {
        await ctx.page.goto(site.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
      const t0 = Date.now();
      // If JourneyStage's planner augmented this flow with sitemap-derived
      // steps (e.g., a navigate-to-/login prepended for sign_in), use those;
      // otherwise the runner falls back to the static FLOWS entry.
      const stepsOverride = ctx.journeySteps?.[key];
      const r = await runner.runFlow(key, flowCtx, { stepsOverride });
      r.timingMs = Date.now() - t0;
      r.viewport = variant.name;
      if (variant.persona) r.persona = variant.persona.name;
      ctx.flows.push(r);
      if (r.status === 'failed' && r.critical) ctx.degrade('failed');
      else if (r.status === 'degraded') ctx.degrade('degraded');
    }
    ctx.profiles[variant.name] = profile.summary();
  }
}

module.exports = { ExecutionStage };
