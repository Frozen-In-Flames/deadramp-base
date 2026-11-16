#!/usr/bin/env node
/*
 * DeadRamp Base verification: the interior spiral climb, on foot.
 *
 * The Phase 2 suite positions its interior cameras with
 * interiorTeleport, so it never proved the one thing a visitor does:
 * walk up the coil. This test enters IBM (the largest building, 10
 * rooms) through the real door path (stand at the door, press E),
 * then climbs using ONLY the movement path: W held through the game's
 * own key handler, steering by lookAt (the harness stand-in for mouse
 * look, as in verify.js). No interiorTeleport, no setCamera, no
 * position writes of any kind after entry; every metre of travel and
 * every centimetre of height comes out of stepMovement +
 * resolveInteriorMove. Floor height is logged the whole way, on the
 * approach across the lobby (which must stay on floor 0 while passing
 * under the coil) and up the coil itself (which must gain one floor
 * height per flight and reach floor 3).
 *
 * The surface the height function selected is inferred per sample by
 * comparing the reported floorY against the coil geometry: a whole
 * multiple of FH is a flat floor / landing; a non-multiple within
 * 0.35 m of a flight's helical height at that angle is the ramp.
 *
 * A third leg walks the open well: from the floor-3 landing back
 * along the band over flight 2's span, where the floor is cut and
 * the flat candidate is withheld, proving the visitor steps down
 * onto the ramp instead of standing on air over the well.
 *
 * A fourth leg climbs the full height of the tower to the top
 * door (floor 10), with per-door height checks at unwrapped
 * angles and a step into the top room: the whole coil is
 * walkable, not just its first three floors.
 *
 * Usage: node verify/verify-walk.js   (exit code 0 = climb works)
 */
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('/home/hatch/workspace/.pptr/node_modules/puppeteer-core');

const REPO = path.resolve(__dirname, '..');
const EXE = '/home/hatch/workspace/.pptr/chrome-headless-shell/linux-157.0.8103.78/chrome-headless-shell-linux64/chrome-headless-shell';
const PORT = 8933;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.md': 'text/markdown', '.png': 'image/png' };

/* interior layout constants, mirrored from js/main.js */
const FH = 3.4, R_OUT = 15;
const DOOR_STEP = 1.35;
const doorAngle = (j) => 0.9 + j * DOOR_STEP;
const angNorm = (a) => { a %= Math.PI * 2; return a < 0 ? a + Math.PI * 2 : a; };
const RAMP_R_MIN = R_OUT - 4.9; // ramp height band is [R_OUT-4.9, R_OUT-0.5]
const COIL_R = 12.3; // middle of the ramp ribbon [10.4, 13.6]

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

/* helical height of every flight whose span contains theta (stacked
 * coil: more than one flight can claim an angle), at ramp radius */
function rampHeightsAt(theta, r, levels) {
  const out = [];
  if (r < RAMP_R_MIN || r > R_OUT - 0.5) return out;
  for (let j = 0; j < levels; j++) {
    const a0 = j === 0 ? 0.2 : doorAngle(j - 1), a1 = doorAngle(j);
    const span = angNorm(a1 - a0), rel = angNorm(theta - a0);
    if (rel <= span) out.push({ flight: j, h: j * FH + (rel / span) * FH });
  }
  return out;
}
function classify(s, levels) {
  const whole = Math.round(s.floorY / FH) * FH;
  if (Math.abs(s.floorY - whole) <= 0.06) return 'floor';
  const hs = rampHeightsAt(s.theta, s.r, levels);
  if (hs.some(({ h }) => Math.abs(h - s.floorY) <= 0.35)) return 'ramp';
  return 'other';
}

(async () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'base-catalog.json'), 'utf8'));
  const ibm = catalog.vendors.find((v) => v.name === 'IBM');
  if (!ibm) { console.error('IBM not in catalog'); process.exit(2); }
  const srv = await serve();
  const browser = await puppeteer.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const results = { vendor: ibm.name, levels: ibm.offeringCount };
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction('window.__BASE_READY__ === true', { timeout: 30000 });
    await sleep(800);

    /* ---- entry through the normal door path (as verify-platform) ---- */
    const fx = Math.sin(ibm.rotationY), fz = Math.cos(ibm.rotationY);
    const doorPt = {
      x: ibm.position.x + fx * (ibm.size.d / 2 + 1.5),
      z: ibm.position.z + fz * (ibm.size.d / 2 + 1.5),
    };
    await page.evaluate(`window.__BASE__.setCamera({ x: ${doorPt.x + fx * 4}, z: ${doorPt.z + fz * 4} })`);
    await page.evaluate(`window.__BASE__.lookAt(${doorPt.x}, ${doorPt.z})`);
    let door = null;
    for (let i = 0; i < 25 && !door; i++) {
      door = await page.evaluate('window.__BASE__.door()');
      if (door && door.name !== ibm.name) door = null;
      if (!door) await sleep(400);
    }
    check('door zone armed at IBM', !!door, door && door.name);
    await page.keyboard.press('KeyE');
    let ist = null;
    for (let i = 0; i < 15 && !ist; i++) {
      ist = await page.evaluate('window.__BASE__.interiorState()');
      if (!ist) await sleep(400);
    }
    check('E at the door enters IBM', !!ist && ist.vendor === ibm.name, ist && ist.vendor);
    check('entry lands on the lobby floor', !!ist && Math.abs(ist.floorY) < 0.01, ist && `floorY=${ist.floorY}`);

    /* ---- walk-only locomotion with a floor-height trace ---- */
    const trace = [];
    const t0 = Date.now();
    async function sample(leg) {
      const s = await page.evaluate(`(() => {
        const c = window.__BASE__.getCamera();
        const i = window.__BASE__.interiorState();
        return { x: c.x, z: c.z, floorY: i ? i.floorY : null };
      })()`);
      if (s.floorY === null) return null;
      const rec = {
        leg, t: (Date.now() - t0) / 1000,
        x: s.x, z: s.z,
        r: Math.hypot(s.x, s.z),
        theta: angNorm(Math.atan2(s.z, s.x)),
        floorY: s.floorY,
      };
      rec.surface = classify(rec, ibm.offeringCount);
      trace.push(rec);
      return rec;
    }
    let walking = false;
    async function walkTo(tx, tz, leg, timeoutMs = 90000) {
      if (!walking) { await page.keyboard.down('KeyW'); walking = true; }
      const start = Date.now();
      let cur = await sample(leg);
      while (Date.now() - start < timeoutMs) {
        if (Math.hypot(cur.x - tx, cur.z - tz) < 1.1) return cur;
        await page.evaluate(`window.__BASE__.lookAt(${tx}, ${tz})`);
        await sleep(180);
        cur = await sample(leg);
      }
      return cur;
    }
    async function stopWalking() {
      if (walking) { await page.keyboard.up('KeyW'); walking = false; }
    }

    /* leg 1: around the lobby ring to above the foot of the coil.
     * Waypoints follow the ring (a straight line from spawn to the
     * foot would cut across the core railing's exclusion disc, and
     * bounds-only collision has no slide; a visitor walks the ring).
     * The route passes under flights 1 and 2 and along flight 0's
     * span at ring radius; the lobby floor must hold the whole way
     * (the ramp passes from 4.2 m overhead down to 1.7 m at the
     * last waypoint, always more than a step above the floor). */
    for (const th of [2.0, 1.6, 1.2, 0.8, 0.55]) {
      await walkTo(Math.cos(th) * 10.5, Math.sin(th) * 10.5, 'approach', 45000);
    }
    await stopWalking();
    const approach = trace.filter((s) => s.leg === 'approach');
    const approachMax = Math.max(...approach.map((s) => s.floorY));
    results.approachMaxFloorY = approachMax;
    check('approach: lobby floor holds while crossing under the coil (max floorY below 0.6 m)',
      approachMax < 0.6, `max=${approachMax.toFixed(2)} m over ${approach.length} samples`);

    /* leg 2: out to the foot of flight 0, then up the coil,
     * waypoints every 0.25 rad of arc at ramp radius, to just past
     * the floor-3 door at theta = doorAngle(2) = 3.6 */
    const climbStart = trace.length;
    await walkTo(Math.cos(0.18) * COIL_R, Math.sin(0.18) * COIL_R, 'climb', 45000);
    for (let th = 0.35; th <= 3.78; th += 0.25) {
      await walkTo(Math.cos(th) * COIL_R, Math.sin(th) * COIL_R, 'climb', 45000);
    }
    await stopWalking();
    await sleep(700);
    const finalSample = await sample('settle');
    const climb = trace.slice(climbStart);
    const maxFloorY = Math.max(...climb.map((s) => s.floorY));
    results.maxFloorY = maxFloorY;
    results.finalFloorY = finalSample ? finalSample.floorY : null;

    /* height at each door crossing: the sample nearest the door
     * angle during the climb should sit at that floor's height */
    results.doors = [];
    for (let j = 0; j < 3; j++) {
      const da = doorAngle(j), want = (j + 1) * FH;
      let best = null, bd = Infinity;
      for (const s of climb) {
        const d = Math.abs(s.theta - da);
        if (d < bd) { bd = d; best = s; }
      }
      results.doors.push({ flight: j, doorAngle: da, expected: want, got: best ? best.floorY : null });
      check(`door ${j + 1}: floor height at the door angle is floor ${j + 1} (${want.toFixed(1)} m)`,
        !!best && Math.abs(best.floorY - want) <= 0.7,
        best ? `floorY=${best.floorY.toFixed(2)} at theta=${best.theta.toFixed(2)}` : 'no sample');
    }
    /* the climb must ride the ramp, not hop between floors */
    const riding = climb.filter((s) => s.floorY > 0.3);
    const onRamp = riding.filter((s) => s.surface === 'ramp' || Math.abs(s.floorY - Math.round(s.floorY / FH) * FH) <= 0.06);
    const rampOnly = riding.filter((s) => s.surface === 'ramp');
    results.climbSamples = climb.length;
    results.rampSamples = rampOnly.length;
    check('climb: height tracks the helical ramp surface (over half of risen samples on the ramp)',
      riding.length > 0 && rampOnly.length / riding.length > 0.5,
      `${rampOnly.length}/${riding.length} risen samples classified ramp`);
    check('climb: reaches floor 3 height (10.2 m)', maxFloorY >= 3 * FH - 0.35, `max=${maxFloorY.toFixed(2)} m`);
    check('climb: ends standing at floor 3', !!finalSample && finalSample.floorY >= 3 * FH - 0.35,
      finalSample ? `final=${finalSample.floorY.toFixed(2)} m` : 'no sample');

    /* leg 3: the open well, walked. The route matters: a visitor
     * who stays on flight 2 is carried by flight continuity on any
     * tree, so this leg first steps off the coil onto floor 3's
     * inner ring (which clears the flight state, as stepping onto
     * any landing does), walks the ring to theta 3.0, then walks
     * back out into the ramp band over flight 2's span. That sector
     * of floor 3's band is cut (the well), and the height function
     * withholds its flat candidate over exactly the cut sector, so
     * stepping out must put the visitor on flight 2's surface,
     * tracking its helical height. On the pre-fix tree the flat
     * candidate held 10.2 m across the whole ring and the outward
     * step walked on air at floor-3 height over the slab: the final
     * sample read 10.2 m and both checks below failed. */
    const wellStart = trace.length;
    await walkTo(Math.cos(3.6) * 7.5, Math.sin(3.6) * 7.5, 'well', 45000);
    await walkTo(Math.cos(3.0) * 7.5, Math.sin(3.0) * 7.5, 'well', 45000);
    await walkTo(Math.cos(3.0) * COIL_R, Math.sin(3.0) * COIL_R, 'well', 45000);
    await stopWalking();
    await sleep(600);
    const wellEnd = await sample('well');
    const f2Height = (th) => 2 * FH + ((th - doorAngle(1)) / DOOR_STEP) * FH;
    results.well = {
      samples: trace.length - wellStart,
      end: wellEnd ? { theta: wellEnd.theta, floorY: wellEnd.floorY, expected: f2Height(wellEnd.theta), surface: wellEnd.surface } : null,
    };
    check('well: stepping into the open well leaves floor-3 height (no standing on air)',
      !!wellEnd && wellEnd.floorY <= 3 * FH - 1.2,
      wellEnd ? `floorY=${wellEnd.floorY.toFixed(2)} m` : 'no sample');
    check('well: the visitor lands on flight 2 and tracks its helical height',
      !!wellEnd && Math.abs(wellEnd.floorY - f2Height(wellEnd.theta)) <= 0.45 && wellEnd.surface === 'ramp',
      wellEnd ? `floorY=${wellEnd.floorY.toFixed(2)} expected=${f2Height(wellEnd.theta).toFixed(2)} at theta=${wellEnd.theta.toFixed(2)} surface=${wellEnd.surface}` : 'no sample');

    /* leg 4: the full-height climb. Aries's playtest (Nov 16,
     * 2026) found 3 of Oracle's 6 rooms; the legs above prove the
     * coil only to floor 3, so this leg climbs the whole tower:
     * from leg 3's end on flight 2 back up and on to the top door
     * (door 10, unwrapped angle doorAngle(9) = 13.05 rad). The
     * unwrapped-angle tracker is seeded HERE, at the start of this
     * monotonic climb, and accumulates only across it: seeding it
     * any earlier conflates the approach (which descends in angle)
     * with the climb and shifts every door reading, the exact
     * instrument error that briefly agreed with the playtest. */
    let unwrapped = null, lastTh = null;
    async function sampleU(leg) {
      const s = await sample(leg);
      if (!s) return null;
      if (unwrapped === null) { unwrapped = s.theta; lastTh = s.theta; }
      else {
        let d = s.theta - lastTh;
        d = ((d % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
        unwrapped += d; lastTh = s.theta;
      }
      s.unwrapped = unwrapped;
      return s;
    }
    async function walkToU(tx, tz, leg, timeoutMs = 90000) {
      if (!walking) { await page.keyboard.down('KeyW'); walking = true; }
      const start = Date.now();
      let cur = await sampleU(leg);
      while (Date.now() - start < timeoutMs) {
        if (Math.hypot(cur.x - tx, cur.z - tz) < 1.1) return cur;
        await page.evaluate(`window.__BASE__.lookAt(${tx}, ${tz})`);
        await sleep(180);
        cur = await sampleU(leg);
      }
      return cur;
    }
    const climb2Start = trace.length;
    await sampleU('climb2');
    const seedU = unwrapped;
    for (let th = seedU + 0.25; th <= doorAngle(9) + 0.3; th += 0.25) {
      await walkToU(Math.cos(th) * COIL_R, Math.sin(th) * COIL_R, 'climb2', 90000);
    }
    await stopWalking();
    await sleep(700);
    const topSample = await sampleU('climb2');
    const climb2 = trace.slice(climb2Start);
    const maxFloorY2 = Math.max(...climb2.map((s) => s.floorY));
    results.maxFloorYFull = maxFloorY2;
    results.topUnwrapped = topSample ? topSample.unwrapped : null;
    /* doors 4..10 by unwrapped angle (doors 1..3 were checked in
     * leg 2, where absolute theta is the unwrapped angle) */
    results.doorsFull = [];
    for (let j = 3; j < 10; j++) {
      const da = doorAngle(j), want = (j + 1) * FH;
      let best = null, bd = Infinity;
      for (const s of climb2) {
        if (s.unwrapped === undefined) continue;
        const d = Math.abs(s.unwrapped - da);
        if (d < bd) { bd = d; best = s; }
      }
      results.doorsFull.push({ flight: j, doorAngle: da, expected: want, got: best ? best.floorY : null });
      check(`full climb: door ${j + 1} floor height at its unwrapped angle is floor ${j + 1} (${want.toFixed(1)} m)`,
        !!best && Math.abs(best.floorY - want) <= 0.7,
        best ? `floorY=${best.floorY.toFixed(2)} at unwrapped=${best.unwrapped.toFixed(2)}` : 'no sample');
    }
    check('full climb: reaches the top floor height (34.0 m)', maxFloorY2 >= 10 * FH - 0.35,
      `max=${maxFloorY2.toFixed(2)} m`);
    /* step off the coil at the top door angle into the top room */
    const topA = doorAngle(9);
    await walkTo(Math.cos(topA) * 18.8, Math.sin(topA) * 18.8, 'climb2', 45000);
    await stopWalking();
    await sleep(500);
    const topRoomState = await page.evaluate('window.__BASE__.interiorState()');
    results.topRoom = topRoomState ? topRoomState.currentRoom : null;
    check('full climb: stepping in at the top door lands in the top room (index 9)',
      !!topRoomState && topRoomState.currentRoom === 9,
      `currentRoom=${topRoomState && topRoomState.currentRoom}`);
    check('zero JS errors across the walk', pageErrors.length === 0, pageErrors.join(' | '));

    /* the trace, decimated for the log */
    console.log('\nheight trace (leg t theta r floorY surface):');
    for (const s of trace) {
      console.log(`  ${s.leg.padEnd(8)} ${s.t.toFixed(1).padStart(6)}s th=${s.theta.toFixed(2)} r=${s.r.toFixed(1)} floorY=${s.floorY.toFixed(2)} ${s.surface}`);
    }
    results.trace = trace;
  } finally {
    await browser.close();
    srv.close();
  }
  results.failures = failures;
  fs.writeFileSync(path.join(__dirname, 'results-walk.json'), JSON.stringify(results, null, 1) + '\n');
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('verify-walk crashed:', e); process.exit(2); });
