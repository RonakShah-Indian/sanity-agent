'use strict';

/**
 * Per-run browser telemetry — every test now catches what no one programmed
 * it to catch. Three signal streams, each free if you're already loading the
 * page:
 *
 *   1. console errors  (page.on('console', level==='error'))
 *   2. uncaught JS exceptions  (page.on('pageerror'))
 *   3. HTTP 4xx/5xx responses for requests originated by the page
 *
 * Plus Web Vitals via PerformanceObserver injected into the page — LCP, CLS,
 * INP — captured non-invasively and snapshotted on demand.
 *
 * Usage:
 *   const t = attachTelemetry(page);
 *   ...run flows...
 *   const snap = await t.snapshot();    // { consoleErrors, pageErrors, badResponses, vitals }
 *   t.detach();
 */

function attachTelemetry(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const badResponses = [];

  const onConsole = (msg) => {
    if (msg.type() !== 'error') return;
    consoleErrors.push({ ts: Date.now(), text: msg.text().slice(0, 600), location: locationOf(msg) });
  };
  const onPageError = (err) => {
    pageErrors.push({ ts: Date.now(), name: err.name, message: String(err.message || err).slice(0, 600), stack: (err.stack || '').slice(0, 1200) });
  };
  const onResponse = (res) => {
    const s = res.status();
    if (s < 400) return;
    // Skip noisy junk: prefetch, analytics 204s, opaque resource hints.
    const url = res.url();
    badResponses.push({ ts: Date.now(), url: url.slice(0, 300), status: s, method: res.request().method(), resourceType: res.request().resourceType() });
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);

  // Inject the Web Vitals collector once per page navigation.
  page.on('framenavigated', async (frame) => {
    if (frame !== page.mainFrame()) return;
    try { await page.evaluate(installVitalsCollector); } catch { /* page may have unloaded */ }
  });

  return {
    snapshot: async () => {
      let vitals = null;
      try { vitals = await page.evaluate(() => window.__sanityVitals || null); } catch { /* page closed */ }
      return {
        consoleErrors: consoleErrors.slice(),
        pageErrors:    pageErrors.slice(),
        badResponses:  uniqByUrlStatus(badResponses),
        vitals,
        counts: { consoleErrors: consoleErrors.length, pageErrors: pageErrors.length, badResponses: badResponses.length },
      };
    },
    detach: () => {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('response', onResponse);
    },
  };
}

function locationOf(msg) {
  const loc = msg.location?.();
  return loc ? `${loc.url || ''}:${loc.lineNumber || ''}` : null;
}

// Dedupe by URL+status — a single broken resource fetched many times shouldn't drown the report.
function uniqByUrlStatus(list) {
  const seen = new Map();
  for (const r of list) {
    const k = `${r.status}|${r.url}`;
    const cur = seen.get(k) || { ...r, hits: 0 };
    cur.hits++;
    seen.set(k, cur);
  }
  return [...seen.values()].sort((a, b) => b.hits - a.hits).slice(0, 30);
}

/**
 * Injected into the page. Wires Performance Observers for LCP / CLS / INP /
 * FCP / TTFB and stuffs the running totals on window.__sanityVitals so the
 * Node side can fetch them via page.evaluate.
 */
function installVitalsCollector() {
  if (window.__sanityVitalsInstalled) return;
  window.__sanityVitalsInstalled = true;
  const v = window.__sanityVitals = { lcp: null, cls: 0, inp: null, fcp: null, ttfb: null };
  try {
    new PerformanceObserver((entryList) => {
      for (const e of entryList.getEntries()) v.lcp = Math.round(e.startTime);
    }).observe({ type: 'largest-contentful-paint', buffered: true });

    new PerformanceObserver((entryList) => {
      for (const e of entryList.getEntries()) if (!e.hadRecentInput) v.cls = +(v.cls + e.value).toFixed(4);
    }).observe({ type: 'layout-shift', buffered: true });

    new PerformanceObserver((entryList) => {
      for (const e of entryList.getEntries()) {
        const d = Math.round(e.duration);
        v.inp = v.inp === null ? d : Math.max(v.inp, d);
      }
    }).observe({ type: 'event', buffered: true, durationThreshold: 16 });

    new PerformanceObserver((entryList) => {
      const fcp = entryList.getEntries().find(e => e.name === 'first-contentful-paint');
      if (fcp) v.fcp = Math.round(fcp.startTime);
    }).observe({ type: 'paint', buffered: true });

    const navEntry = performance.getEntriesByType('navigation')[0];
    if (navEntry) v.ttfb = Math.round(navEntry.responseStart);
  } catch { /* older browsers — skip */ }
}

/**
 * Classify a telemetry snapshot against config thresholds. Pure function.
 * Returns { severity, findings[] } that the agent attaches to the result.
 */
function evaluateTelemetry(snap, budgets = {}) {
  const findings = [];
  const lcpBudget = budgets.lcpMs ?? 2500;
  const clsBudget = budgets.cls ?? 0.1;
  const inpBudget = budgets.inpMs ?? 200;

  if (snap.counts?.pageErrors > 0)
    findings.push({ kind: 'pageerror', severity: 'high', detail: `${snap.counts.pageErrors} uncaught JS exception(s)` });
  if (snap.counts?.consoleErrors > 0)
    findings.push({ kind: 'console', severity: 'medium', detail: `${snap.counts.consoleErrors} console error(s)` });
  if (snap.counts?.badResponses > 0)
    findings.push({ kind: 'http', severity: 'high', detail: `${snap.counts.badResponses} 4xx/5xx response(s)` });

  const v = snap.vitals;
  if (v && Number.isFinite(v.lcp) && v.lcp > lcpBudget)
    findings.push({ kind: 'vitals.lcp', severity: 'medium', detail: `LCP ${v.lcp}ms > ${lcpBudget}ms` });
  if (v && Number.isFinite(v.cls) && v.cls > clsBudget)
    findings.push({ kind: 'vitals.cls', severity: 'medium', detail: `CLS ${v.cls} > ${clsBudget}` });
  if (v && Number.isFinite(v.inp) && v.inp > inpBudget)
    findings.push({ kind: 'vitals.inp', severity: 'medium', detail: `INP ${v.inp}ms > ${inpBudget}ms` });

  const severity = findings.some(f => f.severity === 'high') ? 'high'
                 : findings.some(f => f.severity === 'medium') ? 'medium'
                 : 'ok';
  return { severity, findings };
}

module.exports = { attachTelemetry, evaluateTelemetry };
