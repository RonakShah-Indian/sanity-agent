'use strict';

const fs = require('fs');
const path = require('path');

/**
 * DiffEngine
 * ----------
 * Compares the CURRENT run against the last known-good BASELINE for a site and
 * outlines what changed. This is the feature that makes deploy-triggered runs
 * actually useful: not "did it pass?" but "what did this deployment change?"
 *
 * Four difference dimensions (all requested):
 *   1. Flow status delta     - flow pass/fail changed vs last run
 *   2. Structural delta       - interactive elements added / removed / moved
 *   3. Performance delta       - step + page timing regression
 *   4. Content/locale delta    - language / currency / title shifts
 *
 * A baseline is the last run whose status was 'passed'. We never overwrite a
 * good baseline with a failing run, so the diff always compares against the
 * last healthy state — exactly what you want post-deploy.
 */
class DiffEngine {
  constructor(baselineDir) {
    this.dir = baselineDir;
    fs.mkdirSync(baselineDir, { recursive: true });
  }

  _file(siteId) { return path.join(this.dir, `${sanitize(siteId)}.baseline.json`); }

  loadBaseline(siteId) {
    try { return JSON.parse(fs.readFileSync(this._file(siteId), 'utf8')); }
    catch { return null; }
  }

  /** Persist this run as the new baseline only if healthy. */
  maybeUpdateBaseline(siteId, fingerprint, status) {
    if (status === 'passed') {
      fs.writeFileSync(this._file(siteId), JSON.stringify(fingerprint, null, 2));
      return true;
    }
    return false;
  }

  /**
   * Build a compact, comparable fingerprint of a run.
   * elements: array of {role, text} captured during the run (structural shape)
   */
  static fingerprint({ siteId, locale, archetype, flows, elements, timings }) {
    return {
      siteId, capturedAt: new Date().toISOString(),
      locale: locale ? { lang: locale.lang, currency: locale.currency } : null,
      archetype,
      flowStatus: Object.fromEntries((flows || []).map(f => [f.key || f.flow, f.status])),
      elementSet: (elements || []).map(e => `${e.role || e.tag}:${(e.text || '').trim().slice(0, 24)}`.toLowerCase()),
      timings: timings || {},   // { flowKey: ms } or { 'page.load': ms }
    };
  }

  /** Compare current fingerprint to baseline; returns a structured diff. */
  diff(baseline, current, { perfRegressionPct = 30 } = {}) {
    if (!baseline) return { firstRun: true, changes: [], severity: 'info' };

    const changes = [];

    // 1. Flow status delta
    for (const [flow, statusNow] of Object.entries(current.flowStatus)) {
      const was = baseline.flowStatus[flow];
      if (was && was !== statusNow) {
        const regressed = was === 'passed' && statusNow !== 'passed';
        changes.push({ type: 'flow-status', flow, from: was, to: statusNow,
          severity: regressed ? 'high' : 'info',
          note: regressed ? `REGRESSION: ${flow} was passing, now ${statusNow}` : `${flow}: ${was} -> ${statusNow}` });
      }
    }

    // 2. Structural delta (added / removed interactive elements)
    const baseSet = new Set(baseline.elementSet);
    const curSet = new Set(current.elementSet);
    const removed = [...baseSet].filter(e => !curSet.has(e));
    const added = [...curSet].filter(e => !baseSet.has(e));
    if (removed.length) changes.push({ type: 'structure-removed', count: removed.length,
      examples: removed.slice(0, 6), severity: removed.length > 5 ? 'high' : 'medium',
      note: `${removed.length} interactive element(s) disappeared since last deploy` });
    if (added.length) changes.push({ type: 'structure-added', count: added.length,
      examples: added.slice(0, 6), severity: 'low', note: `${added.length} new interactive element(s) appeared` });

    // 3. Performance delta
    for (const [k, msNow] of Object.entries(current.timings)) {
      const msWas = baseline.timings[k];
      if (msWas && msNow > msWas * (1 + perfRegressionPct / 100)) {
        const pct = Math.round(((msNow - msWas) / msWas) * 100);
        changes.push({ type: 'perf-regression', metric: k, from: msWas, to: msNow,
          severity: pct > 100 ? 'high' : 'medium', note: `${k} slower by ${pct}% (${msWas}ms -> ${msNow}ms)` });
      }
    }

    // 4. Content / locale delta
    if (baseline.locale && current.locale) {
      if (baseline.locale.lang !== current.locale.lang)
        changes.push({ type: 'locale-change', from: baseline.locale.lang, to: current.locale.lang,
          severity: 'high', note: `Site language changed ${baseline.locale.lang} -> ${current.locale.lang}` });
      if (baseline.locale.currency !== current.locale.currency)
        changes.push({ type: 'currency-change', from: baseline.locale.currency, to: current.locale.currency,
          severity: 'medium', note: `Currency changed ${baseline.locale.currency} -> ${current.locale.currency}` });
    }
    if (baseline.archetype && current.archetype && baseline.archetype !== current.archetype)
      changes.push({ type: 'business-change', from: baseline.archetype, to: current.archetype,
        severity: 'high', note: `Detected business archetype shifted — major page change` });

    const severity = changes.some(c => c.severity === 'high') ? 'high'
      : changes.some(c => c.severity === 'medium') ? 'medium'
      : changes.length ? 'low' : 'none';

    return { firstRun: false, baselineAt: baseline.capturedAt, changeCount: changes.length, severity, changes };
  }
}

function sanitize(s) { return String(s).replace(/[^a-z0-9._-]/gi, '_'); }

module.exports = { DiffEngine };
