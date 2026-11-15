#!/usr/bin/env node
/*
 * DeadRamp Base verification: Phase 3, the WebXR control layer.
 *
 * What this suite proves, and what it cannot:
 *
 * This environment (headless Chrome, SwiftShader) has no XR runtime:
 * there is no headset, no XRWebGLLayer against a real session, and a
 * fabricated session object cannot carry Three's WebXRManager past
 * session setup. True presentation is therefore NOT emulated here,
 * and this suite does not claim it. What it verifies is everything
 * up to the session boundary, in two contexts:
 *
 *  - No-XR context (stock headless Chrome): the page loads with zero
 *    JS errors, the renderer has XR enabled, feature detection and
 *    the Enter VR affordance agree (no dead button: if immersive-vr
 *    is not supported, the button never appears), prompts stay in
 *    keyboard language, and the flat loop still renders and moves.
 *
 *  - Stubbed-XR context: an XRSystem stub is installed before the
 *    page's scripts run. It reports immersive-vr as supported but
 *    refuses every session request. The suite then proves the real
 *    affordance appears, and that clicking it runs the full
 *    reference-space negotiation ladder against the stub, in order
 *    (local-floor required, then local with local-floor optional,
 *    then viewer), fails cleanly with the error recorded, leaves the
 *    button usable, produces zero JS errors, and leaves the flat
 *    experience fully intact afterwards.
 *
 * What remains for the on-device check on Aries's Quest 2 (the known,
 * accepted Phase 3 gate; see release-notes-v0.3.0.md): session start
 * from the button in Quest Browser, headset pose driving the view,
 * thumbstick locomotion and snap turn feel, the spiral climb in VR,
 * trigger picking and the in-world record card, gaze dwell on a
 * controller-less device, prompt/help language inside the headset,
 * exit returning to the exact flat view, and frame rate in the
 * densest district.
 *
 * Usage: node verify/verify-xr.js   (exit code 0 = all checks pass)
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('/home/hatch/workspace/.pptr/node_modules/puppeteer-core');

const REPO = path.resolve(__dirname, '..');
const EXE = '/home/hatch/workspace/.pptr/chrome-headless-shell/linux-157.0.8103.78/chrome-headless-shell-linux64/chrome-headless-shell';
const PORT = 8934;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.md': 'text/markdown', '.png': 'image/png' };

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

const XR_STUB = `
window.__XR_STUB_CALLS__ = [];
(function () {
  const calls = window.__XR_STUB_CALLS__;
  const fns = {
    isSessionSupported: (mode) => {
      calls.push({ fn: 'isSessionSupported', mode });
      return Promise.resolve(mode === 'immersive-vr');
    },
    requestSession: (mode, opts) => {
      calls.push({ fn: 'requestSession', mode, opts: JSON.parse(JSON.stringify(opts || {})) });
      const e = new Error('stub: immersive session unavailable in headless test');
      e.name = 'NotSupportedError';
      return Promise.reject(e);
    },
  };
  if ('xr' in navigator && navigator.xr) {
    navigator.xr.isSessionSupported = fns.isSessionSupported;
    navigator.xr.requestSession = fns.requestSession;
  } else {
    Object.defineProperty(window.navigator, 'xr', {
      configurable: true, writable: true,
      value: Object.assign({ addEventListener() {}, removeEventListener() {} }, fns),
    });
  }
})();
`;

async function newObservedPage(browser, stubXR) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const pageErrors = [], consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  if (stubXR) await page.evaluateOnNewDocument(XR_STUB);
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction('window.__BASE_READY__ === true', { timeout: 30000 });
  await sleep(900);
  return { page, pageErrors, consoleErrors };
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
    /* ---------- context A: no XR runtime (stock headless) ---------- */
    {
      const { page, pageErrors, consoleErrors } = await newObservedPage(browser, false);
      const xr = await page.evaluate('window.__BASE__.xr()');
      results.noXR = xr;
      console.log('no-XR context xr():', JSON.stringify(xr));
      check('A: page loaded with zero JS page errors', pageErrors.length === 0, pageErrors.join(' | '));
      if (consoleErrors.length) console.log('A console errors (informational):', consoleErrors.join(' | '));
      check('A: renderer has WebXR enabled', xr.xrEnabled === true);
      check('A: not presenting', xr.presenting === false);
      check('A: Enter VR affordance matches feature detection (never a dead button)',
        xr.buttonVisible === xr.supported, `supported=${xr.supported} buttonVisible=${xr.buttonVisible}`);
      check('A: no negotiation attempted at load', xr.attempts.length === 0 && xr.requesting === false);
      check('A: in-world XR panels all hidden on the flat view',
        !xr.panels.help && !xr.panels.card && !xr.panels.prompt && !xr.panels.reticle);
      const help = await page.evaluate('window.__BASE__.help()');
      check('A: help speaks keyboard language (mode kb)', help.mode === 'kb' && /WASD/.test(help.text), `mode=${help.mode}`);
      const stats = await page.evaluate('window.__BASE_STATS__()');
      check('A: world stats match the catalog', stats.vendorsRendered === catalog.meta.vendors && stats.offeringsIndexed === catalog.meta.offerings,
        `${stats.vendorsRendered} vendors, ${stats.offeringsIndexed} offerings`);
      const px = await page.evaluate('window.__BASE__.samplePixels()');
      check('A: flat frame renders (non-background fraction above 0.10)', px.nonBgFraction > 0.10, `nonBg=${px.nonBgFraction.toFixed(3)}`);
      const before = await page.evaluate('window.__BASE__.getCamera()');
      await page.evaluate('window.__BASE__.setMove({ forward: 1 })');
      let moved = 0, after = before;
      for (let i = 0; i < 10 && moved <= 3; i++) {
        await sleep(500);
        after = await page.evaluate('window.__BASE__.getCamera()');
        moved = Math.hypot(after.x - before.x, after.z - before.z);
      }
      await page.evaluate('window.__BASE__.setMove({ forward: 0 })');
      check('A: flat movement still works under the animation loop', moved > 3, `moved=${moved.toFixed(2)} m`);
      /* read the player and the rig in one evaluation, after a settle
       * wait with input zeroed: two separate reads race the live loop
       * (the player keeps moving between them), one atomic read does
       * not */
      await sleep(400);
      const both = await page.evaluate('({ cam: window.__BASE__.getCamera(), rig: window.__BASE__.xr().rig })');
      check('A: rig carries the player position (x/z match, y is ground level)',
        Math.abs(both.rig.x - both.cam.x) < 0.001 && Math.abs(both.rig.z - both.cam.z) < 0.001 &&
        Math.abs(both.rig.y - (both.cam.y - 1.7)) < 0.001,
        JSON.stringify(both));
      check('A: zero JS page errors across the context', pageErrors.length === 0, pageErrors.join(' | '));
      await page.close();
    }

    /* ---------- context B: stubbed XRSystem, sessions refused ---------- */
    {
      const { page, pageErrors, consoleErrors } = await newObservedPage(browser, true);
      const xr0 = await page.evaluate('window.__BASE__.xr()');
      results.stubXR = { before: xr0 };
      console.log('stub-XR context xr() before click:', JSON.stringify(xr0));
      check('B: page loaded with zero JS page errors', pageErrors.length === 0, pageErrors.join(' | '));
      if (consoleErrors.length) console.log('B console errors (informational):', consoleErrors.join(' | '));
      check('B: stubbed immersive-vr detected as supported', xr0.supported === true);
      check('B: Enter VR button appears once support is proven', xr0.buttonVisible === true && xr0.buttonText === 'Enter VR',
        `text=${JSON.stringify(xr0.buttonText)}`);
      await page.click('#vrBtn');
      await page.waitForFunction('window.__BASE__.xr().requesting === false', { timeout: 15000 });
      await sleep(300);
      const xr1 = await page.evaluate('window.__BASE__.xr()');
      const calls = await page.evaluate('window.__XR_STUB_CALLS__');
      results.stubXR.after = xr1;
      results.stubXR.calls = calls;
      console.log('stub-XR calls:', JSON.stringify(calls));
      console.log('stub-XR context xr() after click:', JSON.stringify(xr1));
      const reqs = calls.filter((c) => c.fn === 'requestSession');
      check('B: the click ran the session negotiation (3 attempts)', reqs.length === 3, `${reqs.length} requestSession calls`);
      check('B: attempt 1 requires local-floor', !!reqs[0] && JSON.stringify(reqs[0].opts.requiredFeatures || []) === '["local-floor"]',
        reqs[0] ? JSON.stringify(reqs[0].opts) : 'none');
      check('B: attempt 2 falls back to local with local-floor optional',
        !!reqs[1] && !reqs[1].opts.requiredFeatures && (reqs[1].opts.optionalFeatures || []).includes('local-floor'),
        reqs[1] ? JSON.stringify(reqs[1].opts) : 'none');
      check('B: attempt 3 falls back to a plain viewer request',
        !!reqs[2] && !reqs[2].opts.requiredFeatures && !reqs[2].opts.optionalFeatures,
        reqs[2] ? JSON.stringify(reqs[2].opts) : 'none');
      check('B: page recorded the ladder in order', JSON.stringify(xr1.attempts) === '["local-floor","local","viewer"]',
        JSON.stringify(xr1.attempts));
      check('B: failure is recorded, not swallowed', typeof xr1.lastError === 'string' && xr1.lastError.includes('stub'),
        String(xr1.lastError));
      check('B: not presenting after a refused negotiation', xr1.presenting === false && xr1.refSpace === null);
      const btn = await page.evaluate(`({ disabled: document.getElementById('vrBtn').disabled, text: document.getElementById('vrBtn').textContent, display: document.getElementById('vrBtn').style.display })`);
      check('B: button restored for another attempt', btn.disabled === false && btn.text === 'Enter VR' && btn.display === 'block',
        JSON.stringify(btn));
      const stats = await page.evaluate('window.__BASE_STATS__()');
      check('B: flat world intact after the failed negotiation',
        stats.vendorsRendered === catalog.meta.vendors && stats.offeringsIndexed === catalog.meta.offerings);
      const px = await page.evaluate('window.__BASE__.samplePixels()');
      check('B: flat frame still renders', px.nonBgFraction > 0.10, `nonBg=${px.nonBgFraction.toFixed(3)}`);
      check('B: zero JS page errors across the context', pageErrors.length === 0, pageErrors.join(' | '));
      await page.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
  results.failures = failures;
  fs.writeFileSync(path.join(__dirname, 'results-xr.json'), JSON.stringify(results, null, 1) + '\n');
  console.log('\nNOTE: presentation itself is not emulated in this environment; see the header for the on-device checklist.');
  console.log(failures === 0 ? '\nALL XR BOUNDARY CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('verify-xr crashed:', e); process.exit(2); });
