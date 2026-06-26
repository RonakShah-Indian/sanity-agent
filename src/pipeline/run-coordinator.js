'use strict';

const { chromium, devices } = require('playwright');
const path = require('path');
const { RunContext } = require('./run-context');
const { resolvePersonas } = require('../personas');
const { launchForVariant } = require('../remote-browser');

/**
 * RunCoordinator — top-level conductor (the design doc's "Orchestration" layer).
 *
 * Walks ONE site through the agent pipeline, producing a Run record. The
 * Orchestrator (src/orchestrator.js) parallelizes many sites; this class
 * focuses on the per-site lifecycle:
 *
 *   1. Resolve viewports + personas (run variants)
 *   2. Launch browser session for each variant
 *   3. For each variant, walk the pipeline of AgentStages in order
 *   4. Roll up results
 *
 * Stages are passed in (dependency injection) — RunCoordinator doesn't know
 * Discovery from Validation, just that each one implements AgentStage.
 */
class RunCoordinator {
  constructor({ stages, profileDir, visualDir = null, diffEngine = null, llm = null, config = {}, logger = console }) {
    this.stages = stages;            // ordered array of AgentStage instances
    this.profileDir = profileDir;
    this.visualDir = visualDir;
    this.diffEngine = diffEngine;
    this.llm = llm;
    this.config = config;
    this.logger = logger;
  }

  async run(site) {
    const runId = `${site.id}-${Date.now()}`;
    const ctx = new RunContext({
      runId, site, llm: this.llm, config: this.config,
      profileDir: this.profileDir, visualDir: this.visualDir, logger: this.logger,
    });

    // Resolve run variants (viewports × personas).
    const personas = resolvePersonas(site);
    const viewports = this._resolveViewports(site);
    const variants = personas.length
      ? personas.map(p => ({ kind: 'persona', name: p.name, vp: p.viewportConfig, persona: p }))
      : viewports.map(v => ({ kind: 'viewport', name: v.name, vp: v, persona: null }));
    ctx.viewports = viewports.map(v => v.name);
    ctx.personas = personas.map(p => p.name);

    let browser;
    let transport = 'local';
    try {
      browser = await chromium.launch({ headless: process.env.SANITY_HEADED !== '1' });
      for (let i = 0; i < variants.length; i++) {
        const variant = variants[i];
        const isFirst = i === 0;
        await this._runVariant(ctx, site, variant, isFirst, browser, transport);
      }
      ctx.transport = transport;
    } catch (e) {
      ctx.status = 'error';
      ctx.error = e.message;
    } finally {
      if (browser) await browser.close().catch(() => {});
    }

    return ctx.toResult();
  }

  async _runVariant(ctx, site, variant, isFirst, sharedBrowser, transport) {
    const { name: vpName, _device, ...vpOpts } = variant.vp;

    let browser = sharedBrowser, currentTransport = transport;
    if (variant.remote || site.remote) {
      const launched = await launchForVariant({ ...variant, remote: variant.remote || site.remote, site }, { config: this.config, logger: this.logger });
      browser = launched.browser; currentTransport = launched.transport;
    }
    const context = await browser.newContext({
      ignoreHTTPSErrors: true, locale: site.locale || undefined,
      userAgent: this.config.userAgent, ...vpOpts,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(this.config.stepTimeout ?? 8000);
    ctx.variant = variant;
    ctx.page = page;
    ctx.isFirstVariant = isFirst;
    ctx.transport = currentTransport;
    ctx._diffEngine = this.diffEngine;

    try {
      const navT0 = Date.now();
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: this.config.navTimeout ?? 20000 });
      ctx.navMs = Date.now() - navT0;

      for (const stage of this.stages) {
        try {
          await stage.execute(ctx, site);
        } catch (e) {
          this.logger.warn?.(`[stage:${stage.name}] failed: ${e.message}`);
          if (stage.required) { ctx.status = 'error'; ctx.error = `${stage.name}: ${e.message}`; break; }
          ctx.degrade('degraded');
        }
      }
    } finally {
      await context.close().catch(() => {});
    }
  }

  _resolveViewports(site) {
    const DEFAULT = [{ name: 'desktop', viewport: { width: 1280, height: 800 } }];
    const list = (site.viewports && site.viewports.length) ? site.viewports : DEFAULT;
    return list.map(v => {
      if (v.device) {
        const d = devices[v.device];
        if (!d) throw new Error(`Unknown Playwright device: ${v.device}`);
        const { device, name, ...overrides } = v;
        return { name: name || device, _device: device, ...d, ...overrides };
      }
      return { name: v.name || `${v.viewport?.width || '?'}x${v.viewport?.height || '?'}`, ...v };
    });
  }
}

module.exports = { RunCoordinator };
