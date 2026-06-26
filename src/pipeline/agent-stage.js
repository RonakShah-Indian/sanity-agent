'use strict';

/**
 * AgentStage — the contract every pipeline stage implements.
 *
 * Matches the design doc's "agent pipeline rather than a monolith" principle:
 * each stage has ONE responsibility, a clean handoff via the run context, and
 * a failure mode that can degrade without crashing the whole run.
 *
 * Pipeline order (per the design):
 *   DiscoveryAgent → JourneyAgent → ExecutionAgent → ValidationAgent →
 *   VisualAgent → HealingAgent (feeds back into Execution) → LearningAgent
 *
 * Implementations live in src/stages/*.
 */
class AgentStage {
  /** Human-readable id surfaced in logs and reports. */
  get name() { throw new Error('AgentStage.name() must be overridden'); }

  /** True if this stage is mandatory for a complete run. False = optional. */
  get required() { return false; }

  /**
   * Execute one stage of the pipeline. Mutates the RunContext in place.
   * Throwing here moves the stage to "failed"; if `required` is false, the
   * pipeline continues, allowing partial-pipeline runs while later phases
   * are still being built.
   *
   * @param {RunContext} ctx
   * @param {object} site
   */
  // eslint-disable-next-line no-unused-vars
  async execute(ctx, site) { throw new Error('AgentStage.execute() must be overridden'); }
}

module.exports = { AgentStage };
