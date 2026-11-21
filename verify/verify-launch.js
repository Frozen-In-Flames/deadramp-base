#!/usr/bin/env node
/*
 * DeadRamp Base verification, experience pass: the room terminals.
 * Serves the repo over HTTP and loads the page in headless Chrome,
 * and proves the launch paths end to end. The Python runtime is
 * vendored in the repo (vendor/pyodide/), so the live session uses
 * the page's own default runtime path; a third session proves a
 * live launch with every request to the old CDN host blocked.
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
 *   VENDORED: a third session, no runtime-base override, with
 *   every request to cdn.jsdelivr.net aborted by interception:
 *   the live launch must still complete from the runtime vendored
 *   in the repo, because a visitor's phone owes the old CDN
 *   nothing.
 *   INTEGRITY: a fourth session serves one bundle file with its
 *   bytes altered after catalog generation. The catalog records a
 *   SHA-256 for every bundle file; the load-time check must
 *   refuse the live launch, fall back to the recorded surface,
 *   and state the integrity failure in the transcript, while the
 *   untampered LIVE session above states that its files verified.
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
      const file = path.join(REPO, url === '/' ? 'index.html' : url);
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
    check('integrity: the live session states its bundle files verified against the catalogued SHA-256 record',
      t.transcript.some((l) => l.includes(`Load-time integrity verification: ${aiBuild.launch.bundle.files.length} bundle files match the SHA-256 hashes recorded in the catalog`)),
      t.transcript.filter((l) => l.includes('integrity')).join(' | ').slice(0, 160));

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

    /* ---------- LIVE session with the old CDN host blocked ----------
     * The runtime is vendored with the site, so a live launch must
     * succeed with every request to cdn.jsdelivr.net aborted. No
     * runtime-base override is set on this page: it uses the page's
     * own default path, exactly as a visitor's phone does. */
    const page3 = await browser.newPage();
    await page3.setViewport({ width: 1280, height: 800 });
    const errors3 = [];
    page3.on('pageerror', (e) => errors3.push('pageerror: ' + String(e)));
    page3.on('console', (m) => {
      if (m.type() === 'error' && !/cdn\.jsdelivr\.net|ERR_FAILED/.test(m.text())) errors3.push('console: ' + m.text());
    });
    let cdnBlocked = 0;
    await page3.setRequestInterception(true);
    page3.on('request', (req) => {
      if (req.url().includes('cdn.jsdelivr.net')) { cdnBlocked++; req.abort(); }
      else req.continue();
    });
    await page3.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 120000 });
    await page3.waitForFunction('window.__BASE_READY__ === true', { timeout: 120000 });
    await page3.evaluate(`window.__BASE__.enterBuilding(${JSON.stringify(vendor.name)})`);
    await sleep(500);
    const pts3 = await page3.evaluate('window.__BASE__.interiorPoints()');
    const rp3 = pts3.rooms[roomIdx];
    await page3.evaluate(`window.__BASE__.interiorTeleport(${JSON.stringify({ x: rp3.pos.x, z: rp3.pos.z, floorY: rp3.floorY })})`);
    await sleep(300);
    const opened3 = await page3.evaluate('window.__BASE__.useTerminal()');
    check('vendored: the terminal opens with cdn.jsdelivr.net blocked', opened3 === true);
    await sleep(300);
    t = await page3.evaluate('window.__BASE__.terminal()');
    results.cdnBlocked = { blockedRequests: cdnBlocked, sessionMode: t.sessionMode, fallback: t.fallback };
    check('vendored: the session is live, not a fallback, with the CDN unreachable',
      t.sessionMode === 'live' && t.fallback === false,
      `session=${t.sessionMode} fallback=${t.fallback} cdnRequestsBlocked=${cdnBlocked}`);
    lines = await page3.evaluate(`window.__BASE__.termRun('GET /health')`);
    check('vendored: the build itself answers GET /health from the vendored runtime',
      lines.some((l) => l.startsWith('← 200')) && lines.some((l) => l.includes('"status": "ok"')),
      lines.slice(-3).join(' | ').slice(0, 160));
    check('vendored: zero JS errors through the blocked-CDN session', errors3.length === 0, errors3.slice(0, 2).join(' | '));
    await page3.close();

    /* ---------- INTEGRITY session (one bundle file tampered) ----------
     * The catalog's bundle manifest carries the SHA-256 of every
     * file recorded at export time. Serve the first ai-l2 bundle
     * file with bytes altered after catalog generation: the
     * load-time check must refuse the live launch, the session
     * must fall back to the recorded surface, and the transcript
     * must state the integrity failure, naming the file. The
     * recorded surface must still answer from its recordings. */
    const page4 = await browser.newPage();
    await page4.setViewport({ width: 1280, height: 800 });
    const errors4 = [];
    page4.on('pageerror', (e) => errors4.push('pageerror: ' + String(e)));
    page4.on('console', (m) => { if (m.type() === 'error') errors4.push('console: ' + m.text()); });
    const targetFile = aiBuild.launch.bundle.files[0];
    const targetUrlPart = `launch/bundles/ai-l2/${targetFile.path}`;
    let tamperedServed = 0;
    await page4.setRequestInterception(true);
    page4.on('request', (req) => {
      if (req.url().includes(targetUrlPart)) {
        tamperedServed++;
        const real = fs.readFileSync(path.join(REPO, targetUrlPart));
        req.respond({ status: 200, contentType: 'text/plain',
          body: Buffer.concat([real, Buffer.from('\n# altered after catalog generation\n')]) });
      } else req.continue();
    });
    await page4.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 120000 });
    await page4.waitForFunction('window.__BASE_READY__ === true', { timeout: 120000 });
    await page4.evaluate(`window.__BASE__.enterBuilding(${JSON.stringify(vendor.name)})`);
    await sleep(500);
    const opened4 = await page4.evaluate(`window.__BASE__.openTerminalFor(${JSON.stringify(product)})`);
    check('integrity: the terminal opens with a tampered bundle file served', opened4 === true);
    await sleep(300);
    t = await page4.evaluate('window.__BASE__.terminal()');
    results.integrity = { tamperedServed, sessionMode: t.sessionMode, fallback: t.fallback };
    check('integrity: the tampered bytes were actually served', tamperedServed >= 1, `served=${tamperedServed}`);
    check('integrity: the live launch is refused and the session falls back to the recorded surface',
      t.sessionMode === 'recorded' && t.fallback === true,
      `session=${t.sessionMode} fallback=${t.fallback}`);
    check('integrity: the failure is stated plainly in the transcript, naming the file',
      t.transcript.some((l) => l.includes('Integrity check failed') && l.includes(targetFile.path)),
      t.transcript.filter((l) => l.includes('Integrity')).join(' | ').slice(0, 220));
    lines = await page4.evaluate(`window.__BASE__.termRun('GET /health')`);
    check('integrity: the recorded surface still answers after the refusal',
      lines.some((l) => l.startsWith('← 200')) && lines.some((l) => l.includes('"status": "ok"')),
      lines.slice(-3).join(' | ').slice(0, 160));
    check('integrity: zero JS errors through the tampered session', errors4.length === 0, errors4.slice(0, 2).join(' | '));
    await page4.close();
  } finally {
    await browser.close();
    srv.close();
  }
  fs.writeFileSync(path.join(__dirname, 'results-launch.json'), JSON.stringify(results, null, 1) + '\n');
  console.log(failures === 0 ? '\nALL LAUNCH TESTS PASSED' : `\n${failures} LAUNCH TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('verify-launch crashed:', e); process.exit(2); });
