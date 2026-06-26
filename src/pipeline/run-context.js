'use strict';

/**
 * RunContext — the mutable carrier passed between agent stages.
 *
 * Each stage reads what it needs and writes back its outputs. By the time the
 * pipeline finishes, this object is the canonical per-site Run record, ready
 * for the ReportingEngine.
 *
 * Fields are deliberately permissive (additive) so a new stage can attach new
 * data without changing the contract.
 */
class RunContext {
  constructor({ runId, site, llm = null, config = {}, profileDir = null, visualDir = null, logger = console }) {
    this.runId = runId;
    this.site = site;
    this.llm = llm;
    this.config = config;
    this.profileDir = profileDir;
    this.visualDir = visualDir;
    this.logger = logger;

    // Filled by stages as the pipeline progresses.
    this.startedAt = new Date().toISOString();
    this.sitemap = null;           // DiscoveryAgent
    this.business = null;          // JourneyAgent's classifier output
    this.plan = null;              // JourneyAgent's chosen flow keys
    this.journeys = [];            // JourneyAgent's full Journey objects
    this.flows = [];               // ExecutionAgent's per-flow results
    this.profiles = {};            // ExecutionAgent's learned-selector summaries
    this.personaFindings = [];     // ValidationAgent's persona validators
    this.contentFindings = [];     // ValidationAgent's content / consistency findings
    this.telemetry = [];           // VisualAgent + telemetry stage
    this.visual = {};              // VisualAgent's per-variant diff results
    this.videos = {};              // recording paths
    this.diff = null;              // deployment baseline diff
    this.status = 'passed';        // worst-of across stages
    this.error = null;
    this.locale = null;
    this.transport = 'local';
    this.tier = 'full';
    this.viewports = [];
    this.personas = [];
  }

  /** Worst-status rollup helper used across stages. */
  static STATUS_RANK = { passed: 0, skipped: 0, degraded: 1, quarantined: 1, failed: 2, error: 3 };
  static worstStatus(a, b) {
    return (RunContext.STATUS_RANK[b] ?? 0) > (RunContext.STATUS_RANK[a] ?? 0) ? b : a;
  }
  degrade(to) { this.status = RunContext.worstStatus(this.status, to); }

  /** Produce the final Run record consumed by the ReportingEngine. */
  toResult() {
    return {
      site: this.site.id, url: this.site.url, startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      status: this.status, error: this.error,
      locale: this.locale,
      viewports: this.viewports, personas: this.personas,
      tier: this.tier, plan: this.plan, business: this.business,
      flows: this.flows, profiles: this.profiles, profile: this.profiles[this.viewports[0]] || null,
      personaFindings: this.personaFindings,
      telemetry: this.telemetry, visual: this.visual, videos: this.videos,
      diff: this.diff, transport: this.transport,
      region: this.site.region || null,
      themeVersion: this.site.themeVersion || null,
      traffic_per_hour: Number.isFinite(this.site.traffic_per_hour) ? this.site.traffic_per_hour : null,
      aov: Number.isFinite(this.site.aov) ? this.site.aov : null,
      currency: this.site.currency || null,
      durationMs: Date.now() - Date.parse(this.startedAt),
    };
  }
}

module.exports = { RunContext };
