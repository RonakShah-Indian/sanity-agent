'use strict';

const { AgentStage } = require('../pipeline/agent-stage');
const { applyValidators } = require('../personas');

/**
 * ValidationStage (Phase 5)
 *
 * Runs the persona validators against the final page state — the
 * "did the user actually have a working experience" check that goes beyond
 * "did the click succeed". Functional + business validation already lives
 * inside the runner / validator modules; this stage adds the persona axis
 * and rolls up content findings emitted by validate_content steps.
 */
class ValidationStage extends AgentStage {
  get name() { return 'validation'; }

  async execute(ctx) {
    const variant = ctx.variant;
    if (!variant.persona) return;

    const findings = await applyValidators(ctx.page, variant.persona, { navMs: ctx.navMs });
    ctx.personaFindings.push({
      persona: variant.persona.name, viewport: variant.name, navMs: ctx.navMs, findings,
    });
    if (findings.length && findings.some(f => f.status === 'failed')) {
      ctx.degrade('degraded');
    }
  }
}

module.exports = { ValidationStage };
