'use strict';

const { LLMClient } = require('./llm');
const { RunCoordinator } = require('./pipeline/run-coordinator');
const {
  DiscoveryStage, ClassificationStage, JourneyStage, ExecutionStage,
  ValidationStage, VisualStage, LearningStage,
} = require('./stages');

/**
 * SiteAgent — thin façade over the new agent pipeline.
 *
 * Pre-refactor (legacy): a ~250-line monolith that did locale + classification +
 * variant loop + flow runner + telemetry + visual diff + baseline diff all in
 * one function.
 *
 * Post-refactor: SiteAgent constructs the pipeline (the design doc's six
 * AgentStages) and delegates the per-site run to a RunCoordinator. Each
 * concern lives in its own stage module — failure in one stage no longer
 * destabilizes the others, and any stage can be improved or swapped without
 * touching this class.
 *
 * Matches the design doc's "agent pipeline rather than a monolith" principle
 * applied to the existing Node code.
 */
class SiteAgent {
  constructor({ site, config, profileDir, llm, diffEngine, visualDir = null, logger = console }) {
    this.site = site;
    this.config = config;
    this.profileDir = profileDir;
    this.visualDir = visualDir;
    this.llm = llm || new LLMClient({ logger });
    this.diffEngine = diffEngine;
    this.logger = logger;
  }

  async run() {
    const stages = [
      new DiscoveryStage(),        // opt-in via site.discoverPages
      new ClassificationStage(),
      new JourneyStage(),
      new ExecutionStage(),
      new ValidationStage(),
      new VisualStage(),
      new LearningStage(),
    ];

    const coordinator = new RunCoordinator({
      stages,
      profileDir: this.profileDir,
      visualDir: this.visualDir,
      diffEngine: this.diffEngine,
      llm: this.llm,
      config: this.config,
      logger: this.logger,
    });
    return coordinator.run(this.site);
  }
}

module.exports = { SiteAgent };
