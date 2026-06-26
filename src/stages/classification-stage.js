'use strict';

const { AgentStage } = require('../pipeline/agent-stage');
const { BusinessClassifier } = require('../classifier');
const { detectLocale } = require('../localization');

/**
 * ClassificationStage (Phase 3a)
 * Detects the site's business archetype on the first variant only.
 * Drives Phase 3b (JourneyStage) which picks the flow plan.
 *
 * Wraps the existing src/classifier.js + src/localization.js — same logic,
 * now living behind a formal AgentStage contract so the pipeline is explicit.
 */
class ClassificationStage extends AgentStage {
  get name() { return 'classification'; }
  get required() { return true; }

  async execute(ctx) {
    if (!ctx.isFirstVariant) return;
    const locale = await detectLocale(ctx.page);
    ctx.locale = locale;
    const classifier = new BusinessClassifier({ llm: ctx.llm, logger: ctx.logger });
    const classification = await classifier.classify(ctx.page);
    ctx.business = {
      archetype: classification.archetype,
      label: classification.label,
      confidence: classification.confidence,
      method: classification.method,
    };
    ctx._weights = classification.weights;
    ctx._archetypePlan = classification.plan;
    ctx.logger.info?.(`  ↳ business: ${classification.label} (${classification.confidence}, ${classification.method})`);
  }
}

module.exports = { ClassificationStage };
