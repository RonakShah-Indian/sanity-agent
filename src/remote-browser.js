'use strict';

/**
 * Real-device / real-browser adapter.
 *
 * Today the agent runs against local headless Chromium. That misses bugs
 * that only manifest on real iOS WebKit, real Safari on macOS, real Edge
 * on Windows, real touch events on a real Pixel, etc.
 *
 * This module abstracts the "where does the browser live" decision. Three
 * providers ship today:
 *
 *   local         — Playwright launches chromium/firefox/webkit locally
 *                   (default; no credentials needed)
 *   browserstack  — Playwright connects to BrowserStack's CDP over WSS.
 *                   Supports the full real-device matrix AND the desktop
 *                   browser matrix (Safari@macOS, Chrome@Windows, Firefox@Linux,
 *                   Edge@Windows, mobile Safari@iOS, mobile Chrome@Android).
 *   custom-cdp    — Connect to an arbitrary CDP/WSS endpoint (Selenium Grid,
 *                   Sauce Labs, LambdaTest, or a self-hosted browser grid).
 *
 * The selection lives on the SITE or on the VIEWPORT:
 *   site.remote        = "browserstack"
 *   viewport.remote    = "browserstack"   (overrides site-level)
 *   viewport.bs        = { os, os_version, browser, browser_version,
 *                          device?, real_mobile? }
 *
 * Auth comes from env: BROWSERSTACK_USERNAME + BROWSERSTACK_ACCESS_KEY.
 *
 * NB: We don't bake credentials into the codebase. The adapter is built
 * so that if you flip a config flag, the next run uses real devices — no
 * code change needed.
 */

const { chromium, firefox, webkit } = require('playwright');

const BS_CDP_BASE = 'wss://cdp.browserstack.com/playwright?caps=';

async function launchForVariant(variant, { config, logger } = {}) {
  const remote = variant.remote || variant.site?.remote || null;

  // ---- Provider: browserstack (real device OR real desktop browser) -----
  if (remote === 'browserstack') {
    const caps = buildBrowserStackCaps(variant);
    if (!caps['browserstack.username'] || !caps['browserstack.accessKey']) {
      throw new Error('BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY env vars required for remote=browserstack');
    }
    const wsEndpoint = `${BS_CDP_BASE}${encodeURIComponent(JSON.stringify(caps))}`;
    logger?.info?.(`[remote] browserstack: ${describeCaps(caps)}`);
    // BrowserStack supports Playwright-compatible CDP for chromium-family targets.
    const browser = await chromium.connect({ wsEndpoint });
    return { browser, transport: 'browserstack-cdp', caps };
  }

  // ---- Provider: arbitrary CDP grid -------------------------------------
  if (remote === 'custom-cdp') {
    const ws = variant.cdpUrl || process.env.SANITY_CDP_URL;
    if (!ws) throw new Error('remote=custom-cdp requires viewport.cdpUrl or SANITY_CDP_URL env');
    logger?.info?.(`[remote] custom-cdp: ${ws}`);
    const browser = await chromium.connect({ wsEndpoint: ws });
    return { browser, transport: 'custom-cdp', caps: { wsEndpoint: ws } };
  }

  // ---- Provider: local (default) ---------------------------------------
  const browserType = pickLocalBrowser(variant);
  // Honor SANITY_HEADED=1 (CLI: --headed) or per-variant override for live demos.
  const headless = !(process.env.SANITY_HEADED === '1' || variant.headed || config?.headed);
  const browser = await browserType.launch({ headless });
  return { browser, transport: headless ? 'local' : 'local-headed', caps: { engine: browserType.name() } };
}

function pickLocalBrowser(variant) {
  const eng = (variant.engine || 'chromium').toLowerCase();
  if (eng === 'firefox') return firefox;
  if (eng === 'webkit' || eng === 'safari') return webkit;
  return chromium;
}

/**
 * Translate a viewport spec into BrowserStack capability JSON.
 * Accepts EITHER a `viewport.bs` block (raw caps) OR shorthand fields:
 *
 *   { device: "iPhone 14", os_version: "16", real_mobile: true }
 *   { browser: "Safari", browser_version: "17", os: "OS X", os_version: "Sonoma" }
 *   { browser: "Chrome",  browser_version: "120", os: "Windows", os_version: "11" }
 *
 * Plus auth pulled from env (so it stays out of configs / git).
 */
function buildBrowserStackCaps(variant) {
  const v = variant.bs || variant;
  const base = {
    'browserstack.username':  process.env.BROWSERSTACK_USERNAME || '',
    'browserstack.accessKey': process.env.BROWSERSTACK_ACCESS_KEY || '',
    'browserstack.local':     'false',
    'project':                process.env.BROWSERSTACK_PROJECT || 'sanity-agent',
    'name':                   variant.name || 'sanity',
    'build':                  process.env.BROWSERSTACK_BUILD || `sanity-${new Date().toISOString().slice(0,10)}`,
  };
  // Real mobile device
  if (v.device) {
    return {
      ...base,
      'device':      v.device,
      'realMobile':  String(v.real_mobile ?? true),
      'os_version':  String(v.os_version || ''),
    };
  }
  // Desktop browser matrix
  return {
    ...base,
    'browser':         v.browser || 'Chrome',
    'browser_version': v.browser_version || 'latest',
    'os':              v.os || 'Windows',
    'os_version':      v.os_version || '11',
  };
}

function describeCaps(caps) {
  if (caps.device) return `${caps.device} (real device, iOS/Android ${caps.os_version})`;
  return `${caps.browser} ${caps.browser_version} on ${caps.os} ${caps.os_version}`;
}

module.exports = { launchForVariant, buildBrowserStackCaps };
