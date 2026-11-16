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

/* ================= Phase 4: merges, platform, construction =================
 * Three records join the catalog, each derived from a DeadRamp source
 * outside forks.json: union lineage (groups/<g>/UNION-SPEC.md), the
 * platform layer (PLATFORM-LAYER.md decisions + GAPS.md re-scoped
 * entries), and per-vendor construction state (offering statuses).
 * Each is re-derived here independently, then pinned by controls. */
const districtIds = new Set(cat.districts.map((d) => d.id));

console.log('\n[phase 4: union merges]');
/* Independent derivation: a build has a parent build iff its spec
 * sheet says, in so many words, that it does not start from zero
 * (exactly 18 spec sheets say that, and no other spec sheet does);
 * the parents are the group links in the bold-build parenthetical of
 * its Lineage section. */
const unionExpected = new Map();
for (const g of fs.readdirSync(path.join(DEADRAMP_ROOT, 'groups')).sort()) {
  const p = path.join(DEADRAMP_ROOT, 'groups', g, 'UNION-SPEC.md');
  if (!fs.existsSync(p)) continue;
  const text = fs.readFileSync(p, 'utf8');
  if (!text.includes('does not start from zero')) continue;
  const seg = text.slice(text.indexOf('## Lineage')).replace(/\s+/g, ' ');
  const pm = seg.match(/\*\*[^*]*build\*\*\s*\(([^)]*)\)/);
  unionExpected.set(g, pm ? [...pm[1].matchAll(/\.\.\/([a-z0-9-]+)\//g)].map((m) => m[1]) : []);
}
check('exactly 18 builds declare they do not start from zero', unionExpected.size === 18,
  `found ${unionExpected.size}`);
check('every declared build parsed at least one parent',
  [...unionExpected.values()].every((ps) => ps.length >= 1),
  'a spec declaring a merge must never parse to zero parents');
const catEdges = cat.merges.map((m) => `${m.child}<-${m.parent}`).sort();
const expEdges = [];
for (const [child, parents] of unionExpected) for (const p of parents) expEdges.push(`${child}<-${p}`);
expEdges.sort();
check('catalog merge edges equal the lineage records exactly (19 edges)',
  JSON.stringify(catEdges) === JSON.stringify(expEdges),
  `catalog ${catEdges.length} vs records ${expEdges.length}`);
const parentsOf = (child) => cat.merges.filter((m) => m.child === child).map((m) => m.parent).sort();
check('pin: ai-l3 merges ai-l2 only', JSON.stringify(parentsOf('ai-l3')) === '["ai-l2"]');
check('pin: customer-service-l3 merges both lower tiers of its category',
  JSON.stringify(parentsOf('customer-service-l3')) === '["customer-service-l1","customer-service-l2"]',
  JSON.stringify(parentsOf('customer-service-l3')));
check('pin: health-wellness-l1 carries from l2 only (a prose mention of l3 is not a parent)',
  JSON.stringify(parentsOf('health-wellness-l1')) === '["health-wellness-l2"]',
  JSON.stringify(parentsOf('health-wellness-l1')));
check('pin: merge kinds from the lineage headings',
  cat.merges.find((m) => m.child === 'crm-l1').kind === 'carry-down'
  && cat.merges.find((m) => m.child === 'fleet-management-l2').kind === 'carry-up'
  && cat.merges.find((m) => m.child === 'ai-l3').kind === 'merge');
check('every merge endpoint is a real build record',
  cat.merges.every((m) => cat.builds[m.child] && cat.builds[m.parent]));
check('merge fork counts are the builds\u2019 own spec counts',
  cat.merges.every((m) => m.childForks === cat.builds[m.child].specCount && m.parentForks === cat.builds[m.parent].specCount));
/* Anchors re-derived from the rooms: plurality district per build. */
const anchorOf = (g) => {
  const counts = new Map();
  for (const v of cat.vendors) for (const o of v.offerings) {
    if (o.room.buildGroup !== g) continue;
    counts.set(o.district, (counts.get(o.district) || 0) + 1);
  }
  let best = null;
  for (const [d, c] of counts) if (!best || c > best.c || (c === best.c && d < best.d)) best = { d, c };
  return best ? best.d : null;
};
check('merge anchors are the builds\u2019 plurality districts, recomputed from the rooms',
  cat.merges.every((m) => m.childDistrict === anchorOf(m.child) && m.parentDistrict === anchorOf(m.parent)));
check('every bridge joins two different districts',
  cat.merges.every((m) => m.childDistrict !== m.parentDistrict
    && districtIds.has(m.childDistrict) && districtIds.has(m.parentDistrict)));
check('build records carry their union (or null) and the spec path',
  cat.builds['ai-l3'].union && cat.builds['ai-l3'].union.spec === 'groups/ai-l3/UNION-SPEC.md'
  && cat.builds['ai-l2'].union === null);

console.log('\n[phase 4: platform layer]');
const plText = fs.readFileSync(path.join(DEADRAMP_ROOT, 'PLATFORM-LAYER.md'), 'utf8');
const gapsText = fs.readFileSync(path.join(DEADRAMP_ROOT, 'GAPS.md'), 'utf8');
const expTitles = [...plText.matchAll(/^\d+\.\s+\*\*(.+?)\*\*/gm)]
  .map((m) => m[1].replace(/\.\s*$/, '').replace(/\s*\((.*)\)\s*$/, '').trim());
check('platform decisions: exactly the six of PLATFORM-LAYER.md',
  cat.platformLayer.decisions.length === 6
  && JSON.stringify(cat.platformLayer.decisions.map((d) => d.title)) === JSON.stringify(expTitles),
  JSON.stringify(cat.platformLayer.decisions.map((d) => d.title)));
check('decision control citations carried where the decision names them',
  cat.platformLayer.decisions[0].controls === 'IA-2, IA-2(1)/(2), IA-5'
  && cat.platformLayer.decisions[1].controls === 'SC-13'
  && cat.platformLayer.decisions[5].controls === null);
check('decision bodies are the decision text itself (non-empty, bounded)',
  cat.platformLayer.decisions.every((d) => d.text.length > 100 && d.text.length <= 701));
const expRescopedCount = (gapsText.match(/^- \[x\] re-scoped — /gm) || []).length;
check('re-scoped entries: catalog equals the GAPS.md record',
  cat.platformLayer.rescoped.length === expRescopedCount && expRescopedCount === 40,
  `catalog ${cat.platformLayer.rescoped.length} vs GAPS.md ${expRescopedCount}`);
check('every re-scoped entry text is verbatim in GAPS.md',
  cat.platformLayer.rescoped.every((e) => gapsText.includes(e.text)));
const sectionCounts = {};
for (const e of cat.platformLayer.rescoped) sectionCounts[e.group] = (sectionCounts[e.group] || 0) + 1;
check('re-scoped entries by owning GAPS section (2:1, 3:5, 4:1, 8:1, 36:32)',
  JSON.stringify(sectionCounts) === JSON.stringify({ 2: 1, 3: 5, 4: 1, 8: 1, 36: 32 }),
  JSON.stringify(sectionCounts));
check('every re-scoped entry resolves to a real district and build',
  cat.platformLayer.rescoped.every((e) => e.district && districtIds.has(e.district) && cat.builds[e.buildGroup]));
check('the platform deck anchor is a fixed plaza constant facing spawn',
  cat.platformLayer.deckAnchor.x === -48 && cat.platformLayer.deckAnchor.z === 26
  && Math.abs(cat.platformLayer.deckAnchor.rotationY - 1.917) < 0.01);

console.log('\n[phase 4: construction states]');
let fracOk = true;
for (const v of cat.vendors) {
  const pend = v.offerings.filter((o) => o.authorization_status !== 'FedRAMP Certified').length;
  if (Math.abs(pend / v.offerings.length - v.construction.frac) > 0.0011) fracOk = false;
}
check('construction frac equals each vendor\u2019s pending-offering share, recomputed', fracOk);
check('certified vendors are finished (frac 0); pipeline vendors fully pending (frac 1); mixed in between',
  cat.vendors.every((v) => (v.statusClass === 'certified' && v.construction.frac === 0)
    || (v.statusClass === 'pipeline' && v.construction.frac === 1)
    || (v.statusClass === 'mixed' && v.construction.frac > 0 && v.construction.frac < 1)));
/* Crane rule re-derived: per district, >= 3 fully-pipeline buildings;
 * the tallest (registry order breaks ties) carries the crane. */
const craneExpected = new Set();
{
  const byD = new Map();
  for (const v of cat.vendors) {
    if (v.kind !== 'building' || v.statusClass !== 'pipeline') continue;
    if (!byD.has(v.district)) byD.set(v.district, []);
    byD.get(v.district).push(v);
  }
  const sizeOf = (n) => Math.min(60, 9 + 6 * (n - 1) + (n >= 5 ? 6 : 0));
  for (const list of byD.values()) {
    if (list.length < 3) continue;
    const t = list.slice().sort((a, b) => sizeOf(b.offeringCount) - sizeOf(a.offeringCount)
      || Math.min(...a.offerings.map((o) => o.registryIndex)) - Math.min(...b.offerings.map((o) => o.registryIndex)))[0];
    craneExpected.add(t.name);
  }
}
const craneActual = new Set(cat.vendors.filter((v) => v.construction.crane).map((v) => v.name));
check('cranes equal the district rule, re-derived (17 expected)',
  JSON.stringify([...craneActual].sort()) === JSON.stringify([...craneExpected].sort()) && craneActual.size === 17,
  `catalog ${craneActual.size} vs rule ${craneExpected.size}`);
check('the surveyed lot carries no crane',
  cat.vendors.filter((v) => v.kind === 'lot').every((v) => !v.construction.crane));

/* Gate signs: every vendor with pending offerings carries a sign
 * record (certified count and offering total) for its per-building
 * gate sign. Re-derived here from forks.json itself, grouped by
 * vendor, so the sign data is pinned to the registry and not to the
 * exporter's own arithmetic. */
console.log('\n[phase 4: gate sign records]');
{
  const forksByVendor = new Map();
  for (const f of forks) {
    if (!forksByVendor.has(f.vendor)) forksByVendor.set(f.vendor, { cert: 0, total: 0 });
    const rec = forksByVendor.get(f.vendor);
    rec.total++;
    if (f.authorization_status === 'FedRAMP Certified') rec.cert++;
  }
  const signed = cat.vendors.filter((v) => v.construction.sign);
  check('gate sign: exactly the 228 vendors with pending offerings carry a sign record',
    signed.length === 228
    && signed.length === cat.vendors.filter((v) => v.construction.frac > 0).length
    && cat.vendors.every((v) => (v.construction.frac > 0) === !!v.construction.sign),
    `signed=${signed.length}`);
  let signOk = true, agreeOk = true;
  for (const v of cat.vendors) {
    const exp = forksByVendor.get(v.name);
    if (!exp) { signOk = false; continue; }
    if (v.construction.sign
      && (v.construction.sign.cert !== exp.cert || v.construction.sign.total !== exp.total)) signOk = false;
    if (v.construction.sign
      && Math.abs(exp.cert / exp.total - (1 - v.construction.frac)) > 0.0011) agreeOk = false;
  }
  check('gate sign: cert/total equal the forks.json recomputation for every vendor', signOk);
  check('gate sign: certified share agrees with construction frac (1 - frac) within rounding', agreeOk);
  const cisco = cat.vendors.find((v) => v.name === 'Cisco Systems Inc.');
  check('gate sign pin: the mixed Cisco building reads 5 of 6',
    !!cisco && !!cisco.construction.sign && cisco.construction.sign.cert === 5 && cisco.construction.sign.total === 6,
    cisco && cisco.construction.sign ? `${cisco.construction.sign.cert}/${cisco.construction.sign.total}` : 'no sign');
  const lot = cat.vendors.find((v) => v.kind === 'lot');
  check('gate sign pin: the surveyed lot (TERIDA) carries a sign record reading 0 of 1',
    !!lot && !!lot.construction.sign && lot.construction.sign.cert === 0 && lot.construction.sign.total === 1);
}

/* Negative control (data removal): the sparse tree has spec sheets
 * only — no UNION-SPEC.md in it, and its root has no GAPS.md or
 * PLATFORM-LAYER.md — so its catalog must carry zero merges and zero
 * platform entries. mutCat2 above is exactly that export. */
console.log('\n[phase 4 controls: source records removed]');
check('control: with the union/platform sources absent, merges are zero',
  Array.isArray(mutCat2.merges) && mutCat2.merges.length === 0,
  `sparse catalog merges: ${mutCat2.merges && mutCat2.merges.length}`);
check('control: with the sources absent, platform decisions and entries are zero',
  mutCat2.platformLayer.decisions.length === 0 && mutCat2.platformLayer.rescoped.length === 0);
check('control: with the sources absent, every build union is null',
  Object.values(mutCat2.builds).every((b) => b.union === null));

/* Negative control (status flip): one certified vendor's only
 * offering flips to In Process in a registry copy. Its construction
 * frac must go 0 -> 1; merges, platform layer and districts must not
 * move; and no other vendor's construction may change. The target is
 * chosen so the crane rule cannot shift: a district that already has
 * a pipeline building taller than any single-offering tower. */
console.log('\n[phase 4 controls: authorization status flip]');
{
  const sizeOf = (n) => Math.min(60, 9 + 6 * (n - 1) + (n >= 5 ? 6 : 0));
  const byDistrict = new Map();
  for (const v of cat.vendors) {
    if (!byDistrict.has(v.district)) byDistrict.set(v.district, []);
    byDistrict.get(v.district).push(v);
  }
  let target = null;
  for (const list of byDistrict.values()) {
    const tallestPipe = Math.max(0, ...list.filter((v) => v.statusClass === 'pipeline').map((v) => sizeOf(v.offeringCount)));
    if (tallestPipe <= 9) continue;
    target = list.find((v) => v.statusClass === 'certified' && v.offeringCount === 1) || null;
    if (target) break;
  }
  check('flip control found a certified single-offering target under a taller pipeline building', !!target,
    target ? target.name : 'none');
  if (target) {
    const forksFlip = JSON.parse(fs.readFileSync(FORKS, 'utf8'));
    const hit = forksFlip.find((f) => f.vendor === target.name);
    hit.authorization_status = 'FedRAMP In Process';
    const flipPath = path.join(tmp, 'forks-flip.json');
    const flipOut = path.join(tmp, 'flip-catalog.json');
    fs.writeFileSync(flipPath, JSON.stringify(forksFlip));
    runExporter(flipPath, flipOut);
    const flipCat = JSON.parse(fs.readFileSync(flipOut, 'utf8'));
    const flipVendor = flipCat.vendors.find((v) => v.name === target.name);
    check('flip: the flipped vendor\u2019s construction goes 0 -> 1',
      target.construction.frac === 0 && flipVendor.construction.frac === 1,
      `${target.name}: ${target.construction.frac} -> ${flipVendor.construction.frac}`);
    check('flip: the flipped vendor gains a gate sign reading 0 of 1',
      !target.construction.sign
      && !!flipVendor.construction.sign
      && flipVendor.construction.sign.cert === 0 && flipVendor.construction.sign.total === 1,
      JSON.stringify(flipVendor.construction.sign));
    const signChanged = flipCat.vendors.filter((v, i) =>
      JSON.stringify(v.construction.sign || null) !== JSON.stringify(cat.vendors[i].construction.sign || null)).map((v) => v.name);
    check('flip: no other vendor\u2019s gate sign record changes',
      JSON.stringify(signChanged) === JSON.stringify([target.name]), JSON.stringify(signChanged));
    const changed = flipCat.vendors.filter((v, i) =>
      JSON.stringify(v.construction) !== JSON.stringify(cat.vendors[i].construction)).map((v) => v.name);
    check('flip: no other vendor\u2019s construction record changes (cranes included)',
      JSON.stringify(changed) === JSON.stringify([target.name]), JSON.stringify(changed));
    check('flip: merges and platform layer are untouched by a status change',
      JSON.stringify(flipCat.merges) === JSON.stringify(cat.merges)
      && JSON.stringify(flipCat.platformLayer) === JSON.stringify(cat.platformLayer));
    check('flip: districts are untouched by a status change',
      JSON.stringify(flipCat.districts) === JSON.stringify(cat.districts));
  }
}

/* ---- experience pass: launch data fidelity ----
 * The launch record on every build is re-derived here from the
 * probe evidence files and the DeadRamp source tree, independently
 * of the exporter: the mode rule from the two probe verdicts, the
 * demo users from the source text of two sampled builds (one plain
 * registry, one identity-object registry), the bundle manifest
 * against both the staged bundle bytes and the source bytes, and
 * the recorded surface against its named source files. A mutation
 * control then alters one asserted response inside a copied test
 * suite and shows the harvest, and only that harvest, change. */
{
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  const cpProbe = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'probe-cpython.json'), 'utf8'));
  const webProbe = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'live-probe-results.json'), 'utf8'));
  const groups = Object.keys(cat.builds).sort();
  check('launch: every build carries a launch record',
    groups.every((g) => cat.builds[g].launch && ['live', 'recorded'].includes(cat.builds[g].launch.mode)),
    `${groups.length} builds`);
  check('launch: meta counts match the build records',
    cat.meta.launchLive === groups.filter((g) => cat.builds[g].launch.mode === 'live').length
    && cat.meta.launchRecorded === groups.filter((g) => cat.builds[g].launch.mode === 'recorded').length,
    `live=${cat.meta.launchLive} recorded=${cat.meta.launchRecorded}`);
  const modeMismatches = groups.filter((g) => {
    const expected = (cpProbe[g] && cpProbe[g].ok && webProbe[g] && webProbe[g].ok) ? 'live' : 'recorded';
    return cat.builds[g].launch.mode !== expected;
  });
  check('launch: every mode equals the probe-evidence rule (CPython drive and browser drive both green)',
    modeMismatches.length === 0, modeMismatches.join(', ') || 'all 101 agree');
  const basisBad = groups.filter((g) => {
    const b = cat.builds[g].launch;
    return b.mode === 'live' ? !/Pyodide/.test(b.basis) || !/CPython/.test(b.basis) : !/recorded surface/.test(b.basis);
  });
  check('launch: every basis names its evidence (live) or its fallback (recorded)', basisBad.length === 0, basisBad.join(', '));

  // Demo users re-derived from source text for two sampled builds.
  const usersFromService = (g) => {
    const dir = path.join(GROUPS, g, 'src');
    const pkg = fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory())[0];
    const main = fs.readFileSync(path.join(dir, pkg, '__main__.py'), 'utf8');
    const m = main.match(/DEMO_USERS = \{([^}]*)\}/);
    if (!m) return null;
    const out = {};
    for (const pm of m[1].matchAll(/"(\w+)":\s*"(\w+)"/g)) out[pm[1]] = pm[2];
    return out;
  };
  const usersFromObjects = (g) => {
    const dir = path.join(GROUPS, g, 'src');
    const pkg = fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory())[0];
    const main = fs.readFileSync(path.join(dir, pkg, '__main__.py'), 'utf8');
    const m = main.match(/DEMO_USERS = \{([^}]*)\}/);
    if (!m) return null;
    const out = {};
    for (const pm of m[1].matchAll(/"(\w+)":\s*\w+\("\1",\s*"(\w+)"\)/g)) out[pm[1]] = pm[2];
    return out;
  };
  for (const [g, derive] of [['ai-l2', usersFromService], ['manufacturing-untiered', usersFromObjects]]) {
    const expected = derive(g);
    check(`launch: demo users for ${g} match the source registry`,
      expected && JSON.stringify(cat.builds[g].launch.users) === JSON.stringify(expected),
      JSON.stringify(cat.builds[g].launch.users));
  }
  check('launch: every build resolved a non-empty demo registry',
    groups.every((g) => Object.keys(cat.builds[g].launch.users).length > 0));

  // Bundle provenance: manifest hash == staged bytes == source bytes.
  let bundleBad = [];
  let bundleFiles = 0;
  for (const g of groups) {
    const b = cat.builds[g];
    if (b.launch.mode !== 'live') continue;
    if (!b.launch.bundle || !b.launch.bundle.files.length) { bundleBad.push(g + ':no-bundle'); continue; }
    for (const f of b.launch.bundle.files) {
      bundleFiles++;
      const staged = path.join(tmp, 'launch', 'bundles', g, f.path);
      const rel = f.path.slice(b.launch.bundle.package.length + 1);
      const source = path.join(GROUPS, g, 'src', b.package, rel);
      if (!fs.existsSync(staged) || !fs.existsSync(source)) { bundleBad.push(`${g}:${rel}:missing`); continue; }
      const sb = fs.readFileSync(staged), ob = fs.readFileSync(source);
      if (sha(sb) !== f.sha256 || sha(ob) !== f.sha256 || sb.length !== f.bytes) bundleBad.push(`${g}:${rel}:hash`);
    }
  }
  check('launch: every bundle file hashes to its manifest entry and to the DeadRamp source file',
    bundleBad.length === 0, `${bundleFiles} files${bundleBad.length ? ' bad: ' + bundleBad.slice(0, 4).join(', ') : ''}`);

  // Recorded surface provenance: counts, and every exchange traces
  // to a source file that names it.
  let recBad = [];
  let recTotal = 0;
  for (const g of groups) {
    const b = cat.builds[g];
    const recPath = path.join(tmp, 'launch', 'recorded', `${g}.json`);
    if (!fs.existsSync(recPath)) { recBad.push(g + ':no-file'); continue; }
    const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
    recTotal += rec.exchanges.length;
    if (rec.exchanges.length !== b.launch.recorded.exchanges) recBad.push(g + ':count');
    for (const ex of rec.exchanges) {
      const srcFile = path.join(GROUPS, '..', ex.source.file);
      if (!fs.existsSync(srcFile)) { recBad.push(`${g}:missing-source`); break; }
      if (ex.source.kind === 'test') {
        const text = fs.readFileSync(srcFile, 'utf8');
        const testName = ex.source.test.split('.').pop();
        if (!text.includes(testName) || !text.includes(ex.path)) { recBad.push(`${g}:untraced:${ex.path}`); break; }
      }
    }
  }
  check('launch: every recorded exchange traces to a DeadRamp source file that names it',
    recBad.length === 0, `${recTotal} exchanges${recBad.length ? ' bad: ' + recBad.slice(0, 4).join(', ') : ''}`);
  // Drive-first order: no test-recorded exchange may precede a
  // drive exchange in any recorded surface, so the terminal's
  // first exchanges (and its command chips) lead with full real
  // responses from driving the build.
  const orderBad = [];
  for (const g of groups) {
    const rec = JSON.parse(fs.readFileSync(path.join(tmp, 'launch', 'recorded', `${g}.json`), 'utf8'));
    let seenTest = false;
    for (const ex of rec.exchanges) {
      if (ex.source.kind === 'test') seenTest = true;
      else if (ex.source.kind === 'drive' && seenTest) { orderBad.push(g); break; }
    }
  }
  check('launch: every recorded surface is ordered drive-first, then test exchanges',
    orderBad.length === 0, orderBad.length ? 'bad: ' + orderBad.slice(0, 4).join(', ') : `${groups.length} surfaces`);
  const aiRec = JSON.parse(fs.readFileSync(path.join(tmp, 'launch', 'recorded', 'ai-l2.json'), 'utf8'));
  check('launch: ai-l2 recorded surface contains its real health response',
    aiRec.exchanges.some((e) => e.method === 'GET' && e.path === '/health'
      && ((e.response.text || '').includes('"status": "ok"') || (e.response.text || '').includes('"status":"ok"'))));

  // Mutation control: change one asserted body in a copied ai-l2
  // test suite; the harvest of the copy must change, and only there.
  const mutRoot = path.join(tmp, 'mutroot');
  fs.mkdirSync(path.join(mutRoot, 'groups'), { recursive: true });
  fs.cpSync(path.join(GROUPS, 'ai-l2'), path.join(mutRoot, 'groups', 'ai-l2'), { recursive: true });
  const mutTest = path.join(mutRoot, 'groups', 'ai-l2', 'tests', 'test_service.py');
  const origText = fs.readFileSync(mutTest, 'utf8');
  const mutText = origText.replace('self.assertEqual(parsed, {"status": "ok"})',
    'self.assertEqual(parsed, {"status": "mutated-ok"})');
  check('launch mutation: the ai-l2 health assertion exists to mutate', mutText !== origText);
  fs.writeFileSync(mutTest, mutText);
  const mutHarvestPath = path.join(tmp, 'mut-harvest.json');
  execFileSync('python3', [path.join(REPO, 'tools', 'launchprobe.py'), 'harvest',
    '--root', mutRoot, '--out', mutHarvestPath], { stdio: 'pipe' });
  const mutHarvest = JSON.parse(fs.readFileSync(mutHarvestPath, 'utf8'));
  const baseHarvest = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'launch-harvest.json'), 'utf8'));
  const mutHas = (mutHarvest['ai-l2'].recorded || []).some((e) => (e.response.text || '').includes('mutated-ok'));
  const baseHas = (baseHarvest['ai-l2'].recorded || []).some((e) => (e.response.text || '').includes('mutated-ok'));
  check('launch mutation: altering a source fixture changes the harvested surface',
    mutHas && !baseHas,
    `mutated harvest carries the change=${mutHas}, committed harvest untouched=${!baseHas}`);
  check('launch mutation: the mutated harvest keeps the same exchange count',
    mutHarvest['ai-l2'].recorded.length === baseHarvest['ai-l2'].recorded.length,
    `${baseHarvest['ai-l2'].recorded.length} -> ${mutHarvest['ai-l2'].recorded.length}`);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
