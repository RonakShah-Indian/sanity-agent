'use strict';

/**
 * Visual diff per (viewport × persona). Catches CSS / layout regressions that
 * pass functional tests but ruin UX — the CTA moved 80px, the cart icon
 * vanished, the price label color is now invisible on dark mode, etc.
 *
 * Implementation: downsample to a fixed grid (256x256) with sharp, then do
 * a fast per-pixel delta. Cheap enough to run on every flow finish; tight
 * enough to catch real regressions while ignoring jitter (font hinting,
 * sub-pixel anti-aliasing).
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const GRID = 256;        // 256×256 grayscale = 65K bytes per fingerprint
const THRESHOLD = 24;    // per-channel delta (0-255) to count as "different"

async function captureFingerprint(page) {
  const png = await page.screenshot({ fullPage: false, type: 'png' });
  const fp = await sharp(png).resize(GRID, GRID, { fit: 'fill' }).grayscale().raw().toBuffer();
  return { fp, png };
}

function compareFingerprints(a, b) {
  if (!a || !b || a.length !== b.length) return { diffPercent: 1, comparable: false };
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > THRESHOLD) diff++;
  }
  return { diffPercent: +(diff / a.length).toFixed(4), comparable: true };
}

function baselinePath(visualDir, siteId, variantName) {
  fs.mkdirSync(visualDir, { recursive: true });
  return path.join(visualDir, `${sanitize(siteId)}__${sanitize(variantName)}.bin`);
}

function loadBaseline(visualDir, siteId, variantName) {
  const p = baselinePath(visualDir, siteId, variantName);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

function saveBaseline(visualDir, siteId, variantName, fp) {
  fs.writeFileSync(baselinePath(visualDir, siteId, variantName), fp);
}

async function diffAgainstBaseline(page, { visualDir, siteId, variantName, updateBaseline = false, threshold = 0.05 }) {
  try {
    const { fp } = await captureFingerprint(page);
    const prev = loadBaseline(visualDir, siteId, variantName);
    if (!prev) {
      saveBaseline(visualDir, siteId, variantName, fp);
      return { diffPercent: 0, baseline: 'created', regressed: false };
    }
    const cmp = compareFingerprints(prev, fp);
    const regressed = cmp.diffPercent > threshold;
    if (updateBaseline && !regressed) saveBaseline(visualDir, siteId, variantName, fp);
    return { ...cmp, baseline: 'compared', regressed, threshold };
  } catch (e) {
    return { error: e.message, comparable: false, regressed: false };
  }
}

function sanitize(s) { return String(s).replace(/[^a-z0-9._-]/gi, '_'); }

module.exports = { captureFingerprint, compareFingerprints, diffAgainstBaseline, loadBaseline, saveBaseline };
