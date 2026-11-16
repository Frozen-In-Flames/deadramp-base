#!/usr/bin/env node
/*
 * DeadRamp Base verification, experience pass: the room terminals.
 * Serves the repo over HTTP (plus the local Pyodide copy, since the
 * sandbox proxy blocks the CDN the production page uses), loads the
 * page in headless Chrome, and proves the launch paths end to end:
 *
 *   LIVE: enter a building whose build the probes verified (ai-l2),
 *   stand in its room, open the terminal, and run real commands the
 *   build itself answers: its health response, a create whose
 *   effect a later request can see (session state is real), and
 *   honest handling of a nonsense command. Labels are checked
 *   against the catalog at every surface: door signage, console
 *   header, catalog mode.
 *   RECORDED: reload with the Python runtime pointed at a dead
 *   address, so the live launch cannot complete; the terminal must
 *   fall back to the recorded surface, say so in its header, replay
 *   a recorded exchange with its source named, and answer a
 *   fabricated request honestly as unrecorded.
 *   BUDGET: no bundle or runtime bytes move before the first launch
 *   (boot weight), and draw calls stay at the shipped counts.
 *
 * Usage: node verify/verify-launch.js   (exit code 0 = all pass)
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('/home/hatch/workspace/.pptr/node_modules/puppeteer-core');

const REPO = path.resolve(__dirname, '..');
const PYODIDE_DIR = '/home/hatch/workspace/fif-ears/verify-web/pyodide-local';
const EXE = '/home/hatch/workspace/.pptr/chrome-headless-shell/linux-157.0.8103.78/chrome-headless-shell-linux64/chrome-headless-shell';
const PORT = 8949;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.py': 'text/plain', '.wasm': 'application/wasm', '.zip': 'application/zip', '.md': 'text/markdown' };

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS ${name}${detail ? ' (' + detail + ')' : ''}`);
  else { failures++; console.log(`FAIL ${name}${detail ? ' (' + detail + ')' : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      let file;
      if (url.startsWith('/pyodide/')) file = path.join(PYODIDE_DIR, url.slice(9));
      else file = path.join(REPO, url === '/' ? 'index.html' : url);
      if (!file.startsWith('/') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
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
  const aiBuild = catalog.builds['ai-l2'];
  check('catalogue: ai-l2 is catalogued live', aiBuild.launch.mode === 'live');
  const vendor = catalog.vendors.find((v) => v.offerings.some((o) => o.room.buildGroup === 'ai-l2'));
  const roomIdx = vendor.offerings.findIndex((o) => o.room.buildGroup === 'ai-l2');
  const product = vendor.offerings[roomIdx].product;
  console.log(`sampling LIVE room: ${vendor.name} / ${product} (ai-l2)`);

  const srv = await serve();
  const browser = await puppeteer.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const results = {};
  try {
    /* ---------- LIVE session ---------- */
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.evaluateOnNewDocument((base) => { window.__BASE_PYODIDE_BASE__ = base; },
      `http://127.0.0.1:${PORT}/pyodide/`);
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction('window.__BASE_READY__ === true', { timeout: 120000 });
    await sleep(600);

    const boot = await page.evaluate(() => {
      const names = performance.getEntriesByType('resource').map((e) => e.name);
      return {
        stats: window.__BASE__.stats(),
        launchFetches: names.filter((n) => n.includes('launch/bundles') || n.includes('pyodide')).length,
        catalogFetched: names.some((n) => n.includes('base-catalog.json')),
      };
    });
    results.boot = boot;
    check('boot: catalog fetched, and no bundle or runtime bytes moved before the first launch',
      boot.catalogFetched && boot.launchFetches === 0, `launchFetches=${boot.launchFetches}`);
    check('boot: exterior draw calls unchanged from the shipped build (21 in this harness, HEAD identical)',
      boot.stats.exteriorDrawCalls === 21, `drawCalls=${boot.stats.exteriorDrawCalls}`);

    await page.evaluate(`window.__BASE__.enterBuilding(${JSON.stringify(vendor.name)})`);
    await sleep(500);
    const signs = await page.evaluate('window.__BASE__.interiorSigns()');
    check('labels: every door sign in the building states the catalogued mode',
      !!signs && signs.every((s) => s.catalogMode === null
        ? s.signMode === 'NO REFERENCE BUILD'
        : s.signMode === (s.catalogMode === 'live' ? 'RUNS LIVE IN YOUR BROWSER' : 'RECORDED SURFACE')),
      signs ? `${signs.length} signs` : 'no signs hook');

    const pts = await page.evaluate('window.__BASE__.interiorPoints()');
    const rp = pts.rooms[roomIdx];
    await page.evaluate(`window.__BASE__.interiorTeleport(${JSON.stringify({ x: rp.pos.x, z: rp.pos.z, floorY: rp.floorY })})`);
    await page.evaluate(`window.__BASE__.setCamera({ x: ${rp.pos.x}, z: ${rp.pos.z}, y: ${rp.pos.y} })`);
    await page.evaluate(`window.__BASE__.lookAtPoint(${rp.look.x}, ${rp.look.y}, ${rp.look.z})`);
    await sleep(700);
    const inState = await page.evaluate('window.__BASE__.interiorState()');
    check('live: standing in the sampled room', inState && inState.currentRoom === roomIdx,
      `currentRoom=${inState && inState.currentRoom} want=${roomIdx}`);

    const opened = await page.evaluate('window.__BASE__.useTerminal()');
    check('live: the terminal opens from the room', opened === true);
    await sleep(300);
    let t = await page.evaluate('window.__BASE__.terminal()');
    results.liveHeader = t;
    check('live: session mode is live and matches the catalog',
      t.open && t.sessionMode === 'live' && t.catalogMode === 'live' && t.fallback === false,
      `session=${t.sessionMode} catalog=${t.catalogMode}`);
    check('live: console header states the mode in plain words',
      /LIVE/.test(t.headerMode) && /RUNS LIVE IN YOUR BROWSER/.test(t.headerMode), t.headerMode);
    check('live: door sign of the sampled room matches the session label',
      t.signMode === 'RUNS LIVE IN YOUR BROWSER', t.signMode);
    check('live: Pyodide runtime loaded lazily for the launch', t.pyodideLoaded === true);
    check('live: acting as a demo user from the build\u2019s own source',
      !!t.user && t.transcript.some((l) => l.includes(`You are ${t.user}`)), `user=${t.user}`);

    let lines = await page.evaluate(`window.__BASE__.termRun('GET /health')`);
    check('live: GET /health is answered by the build itself (200, its own body)',
      lines.some((l) => l.startsWith('← 200')) && lines.some((l) => l.includes('"status": "ok"')),
      lines.slice(-3).join(' | ').slice(0, 160));
    lines = await page.evaluate(`window.__BASE__.termRun('as bob POST /templates {"name": "verify-wrap", "text": "Please: {prompt}"}')`);
    const postIdx = lines.map((l, i) => [l, i]).filter(([l]) => l.startsWith('> POST /templates')).pop();
    const afterPost = postIdx ? lines.slice(postIdx[1] + 1) : [];
    const created = afterPost.some((l) => l.startsWith('← 200') || l.startsWith('← 201'));
    lines = await page.evaluate(`window.__BASE__.termRun('as bob GET /templates')`);
    /* only the lines after the GET's own echo count: the POST's
     * echo contains the probe name too, and a state proof that the
     * echo alone can satisfy would prove nothing */
    const getIdx = lines.map((l, i) => [l, i]).filter(([l]) => l.startsWith('> GET /templates')).pop();
    const afterGet = getIdx ? lines.slice(getIdx[1] + 1) : [];
    check('live: session state is real (a create is visible to a later request)',
      created && afterGet.some((l) => l.includes('"verify-wrap"')),
      afterGet.slice(0, 3).join(' | ').slice(0, 160));
    lines = await page.evaluate(`window.__BASE__.termRun('GET /models')`);
    check('live: unauthenticated-by-default identity rules are the build\u2019s own (admin session reads its registry)',
      lines.some((l) => l.startsWith('← 200')), lines.slice(-2).join(' | ').slice(0, 120));
    lines = await page.evaluate(`window.__BASE__.termRun('frobnicate the lot')`);
    check('live: a nonsense command is answered honestly, not with invented output',
      lines.some((l) => l.includes('not a command this terminal knows')), lines.slice(-1).join(''));
    lines = await page.evaluate(`window.__BASE__.termRun('GET /definitely-not-a-route')`);
    check('live: an unknown route is answered by the build itself (its own 404)',
      lines.some((l) => l.startsWith('← 404')), lines.slice(-2).join(' | ').slice(0, 120));

    await sleep(400);
    await page.screenshot({ path: path.join(__dirname, 'launch-live.png') });
    const stIn = await page.evaluate('window.__BASE__.stats()');
    results.interior = stIn.interior;
    check('live: interior draw calls bounded (under 300) with the terminal open',
      !!stIn.interior && stIn.interior.drawCalls < 300, `drawCalls=${stIn.interior && stIn.interior.drawCalls}`);

    await page.evaluate('window.__BASE__.closeTerminal()');
    await page.evaluate('window.__BASE__.exitBuilding()');
    await sleep(400);
    const afterExit = await page.evaluate('window.__BASE__.terminal()');
    check('live: leaving the building disposes the terminal', afterExit.open === false);
    check('live: zero JS errors through the live session', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();

    /* ---------- RECORDED session (live launch made impossible) ---------- */
    const page2 = await browser.newPage();
    await page2.setViewport({ width: 1280, height: 800 });
    const errors2 = [];
    page2.on('pageerror', (e) => errors2.push('pageerror: ' + String(e)));
    /* the dead runtime address below is this suite's own induced
     * failure (that is what forces the recorded fallback); its
     * resource-load error is expected and is not a page error */
    page2.on('console', (m) => {
      if (m.type() === 'error' && !/127\.0\.0\.1:9|ERR_UNSAFE_PORT/.test(m.text())) errors2.push('console: ' + m.text());
    });
    await page2.evaluateOnNewDocument(() => { window.__BASE_PYODIDE_BASE__ = 'http://127.0.0.1:9/dead/'; });
    await page2.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 120000 });
    await page2.waitForFunction('window.__BASE_READY__ === true', { timeout: 120000 });
    await page2.evaluate(`window.__BASE__.enterBuilding(${JSON.stringify(vendor.name)})`);
    await sleep(500);
    const opened2 = await page2.evaluate(`window.__BASE__.openTerminalFor(${JSON.stringify(product)})`);
    check('recorded: the terminal opens with the runtime unreachable', opened2 === true);
    await sleep(300);
    t = await page2.evaluate('window.__BASE__.terminal()');
    results.recordedHeader = t;
    check('recorded: session falls back to the recorded surface and says so',
      t.sessionMode === 'recorded' && t.fallback === true && /RECORDED SURFACE/.test(t.headerMode),
      `session=${t.sessionMode} fallback=${t.fallback}`);
    check('recorded: the fallback is explained in the transcript',
      t.transcript.some((l) => l.includes('could not complete')), '');
    lines = await page2.evaluate(`window.__BASE__.termRun('GET /health')`);
    const healthSourced = lines.some((l) => l.includes('Recorded from groups/ai-l2/tests/test_service.py')
      || l.includes('Recorded by driving this build itself'));
    check('recorded: GET /health replays a recorded exchange, source named',
      lines.some((l) => l.startsWith('← 200')) && lines.some((l) => l.includes('"status": "ok"')) && healthSourced,
      lines.slice(-3).join(' | ').slice(0, 200));
    lines = await page2.evaluate(`window.__BASE__.termRun('as bob POST /templates {"name": "wrap", "text": "Please: {prompt}"}')`);
    check('recorded: a recorded create replays its recorded response (tpl-1)',
      lines.some((l) => l.includes('tpl-1')), lines.slice(-3).join(' | ').slice(0, 160));
    lines = await page2.evaluate(`window.__BASE__.termRun('GET /no-such-thing')`);
    check('recorded: a fabricated request is answered honestly as unrecorded',
      lines.some((l) => l.includes('No recorded behavior')), lines.slice(-2).join(' | ').slice(0, 160));
    const chipCount = await page2.evaluate(`document.querySelectorAll('#termChips button').length`);
    check('recorded: tappable command chips are offered (touch input method)', chipCount >= 5, `chips=${chipCount}`);
    const before = await page2.evaluate(`window.__BASE__.terminal().transcript.length`);
    await page2.click('#termChips button');
    await sleep(300);
    const after = await page2.evaluate(`window.__BASE__.terminal().transcript.length`);
    check('recorded: tapping a chip runs its recorded exchange', after > before, `${before} -> ${after}`);
    await sleep(300);
    await page2.screenshot({ path: path.join(__dirname, 'launch-recorded.png') });
    check('recorded: zero JS errors through the recorded session', errors2.length === 0, errors2.slice(0, 2).join(' | '));
    await page2.close();
  } finally {
    await browser.close();
    srv.close();
  }
  fs.writeFileSync(path.join(__dirname, 'results-launch.json'), JSON.stringify(results, null, 1) + '\n');
  console.log(failures === 0 ? '\nALL LAUNCH TESTS PASSED' : `\n${failures} LAUNCH TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('verify-launch crashed:', e); process.exit(2); });
