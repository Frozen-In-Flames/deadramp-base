#!/usr/bin/env node
/*
 * DeadRamp Base verification: platform-matched prompts, tappable
 * doors, and the help lifecycle (Aries, Nov 14, 2026).
 *
 * Two contexts against the same served build:
 *  - desktop (no touch): keyboard copy intact, help visible at load,
 *    faded after the dwell, recalled by the "?" button, E key still
 *    enters at a door and exits at the EXIT door.
 *  - touch (coarse pointer emulated): help and prompts speak tap
 *    language only (no keyboard key is ever named), a tap on the
 *    door itself enters the building, the indoor help variant
 *    appears on first entry and fades, a tap at the EXIT door
 *    returns to the boulevard, the "?" button recalls the help.
 *
 * Usage: node verify/verify-platform.js   (exit 0 = all checks pass)
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('/home/hatch/workspace/.pptr/node_modules/puppeteer-core');

const REPO = path.resolve(__dirname, '..');
const EXE = '/home/hatch/workspace/.pptr/chrome-headless-shell/linux-157.0.8103.78/chrome-headless-shell-linux64/chrome-headless-shell';
const PORT = 8932;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.md': 'text/markdown', '.png': 'image/png' };
const DWELL_WAIT = 8600; // 7 s dwell + 0.7 s fade + margin

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
      if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(PORT, () => resolve(srv));
  });
}

async function newObservedPage(browser) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return { page, errors };
}
async function loadBase(page) {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction('window.__BASE_READY__ === true', { timeout: 30000 });
  await sleep(600);
}
const help = (page) => page.evaluate('window.__BASE__.help()');

/* Poll the help hook until its opacity crosses a threshold. The
 * fade is a CSS transition sampled per compositor frame; under
 * software rendering those frames lag wall-clock, so a fixed wait
 * reads mid-transition values. */
async function helpOpacity(page, pred, timeoutMs = 9000) {
  const start = Date.now();
  let h = await help(page);
  while (!pred(h.opacity) && Date.now() - start < timeoutMs) {
    await sleep(350);
    h = await help(page);
  }
  return h;
}

/* Poll an evaluate expression until it returns a truthy value.
 * Headless frame rates vary and the game's timers accumulate
 * clamped frame dt, so state changes land on game time, not wall
 * time; polling is the honest way to wait for them. */
async function until(page, expr, timeoutMs = 9000) {
  const start = Date.now();
  let val = null;
  while (Date.now() - start < timeoutMs) {
    val = await page.evaluate(expr);
    if (val) return val;
    await sleep(400);
  }
  return val;
}

/* position the player in front of the first catalog building's door,
 * facing it, inside the 7 m door zone; returns the door hook */
async function standAtDoor(page, catalog) {
  const v = catalog.vendors.find((x) => x.kind === 'building');
  const fx = Math.sin(v.rotationY), fz = Math.cos(v.rotationY);
  const door = {
    x: v.position.x + fx * (v.size.d / 2 + 1.5),
    z: v.position.z + fz * (v.size.d / 2 + 1.5),
  };
  await page.evaluate(`window.__BASE__.setCamera({ x: ${door.x + fx * 4}, z: ${door.z + fz * 4} })`);
  await page.evaluate(`window.__BASE__.lookAt(${door.x}, ${door.z})`);
  return until(page, 'window.__BASE__.door()');
}
/* Deliver a tap the way a device does: touchstart and touchend
 * stamped at the same physical instant. CDP-injected taps were
 * measured separately and DO reach the canvas handlers at the exact
 * coordinates (and a CDP tap's own event stamps read a true 206 ms),
 * but under software rendering the two CDP injections can land more
 * than the app's 260 ms tap window apart, which no physical tap
 * does. So taps here are dispatched in-page on the element at the
 * point, exercising the app's real handler chain (touchstart ->
 * tap detection -> handleTap) end to end. Non-canvas targets also
 * get the click a real tap produces. */
async function tapAt(page, x, y) {
  await page.evaluate(`(() => {
    const canvas = document.querySelector('canvas');
    const el = document.elementFromPoint(${x}, ${y}) || canvas;
    const mk = (type) => {
      const t = new Touch({ identifier: 11, target: el, clientX: ${x}, clientY: ${y} });
      return new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true });
    };
    el.dispatchEvent(mk('touchstart'));
    el.dispatchEvent(mk('touchend'));
    if (el !== canvas) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  })()`);
}

/* stand in the lobby EXIT zone (angle -0.9, outer band, floor 0) */
async function standAtExit(page) {
  const x = Math.cos(-0.9) * 12, z = Math.sin(-0.9) * 12;
  await page.evaluate(`window.__BASE__.interiorTeleport(${JSON.stringify({ x, z, floorY: 0 })})`);
  return until(page, '(() => { const s = window.__BASE__.interiorState(); return s && s.atExit ? s : null; })()');
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
    /* ============ desktop context: keyboard copy, E key, lifecycle ============ */
    {
      const { page, errors } = await newObservedPage(browser);
      await page.setViewport({ width: 1280, height: 800 });
      await loadBase(page);
      let h = await help(page);
      results.desktopSignals = h.signals;
      check('desktop: input class detected as keyboard', h.isTouch === false, JSON.stringify(h.signals));
      check('desktop: help visible on arrival', h.visible === true);
      check('desktop: help carries the keyboard copy', /WASD/.test(h.text) && /press/.test(h.text) && /E/.test(h.text), h.text.slice(0, 60) + '…');
      check('desktop: outdoor help states the construction legend verbatim',
        h.text.includes('Finished buildings are FedRAMP authorized. Scaffolded buildings are still in the authorization process.'),
        h.text.slice(-90));
      await sleep(DWELL_WAIT);
      h = await helpOpacity(page, (o) => o < 0.05);
      check('desktop: help faded after the dwell', h.faded === true && h.opacity < 0.05, `opacity=${h.opacity}`);
      await page.click('#helpBtn');
      h = await helpOpacity(page, (o) => o > 0.9);
      check('desktop: "?" button recalls the help', h.visible === true && h.opacity > 0.9, `opacity=${h.opacity}`);

      const door = await standAtDoor(page, catalog);
      check('desktop: door zone armed near a building', !!door, door && door.name);
      h = await help(page);
      check('desktop: door prompt names the E key', !!h.prompt && /E/.test(h.prompt), h.prompt || 'no prompt');
      await page.keyboard.press('KeyE');
      let ist = await until(page, 'window.__BASE__.interiorState()', 5000);
      check('desktop: E enters the building', !!ist && !!door && ist.vendor === door.name, ist && ist.vendor);
      const atExit = await standAtExit(page);
      check('desktop: EXIT zone reached indoors', !!atExit && atExit.atExit === true);
      await page.keyboard.press('KeyE');
      ist = await page.evaluate('window.__BASE__.interiorState()');
      check('desktop: E at the EXIT door returns outside', ist === null);
      check('desktop: zero JS errors', errors.length === 0, errors.join(' | '));
      await page.close();
    }

    /* ============ touch context: tap copy, tappable doors, lifecycle ============ */
    {
      const { page, errors } = await newObservedPage(browser);
      /* puppeteer's media-feature list does not include 'pointer';
       * ask CDP directly (best effort), and let the touch viewport
       * (maxTouchPoints / ontouchstart) carry the signal regardless */
      try {
        const cdp = await page.createCDPSession();
        await cdp.send('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'pointer', value: 'coarse' }] });
      } catch (e) { console.log('note: pointer media emulation unavailable:', e.message); }
      await page.setViewport({ width: 412, height: 915, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
      await loadBase(page);
      let h = await help(page);
      results.touchSignals = h.signals;
      check('touch: input class detected as touch', h.isTouch === true, JSON.stringify(h.signals));
      check('touch: help visible on arrival', h.visible === true);
      check('touch: help speaks tap language', /Tap/.test(h.text) && /thumb stick/.test(h.text), h.text.slice(0, 60) + '…');
      check('touch: outdoor help states the construction legend verbatim',
        h.text.includes('Finished buildings are FedRAMP authorized. Scaffolded buildings are still in the authorization process.'),
        h.text.slice(-90));
      check('touch: help names no keyboard control',
        !/WASD|Shift|mouse|press/i.test(h.text) && !/\bE\b/.test(h.text.replace('EXIT', '').replace('Everything', '')),
        h.text.slice(0, 80) + '…');
      await page.screenshot({ path: path.join(__dirname, 'help-touch.png') });

      const door = await standAtDoor(page, catalog);
      check('touch: door zone armed near a building', !!door && !!door.screen, door && door.name);
      h = await help(page);
      check('touch: door prompt speaks tap language', !!h.prompt && /Tap the door/.test(h.prompt), h.prompt || 'no prompt');
      await tapAt(page, Math.round(door.screen.x), Math.round(door.screen.y));
      let ist = await until(page, 'window.__BASE__.interiorState()', 5000);
      check('touch: tapping the door enters the building', !!ist && !!door && ist.vendor === door.name, ist && ist.vendor);

      h = await help(page);
      check('touch: indoor help variant appears on first entry', h.visible === true && h.space === 'in', `space=${h.space}`);
      check('touch: indoor help names no keyboard control',
        !/WASD|Shift|mouse|press/i.test(h.text) && /EXIT/.test(h.text), h.text.slice(0, 80) + '…');
      await sleep(DWELL_WAIT);
      h = await helpOpacity(page, (o) => o < 0.05);
      check('touch: indoor help faded after the dwell', h.faded === true && h.opacity < 0.05, `opacity=${h.opacity}`);

      const atExit = await standAtExit(page);
      check('touch: EXIT zone reached indoors', !!atExit && atExit.atExit === true);
      /* the prompt refreshes on the game's stats timer; poll for it */
      h = await help(page);
      for (let i = 0; i < 14 && !h.prompt; i++) { await sleep(400); h = await help(page); }
      check('touch: EXIT prompt speaks tap language', !!h.prompt && /^Tap/.test(h.prompt), h.prompt || 'no prompt');
      await tapAt(page, 206, 450);
      ist = await page.evaluate('window.__BASE__.interiorState()');
      check('touch: tapping at the EXIT door returns outside', ist === null);

      const btn = await page.$('#helpBtn');
      const box = await btn.boundingBox();
      await tapAt(page, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
      h = await helpOpacity(page, (o) => o > 0.9);
      check('touch: "?" button recalls the outdoor help', h.visible === true && h.space === 'out', `space=${h.space} opacity=${h.opacity}`);
      check('touch: zero JS errors', errors.length === 0, errors.join(' | '));
      await page.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
  results.failures = failures;
  fs.writeFileSync(path.join(__dirname, 'results-platform.json'), JSON.stringify(results, null, 1) + '\n');
  console.log(failures === 0 ? '\nALL PLATFORM CHECKS PASSED' : `\n${failures} PLATFORM CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('verify-platform crashed:', e); process.exit(2); });
