'use strict';

const { AgentStage } = require('../pipeline/agent-stage');

/**
 * LearningStage (Phase 8) — no-op at the per-variant level.
 *
 * The actual learning + pattern detection happens AFTER all sites finish
 * their pipelines: history append + cross-merchant pattern detection are
 * batch operations on the accumulated result set, performed by the
 * Orchestrator (src/orchestrator.js) once the per-site pipelines complete.
 *
 * This stage exists as a no-op placeholder so the pipeline contract is
 * complete and Phase 8 has a documented home if/when per-run learning
 * (locator confidence promotion, journey-flakiness annotation) needs to
 * fire from inside the pipeline rather than after it.
 */
class LearningStage extends AgentStage {
  get name() { return 'learning'; }
  async execute() { /* deliberate no-op — see file header */ }
}

module.exports = { LearningStage };
