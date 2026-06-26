'use strict';

/**
 * Default per-site pipeline. Stages are run in order; failure in one
 * non-required stage degrades the run but doesn't abort it.
 *
 *   1. ClassificationStage  — business archetype detection             (P3)
 *   2. JourneyStage         — picks the flow plan from the archetype   (P3)
 *   3. ExecutionStage       — runs the flows; ElementFinder + self-heal (P4/P7)
 *   4. ValidationStage      — content validators + persona validators   (P5)
 *   5. VisualStage          — telemetry + screenshot diff               (P6/Tier1)
 *   6. LearningStage        — record run + detect cross-merchant patterns (P8)
 *
 * Discovery (P2) is *not* in the per-site pipeline — it runs platform-wide
 * before any site pipeline kicks off (see src/discovery.js + src/discover.js).
 */
module.exports = {
  DiscoveryStage:      require('./discovery-stage').DiscoveryStage,
  ClassificationStage: require('./classification-stage').ClassificationStage,
  JourneyStage:        require('./journey-stage').JourneyStage,
  ExecutionStage:      require('./execution-stage').ExecutionStage,
  ValidationStage:     require('./validation-stage').ValidationStage,
  VisualStage:         require('./visual-stage').VisualStage,
  LearningStage:       require('./learning-stage').LearningStage,
};
