#!/usr/bin/env node
/*
 * DeadRamp Base, Phase 1 verification.
 * Serves the repo over HTTP, loads the page in headless Chrome
 * (SwiftShader WebGL), and measures what the page itself reports:
 * zero JS errors, rendered stats vs the catalog, non-empty frames by
 * pixel sampling, a movement smoke test, and screenshots.
 *
 * Usage: node verify/verify.js   (exit code 0 = all checks pass)
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
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

    /* movement smoke test */
    const before = await page.evaluate('window.__BASE__.getCamera()');
    await page.evaluate('window.__BASE__.setMove({ forward: 1 })');
    await new Promise((r) => setTimeout(r, 1200));
    await page.evaluate('window.__BASE__.setMove({ forward: 0 })');
    const after = await page.evaluate('window.__BASE__.getCamera()');
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    results.movement = { before, after, moved };
    check('forward input moves the camera (over 3 m in 1.2 s)', moved > 3, `moved=${moved.toFixed(2)} m`);

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
  } finally {
    await browser.close();
    srv.close();
  }
  results.failures = failures;
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(results, null, 1) + '\n');
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('verify crashed:', e); process.exit(2); });
