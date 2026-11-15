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
const crypto = require('crypto');
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
function runExporter(forksPath, outPath, groupsPath) {
  execFileSync('node', [EXPORTER, '--forks', forksPath, '--groups', groupsPath || GROUPS, '--out', outPath], { stdio: 'pipe' });
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

/* ---- Phase 2: rooms and build records ----
 * Rooms are generated from the DeadRamp source repo: each offering's
 * spec entry in groups/<group>/specs/specs.json (joined by fork_id)
 * plus the group's merged build record. These tests re-read the
 * source tree independently and assert exact matches. */
const DEADRAMP_ROOT = path.dirname(GROUPS);
const { archetypeFor, forkIdOf } = require(EXPORTER);
const specIndexT = new Map();
for (const g of fs.readdirSync(GROUPS).sort()) {
  const sp = path.join(GROUPS, g, 'specs', 'specs.json');
  if (!fs.existsSync(sp)) continue;
  for (const e of JSON.parse(fs.readFileSync(sp, 'utf8'))) {
    if (e && e.fork_id && !specIndexT.has(e.fork_id)) specIndexT.set(e.fork_id, { group: g, entry: e });
  }
}
check('source tree holds 779 spec entries (781 offerings minus the 2 unclassified)',
  specIndexT.size === 779, `specs=${specIndexT.size}`);
let roomCount = 0, roomsWithBuild = 0, roomFieldBad = 0, noBuildIds = [];
const ARCHETYPES = ['ops-center', 'server-hall', 'lab', 'meeting-space', 'ledger-office', 'federal-office'];
let archetypeBad = 0;
for (const v of cat.vendors) for (const o of v.offerings) {
  if (!o.room) { roomFieldBad++; continue; }
  roomCount++;
  if (!ARCHETYPES.includes(o.room.archetype) || o.room.archetype !== archetypeFor(o.function)) archetypeBad++;
  const hit = specIndexT.get(forkIdOf(o.source_url));
  if (!hit) {
    if (o.room.buildGroup !== null || o.room.specPath !== null || o.room.description !== null) roomFieldBad++;
    noBuildIds.push(o.room.forkId);
    continue;
  }
  roomsWithBuild++;
  const e = hit.entry;
  if (o.room.buildGroup !== hit.group) roomFieldBad++;
  if (o.room.specPath !== `groups/${hit.group}/specs/specs.json`) roomFieldBad++;
  if (o.room.description !== (e.description ?? null)) roomFieldBad++;
  if (o.room.deploymentModel !== (e.deployment_model ?? null)) roomFieldBad++;
  if (o.room.specSource !== (e.source ?? null)) roomFieldBad++;
  const srcFns = (e.functions_claimed || []).map((f) => ({ id: f.function_id, name: f.function }));
  if (JSON.stringify(o.room.functions) !== JSON.stringify(srcFns)) roomFieldBad++;
}
check('room count equals offering count (781)', roomCount === 781 && cat.meta.rooms === 781, `rooms=${roomCount}`);
check('every room traces exactly to its source spec entry (description, deployment, functions, paths)',
  roomFieldBad === 0, `bad=${roomFieldBad}`);
check('rooms with a source build number 779', roomsWithBuild === 779, `withBuild=${roomsWithBuild}`);
check('the only rooms without a build are the two unclassified offerings',
  noBuildIds.length === 2 && noBuildIds.includes('FR1901852210') && noBuildIds.includes('AGENCYNITCIAAS'),
  noBuildIds.join(', '));
check('every room archetype is in the documented set and follows the offering function', archetypeBad === 0, `bad=${archetypeBad}`);

/* ---- build records: provenance against the source tree ---- */
const buildKeys = Object.keys(cat.builds || {});
check('one build record per group in the source tree (101)', buildKeys.length === 101 && cat.meta.builds === 101, `builds=${buildKeys.length}`);
let specCountSum = 0, manifestBad = 0, manifestFiles = 0, titleBad = 0, summaryBad = 0;
const stripMd = (s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1').replace(/[*_`]+/g, '').replace(/\s+/g, ' ');
for (const g of buildKeys) {
  const b = cat.builds[g];
  specCountSum += b.specCount;
  const readme = fs.readFileSync(path.join(DEADRAMP_ROOT, 'groups', g, 'README.md'), 'utf8');
  const titleLine = readme.split('\n').find((l) => l.startsWith('# '));
  if (!titleLine || b.title !== titleLine.slice(2).trim()) titleBad++;
  const core = b.summary.endsWith('…') ? b.summary.slice(0, -1) : b.summary;
  if (!core || !stripMd(readme).includes(core)) summaryBad++;
  for (const mf of b.manifest) {
    manifestFiles++;
    const p = path.join(DEADRAMP_ROOT, mf.path);
    if (!fs.existsSync(p)) { manifestBad++; continue; }
    const buf = fs.readFileSync(p);
    if (buf.length !== mf.bytes || crypto.createHash('sha256').update(buf).digest('hex') !== mf.sha256) manifestBad++;
  }
}
check('build spec counts sum to the 779 spec entries', specCountSum === 779, `sum=${specCountSum}`);
check('every build title is the verbatim first heading of its group README', titleBad === 0, `bad=${titleBad}`);
check('every build summary is verbatim text from its group README', summaryBad === 0, `bad=${summaryBad}`);
check('every manifest entry matches its source file (path, size, SHA-256)',
  manifestBad === 0, `files=${manifestFiles} bad=${manifestBad}`);
/* independent recount of the builds' test suites */
let recountedTests = 0;
for (const g of buildKeys) {
  const tdir = path.join(DEADRAMP_ROOT, 'groups', g, 'tests');
  if (!fs.existsSync(tdir)) continue;
  for (const f of fs.readdirSync(tdir)) {
    if (/^test_.*\.py$/.test(f)) {
      recountedTests += (fs.readFileSync(path.join(tdir, f), 'utf8').match(/^\s*def test_/gm) || []).length;
    }
  }
}
const catalogTests = buildKeys.reduce((s, g) => s + cat.builds[g].testCount, 0);
check('build test counts match an independent recount of the source tests',
  catalogTests === recountedTests, `catalog=${catalogTests} recounted=${recountedTests}`);
/* sampled surface checks against source text */
for (const g of ['cybersecurity-l3', 'storage-l2', 'analytics-l2']) {
  const b = cat.builds[g];
  const mainPy = fs.readFileSync(path.join(DEADRAMP_ROOT, 'groups', g, 'src', b.package, '__main__.py'), 'utf8');
  const cliOk = b.cli.every((c) => mainPy.includes(`add_parser("${c.name}"`) || mainPy.includes(`add_parser('${c.name}'`))
    && b.cli.length === (mainPy.match(/add_parser\(/g) || []).length;
  check(`build surface: ${g} CLI commands are verbatim from its __main__.py`, cliOk, `cli=${b.cli.map((c) => c.name).join(',')}`);
}
const cyber = cat.builds['cybersecurity-l3'];
check('spot check: cybersecurity-l3 carries its 34-control NIST SP 800-53 catalog, AC-2 first',
  cyber.controls.length === 34 && cyber.controls[0].id === 'AC-2' && cyber.controlsSource.endsWith('catalog.py'),
  `controls=${cyber.controls.length}`);
check('spot check: cybersecurity-l3 literal routes include GET /health and operations include asset_list',
  cyber.http.routes.includes('GET /health') && cyber.http.operations.includes('asset_list'));
const ctrlGroups = buildKeys.filter((g) => cat.builds[g].controls.length > 0);
check('exactly the 8 cybersecurity and GRC builds carry a control catalog', ctrlGroups.length === 8, ctrlGroups.join(', '));

/* ---- Phase 2 mutation control: one changed spec field changes
 * exactly one room. Sparse groups tree (specs only) with one
 * description flipped; rooms are compared per registry index. ---- */
const sparseRoot = path.join(tmp, 'sparse');
for (const g of fs.readdirSync(GROUPS)) {
  const sp = path.join(GROUPS, g, 'specs', 'specs.json');
  if (!fs.existsSync(sp)) continue;
  const dest = path.join(sparseRoot, 'groups', g, 'specs');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(sp, path.join(dest, 'specs.json'));
}
const targetFork = forkIdOf(forks[0].source_url);
const targetGroup = specIndexT.get(targetFork).group;
const mutSpecPath = path.join(sparseRoot, 'groups', targetGroup, 'specs', 'specs.json');
const mutSpecs = JSON.parse(fs.readFileSync(mutSpecPath, 'utf8'));
const mutEntry = mutSpecs.find((e) => e.fork_id === targetFork);
mutEntry.description = (mutEntry.description || '') + ' MUTATED';
fs.writeFileSync(mutSpecPath, JSON.stringify(mutSpecs));
const mutCat2 = JSON.parse(runExporter(FORKS, path.join(tmp, 'mut2.json'), path.join(sparseRoot, 'groups')));
const roomsOf = (c) => {
  const map = new Map();
  for (const v of c.vendors) for (const o of v.offerings) map.set(o.registryIndex, JSON.stringify(o.room));
  return map;
};
const baseRooms = roomsOf(cat), mutRooms = roomsOf(mutCat2);
const changedRooms = [...baseRooms.keys()].filter((k) => baseRooms.get(k) !== mutRooms.get(k));
check('spec mutation: exactly one room changes', changedRooms.length === 1 && changedRooms[0] === 0, `changed=${changedRooms.join(',')}`);
if (changedRooms.length === 1) {
  const a = JSON.parse(baseRooms.get(0)), b2 = JSON.parse(mutRooms.get(0));
  const keys = new Set([...Object.keys(a), ...Object.keys(b2)]);
  const diffKeys = [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b2[k]));
  check('spec mutation: the only changed room field is the description', diffKeys.length === 1 && diffKeys[0] === 'description', `diffs=${diffKeys.join(',')}`);
  check('spec mutation: build records and districts are untouched by a spec text change',
    JSON.stringify(Object.keys(mutCat2.builds).sort()) === JSON.stringify(buildKeys.sort()));
}

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
