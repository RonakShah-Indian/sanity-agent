'use strict';

/**
 * Precision/recall benchmark for the cross-merchant PatternAnalyzer.
 *
 * Why this exists: PLAYBOOK §12.5 used to say the detector was "advisory until
 * tuned, no precision measurement." This test produces the measurement, and
 * does so on a deliberately hard synthetic fleet — not a softball.
 *
 * Methodology (hard mode):
 *   1. Generate a synthetic fleet of 100 merchants stratified across 5
 *      archetypes, 3 regions, 4 themeVersions, 4 locales. Distribution chosen
 *      to mirror a real multi-tenant commerce platform, AND to deliberately
 *      correlate two dimensions (theme v3.2 ↔ quick_commerce archetype) so
 *      the detector has to disambiguate co-confounded patterns.
 *
 *   2. Inject 3 ground-truth platform patterns ("oracles") at a hard
 *      injection rate of 50% (not the easy-mode 80-90%):
 *        ORACLE A: themeVersion = "lifestyle-v3.2"  → add_to_cart fails 50%
 *        ORACLE B: region       = "MY"               → checkout fails 65%
 *        ORACLE C: archetype    = "food_delivery"   → food_order fails 60%
 *
 *   3. Add baseline noise: every (site, flow) has a 15% independent chance of
 *      failing. That's 3× the easy-mode 5%, generating many spurious
 *      multi-site failure clusters that the filter has to reject.
 *
 *   4. Run detectPatterns() across 3 threshold profiles (loose/default/strict).
 *      Sweep N=10 RNG seeds. Report median + min/max precision per profile,
 *      not a single-seed number. A single seed could be lucky; the median
 *      across seeds is what you'd see on a real fleet of similar shape.
 *
 *   5. Assert default-profile median precision ≥ 0.70 (the PLAYBOOK
 *      production-trust threshold). Recall is informational — when noise is
 *      high, recall drops because oracle failure rates and noise overlap.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { recordRun } = require('../src/health');
const { detectPatterns } = require('../src/patterns');

// Seedable linear-congruential RNG (one instance per seed sweep).
function makeRng(seed) {
  let s = seed & 0x7fffffff;
  return {
    rand() { s = (s * 1664525 + 1013904223) & 0x7fffffff; return s / 0x7fffffff; },
    pick(list) { return list[Math.floor(this.rand() * list.length)]; },
  };
}

const LOCALES = ['en-IN', 'ms-MY', 'en-US', 'hi-IN'];
const FLOWS = ['sign_in', 'search_product', 'add_to_cart', 'checkout', 'food_order'];
const NOISE_RATE = 0.15;        // 3× the easy-mode rate
const FLEET_SIZE = 100;

// Hard-mode oracles — lower inject rates approach the noise floor.
const ORACLES = [
  { flow: 'add_to_cart', dimension: 'themeVersion', value: 'lifestyle-v3.2', injectRate: 0.50 },
  { flow: 'checkout',    dimension: 'region',       value: 'MY',             injectRate: 0.65 },
  { flow: 'food_order',  dimension: 'archetype',    value: 'food_delivery',  injectRate: 0.60 },
];

function buildFleet(rng) {
  const fleet = [];
  for (let i = 0; i < FLEET_SIZE; i++) {
    // Stratified composition: fashion 40, electronics 25, quick 15, food 10, b2b 10
    const archetype =
      i < 40 ? 'fashion_retail' :
      i < 65 ? 'electronics' :
      i < 80 ? 'quick_commerce' :
      i < 90 ? 'food_delivery' :
               'b2b_wholesale';
    // Region: IN 50, MY 20, US 30
    const region = i < 50 ? 'IN' : i < 70 ? 'MY' : 'US';
    // Theme: v3.0=30, v3.1=30, v3.2=25, v3.3=15
    // NOTE: v3.2 spans sites 60-84, which fully contains quick_commerce
    // (sites 65-79). This DELIBERATE correlation makes co-confounding the
    // detector's hardest test case (PASS 1 of dedupeNestedPatterns is what
    // disambiguates them).
    const themeVersion =
      i < 30 ? 'lifestyle-v3.0' :
      i < 60 ? 'lifestyle-v3.1' :
      i < 85 ? 'lifestyle-v3.2' :
               'lifestyle-v3.3';
    const locale = rng.pick(LOCALES);
    fleet.push({ id: `site-${i}`, archetype, region, themeVersion, locale });
  }
  return fleet;
}

function buildRunRecords(fleet, rng) {
  return fleet.map(s => {
    const flows = [];
    for (const flowKey of FLOWS) {
      let status = 'passed';
      // Apply oracle injection.
      for (const oracle of ORACLES) {
        if (flowKey !== oracle.flow) continue;
        if (s[oracle.dimension] === oracle.value && rng.rand() < oracle.injectRate) {
          status = 'failed';
        }
      }
      // Independent noise on every (site, flow).
      if (status === 'passed' && rng.rand() < NOISE_RATE) status = 'failed';
      flows.push({ key: flowKey, status, critical: flowKey !== 'sign_in' });
    }
    return {
      site: s.id,
      url: `https://${s.id}.example`,
      status: flows.some(f => f.status === 'failed') ? 'failed' : 'passed',
      finishedAt: new Date().toISOString(),
      business: { archetype: s.archetype },
      region: s.region,
      themeVersion: s.themeVersion,
      locale: s.locale,
      flows,
      personaFindings: [],
    };
  });
}

const PROFILES = {
  loose:   { minAffected: 3, minRate: 0.40, liftThreshold: 1.5 },
  default: {},   // library defaults: minAffected 5, minRate 0.5, lift 2.0
  strict:  { minAffected: 7, minRate: 0.60, liftThreshold: 3.0 },
};

function classify(pattern) {
  return ORACLES.some(o =>
    o.flow === pattern.flow &&
    o.dimension === pattern.dimension &&
    o.value === pattern.value
  );
}

function runSeed(seed) {
  const rng = makeRng(seed);
  const fleet = buildFleet(rng);
  const records = buildRunRecords(fleet, rng);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `patterns-precision-${seed}-`));
  recordRun({ results: records }, tmp);

  const seedResult = {};
  for (const [name, opts] of Object.entries(PROFILES)) {
    const out = detectPatterns(tmp, opts);
    const tp = out.patterns.filter(classify).length;
    const fp = out.patterns.length - tp;
    const detectedOracles = new Set(out.patterns.filter(classify).map(p => `${p.flow}|${p.dimension}|${p.value}`));
    const fn = ORACLES.filter(o => !detectedOracles.has(`${o.flow}|${o.dimension}|${o.value}`)).length;
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall    = tp + fn === 0 ? 1 : tp / (tp + fn);
    const f1        = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
    seedResult[name] = { tp, fp, fn, precision, recall, f1 };
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return seedResult;
}

// Sweep N seeds to get a stable distribution.
const SEEDS = [20260625, 1, 42, 1337, 9999, 314159, 271828, 81, 161, 256];
const allRuns = SEEDS.map(s => runSeed(s));

function statsFor(profile, metric) {
  const vals = allRuns.map(r => r[profile][metric]).sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];
  return { median, min: vals[0], max: vals[vals.length - 1] };
}

console.log('\n=== PatternAnalyzer Precision Benchmark (HARD mode) ===');
console.log(`Fleet: ${FLEET_SIZE} merchants · noise rate: ${NOISE_RATE * 100}% per-flow · 3 oracle patterns @ 50-65% injection`);
console.log(`Co-confound: v3.2 theme ⊃ quick_commerce archetype (PASS 1 dedup must disambiguate)`);
console.log(`Seeds swept: ${SEEDS.length}\n`);
console.log('Profile     | Precision (median, min-max)  | Recall (median, min-max)     | F1');
console.log('------------+------------------------------+------------------------------+-------');
for (const profile of ['loose', 'default', 'strict']) {
  const p = statsFor(profile, 'precision');
  const r = statsFor(profile, 'recall');
  const f = statsFor(profile, 'f1');
  console.log(
    `${profile.padEnd(11)} |   ${p.median.toFixed(2)}  (${p.min.toFixed(2)}-${p.max.toFixed(2)})           ` +
    `|   ${r.median.toFixed(2)}  (${r.min.toFixed(2)}-${r.max.toFixed(2)})           ` +
    `|  ${f.median.toFixed(2)}`
  );
}
console.log('');

// --- Assertions ---
let failed = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`✓ ${name}`); }
  else { failed++; console.log(`✗ ${name}\n   ${detail}`); }
}

const defaultPrecision = statsFor('default', 'precision');
const defaultRecall = statsFor('default', 'recall');
const strictPrecision = statsFor('strict', 'precision');
const loosePrecision = statsFor('loose', 'precision');

check(`default median precision ≥ 0.70 (PLAYBOOK production-trust threshold)`,
  defaultPrecision.median >= 0.70,
  `default median was ${defaultPrecision.median.toFixed(3)} across ${SEEDS.length} seeds`);

check(`default min precision ≥ 0.50 (no individual seed catastrophically wrong)`,
  defaultPrecision.min >= 0.50,
  `worst-seed precision was ${defaultPrecision.min.toFixed(3)}; detector unstable`);

check(`default median recall ≥ 0.33 (catches at least 1 of 3 oracles)`,
  defaultRecall.median >= 0.33,
  `default median recall was ${defaultRecall.median.toFixed(3)}`);

check(`strict median precision ≥ default median precision`,
  strictPrecision.median >= defaultPrecision.median,
  `strict ${strictPrecision.median.toFixed(3)} < default ${defaultPrecision.median.toFixed(3)}`);

check(`strict has fewer or equal false positives than loose (across all seeds)`,
  SEEDS.every((_, i) => allRuns[i].strict.fp <= allRuns[i].loose.fp),
  `strict had more FPs than loose on some seeds`);

console.log(failed === 0 ? '\nPATTERNS PRECISION BENCHMARK PASSED ✅' : `\n${failed} assertion(s) failed ❌`);
process.exit(failed ? 1 : 0);
