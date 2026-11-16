#!/usr/bin/env node
/*
 * DeadRamp Base verification: the v0.5.0 accessibility build.
 *
 * The specification is the measured audit (AUDIT.md in
 * deadramp-base-a11y-audit): three blockers (2.1.1 keyboard,
 * 1.1.1/1.3.1 text alternative, 4.1.3 status messages) and the
 * measured majors (faded-label contrast, the zoom-banning viewport
 * meta, sub-24px close buttons, focus management, the label pool,
 * reduced motion). This suite measures each fix the way the audit
 * measured the defect, in the project's style: real assertions, and
 * negative controls where the pattern fits (the directory builder
 * run against a mutated catalog; the label contrast computation
 * run at the old 0.55 fade floor against the same sampled
 * backgrounds).
 *
 * What this suite cannot prove, stated plainly: anything inside a
 * WebXR session (no headless XR runtime exists), and the on-device
 * behaviour of VoiceOver on the owner's iPhone. Those remain the
 * audit's on-device checklist.
 *
 * Usage: node verify/verify-a11y.js   (exit code 0 = all pass)
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('/home/hatch/workspace/.pptr/node_modules/puppeteer-core');

const REPO = path.resolve(__dirname, '..');
const EXE = '/home/hatch/workspace/.pptr/chrome-headless-shell/linux-157.0.8103.78/chrome-headless-shell-linux64/chrome-headless-shell';
const PORT = 8936;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.py': 'text/plain', '.wasm': 'application/wasm', '.zip': 'application/zip', '.md': 'text/markdown', '.png': 'image/png' };

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`PASS ${name}${detail ? ' (' + detail + ')' : ''}`);
  else { failures++; console.log(`FAIL ${name}${detail ? ' (' + detail + ')' : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(page, expr, timeout = 15000, step = 300) {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(expr).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await sleep(step);
  }
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
  const mainSrc = fs.readFileSync(path.join(REPO, 'js', 'main.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const results = {};
  let prevDrawCalls = null;
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(__dirname, 'results.json'), 'utf8'));
    if (prev.stats && typeof prev.stats.drawCalls === 'number') prevDrawCalls = prev.stats.drawCalls;
  } catch (e) { /* no baseline */ }

  /* framing invariants, the same string-level discipline as verify.js */
  const FRAMING_EXACT = 'Clean-room model built from public FedRAMP Marketplace information, inspired by the vendor\'s public brand identity. Not affiliated with or endorsed by the vendor.';
  const countOcc = (hay, needle) => hay.split(needle).length - 1;
  check('framing text still occurs exactly once in the client script', countOcc(mainSrc, FRAMING_EXACT) === 1, `count=${countOcc(mainSrc, FRAMING_EXACT)}`);
  check('framing text still occurs zero times in the page markup', countOcc(htmlSrc, 'Not affiliated with or endorsed by the vendor') === 0);

  const srv = await serve();
  const browser = await puppeteer.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const pageErrors = [], badResponses = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('response', (r) => { if (r.status() >= 400) badResponses.push(r.status() + ' ' + r.url()); });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction('window.__BASE_READY__ === true', { timeout: 30000 });
    await sleep(1200);

    check('page loaded with zero JS page errors', pageErrors.length === 0, pageErrors.join(' | '));
    check('no failed local requests', badResponses.length === 0, badResponses.join(' | '));

    /* ---- M2: the viewport meta no longer bans zoom ---- */
    const meta = await page.evaluate(`document.querySelector('meta[name="viewport"]').getAttribute('content')`);
    check('viewport meta allows pinch zoom (no user-scalable or maximum-scale ban)',
      !/user-scalable\s*=\s*no/.test(meta) && !/maximum-scale/.test(meta), meta);

    /* ---- B2: canvas semantics and the label pool ---- */
    const a11y0 = await page.evaluate('window.__BASE__.a11y()');
    results.a11y = a11y0;
    check('canvas carries the image role, a name, and a description',
      a11y0.canvas.role === 'img' && !!a11y0.canvas.label && a11y0.canvas.tabIndex === 0 &&
      !!(await page.evaluate(`document.getElementById('${a11y0.canvas.describedBy}')`)),
      JSON.stringify(a11y0.canvas));
    check('pooled floating labels are hidden from assistive technology',
      await page.evaluate(`document.getElementById('labels').getAttribute('aria-hidden') === 'true'`));
    check('exactly one H1 on the page',
      (await page.evaluate(`document.querySelectorAll('h1').length`)) === 1);

    /* ---- B3: live regions exist and the arrival is announced ---- */
    check('a polite live region exists and the terminal output is a live log',
      (await page.evaluate(`!!document.querySelector('#ariaLive[aria-live="polite"]')`)) &&
      (await page.evaluate(`document.getElementById('termOut').getAttribute('role') === 'log'`)) &&
      (await page.evaluate(`document.getElementById('loading').getAttribute('role') === 'status'`)));
    const arrival = await until(page, `window.__BASE__.a11y().liveText.includes('${catalog.meta.vendors} vendors')`, 8000);
    check('arrival is announced with the catalog counts', !!arrival, a11y0.liveText.slice(0, 60));

    /* ---- draw calls: the accessibility build is DOM, not geometry ---- */
    const stats = await page.evaluate('window.__BASE_STATS__()');
    results.drawCalls = stats.drawCalls;
    if (prevDrawCalls !== null) {
      check('draw calls at spawn did not grow materially', stats.drawCalls <= prevDrawCalls + 1,
        `${stats.drawCalls} vs baseline ${prevDrawCalls}`);
    }

    /* ---- M1: label contrast, measured the audit's way ---- */
    check('label fade floors are the raised ones (vendor 0.85, district 0.70)',
      a11y0.labelFloors.vendor === 0.85 && a11y0.labelFloors.district === 0.7,
      JSON.stringify(a11y0.labelFloors));
    const labelSample = await page.evaluate(`(() => {
      const out = [];
      for (const el of document.querySelectorAll('#labels .lbl:not(.district)')) {
        if (el.style.display === 'none') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.top < 0 || r.bottom > innerHeight) continue;
        out.push({ x: r.x, y: r.y, w: r.width, h: r.height, opacity: parseFloat(getComputedStyle(el).opacity), text: el.textContent });
        if (out.length >= 4) break;
      }
      return out;
    })()`);
    check('vendor labels are on screen to measure', labelSample.length >= 1, `${labelSample.length} sampled`);
    if (labelSample.length) {
      const shot = await page.screenshot({ encoding: 'base64' });
      const contrast = await page.evaluate(async (b64, labels) => {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        const lum = (r, g, b) => {
          const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const ratioAt = (B, o) => {
          const T = [238, 243, 250], P = [10, 14, 22], pa = 0.42;
          const pillEff = P.map((p, i) => pa * p + (1 - pa) * B[i]);
          const glyph = T.map((t, i) => o * t + (1 - o) * B[i]);
          const pill = pillEff.map((p, i) => o * p + (1 - o) * B[i]);
          return (lum(...glyph) + 0.05) / (lum(...pill) + 0.05);
        };
        return labels.map((L) => {
          const samples = [];
          const x0 = Math.max(0, Math.floor(L.x - 10)), x1 = Math.min(c.width - 1, Math.ceil(L.x + L.w + 10));
          const y0 = Math.max(0, Math.floor(L.y - 10)), y1 = Math.min(c.height - 1, Math.ceil(L.y + L.h + 10));
          const data = x.getImageData(x0, y0, x1 - x0, y1 - y0).data;
          const pts = [];
          for (let i = 0; i < data.length; i += 16) pts.push([data[i], data[i + 1], data[i + 2]]);
          pts.sort((a, b) => lum(...a) - lum(...b));
          const B = pts[Math.floor(pts.length * 0.75)] || [27, 36, 54];
          return { text: L.text, opacity: L.opacity, bg: B, live: ratioAt(B, L.opacity), atOldFloor: ratioAt(B, 0.55) };
        });
      }, shot, labelSample);
      results.contrast = contrast;
      const worst = Math.min(...contrast.map((c) => c.live));
      check('every sampled vendor label clears 4.5:1 at its rendered opacity', worst >= 4.5,
        contrast.map((c) => `${c.text}=${c.live.toFixed(2)}`).join(', '));
      const brightest = contrast.reduce((a, b) => (a.atOldFloor < b.atOldFloor ? a : b));
      check('negative control: the same computation at the old 0.55 floor is strictly worse, and fails where the audit said it fails',
        contrast.every((c) => c.atOldFloor < c.live) && brightest.atOldFloor < 4.5,
        `brightest sample: live=${brightest.live.toFixed(2)} oldFloor=${brightest.atOldFloor.toFixed(2)}`);
    }

    /* ---- M3: close buttons measure at least 24 by 24 ---- */
    await page.click('#settingsBtn');
    await sleep(300);
    const setBox = await page.evaluate(`(() => { const r = document.getElementById('settingsClose').getBoundingClientRect(); return { w: r.width, h: r.height }; })()`);
    check('Settings close button is at least 24 by 24', setBox.w >= 24 && setBox.h >= 24, `${setBox.w}x${setBox.h}`);
    check('opening Settings moves focus into the panel',
      (await page.evaluate('document.activeElement && document.activeElement.id')) === 'settingsClose');
    check('Settings carries the comfort controls and the accessibility statement',
      (await page.evaluate(`document.querySelectorAll('#settingsPanel input[type="checkbox"]').length`)) >= 4 &&
      (await page.evaluate(`document.getElementById('settingsPanel').textContent.includes('Accessibility statement')`)));
    check('Settings title is an H2 under the page H1',
      (await page.evaluate(`!!document.querySelector('#settingsPanel h2')`)));
    await page.keyboard.press('Escape');
    await sleep(200);
    check('Escape closes Settings and returns focus to its button',
      (await page.evaluate('window.__BASE__.settings().open')) === false &&
      (await page.evaluate('document.activeElement && document.activeElement.id')) === 'settingsBtn');

    /* ---- B1: keyboard turning ---- */
    await page.evaluate('document.querySelector("canvas").focus()');
    const yaw0 = await page.evaluate('window.__BASE__.getCamera().yaw');
    await page.keyboard.down(',');
    const turned = await until(page, `(window.__BASE__.getCamera().yaw - ${yaw0}) > 0.05`, 5000, 120);
    await page.keyboard.up(',');
    check('comma key turns the view left', !!turned, `delta=${turned ? '' : 'none'}`);
    const yaw1 = await page.evaluate('window.__BASE__.getCamera().yaw');
    await page.keyboard.down('.');
    const turnedBack = await until(page, `(window.__BASE__.getCamera().yaw - ${yaw1}) < -0.05`, 5000, 120);
    await page.keyboard.up('.');
    check('period key turns the view right', !!turnedBack);
    /* the m5 off switch makes the keys inert */
    await page.click('#settingsBtn'); await sleep(250);
    await page.click('#setKeys'); await sleep(150);
    await page.keyboard.press('Escape'); await sleep(150);
    await page.evaluate('document.querySelector("canvas").focus()');
    const yaw2 = await page.evaluate('window.__BASE__.getCamera().yaw');
    await page.keyboard.down(',');
    await sleep(900);
    await page.keyboard.up(',');
    const yaw3 = await page.evaluate('window.__BASE__.getCamera().yaw');
    check('with keyboard controls switched off, the turn keys are inert', Math.abs(yaw3 - yaw2) < 0.01, `delta=${(yaw3 - yaw2).toFixed(3)}`);
    await page.click('#settingsBtn'); await sleep(250);
    await page.click('#setKeys'); await sleep(150);
    await page.keyboard.press('Escape'); await sleep(150);

    /* ---- B1: Enter is the keyboard pick; focus follows the card ----
     * The assertion is pointer equivalence, not a guessed building:
     * whatever a centre click opens from this spot, Enter must open
     * the same record (neighbouring towers overlap sight lines in
     * the spiral, so naming the expected building from geometry
     * alone would test the city, not the keyboard). */
    const ibm = catalog.vendors.find((v) => v.name === 'IBM');
    const ifx = Math.sin(ibm.rotationY), ifz = Math.cos(ibm.rotationY);
    await page.evaluate(`window.__BASE__.setCamera({x: ${ibm.position.x + ifx * 14}, z: ${ibm.position.z + ifz * 14}})`);
    await page.evaluate(`window.__BASE__.lookAt(${ibm.position.x}, ${ibm.position.z})`);
    await page.evaluate('document.querySelector("canvas").focus()');
    await sleep(400);
    await page.mouse.click(640, 400);
    const clickCard = await until(page, `window.__BASE__.cardText()`, 6000);
    const clickName = clickCard ? await page.evaluate(`document.querySelector('#cardBody h2').textContent`) : null;
    check('a centre click opens a record from the test position', !!clickName, clickName || 'none');
    await page.keyboard.press('Escape');
    await sleep(250);
    await page.evaluate('document.querySelector("canvas").focus()');
    await page.keyboard.press('Enter');
    const enterCard = await until(page, `window.__BASE__.cardText()`, 6000);
    const enterName = enterCard ? await page.evaluate(`document.querySelector('#cardBody h2').textContent`) : null;
    check('Enter opens the same record as the centre click (the keyboard pick)',
      !!enterName && enterName === clickName, `click=${clickName} enter=${enterName}`);
    check('the opened card takes focus at its close button',
      (await page.evaluate('document.activeElement && document.activeElement.id')) === 'cardClose');
    check('card title is an H2', (await page.evaluate(`!!document.querySelector('#card h2')`)));
    const cardAnn = await until(page, `window.__BASE__.a11y().liveText.includes(${JSON.stringify(clickName || ' ')}) && /authorized|in process/.test(window.__BASE__.a11y().liveText)`, 6000);
    check('opening the card is announced with its status', !!cardAnn,
      await page.evaluate('window.__BASE__.a11y().liveText'));
    await page.keyboard.press('Escape');
    await sleep(250);
    check('Escape closes the card and focus returns to the canvas',
      (await page.evaluate('window.__BASE__.cardText()')) === null &&
      (await page.evaluate('document.activeElement && document.activeElement.tagName')) === 'CANVAS');

    /* ---- B1 + B3: the door by keyboard, entry announced ---- */
    const solo = catalog.vendors.find((v) => v.kind === 'building' && v.offerings.length === 1 && v.name !== 'IBM');
    const sfx = Math.sin(solo.rotationY), sfz = Math.cos(solo.rotationY);
    const doorPt = { x: solo.position.x + sfx * (solo.size.d / 2 + 1.5), z: solo.position.z + sfz * (solo.size.d / 2 + 1.5) };
    await page.evaluate(`window.__BASE__.setCamera({x: ${doorPt.x + sfx * 2}, z: ${doorPt.z + sfz * 2}})`);
    /* poll for THIS door: the previously armed door stays readable
     * for a tick after a teleport, and a bare truthiness poll would
     * return the stale one */
    const doorArmed = await until(page, `(() => { const d = window.__BASE__.door(); return d && d.name === ${JSON.stringify(solo.name)} ? d : null; })()`, 12000);
    check('the door arms for a keyboard visitor standing at it', !!doorArmed, doorArmed && doorArmed.name);
    const doorAnn = await until(page, `window.__BASE__.a11y().liveText.includes(${JSON.stringify(solo.name)})`, 6000);
    check('the armed door prompt is announced', !!doorAnn,
      await page.evaluate('window.__BASE__.a11y().liveText'));
    await page.keyboard.press('KeyE');
    const inside = await until(page, 'window.__BASE__.interiorState()', 12000);
    check('E at the door enters the building by keyboard alone', !!inside && inside.vendor === solo.name, inside && inside.vendor);
    const entryAnn = await until(page, `window.__BASE__.a11y().liveText.includes(${JSON.stringify(solo.name)}) && /Inside/.test(window.__BASE__.a11y().liveText)`, 6000);
    check('the entry is announced with the room count', !!entryAnn,
      await page.evaluate('window.__BASE__.a11y().liveText'));
    await page.evaluate('window.__BASE__.exitBuilding()');
    await sleep(300);

    /* ---- B2: the Directory ---- */
    const probe = await page.evaluate('window.__BASE__.a11y().directoryProbe()');
    check('directory data is derived from the catalog', probe.full === catalog.meta.vendors, `full=${probe.full}`);
    check('negative control: dropping one vendor from a catalog copy drops exactly one directory record',
      probe.mutated === catalog.meta.vendors - 1 && probe.dropped === catalog.vendors[0].name,
      `mutated=${probe.mutated} dropped=${probe.dropped}`);
    await page.click('#directoryBtn');
    await sleep(400);
    const dirCounts = await page.evaluate('window.__BASE__.a11y().directory');
    check('the Directory lists every vendor and district',
      dirCounts.open && dirCounts.vendors === catalog.meta.vendors && dirCounts.districts === catalog.meta.districts,
      JSON.stringify(dirCounts));
    check('opening the Directory puts focus in the search field',
      (await page.evaluate('document.activeElement && document.activeElement.id')) === 'directorySearch');
    await page.type('#directorySearch', 'Oracle');
    const filtered = await until(page, `document.getElementById('directoryMeta').textContent.startsWith('2 of ')`, 6000);
    check('search filters the Directory to matching vendors', !!filtered,
      await page.evaluate(`document.getElementById('directoryMeta').textContent`));
    await page.evaluate(`document.getElementById('directorySearch').value = ''; document.getElementById('directorySearch').dispatchEvent(new Event('input'));`);
    await sleep(300);
    /* open a record from the Directory: focus returns to the invoking button */
    await page.evaluate(`(() => {
      for (const li of document.querySelectorAll('.dirVendor')) {
        if (li.querySelector('.dirVName').textContent === 'Oracle Corporation') {
          li.querySelector('button').click(); return true;
        }
      } return false;
    })()`);
    const dirCard = await until(page, `window.__BASE__.cardText() && window.__BASE__.cardText().includes('Oracle Corporation')`, 6000);
    check('a Directory record button opens the same card as picking the building', !!dirCard);
    await page.keyboard.press('Escape');
    await sleep(250);
    const backAt = await page.evaluate('document.activeElement && (document.activeElement.getAttribute("aria-label") || document.activeElement.textContent)');
    check('closing that card returns focus to the Directory button that opened it',
      /Oracle Corporation/.test(backAt || ''), backAt || 'none');
    /* go to the lot */
    await page.evaluate(`(() => {
      for (const li of document.querySelectorAll('.dirVendor')) {
        if (li.querySelector('.dirVName').textContent === 'TERIDA') {
          [...li.querySelectorAll('button')].find((b) => b.textContent === 'Go to').click(); return true;
        }
      } return false;
    })()`);
    await sleep(300);
    const terida = catalog.vendors.find((v) => v.name === 'TERIDA');
    const camAfterGo = await page.evaluate('window.__BASE__.getCamera()');
    const goDist = Math.hypot(camAfterGo.x - terida.position.x, camAfterGo.z - terida.position.z);
    check('Go to places the visitor at the vendor', goDist < 20, `distance=${goDist.toFixed(1)} m`);
    const goAnn = await page.evaluate('window.__BASE__.a11y().liveText');
    check('the placement is announced', goAnn.includes('TERIDA'), goAnn.slice(0, 60));
    await page.keyboard.press('Escape'); // close the directory if still open under the card flow
    if (await page.evaluate('window.__BASE__.a11y().directory.open')) await page.click('#directoryBtn');
    await sleep(200);

    /* enter a two-room building from the Directory, use its room list */
    const two = catalog.vendors.find((v) => v.kind === 'building' && v.offerings.length === 2);
    if (!(await page.evaluate('window.__BASE__.a11y().directory.open'))) { await page.click('#directoryBtn'); await sleep(300); }
    await page.evaluate(`(() => {
      for (const li of document.querySelectorAll('#directoryList .dirVendor')) {
        if (li.querySelector('.dirVName').textContent === ${JSON.stringify(two.name)}) {
          [...li.querySelectorAll('button')].find((b) => b.textContent === 'Enter building').click(); return true;
        }
      } return false;
    })()`);
    const inside2 = await until(page, 'window.__BASE__.interiorState()', 12000);
    check('Enter building in the Directory enters that building', !!inside2 && inside2.vendor === two.name, inside2 && inside2.vendor);
    await page.click('#directoryBtn');
    await sleep(400);
    const roomRows = await page.evaluate(`document.querySelectorAll('#directoryInterior .dirVendor').length`);
    check('inside, the Directory lists the building rooms', roomRows === two.offerings.length, `${roomRows} rooms`);
    /* floor announcement on a floor change */
    const pts = await page.evaluate('window.__BASE__.interiorPoints()');
    const top = pts.rooms[pts.rooms.length - 1];
    await page.evaluate(`window.__BASE__.interiorTeleport({x: ${top.pos.x}, z: ${top.pos.z}, floorY: ${top.floorY}})`);
    const floorAnn = await until(page, `window.__BASE__.a11y().liveText.includes('Floor')`, 9000);
    check('a floor change is announced', !!floorAnn, await page.evaluate('window.__BASE__.a11y().liveText'));
    /* open a room terminal from the Directory: focus lands in the input */
    if (!(await page.evaluate('window.__BASE__.a11y().directory.open'))) { await page.click('#directoryBtn'); await sleep(300); }
    const termBtnClicked = await page.evaluate(`(() => {
      const b = document.querySelector('#directoryInterior .dirBtns button:nth-child(2)') ||
        [...document.querySelectorAll('#directoryInterior button')].find((x) => x.textContent === 'Open terminal');
      if (b) { b.click(); return true; } return false;
    })()`);
    check('the room list offers a terminal action', termBtnClicked === true);
    const termOpen = await until(page, `window.__BASE__.terminal().open`, 30000, 400);
    check('the terminal opens from the Directory', !!termOpen);
    /* the session establishes when the in-browser runtime is ready;
     * focus enters the input at that same moment by design, so the
     * focus and announcement checks wait for the session, with the
     * long budget this shared VM needs for a first Pyodide load */
    const termSession = await until(page, `window.__BASE__.terminal().sessionMode`, 240000, 1000);
    check('the terminal session establishes from the Directory', !!termSession, termSession && termSession.sessionMode);
    check('the terminal session is announced',
      /Terminal open/.test(await page.evaluate('window.__BASE__.a11y().liveText')));
    check('opening the terminal puts focus in the command input',
      (await page.evaluate('document.activeElement && document.activeElement.id')) === 'termInput');
    const termBox = await page.evaluate(`(() => { const r = document.getElementById('termClose').getBoundingClientRect(); return { w: r.width, h: r.height }; })()`);
    check('terminal close button is at least 24 by 24', termBox.w >= 24 && termBox.h >= 24, `${termBox.w}x${termBox.h}`);
    await page.keyboard.press('Escape');
    await sleep(300);
    check('Escape in the terminal closes it and returns focus to the canvas',
      (await page.evaluate('window.__BASE__.terminal().open')) === false &&
      (await page.evaluate('document.activeElement && document.activeElement.tagName')) === 'CANVAS');
    await page.evaluate('window.__BASE__.openCard("IBM")');
    await sleep(300);
    const cardBox = await page.evaluate(`(() => { const r = document.getElementById('cardClose').getBoundingClientRect(); return { w: r.width, h: r.height }; })()`);
    check('card close button is at least 24 by 24', cardBox.w >= 24 && cardBox.h >= 24, `${cardBox.w}x${cardBox.h}`);
    await page.keyboard.press('Escape');
    await sleep(200);
    await page.evaluate('window.__BASE__.exitBuilding()');
    await sleep(300);

    /* ---- comfort settings persist ---- */
    await page.click('#settingsBtn'); await sleep(250);
    await page.click('#setHcLabels'); await sleep(200);
    const hc = await page.evaluate('window.__BASE__.a11y()');
    check('high-contrast labels raise the floors to full strength',
      hc.highContrastLabels === true && hc.labelFloors.vendor === 1 && hc.labelFloors.district === 1,
      JSON.stringify(hc.labelFloors));
    await page.reload({ waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction('window.__BASE_READY__ === true', { timeout: 30000 });
    await sleep(600);
    const hcAfter = await page.evaluate('window.__BASE__.a11y()');
    check('comfort settings persist across a reload (localStorage)',
      hcAfter.highContrastLabels === true && hcAfter.labelFloors.vendor === 1);
    check('zero JS page errors across the whole run', pageErrors.length === 0, pageErrors.join(' | '));
    await page.close();

    /* ---- M6: reduced motion is honoured ---- */
    const page2 = await browser.newPage();
    await page2.setViewport({ width: 1280, height: 800 });
    const errs2 = [];
    page2.on('pageerror', (e) => errs2.push(String(e)));
    await page2.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page2.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
    await page2.waitForFunction('window.__BASE_READY__ === true', { timeout: 30000 });
    await sleep(600);
    const rm = await page2.evaluate('window.__BASE__.a11y()');
    check('the system reduced-motion preference is honoured at boot',
      rm.systemReducedMotion === true && rm.reducedMotion === true, JSON.stringify({ s: rm.systemReducedMotion, r: rm.reducedMotion }));
    await sleep(8500);
    const helpRm = await page2.evaluate('window.__BASE__.help()');
    check('under reduced motion the help does not fade', helpRm.faded === false && helpRm.opacity > 0.9, `opacity=${helpRm.opacity}`);
    check('reduced-motion page: zero JS errors', errs2.length === 0, errs2.join(' | '));
    await page2.close();

    /* control: without the preference, the same help fades on schedule */
    const page3 = await browser.newPage();
    await page3.setViewport({ width: 1280, height: 800 });
    await page3.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
    await page3.waitForFunction('window.__BASE_READY__ === true', { timeout: 30000 });
    const faded = await until(page3, 'window.__BASE__.help().faded === true', 16000, 500);
    check('control: without reduced motion the help still fades after the dwell', !!faded);
    await page3.close();
  } finally {
    await browser.close();
    srv.close();
  }
  results.failures = failures;
  fs.writeFileSync(path.join(__dirname, 'results-a11y.json'), JSON.stringify(results, null, 1) + '\n');
  console.log(failures === 0 ? '\nALL A11Y CHECKS PASSED' : `\n${failures} A11Y CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('verify-a11y crashed:', e); process.exit(2); });
