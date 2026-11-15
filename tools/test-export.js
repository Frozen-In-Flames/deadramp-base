#!/usr/bin/env node
/*
 * DeadRamp Base, Phase 0 fidelity tests for the catalog exporter.
 * Asserts numbers, not just "ran": counts against the registry, field
 * fidelity for every offering, determinism (byte-identical re-export),
 * and a mutation negative control (flip one field in a copy of the
 * input, exactly that offering's entry changes and nothing else does).
 *
 * Usage: node tools/test-export.js   (exit code 0 = all pass)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const EXPORTER = path.join(__dirname, 'export-catalog.js');
const FORKS = path.join(os.homedir(), 'workspace', 'deadramp', 'forks.json');
const GROUPS = path.join(os.homedir(), 'workspace', 'deadramp', 'groups');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deadramp-base-test-'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`PASS ${name}${detail ? ' (' + detail + ')' : ''}`); }
  else { failures++; console.log(`FAIL ${name}${detail ? ' (' + detail + ')' : ''}`); }
}
function runExporter(forksPath, outPath) {
  execFileSync('node', [EXPORTER, '--forks', forksPath, '--groups', GROUPS, '--out', outPath], { stdio: 'pipe' });
  return fs.readFileSync(outPath, 'utf8');
}

const forks = JSON.parse(fs.readFileSync(FORKS, 'utf8'));
const baseText = runExporter(FORKS, path.join(tmp, 'base.json'));
const cat = JSON.parse(baseText);

/* ---- counts ---- */
check('offerings count equals registry length', cat.meta.offerings === forks.length, `catalog=${cat.meta.offerings} registry=${forks.length}`);
check('offerings count is 781', cat.meta.offerings === 781);
const distinctVendors = new Set(forks.map((f) => f.vendor)).size;
check('vendor count equals distinct registry vendors', cat.meta.vendors === distinctVendors && cat.vendors.length === distinctVendors, `catalog=${cat.vendors.length} registry=${distinctVendors}`);
check('vendor count is 674', cat.vendors.length === 674);
check('district count is 81', cat.districts.length === 81, `districts=${cat.districts.length}`);
const embedded = cat.vendors.reduce((s, v) => s + v.offerings.length, 0);
check('embedded offerings sum to registry length', embedded === forks.length, `embedded=${embedded}`);
const districtVendorTotal = cat.districts.reduce((s, d) => s + d.vendors.length, 0);
check('every vendor homed in exactly one district', districtVendorTotal === cat.vendors.length, `district vendor slots=${districtVendorTotal}`);
const districtOfferingTotal = cat.districts.reduce((s, d) => s + d.offeringCount, 0);
check('district offering counts sum to registry length', districtOfferingTotal === forks.length, `sum=${districtOfferingTotal}`);

/* ---- field fidelity: every offering matches forks.json verbatim ---- */
const FIELDS = ['vendor', 'product', 'service_model', 'fedramp_impact_level', 'authorization_status', 'category', 'cmmc_tier', 'source_url'];
let fieldMismatch = 0;
const byIndex = new Map();
for (const v of cat.vendors) for (const o of v.offerings) byIndex.set(o.registryIndex, o);
check('every registry index present exactly once', byIndex.size === forks.length, `indexed=${byIndex.size}`);
for (let i = 0; i < forks.length; i++) {
  const o = byIndex.get(i);
  if (!o) { fieldMismatch++; continue; }
  for (const f of FIELDS) if (o[f] !== forks[i][f]) fieldMismatch++;
}
check('all offering fields match the registry verbatim', fieldMismatch === 0, `mismatched fields=${fieldMismatch}`);

/* ---- district naming consistency with the groups tree ---- */
const groupDirs = new Set(fs.readdirSync(GROUPS).filter((d) => fs.statSync(path.join(GROUPS, d)).isDirectory()));
const exceptions = cat.districts.filter((d) => !groupDirs.has(d.id));
const badExceptions = exceptions.filter((d) => !(d.id.startsWith('uncategorized-') || d.id.endsWith('-untiered')));
check('district ids match groups tree names, exceptions are uncategorized or untiered only',
  badExceptions.length === 0, `exceptions=${exceptions.map((d) => d.id).join(', ') || 'none'}`);

/* ---- layout sanity ---- */
let nanCount = 0, missingPos = 0;
for (const v of cat.vendors) {
  if (!v.position || !v.size) { missingPos++; continue; }
  for (const n of [v.position.x, v.position.z, v.rotationY, v.size.w, v.size.d, v.size.h]) if (!Number.isFinite(n)) nanCount++;
}
check('every vendor has a finite layout position and size', missingPos === 0 && nanCount === 0, `missing=${missingPos} nan=${nanCount}`);
const lots = cat.vendors.filter((v) => v.kind === 'lot');
check('exactly one empty lot (TERIDA)', lots.length === 1 && lots[0].name === 'TERIDA', `lots=${lots.map((v) => v.name).join(',')}`);
const unclass = [];
for (const v of cat.vendors) for (const o of v.offerings) if (o.unclassified) unclass.push(o.product);
check('exactly two offerings flagged unclassified', unclass.length === 2, unclass.join(' | '));

/* ---- brand palettes: integrity of the rendition layer ---- */
const { BRAND_SEEDS, FEDERAL_FINISH } = require(EXPORTER);
const registryVendors = new Set(forks.map((f) => f.vendor));
const deadSeeds = Object.keys(BRAND_SEEDS).filter((k) => !registryVendors.has(k));
check('every seeded brand palette belongs to a registry vendor (no dead seeds)', deadSeeds.length === 0, deadSeeds.join(', '));
let brandShapeBad = 0, researchedCount = 0, defaultMismatch = 0;
const hexRe = /^#[0-9a-f]{6}$/;
for (const v of cat.vendors) {
  const b = v.brand;
  if (!b || !['researched', 'default'].includes(b.source) || !hexRe.test(b.primary) || !hexRe.test(b.secondary) || !hexRe.test(b.accent)) { brandShapeBad++; continue; }
  if (b.source === 'researched') {
    researchedCount++;
    const seed = BRAND_SEEDS[v.name];
    if (!seed || seed.primary !== b.primary || seed.secondary !== b.secondary || seed.accent !== b.accent) brandShapeBad++;
  } else if (b.primary !== FEDERAL_FINISH.primary || b.secondary !== FEDERAL_FINISH.secondary || b.accent !== FEDERAL_FINISH.accent) {
    defaultMismatch++;
  }
}
check('every vendor carries a well-formed brand palette matching its source', brandShapeBad === 0, `bad=${brandShapeBad}`);
check('every default vendor wears exactly the federal finish (no invented brand colours)', defaultMismatch === 0, `mismatched=${defaultMismatch}`);
check('researched palette count equals seed table size', researchedCount === Object.keys(BRAND_SEEDS).length,
  `researched=${researchedCount} seeds=${Object.keys(BRAND_SEEDS).length}`);
const ms = cat.vendors.find((v) => v.name === 'Microsoft');
check('spot check: Microsoft palette is the seeded public brand palette',
  !!ms && ms.brand.source === 'researched' && ms.brand.primary === '#0078d4', ms ? ms.brand.primary : 'missing');

/* ---- determinism: byte-identical re-export ---- */
const againText = runExporter(FORKS, path.join(tmp, 'again.json'));
check('re-export is byte-identical (deterministic layout)', againText === baseText);

/* ---- mutation negative control ----
 * Flip one field (product of registry entry 0) in a copy of the input.
 * Exactly that offering's entry may change; districts, roads, meta and
 * every other vendor entry must be byte-identical. */
const mutated = JSON.parse(JSON.stringify(forks));
mutated[0].product = mutated[0].product + ' MUTATED';
const mutPath = path.join(tmp, 'forks-mutated.json');
fs.writeFileSync(mutPath, JSON.stringify(mutated));
const mutCat = JSON.parse(runExporter(mutPath, path.join(tmp, 'mut.json')));
check('mutation: meta unchanged', JSON.stringify(mutCat.meta) === JSON.stringify(cat.meta));
check('mutation: districts unchanged', JSON.stringify(mutCat.districts) === JSON.stringify(cat.districts));
check('mutation: roads unchanged', JSON.stringify(mutCat.roads) === JSON.stringify(cat.roads));
const changedVendors = [];
for (let i = 0; i < cat.vendors.length; i++) {
  if (JSON.stringify(mutCat.vendors[i]) !== JSON.stringify(cat.vendors[i])) changedVendors.push(i);
}
check('mutation: exactly one vendor entry changed', changedVendors.length === 1, `changed=${changedVendors.length}`);
if (changedVendors.length === 1) {
  const a = cat.vendors[changedVendors[0]], b = mutCat.vendors[changedVendors[0]];
  const diffs = [];
  for (let j = 0; j < a.offerings.length; j++) {
    for (const f of FIELDS) if (a.offerings[j][f] !== b.offerings[j][f]) diffs.push(`${j}:${f}`);
  }
  check('mutation: exactly one field of one offering changed', diffs.length === 1 && diffs[0].endsWith(':product'), `diffs=${diffs.join(',')}`);
  check('mutation: layout of the changed vendor unchanged',
    a.position.x === b.position.x && a.position.z === b.position.z && a.rotationY === b.rotationY);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
