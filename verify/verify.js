#!/usr/bin/env node
/*
 * DeadRamp Base verification (Phase 1 exterior + Phase 2 interiors).
 * Serves the repo over HTTP, loads the page in headless Chrome
 * (SwiftShader WebGL), and measures what the page itself reports:
 * zero JS errors, rendered stats vs the catalog, non-empty frames by
 * pixel sampling, a movement smoke test, screenshots, then interior
 * round trips (room counts vs the catalog for three building sizes),
 * a string-level room-content match against the DeadRamp source, and
 * interior screenshots (lobby, spiral, one room per archetype).
 *
 * Usage: node verify/verify.js   (exit code 0 = all checks pass)
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('/home/hatch/workspace/.pptr/node_modules/puppeteer-core');

const REPO = path.resolve(__dirname, '..');
const EXE = '/home/hatch/workspace/.pptr/chrome-headless-shell/linux-157.0.8103.78/chrome-headless-shell-linux64/chrome-headless-shell';
const PORT = 8931;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.md': 'text/markdown', '.png': 'image/png' };

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS ${name}${detail ? ' (' + detail + ')' : ''}`);
  else { failures++; console.log(`FAIL ${name}${detail ? ' (' + detail + ')' : ''}`); }
}

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(REPO, url === '/' ? 'index.html' : url);
      if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(PORT, () => resolve(srv));
  });
}

(async () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'base-catalog.json'), 'utf8'));
  const srv = await serve();
  const browser = await puppeteer.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const results = {};
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const pageErrors = [], consoleErrors = [], badResponses = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('response', (r) => { if (r.status() >= 400) badResponses.push(r.status() + ' ' + r.url()); });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction('window.__BASE_READY__ === true', { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1200)); // let several frames render

    check('page loaded with zero JS page errors', pageErrors.length === 0, pageErrors.join(' | '));
    check('no failed local requests', badResponses.length === 0, badResponses.join(' | '));
    if (consoleErrors.length) console.log('console errors (informational):', consoleErrors.join(' | '));

    const stats = await page.evaluate('window.__BASE_STATS__()');
    results.stats = stats;
    console.log('page stats:', JSON.stringify(stats));
    check('vendors rendered equals catalog vendors', stats.vendorsRendered === catalog.meta.vendors, `${stats.vendorsRendered} vs ${catalog.meta.vendors}`);
    check('buildings instanced equals catalog buildings', stats.buildingsInstanced === catalog.vendors.filter((v) => v.kind === 'building').length, `${stats.buildingsInstanced}`);
    check('offerings indexed equals 781', stats.offeringsIndexed === 781, `${stats.offeringsIndexed}`);
    check('districts equals catalog districts', stats.districts === catalog.meta.districts, `${stats.districts}`);
    check('draw calls are low (under 60)', stats.drawCalls > 0 && stats.drawCalls < 60, `drawCalls=${stats.drawCalls}`);
    const researched = catalog.vendors.filter((v) => v.brand && v.brand.source === 'researched').length;
    check('brand palettes: page researched count matches catalog', stats.brandResearched === researched, `page=${stats.brandResearched} catalog=${researched}`);
    check('brand palettes: researched plus default equals all vendors', stats.brandResearched + stats.brandDefault === catalog.meta.vendors,
      `${stats.brandResearched}+${stats.brandDefault}`);

    const px = await page.evaluate('window.__BASE__.samplePixels()');
    results.spawnPixels = px;
    console.log('spawn pixels:', JSON.stringify(px));
    check('spawn frame is not blank (non-background fraction above 0.10)', px.nonBgFraction > 0.10, `nonBg=${px.nonBgFraction.toFixed(3)}`);
    check('spawn frame has colour variety (distinct colours above 12)', px.distinctColors > 12, `distinct=${px.distinctColors}`);

    await page.screenshot({ path: path.join(__dirname, 'spawn.png') });

    /* movement smoke test: hold the input until the camera has moved
     * 3 m or 5 s pass (headless frame rates vary; distance is the test) */
    const before = await page.evaluate('window.__BASE__.getCamera()');
    await page.evaluate('window.__BASE__.setMove({ forward: 1 })');
    let moved = 0, after = before;
    for (let i = 0; i < 10 && moved <= 3; i++) {
      await new Promise((r) => setTimeout(r, 500));
      after = await page.evaluate('window.__BASE__.getCamera()');
      moved = Math.hypot(after.x - before.x, after.z - before.z);
    }
    await page.evaluate('window.__BASE__.setMove({ forward: 0 })');
    results.movement = { before, after, moved };
    check('forward input moves the camera (over 3 m)', moved > 3, `moved=${moved.toFixed(2)} m`);

    /* district screenshot: stand at the analytics-l2 gate, look at its centre */
    const d = catalog.districts.find((x) => x.id === 'analytics-l2');
    // Pick the street viewpoint from the data: the road point (in a mid
    // range of the coil) with the most clearance from any building face,
    // looking further along the road. Deterministic for a given catalog.
    const dvendors = catalog.vendors.filter((v) => v.district === d.id && v.kind === 'building');
    let camIdx = 0, bestClear = -1;
    for (let i = 15; i < Math.min(220, d.road.length - 20); i++) {
      let clear = Infinity;
      for (const v of dvendors) {
        const dist = Math.hypot(v.position.x - d.road[i][0], v.position.z - d.road[i][1]) - Math.max(v.size.w, v.size.d) / 2;
        if (dist < clear) clear = dist;
      }
      if (clear > bestClear) { bestClear = clear; camIdx = i; }
    }
    const camPt = d.road[camIdx];
    const lookPt = d.road[Math.min(camIdx + 18, d.road.length - 1)];
    results.districtView = { camIdx, clearance: Math.round(bestClear * 10) / 10 };
    await page.evaluate(`window.__BASE__.setCamera({ x: ${camPt[0]}, z: ${camPt[1]} })`);
    await page.evaluate(`window.__BASE__.lookAt(${lookPt[0]}, ${lookPt[1]})`);
    await new Promise((r) => setTimeout(r, 700));
    const dpx = await page.evaluate('window.__BASE__.samplePixels()');
    results.districtPixels = dpx;
    check('district frame is not blank (non-background fraction above 0.10)', dpx.nonBgFraction > 0.10, `nonBg=${dpx.nonBgFraction.toFixed(3)}`);
    await page.screenshot({ path: path.join(__dirname, 'district.png') });

    /* overview screenshot: high above the plaza looking down the boulevard */
    await page.evaluate('window.__BASE__.setCamera({ x: -50, z: -80, y: 150, yawDeg: -90, pitchDeg: -40 })');
    await new Promise((r) => setTimeout(r, 700));
    const opx = await page.evaluate('window.__BASE__.samplePixels()');
    results.overviewPixels = opx;
    check('overview frame is not blank (non-background fraction above 0.10)', opx.nonBgFraction > 0.10, `nonBg=${opx.nonBgFraction.toFixed(3)}`);
    await page.screenshot({ path: path.join(__dirname, 'overview.png') });

    /* ================= Phase 2: interiors ================= */
    const DEADRAMP = path.join(process.env.HOME, 'workspace', 'deadramp');
    const phase2 = {};
    results.phase2 = phase2;
    /* Draw calls are frustum-dependent, so the regression baseline and
     * the after-reading use the same viewpoint, each after a settle
     * wait so renderer.info reflects a frame from that viewpoint. */
    async function statsAtSpawnView() {
      await page.evaluate('window.__BASE__.setCamera({ x: 30, z: 34 })');
      await page.evaluate('window.__BASE__.lookAt(0, 0)');
      await new Promise((r) => setTimeout(r, 1100));
      return page.evaluate('window.__BASE_STATS__()');
    }
    const extBefore = await statsAtSpawnView();
    phase2.exteriorDrawCallsBefore = extBefore.drawCalls;
    const largest = catalog.vendors.filter((v) => v.kind === 'building')
      .slice().sort((a, b) => b.offeringCount - a.offeringCount)[0];
    const mid = catalog.vendors.filter((v) => v.kind === 'building' && v.offeringCount >= 4 && v.offeringCount <= 7)
      .slice().sort((a, b) => a.offeringCount - b.offeringCount)[0];
    const single = catalog.vendors.find((v) => v.kind === 'building' && v.offeringCount === 1);
    phase2.buildings = {
      largest: { name: largest.name, offerings: largest.offeringCount },
      mid: { name: mid.name, offerings: mid.offeringCount },
      single: { name: single.name, offerings: 1 },
    };
    for (const v of [single, mid, largest]) {
      const ok = await page.evaluate(`window.__BASE__.enterBuilding(${JSON.stringify(v.name)})`);
      check(`enter building: ${v.name}`, ok === true);
      const ist = await page.evaluate('window.__BASE__.interiorState()');
      check(`${v.name}: rooms built equals catalog offerings`,
        !!ist && ist.roomsBuilt === v.offeringCount, `built=${ist && ist.roomsBuilt} catalog=${v.offeringCount}`);
      if (v === largest) {
        await new Promise((r) => setTimeout(r, 1100)); // settle: stats must reflect an interior frame
        const stIn = await page.evaluate('window.__BASE_STATS__()');
        phase2.largestInterior = { drawCalls: stIn.interior.drawCalls, triangles: stIn.interior.triangles, view: 'lobby after settle' };
        check('largest building interior draw calls measured and bounded (under 300)',
          stIn.interior.drawCalls > 0 && stIn.interior.drawCalls < 300, `drawCalls=${stIn.interior.drawCalls}`);
      }
      const exited = await page.evaluate('window.__BASE__.exitBuilding()');
      check(`exit building: ${v.name}`, exited === true);
      const istAfter = await page.evaluate('window.__BASE__.interiorState()');
      check(`${v.name}: interior fully disposed on exit`, istAfter === null);
    }
    const extAfter = await statsAtSpawnView();
    phase2.exteriorDrawCallsAfter = extAfter.drawCalls;
    check('exterior draw calls unchanged after interior round trips (same viewpoint)',
      extAfter.drawCalls === extBefore.drawCalls, `before=${extBefore.drawCalls} after=${extAfter.drawCalls}`);

    /* room content match against the DeadRamp source, string level */
    const rd = await page.evaluate(`window.__BASE__.roomData(${JSON.stringify(largest.name)})`);
    const sample = rd.find((r) => r.build) || rd[0];
    const specs = JSON.parse(fs.readFileSync(path.join(DEADRAMP, sample.room.specPath), 'utf8'));
    const specEntry = specs.find((e) => e.fork_id === sample.room.forkId);
    check('sampled room: description matches the source spec verbatim',
      !!specEntry && sample.room.description === specEntry.description, sample.product);
    check('sampled room: claimed functions match the source spec verbatim',
      !!specEntry && JSON.stringify(sample.room.functions.map((f) => f.name)) ===
        JSON.stringify((specEntry.functions_claimed || []).map((f) => f.function)));
    const build = sample.build;
    const mainText = fs.readFileSync(path.join(DEADRAMP, 'groups', build.groupDir, 'src', build.package, '__main__.py'), 'utf8');
    check('sampled room: every CLI command appears in the source __main__.py',
      build.cli.length > 0 && build.cli.every((c) => mainText.includes(`add_parser("${c.name}"`) || mainText.includes(`add_parser('${c.name}'`)),
      build.cli.map((c) => c.name).join(','));
    if (build.controls.length) {
      const ctrlText = fs.readFileSync(path.join(DEADRAMP, build.controlsSource), 'utf8');
      check('sampled room: every control id appears in the source control catalog',
        build.controls.every((c) => ctrlText.includes(`"${c.id}"`)), `${build.controls.length} controls`);
    }
    let hashOk = true;
    for (const mf of build.manifest.slice(0, 3)) {
      const buf = fs.readFileSync(path.join(DEADRAMP, mf.path));
      if (crypto.createHash('sha256').update(buf).digest('hex') !== mf.sha256) hashOk = false;
    }
    check('sampled room: build manifest hashes match the source files', hashOk);
    phase2.sampledRoom = { vendor: largest.name, product: sample.product, buildGroup: build.groupDir };

    /* interior screenshots: lobby, spiral, rooms across archetypes */
    /* Pixel evidence for interior shots is measured from the
     * screenshot bitmap itself, not from a live canvas readback:
     * with a non-preserved WebGL drawing buffer under SwiftShader, a
     * readback between frames intermittently returns the cleared
     * buffer (pure background) even when the scene renders correctly
     * (observed twice; the matching screenshots were correct). The
     * screenshot is the artifact of record, so measure it directly. */
    async function pixelsFromScreenshot(buf) {
      const b64 = buf.toString('base64');
      return page.evaluate(`(async () => {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,${b64}'; });
        const w = 96, h = 60;
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0, w, h);
        const data = x.getImageData(0, 0, w, h).data;
        const bg = [data[0], data[1], data[2]];
        let nonBg = 0; const colors = new Set();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 24) nonBg++;
          colors.add((r >> 4) + ',' + (g >> 4) + ',' + (b >> 4));
        }
        return { nonBgFraction: nonBg / (w * h), distinctColors: colors.size, bg };
      })()`);
    }
    async function shotAt(pos, look, floorY, file) {
      if (floorY !== undefined && floorY !== null) {
        await page.evaluate(`window.__BASE__.interiorTeleport(${JSON.stringify({ x: pos.x, z: pos.z, floorY })})`);
      }
      await page.evaluate(`window.__BASE__.setCamera({ x: ${pos.x}, z: ${pos.z}, y: ${pos.y} })`);
      await page.evaluate(`window.__BASE__.lookAtPoint(${look.x}, ${look.y}, ${look.z})`);
      await new Promise((r) => setTimeout(r, 800));
      const buf = await page.screenshot({ path: path.join(__dirname, file) });
      return pixelsFromScreenshot(buf);
    }
    await page.evaluate(`window.__BASE__.enterBuilding(${JSON.stringify(largest.name)})`);
    const pts = await page.evaluate('window.__BASE__.interiorPoints()');
    const lpx = await shotAt(pts.lobby.pos, pts.lobby.look, pts.lobby.floorY, 'interior-lobby.png');
    check('lobby frame is not blank', lpx.nonBgFraction > 0.10, `nonBg=${lpx.nonBgFraction.toFixed(3)}`);
    phase2.lobbyPixels = lpx;
    const spx = await shotAt(pts.spiral.pos, pts.spiral.look, pts.spiral.floorY, 'interior-spiral.png');
    check('spiral frame is not blank', spx.nonBgFraction > 0.10, `nonBg=${spx.nonBgFraction.toFixed(3)}`);
    phase2.spiralPixels = spx;
    phase2.largestRoomPixels = {};
    for (const r of pts.rooms) {
      const pxs = await shotAt(r.pos, r.look, r.floorY, `interior-room-largest-${r.archetype}.png`);
      phase2.largestRoomPixels[r.product] = { archetype: r.archetype, nonBg: pxs.nonBgFraction };
      check(`largest building room frame not blank: ${r.product} (${r.archetype})`,
        pxs.nonBgFraction > 0.10, `nonBg=${pxs.nonBgFraction.toFixed(3)}`);
      const stRoom = await page.evaluate('window.__BASE_STATS__()');
      if (stRoom.interior && stRoom.interior.drawCalls > phase2.largestInterior.drawCalls) {
        phase2.largestInterior.drawCalls = stRoom.interior.drawCalls;
        phase2.largestInterior.triangles = stRoom.interior.triangles;
        phase2.largestInterior.view = `room: ${r.product}`;
      }
    }
    await page.evaluate('window.__BASE__.exitBuilding()');

    const wanted = ['ops-center', 'server-hall', 'meeting-space', 'ledger-office', 'lab', 'federal-office'];
    const covered = new Set(Object.values(phase2.largestRoomPixels).map((x) => x.archetype));
    phase2.archetypeShots = {};
    for (const arch of wanted) {
      if (covered.has(arch)) { phase2.archetypeShots[arch] = 'largest building'; continue; }
      const host = catalog.vendors.find((v) => v.kind === 'building' && v.offerings.some((o) => o.room.archetype === arch));
      if (!host) continue;
      await page.evaluate(`window.__BASE__.enterBuilding(${JSON.stringify(host.name)})`);
      const p2 = await page.evaluate('window.__BASE__.interiorPoints()');
      const room = p2.rooms.find((r) => r.archetype === arch);
      const pxs = await shotAt(room.pos, room.look, room.floorY, `interior-room-${arch}.png`);
      phase2.archetypeShots[arch] = { vendor: host.name, nonBg: pxs.nonBgFraction };
      check(`room frame not blank: ${arch} (${host.name})`, pxs.nonBgFraction > 0.10, `nonBg=${pxs.nonBgFraction.toFixed(3)}`);
      await page.evaluate('window.__BASE__.exitBuilding()');
      covered.add(arch);
    }
    phase2.archetypesCovered = [...covered];
    check('at least three archetypes screenshotted', covered.size >= 3, [...covered].join(', '));
    check('zero JS page errors across the whole run (including interiors)', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await browser.close();
    srv.close();
  }
  results.failures = failures;
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(results, null, 1) + '\n');
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('verify crashed:', e); process.exit(2); });
