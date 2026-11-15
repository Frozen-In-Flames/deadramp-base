/*
 * DeadRamp Base, Phase 1: spiral city exterior.
 *
 * The whole world is generated at load from data/base-catalog.json
 * (exported from the DeadRamp registry by tools/export-catalog.js).
 * Zero hand-placed buildings. Layout math: see LAYOUT.md.
 *
 * Rendering discipline for the Quest 2 floor: buildings, lit-window
 * overlays, roof trims and gate pylons are each a single InstancedMesh;
 * ground discs and roads are each one merged geometry. Structure is
 * rig-friendly: the world hangs off `worldGroup`, the player off
 * `player` (position + yaw/pitch), so a WebXR rig can replace the
 * control layer in Phase 3 without touching world generation.
 */
import * as THREE from 'three';

const EYE = 1.7;
const WALK_SPEED = 14;
const FAST_MULT = 3.5;
const LABEL_VENDOR_RANGE = 150;
const LABEL_DISTRICT_RANGE = 750;

/* ---------------- small deterministic helpers ---------------- */
function lcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function hexColor(hex) { return new THREE.Color(hex); }
function mixColor(a, b, t) { return a.clone().lerp(b, t); }

/* Merge non-indexed geometries that carry position/normal/color. */
function mergeGeoms(geoms) {
  let total = 0;
  for (const g of geoms) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let o = 0;
  for (const g of geoms) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}
function coloredGeom(geom, color) {
  const g = geom.index ? geom.toNonIndexed() : geom;
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = color.r; arr[i * 3 + 1] = color.g; arr[i * 3 + 2] = color.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
/* Road ribbon along a polyline of [x, z] points. */
function ribbonGeom(points, width, y, color) {
  const n = points.length;
  const pos = [], nor = [], col = [], idx = [];
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = points[Math.min(i + 1, n - 1)], r = points[Math.max(i - 1, 0)];
    let tx = q[0] - r[0], tz = q[1] - r[1];
    const m = Math.hypot(tx, tz) || 1; tx /= m; tz /= m;
    const nx = -tz, nz = tx, hw = width / 2;
    pos.push(p[0] + nx * hw, y, p[1] + nz * hw, p[0] - nx * hw, y, p[1] - nz * hw);
    nor.push(0, 1, 0, 0, 1, 0);
    col.push(color.r, color.g, color.b, color.r, color.g, color.b);
    if (i > 0) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  g.setIndex(idx);
  return g;
}
function mergeIndexed(geoms) {
  let vTotal = 0, iTotal = 0;
  for (const g of geoms) { vTotal += g.attributes.position.count; iTotal += g.index.count; }
  const pos = new Float32Array(vTotal * 3), nor = new Float32Array(vTotal * 3), col = new Float32Array(vTotal * 3);
  const idx = new Uint32Array(iTotal);
  let vo = 0, io = 0;
  for (const g of geoms) {
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    col.set(g.attributes.color.array, vo * 3);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
    vo += g.attributes.position.count; io += gi.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
function textTexture(lines, { w = 512, h = 128, bg = '#10141d', fg = '#ffd9a0', sub = '#9fb0c3' } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = bg; x.fillRect(0, 0, w, h);
  x.textAlign = 'center'; x.textBaseline = 'middle';
  if (lines.length >= 3) {
    x.fillStyle = fg; x.font = '30px sans-serif';
    lines.forEach((ln, i) => x.fillText(ln, w / 2, h / 2 + (i - (lines.length - 1) / 2) * 44));
  } else {
    x.fillStyle = fg; x.font = `700 ${lines.length > 1 ? 44 : 52}px sans-serif`;
    x.fillText(lines[0], w / 2, lines.length > 1 ? h / 2 - 24 : h / 2);
    if (lines.length > 1) { x.fillStyle = sub; x.font = '28px sans-serif'; x.fillText(lines[1], w / 2, h / 2 + 30); }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function windowTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 1024;
  const x = c.getContext('2d');
  x.clearRect(0, 0, 512, 1024);
  const rnd = lcg(20261114);
  const warm = ['#ffd9a0', '#fff3c4', '#ffb36b', '#ffe9b8'];
  const CW = 512 / 14, CH = 1024 / 30;
  for (let row = 0; row < 30; row++) for (let col = 0; col < 14; col++) {
    if (rnd() < 0.52) {
      x.fillStyle = warm[Math.floor(rnd() * warm.length)];
      x.globalAlpha = 0.55 + rnd() * 0.45;
      x.fillRect(col * CW + 5, row * CH + 6, CW - 12, CH - 15);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------------- boot ---------------- */
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = new THREE.Color(0x1b2436);
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 70, 560);

const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.1, 4000);
camera.rotation.order = 'YXZ';

scene.add(new THREE.HemisphereLight(0x93b8dd, 0x2c241a, 1.15));
const sun = new THREE.DirectionalLight(0xffb36b, 1.8);
sun.position.set(-0.45, 0.38, 0.25).multiplyScalar(1000);
scene.add(sun);
const fill = new THREE.DirectionalLight(0x6f87b8, 0.35);
fill.position.set(0.5, 0.6, -0.4).multiplyScalar(1000);
scene.add(fill);

const worldGroup = new THREE.Group();
scene.add(worldGroup);

const player = { x: 24, z: 0, y: EYE, yaw: -Math.PI / 2, pitch: 0 };
const state = {
  catalog: null, buildings: [], lots: [], districts: [],
  bodyMesh: null, lotMeshes: [], ready: false, frames: 0, fps: 0,
  selected: null,
  interior: null,          // Phase 2: active interior record, or null outside
  doorVendor: null,        // building whose door zone the player is in
  exteriorDrawCalls: 0,    // last exterior frame's draw calls (regression watch)
};

const TIER_TRIM = { l1: new THREE.Color(0xcd7f32), l2: new THREE.Color(0xcfd8dc), l3: new THREE.Color(0xffd700), untiered: new THREE.Color(0x546e7a) };
const GRAY = new THREE.Color(0x8a8d90);
const LIMESTONE = new THREE.Color(0xcfc9b8);
const WARM_GLASS = new THREE.Color(0xfff4e0);
/* The label, carried wherever a vendor is named (kiosk, info cards):
 * our rendition, their identity, endorsement never implied. */
const FRAMING = "Clean-room model built from public FedRAMP Marketplace information, inspired by the vendor's public brand identity. Not affiliated with or endorsed by the vendor.";

async function boot() {
  const res = await fetch('./data/base-catalog.json');
  const catalog = await res.json();
  state.catalog = catalog;
  buildWorld(catalog);
  document.getElementById('hudSub').textContent =
    `${catalog.meta.vendors} vendors · ${catalog.meta.offerings} offerings · ${catalog.meta.districts} districts · one spiral`;
  document.getElementById('loading').style.display = 'none';
  state.ready = true;
  window.__BASE_READY__ = true;
  showHelp('out');
}

function buildWorld(catalog) {
  const worldRadius = catalog.meta.worldRadius;

  /* ground */
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(worldRadius + 260, 72).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x2e3a2e }));
  ground.position.y = 0;
  worldGroup.add(ground);

  /* district ground discs, one merged geometry */
  const discs = [];
  for (const d of catalog.districts) {
    const c = hexColor(d.color).multiplyScalar(0.38);
    const g = new THREE.CircleGeometry(d.radius, 40).rotateX(-Math.PI / 2).translate(d.center.x, 0.02, d.center.z);
    discs.push(coloredGeom(g, c));
  }
  const discMesh = new THREE.Mesh(mergeGeoms(discs), new THREE.MeshLambertMaterial({ vertexColors: true }));
  worldGroup.add(discMesh);
  discs.forEach((g) => g.dispose());

  /* roads: boulevard + district sub-spiral ribbons, one merged geometry */
  const ribbons = [ribbonGeom(catalog.roads.boulevard, 13, 0.06, new THREE.Color(0x5a626d))];
  for (const d of catalog.districts) ribbons.push(ribbonGeom(d.road, 9, 0.05, new THREE.Color(0x474f59)));
  const roadMesh = new THREE.Mesh(mergeIndexed(ribbons), new THREE.MeshLambertMaterial({ vertexColors: true }));
  worldGroup.add(roadMesh);
  ribbons.forEach((g) => g.dispose());

  /* plaza + directory kiosk placeholder at the spiral centre */
  const plaza = new THREE.Mesh(
    new THREE.CircleGeometry(112, 56).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x50565f }));
  plaza.position.y = 0.04;
  worldGroup.add(plaza);
  const kiosk = new THREE.Group();
  const kioskMat = new THREE.MeshLambertMaterial({ color: 0x2b3444 });
  const kioskAccent = new THREE.MeshLambertMaterial({ color: 0xffb36b });
  const base = new THREE.Mesh(new THREE.BoxGeometry(7, 3.4, 1.4), kioskMat); base.position.y = 1.7;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.35, 2.4), kioskAccent); roof.position.y = 3.6;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(7.6, 1.7),
    new THREE.MeshBasicMaterial({ map: textTexture(['DEADRAMP BASE', 'Directory · full kiosk in Phase 2']) }));
  sign.position.set(0, 4.6, 0.2);
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.1, 0.3), kioskMat); legL.position.set(-3.4, 4.05, 0);
  const legR = legL.clone(); legR.position.x = 3.4;
  const plaque = new THREE.Mesh(new THREE.PlaneGeometry(9.6, 1.8),
    new THREE.MeshBasicMaterial({ map: textTexture([
      'Clean-room model built from public FedRAMP Marketplace information,',
      'inspired by the vendor\'s public brand identity.',
      'Not affiliated with or endorsed by the vendor.'], { w: 1024, h: 192, fg: '#c8cfda', sub: '#c8cfda' }) }));
  plaque.position.set(0, 1.75, 0.72);
  kiosk.add(base, roof, sign, legL, legR, plaque);
  kiosk.position.set(64, 0, 0);
  kiosk.rotation.y = -Math.PI / 2;
  worldGroup.add(kiosk);

  /* buildings */
  const buildings = catalog.vendors.filter((v) => v.kind === 'building');
  const lots = catalog.vendors.filter((v) => v.kind === 'lot');
  state.buildings = buildings; state.lots = lots; state.districts = catalog.districts;
  const districtById = new Map(catalog.districts.map((d) => [d.id, d]));

  const bodyGeo = new THREE.BoxGeometry(1, 1, 1); bodyGeo.translate(0, 0.5, 0);
  const bodyMesh = new THREE.InstancedMesh(bodyGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), buildings.length);
  const winMesh = new THREE.InstancedMesh(bodyGeo,
    new THREE.MeshBasicMaterial({ map: windowTexture(), transparent: true, alphaTest: 0.3, color: 0xffffff }), buildings.length);
  const roofGeo = new THREE.BoxGeometry(1, 1, 1);
  const roofMesh = new THREE.InstancedMesh(roofGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), buildings.length);
  const bandMesh = new THREE.InstancedMesh(roofGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), buildings.length);
  let winCount = 0;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), pv = new THREE.Vector3();
  buildings.forEach((v, i) => {
    /* Federal grammar is the constant: limestone massing, granite trim,
     * a signage band. The vendor's brand palette (evocation only, never
     * artwork) modulates the finish inside that grammar: facade tint
     * from the brand primary, trim from the secondary, the signage band
     * from the accent, glass tinted toward the primary. Vendors on the
     * default palette simply wear the federal finish. Status then
     * weathers the finish: pipeline work reads as unfinished. */
    const brand = v.brand || { primary: '#cfc9b8', secondary: '#4c5257', accent: '#8c6a2f', source: 'default' };
    const researched = brand.source === 'researched';
    let bodyCol = researched ? mixColor(hexColor(brand.primary), LIMESTONE, 0.55) : LIMESTONE.clone();
    if (v.statusClass === 'mixed') bodyCol = mixColor(bodyCol, GRAY, 0.25);
    else if (v.statusClass === 'pipeline') bodyCol = mixColor(bodyCol, GRAY, 0.60);
    e.set(0, v.rotationY, 0); q.setFromEuler(e);
    pv.set(v.position.x, 0, v.position.z); sc.set(v.size.w, v.size.h, v.size.d);
    m4.compose(pv, q, sc);
    bodyMesh.setMatrixAt(i, m4);
    bodyMesh.setColorAt(i, bodyCol);
    // roof trim from the brand secondary (federal granite by default)
    let trimCol = hexColor(brand.secondary);
    if (v.statusClass === 'pipeline') trimCol = mixColor(trimCol, GRAY, 0.4);
    pv.set(v.position.x, v.size.h + 0.18, v.position.z); sc.set(v.size.w * 1.07, 0.36, v.size.d * 1.07);
    m4.compose(pv, q, sc);
    roofMesh.setMatrixAt(i, m4);
    roofMesh.setColorAt(i, trimCol);
    // signage band from the brand accent (federal bronze by default)
    let bandCol = hexColor(brand.accent);
    if (v.statusClass === 'pipeline') bandCol = mixColor(bandCol, GRAY, 0.5);
    pv.set(v.position.x, v.size.h - 0.75, v.position.z); sc.set(v.size.w * 1.05, 0.85, v.size.d * 1.05);
    m4.compose(pv, q, sc);
    bandMesh.setMatrixAt(i, m4);
    bandMesh.setColorAt(i, bandCol);
    // lit windows at dusk for certified and mixed buildings, glass tinted by brand
    if (v.statusClass !== 'pipeline') {
      pv.set(v.position.x, 0.1, v.position.z); sc.set(v.size.w * 1.03, v.size.h * 0.985, v.size.d * 1.03);
      m4.compose(pv, q, sc);
      winMesh.setMatrixAt(winCount, m4);
      winMesh.setColorAt(winCount, researched ? mixColor(WARM_GLASS, hexColor(brand.primary), 0.30) : WARM_GLASS);
      winCount++;
    }
  });
  winMesh.count = winCount;
  bodyMesh.instanceMatrix.needsUpdate = true; roofMesh.instanceMatrix.needsUpdate = true; winMesh.instanceMatrix.needsUpdate = true; bandMesh.instanceMatrix.needsUpdate = true;
  if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
  if (roofMesh.instanceColor) roofMesh.instanceColor.needsUpdate = true;
  if (winMesh.instanceColor) winMesh.instanceColor.needsUpdate = true;
  if (bandMesh.instanceColor) bandMesh.instanceColor.needsUpdate = true;
  worldGroup.add(bodyMesh, roofMesh, winMesh, bandMesh);
  state.bodyMesh = bodyMesh;
  state.winCount = winCount;

  /* district gate pylons */
  const pylonGeo = new THREE.BoxGeometry(1.3, 8, 1.3); pylonGeo.translate(0, 4, 0);
  const pylons = new THREE.InstancedMesh(pylonGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), catalog.districts.length);
  catalog.districts.forEach((d, i) => {
    e.set(0, 0, 0); q.setFromEuler(e);
    pv.set(d.gate.x, 0, d.gate.z); sc.set(1, 1, 1);
    m4.compose(pv, q, sc);
    pylons.setMatrixAt(i, m4);
    pylons.setColorAt(i, TIER_TRIM[d.tierKey] || TIER_TRIM.untiered);
  });
  pylons.instanceMatrix.needsUpdate = true;
  if (pylons.instanceColor) pylons.instanceColor.needsUpdate = true;
  worldGroup.add(pylons);

  /* empty lots: slab + survey marker + sign */
  for (const v of lots) {
    const g = new THREE.Group();
    const slab = new THREE.Mesh(new THREE.BoxGeometry(16, 0.35, 13), new THREE.MeshLambertMaterial({ color: 0x555a52 }));
    slab.position.y = 0.18;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 3.4, 8), new THREE.MeshLambertMaterial({ color: 0xb9c4d4 }));
    pole.position.set(0, 1.7, -4);
    const signM = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 1.35),
      new THREE.MeshBasicMaterial({ map: textTexture(['SURVEYED LOT', v.name + ' · unclassified'], { bg: '#241a20', fg: '#f28ba8' }), side: THREE.DoubleSide }));
    signM.position.set(0, 3.1, -4);
    signM.rotation.y = v.rotationY + Math.PI;
    g.add(slab, pole, signM);
    g.position.set(v.position.x, 0, v.position.z);
    g.userData.vendor = v;
    worldGroup.add(g);
    state.lotMeshes.push(slab);
    slab.userData.vendor = v;
  }
}

/* ---------------- labels (pooled HTML overlays) ---------------- */
const labelHost = document.getElementById('labels');
function makePool(n, cls) {
  const pool = [];
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    el.className = 'lbl ' + cls;
    labelHost.appendChild(el);
    pool.push(el);
  }
  return pool;
}
const vendorLabels = makePool(18, '');
const districtLabels = makePool(8, 'district');
const projV = new THREE.Vector3();
function placeLabel(el, x, y, z, text, opacity) {
  projV.set(x, y, z).project(camera);
  if (projV.z > 1 || projV.z < -1) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.style.left = ((projV.x * 0.5 + 0.5) * window.innerWidth) + 'px';
  el.style.top = ((-projV.y * 0.5 + 0.5) * window.innerHeight) + 'px';
  el.style.opacity = opacity.toFixed(2);
  if (el.textContent !== text) el.textContent = text;
}
function updateLabels() {
  if (state.interior) {
    for (const el of vendorLabels) el.style.display = 'none';
    for (const el of districtLabels) el.style.display = 'none';
    return;
  }
  const px = player.x, pz = player.z;
  const cand = [];
  for (const v of state.buildings) {
    const dx = v.position.x - px, dz = v.position.z - pz;
    const d2 = dx * dx + dz * dz;
    if (d2 < LABEL_VENDOR_RANGE * LABEL_VENDOR_RANGE) cand.push({ v, d2 });
  }
  cand.sort((a, b) => a.d2 - b.d2);
  for (let i = 0; i < vendorLabels.length; i++) {
    const el = vendorLabels[i];
    if (i >= cand.length) { el.style.display = 'none'; continue; }
    const { v, d2 } = cand[i];
    const dist = Math.sqrt(d2);
    const op = Math.max(0.2, 1 - dist / LABEL_VENDOR_RANGE);
    placeLabel(el, v.position.x, v.size.h + 2.5, v.position.z, v.name, op);
  }
  let di = 0;
  for (const d of state.districts) {
    if (di >= districtLabels.length) break;
    const dx = d.center.x - px, dz = d.center.z - pz;
    const dist = Math.hypot(dx, dz);
    if (dist < LABEL_DISTRICT_RANGE) {
      placeLabel(districtLabels[di], d.gate.x, 11, d.gate.z, `${d.functionName} · ${d.tier}`, Math.max(0.3, 1 - dist / LABEL_DISTRICT_RANGE));
      di++;
    }
  }
  for (; di < districtLabels.length; di++) districtLabels[di].style.display = 'none';
}

/* ---------------- picking + info card ---------------- */
const raycaster = new THREE.Raycaster();
const card = document.getElementById('card');
const cardBody = document.getElementById('cardBody');
document.getElementById('cardClose').addEventListener('click', () => { card.style.display = 'none'; state.selected = null; });
const STATUS_TEXT = { certified: 'FedRAMP Certified', pipeline: 'In the pipeline', mixed: 'Mixed statuses' };
function showCard(v) {
  state.selected = v;
  const d = state.districts.find((x) => x.id === v.district);
  const rows = v.offerings.map((o) => {
    const meta = [o.service_model || 'model not stated', o.fedramp_impact_level, o.authorization_status].join(' · ');
    const unc = o.unclassified ? ' <span class="unc">UNCLASSIFIED IN THE DEADRAMP BUILD</span>' : '';
    return `<li><a href="${o.source_url}" target="_blank" rel="noopener">${o.product}</a>${unc}<br><span class="om">${meta}</span></li>`;
  }).join('');
  const lotNote = v.kind === 'lot'
    ? `<div class="note">Surveyed empty lot. This vendor's only offering is one of the two the DeadRamp build holds as honestly unclassified, so the Base shows the lot, not a building.</div>` : '';
  const brandLine = v.brand && v.brand.source === 'researched'
    ? `<div class="meta">Brand palette: researched from this vendor's public brand identity. Colours only, as evocation: no logo, wordmark, or trade dress is reproduced.</div>`
    : `<div class="meta">Brand palette: not yet researched, so this building wears the neutral federal finish.</div>`;
  cardBody.innerHTML =
    `<h3>${v.name}</h3>` +
    `<div class="meta">${d ? d.functionName + ' · ' + d.tier : ''} district · ${v.offeringCount} offering${v.offeringCount > 1 ? 's' : ''} · ` +
    `<span class="status-${v.statusClass}">${STATUS_TEXT[v.statusClass]}</span></div>` +
    brandLine +
    lotNote + `<ul>${rows}</ul>` +
    `<div class="framing">${FRAMING}</div>`;
  if (v.kind === 'building') {
    const btn = document.createElement('button');
    btn.className = 'enterBtn';
    btn.textContent = `Enter ${v.name}`;
    btn.addEventListener('click', () => { card.style.display = 'none'; enterBuilding(v); });
    cardBody.appendChild(btn);
  }
  card.style.display = 'block';
}
function pickAt(clientX, clientY) {
  if (state.interior) return false;
  const nx = (clientX / window.innerWidth) * 2 - 1;
  const ny = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera({ x: nx, y: ny }, camera);
  if (state.bodyMesh) {
    const hits = raycaster.intersectObject(state.bodyMesh);
    if (hits.length && hits[0].instanceId !== undefined) { showCard(state.buildings[hits[0].instanceId]); return true; }
  }
  const lotHits = raycaster.intersectObjects(state.lotMeshes);
  if (lotHits.length) { showCard(lotHits[0].object.userData.vendor); return true; }
  return false;
}

/* ---------------- Phase 2: interiors ----------------
 * One building at a time is built, on entry, from the catalog: a
 * federal lobby, then the building-scale spiral (a ramp winding
 * around a solid core, one offering room per floor, each floor's
 * door rotated by DOOR_STEP so the coil reads as you climb), and it
 * is disposed on exit. Rooms are archetypes by function, filled with
 * the offering's own record and its group's reference-build data.
 *
 * Brand treatment (Aries, Nov 14, 2026): the lobby is the building's
 * shared federal space with brand accents; in the offering rooms the
 * vendor's own colour scheme leads (wall treatment, trim, glass,
 * signage, accent light), inside the federal grammar's structure and
 * materials discipline. Researched palettes only; a default-palette
 * vendor's rooms wear the federal finish, never invented colours.
 *
 * Collision is bounds only, documented in LAYOUT.md: the walkable
 * region is the ring (between the core railing and the outer wall)
 * plus the chamber of the floor you are on; height comes from the
 * candidate surfaces (ring floor, ramp flight, landing, or chamber
 * floor) nearest to your current height, which is what makes the
 * stacked floors unambiguous, with one exception: the coil rule.
 * A ramp surface within a step of the current height takes over,
 * and a flight the player is already on keeps its surface, because
 * the flat floor at exactly the current height would otherwise win
 * the nearest contest forever and the coil could not be climbed on
 * foot (interiorHeightAt; proven by verify/verify-walk.js). */
const INT_Y = -2000;         // interior origin: far below the exterior world
const FH = 3.4;              // floor height
const R_CORE = 3;            // central column radius
const R_WELL = 5.6;          // core railing: inner walk boundary
const R_OUT = 15;            // ring outer wall radius
const CH_IN = 14.2;          // chamber inner face radius
const CH_OUT = 23.4;         // chamber outer wall radius
const CH_HALF_W = 5.0;       // chamber half width (tangential)
const DOOR_STEP = 1.35;      // radians of coil per floor
const EXIT_ANGLE = -0.9;
const SPAWN_ANGLE = 2.4;
const doorAngle = (j) => 0.9 + j * DOOR_STEP;
const angNorm = (a) => { a %= Math.PI * 2; return a < 0 ? a + Math.PI * 2 : a; };
const angDiff = (a, b) => Math.abs(angNorm(a - b + Math.PI) - Math.PI);
const FED = {
  limestone: new THREE.Color(0xb8b2a2), wall: new THREE.Color(0x9d978a),
  granite: new THREE.Color(0x4c5257), bronze: new THREE.Color(0x8c6a2f),
  floor: new THREE.Color(0x59616c), dark: new THREE.Color(0x20242c),
};
const STATUS_COLORS = { certified: '#58b368', other: '#e0a458' };
const ARCHETYPE_LABEL = {
  'ops-center': 'Operations center', 'server-hall': 'Server hall', 'lab': 'Laboratory',
  'meeting-space': 'Meeting space', 'ledger-office': 'Ledger office', 'federal-office': 'Federal office',
};

function wrapText(text, width) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    let line = '';
    for (const word of raw.split(/\s+/)) {
      if (!word) continue;
      if (line && line.length + 1 + word.length > width) { out.push(line); line = word; }
      else line = line ? line + ' ' + word : word;
      while (line.length > width) { out.push(line.slice(0, width)); line = line.slice(width); }
    }
    out.push(line);
  }
  return out;
}
function capLines(lines, max) {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max - 1);
  kept.push(`… (+${lines.length - (max - 1)} more in the source record)`);
  return kept;
}
/* A wall panel: canvas texture with a title bar in the accent colour
 * and wrapped body lines. Wrapping and the line cap are derived from
 * the panel's own pixel height, so text never overflows the panel;
 * overflow is acknowledged on the panel itself ("+N more in the
 * source record"). redraw(marker) re-renders with one body line
 * highlighted (used by the ops-center board). */
function makePanel(w, h, title, rawLines, accentCss) {
  const cw = 1024, chh = Math.round(1024 * h / w);
  const capacity = Math.max(4, Math.floor((chh - 100) / 33));
  const lines = capLines(rawLines.flatMap((l) => wrapText(l, 70)), capacity);
  const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = chh;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex }));
  function draw(marker = -1) {
    const x = canvas.getContext('2d');
    x.fillStyle = '#10141d'; x.fillRect(0, 0, cw, chh);
    x.fillStyle = accentCss; x.fillRect(0, 0, cw, 60);
    x.fillStyle = '#0d1017'; x.font = '700 28px sans-serif'; x.textAlign = 'left'; x.textBaseline = 'middle';
    x.fillText(title, 26, 32);
    x.font = '22px ui-monospace, Menlo, monospace';
    lines.forEach((ln, i) => {
      x.fillStyle = i === marker ? '#ffd9a0' : '#c8cfda';
      x.fillText((i === marker ? '▸ ' : '') + ln, 26, 98 + i * 33);
    });
    tex.needsUpdate = true;
  }
  draw();
  mesh.userData.redrawPanel = draw;
  mesh.userData.panelLines = lines;
  return mesh;
}

/* ---- the words on the walls: all from the catalog record ---- */
function districtNameOf(o) {
  const d = state.districts.find((x) => x.id === o.district);
  return d ? `${d.functionName} · ${d.tier}` : o.district;
}
function recordLines(o, v) {
  const lines = [
    o.product,
    v.name,
    `${o.service_model || 'Service model not stated'} · ${o.fedramp_impact_level} · ${o.authorization_status}`,
    `Tier ${o.tier} · ${districtNameOf(o)} district`,
    o.room.deploymentModel ? `Deployment: ${o.room.deploymentModel}` : 'Deployment model: not stated in the source record',
    `Fork ${o.room.forkId || 'id not in source'}`,
    `Marketplace record: ${o.source_url}`,
    o.room.specPath ? `Build source: ${o.room.specPath}` : 'Build source: none (unclassified in the DeadRamp build)',
  ];
  if (o.room.description) lines.push('', 'From the Marketplace record:', o.room.description.slice(0, 300));
  return lines;
}
function functionsLines(o, build) {
  const lines = ['CLAIMED FUNCTIONS — from the Marketplace record'];
  if (o.room.functions.length) for (const f of o.room.functions) lines.push('· ' + f.name);
  else lines.push('The Marketplace record claims no specific functions for this offering.');
  lines.push('');
  if (build && build.controls.length) {
    lines.push(`BUILD CONTROL CATALOG — NIST SP 800-53, from ${build.controlsSource}`);
    for (const c of build.controls) lines.push(`${c.id}  ${c.title}`);
  } else if (build) {
    lines.push('This build carries no control-catalog table. Its anatomy:');
    for (const m of build.modules) lines.push(`${m.path.split('/').pop()} — ${m.doc || 'module'}`);
  }
  return lines;
}
function terminalLines(o, build) {
  if (!build) {
    return [
      'NO REFERENCE BUILD',
      'This offering is one of the two the DeadRamp build holds as',
      'honestly unclassified. There is no clean-room build for it,',
      'so this room shows the Marketplace record only.',
      'Nothing here is invented to fill the space.',
    ];
  }
  const lines = [
    `REFERENCE BUILD — groups/${build.groupDir}`,
    build.title,
    `Merged clean-room build · ${build.specCount} offerings · ${build.testCount} tests · ${build.modules.length} modules`,
    '',
    'CLI surface (from __main__.py):',
  ];
  for (const c of build.cli) lines.push(`  ${c.name}${c.help ? ' — ' + c.help : ''}`);
  lines.push('', `HTTP operations (extracted verbatim from the service source, ${build.http.operationsTotal} total):`);
  lines.push('  ' + build.http.operations.join(', '));
  if (build.http.routes.length) {
    lines.push('', `Literal routes (${build.http.routesTotal} total):`);
    lines.push('  ' + build.http.routes.join('   '));
  }
  if (build.http.resources.length) lines.push('', 'Resource roots: ' + build.http.resources.join(', '));
  lines.push('', 'This surface is the reference build\'s own, extracted from the',
    'source above. It is not the vendor\'s API, and no endorsement is implied.');
  return lines;
}

/* ---- interior layout math (shared by the builder and the hooks) ---- */
function interiorLayout(vendor) {
  return {
    vendor,
    levels: vendor.offerings.length,
    rooms: vendor.offerings.map((o, j) => ({
      index: j, level: j + 1, angle: doorAngle(j), floorY: (j + 1) * FH,
      archetype: o.room.archetype, offering: o,
    })),
  };
}
function chamberAtH(layout, lx, lz, curFloor) {
  for (const room of layout.rooms) {
    if (Math.abs(room.floorY - curFloor) > FH * 0.75) continue;
    const ca = Math.cos(room.angle), sa = Math.sin(room.angle);
    const u = lx * ca + lz * sa, w = -lx * sa + lz * ca;
    if (u >= CH_IN - 0.7 && u <= CH_OUT + 0.5 && Math.abs(w) <= CH_HALF_W + 0.7) return room.index;
  }
  return -1;
}
function interiorHeightAt(layout, lx, lz, curFloor, onFlight) {
  const r = Math.hypot(lx, lz), th = angNorm(Math.atan2(lz, lx));
  const cand = [], rampCand = [];
  const ch = chamberAtH(layout, lx, lz, curFloor);
  if (ch >= 0) cand.push((ch + 1) * FH);
  for (let j = 0; j < layout.levels; j++) {
    const a0 = j === 0 ? 0.2 : doorAngle(j - 1), a1 = doorAngle(j);
    const span = angNorm(a1 - a0), rel = angNorm(th - a0);
    if (rel <= span && r >= R_OUT - 4.9 && r <= R_OUT - 0.5) {
      const h = j * FH + (rel / span) * FH;
      cand.push(h); rampCand.push({ h, j });
    }
    if (angDiff(th, a1) <= 0.18 && r >= R_OUT - 5.2 && r <= R_OUT + 0.6) cand.push((j + 1) * FH);
  }
  if (angDiff(th, EXIT_ANGLE) <= 0.3 && r >= R_OUT - 5.2) cand.push(0);
  if (r >= R_WELL - 0.3 && r <= R_OUT + 0.3) cand.push(Math.round(curFloor / FH) * FH);
  if (curFloor < 0.01 && r <= R_OUT + 0.3) cand.push(0);
  if (!cand.length) return { y: curFloor, flight: -1 };
  /* The coil rule, in two parts. The flat ring floor is generated at
   * exactly the current height whenever the player stands on a whole
   * floor, so in a pure nearest-candidate contest it wins with
   * distance 0 forever and the ramp, which leaves that same height
   * and rises, can never be entered on foot (measured before this
   * rule: a full walk of the IBM coil at ramp radius held floorY at
   * exactly 0 in every one of 368 samples; verify/verify-walk.js).
   * Part one, continuity: a player already on a flight keeps that
   * flight's surface for as long as the flight offers one here, at
   * any speed, until the span or the band ends, where the landing,
   * the next flight, or the general rule takes over. Part two,
   * mounting: a ramp surface within a step of the current height
   * (0.8 m, more than the largest single-frame rise at full walk
   * speed, 14 m/s times the 0.1 s dt clamp at the band's inner edge
   * on the steepest flight, about 0.67 m) is the surface being
   * stepped onto, at the coil's foot or down from a landing. Beyond
   * a step the flat floor keeps the contest, which is what lets the
   * lobby floor hold while walking under the coil where it passes
   * metres overhead. */
  if (onFlight >= 0) {
    const on = rampCand.find((c) => c.j === onFlight);
    if (on) return { y: on.h, flight: on.j };
  }
  let rampBest = null, rampBd = Infinity;
  for (const c of rampCand) { const d = Math.abs(c.h - curFloor); if (d < rampBd) { rampBd = d; rampBest = c; } }
  if (rampBest && rampBd <= 0.8) return { y: rampBest.h, flight: rampBest.j };
  let best = cand[0], bd = Math.abs(cand[0] - curFloor);
  for (const c of cand) { const d = Math.abs(c - curFloor); if (d < bd) { bd = d; best = c; } }
  return { y: best, flight: -1 };
}
function interiorAllowedAt(layout, lx, lz, curFloor) {
  if (chamberAtH(layout, lx, lz, curFloor) >= 0) return true;
  const r = Math.hypot(lx, lz);
  return r >= R_WELL + 0.35 && r <= R_OUT - 0.35;
}

/* ---- geometry helpers for interiors ---- */
function xg(geom, x, y, z, rotY) {
  const g = geom;
  g.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY || 0, 0)),
    new THREE.Vector3(1, 1, 1)));
  return g;
}
function cbox(w, h, d, x, y, z, rotY, color) {
  return coloredGeom(xg(new THREE.BoxGeometry(w, h, d), x, y, z, rotY), color);
}
/* Chamber-frame point: px tangential, pz radial offset from rMid. */
function chPoint(A, rMid, px, py, pz) {
  return new THREE.Vector3(
    rMid * Math.cos(A) + px * Math.sin(A) + pz * Math.cos(A), py,
    rMid * Math.sin(A) - px * Math.cos(A) + pz * Math.sin(A));
}
/* Helical ramp ribbon between angles a0..a1, heights y0..y1. */
function rampGeom(a0, a1, y0, y1, rIn, rOut, color, yOff = 0) {
  const steps = Math.max(4, Math.ceil(Math.abs(a1 - a0) / 0.1));
  const pos = [], nor = [];
  const pt = (i, r) => {
    const t = i / steps, a = a0 + (a1 - a0) * t, y = y0 + (y1 - y0) * t + yOff;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  };
  for (let i = 0; i < steps; i++) {
    const A = pt(i, rIn), B = pt(i, rOut), C = pt(i + 1, rIn), D = pt(i + 1, rOut);
    pos.push(...A, ...B, ...C, ...B, ...D, ...C);
    for (let k = 0; k < 6; k++) nor.push(0, 1, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  return coloredGeom(g, color);
}

/* ---- build one building's interior ---- */
const interiorLight = new THREE.PointLight(0xffd9a0, 0, 60, 1.5);
scene.add(interiorLight);

function buildInterior(vendor) {
  const layout = interiorLayout(vendor);
  const brand = vendor.brand || { primary: '#cfc9b8', secondary: '#4c5257', accent: '#8c6a2f', source: 'default' };
  const researched = brand.source === 'researched';
  const bPri = hexColor(brand.primary), bAcc = hexColor(brand.accent), bSec = hexColor(brand.secondary);
  const accentCss = researched ? brand.accent : '#ffb36b';
  // Room scheme (researched vendors): the palette leads the room.
  const roomWall = researched ? mixColor(bPri, FED.limestone, 0.42) : FED.limestone.clone();
  const roomWallSide = researched ? mixColor(bPri, FED.limestone, 0.55) : FED.wall.clone();
  const roomTrim = researched ? bAcc.clone() : FED.bronze.clone();
  const signBg = researched ? mixColor(bPri, new THREE.Color(0x10141d), 0.5) : new THREE.Color(0x10141d);
  const totalH = (layout.levels + 1) * FH;
  const group = new THREE.Group();
  group.position.set(0, INT_Y, 0);
  const statics = [], strips = [], bars = [], panels = [];
  const rMid = (CH_IN + CH_OUT) / 2, chDepth = CH_OUT - CH_IN;

  /* shell, core, floors, walls */
  statics.push(coloredGeom(xg(new THREE.CylinderGeometry(CH_OUT + 0.7, CH_OUT + 0.7, totalH + FH, 40, 1, true), 0, (totalH + FH) / 2 - FH, 0, 0), FED.dark));
  statics.push(coloredGeom(xg(new THREE.CylinderGeometry(R_CORE, R_CORE, totalH, 20, 1, true), 0, totalH / 2, 0, 0), FED.wall));
  statics.push(coloredGeom(xg(new THREE.CircleGeometry(CH_OUT + 0.7, 40).rotateX(-Math.PI / 2), 0, totalH, 0, 0), FED.dark));
  statics.push(coloredGeom(xg(new THREE.CircleGeometry(R_OUT + 0.4, 40).rotateX(-Math.PI / 2), 0, 0.02, 0, 0), FED.floor));
  for (let L = 1; L <= layout.levels; L++) {
    statics.push(coloredGeom(xg(new THREE.RingGeometry(R_CORE, R_OUT, 40).rotateX(-Math.PI / 2), 0, L * FH, 0, 0), FED.floor));
  }
  statics.push(coloredGeom(xg(new THREE.RingGeometry(R_CORE, R_OUT, 40).rotateX(-Math.PI / 2), 0, totalH, 0, 0), FED.floor));
  for (let L = 0; L <= layout.levels; L++) {
    const gapA = L === 0 ? EXIT_ANGLE : doorAngle(L - 1);
    const gap = 0.085;
    const thetaStart = Math.PI / 2 - (gapA + Math.PI * 2 - gap);
    const seg = new THREE.CylinderGeometry(R_OUT, R_OUT, FH, 40, 1, true, thetaStart, Math.PI * 2 - gap * 2);
    statics.push(coloredGeom(xg(seg, 0, L * FH + FH / 2, 0, 0), FED.wall));
  }
  /* the coil: one ramp flight per floor, accent edge in the brand accent */
  for (let j = 0; j < layout.levels; j++) {
    const a0 = j === 0 ? 0.2 : doorAngle(j - 1), a1 = doorAngle(j);
    statics.push(rampGeom(a0, a1, j * FH, (j + 1) * FH, R_OUT - 4.6, R_OUT - 1.4, FED.granite));
    statics.push(rampGeom(a0, a1, j * FH, (j + 1) * FH, R_OUT - 1.72, R_OUT - 1.42, roomTrim, 0.035));
  }
  /* lobby furnishing: federal, brand accents */
  statics.push(cbox(4.6, 1.05, 1.4, Math.cos(SPAWN_ANGLE) * 11.4, 0.53, Math.sin(SPAWN_ANGLE) * 11.4, Math.PI / 2 - SPAWN_ANGLE, FED.granite));
  statics.push(cbox(3.2, 0.5, 1.0, Math.cos(SPAWN_ANGLE + 0.8) * 11.8, 0.25, Math.sin(SPAWN_ANGLE + 0.8) * 11.8, Math.PI / 2 - (SPAWN_ANGLE + 0.8), FED.granite));
  statics.push(coloredGeom(xg(new THREE.CylinderGeometry(2.1, 2.1, 0.06, 28).rotateX(0), 0, 0.05, 0, 0), roomTrim));
  // exit door frame at EXIT_ANGLE
  {
    const A = EXIT_ANGLE, rot = Math.PI / 2 - A;
    const fx = Math.cos(A) * (R_OUT - 0.1), fz = Math.sin(A) * (R_OUT - 0.1);
    const tx = -Math.sin(A), tz = Math.cos(A); // tangential direction
    statics.push(cbox(0.28, 2.5, 0.28, fx + tx * 1.25, 1.25, fz + tz * 1.25, rot, roomTrim));
    statics.push(cbox(0.28, 2.5, 0.28, fx - tx * 1.25, 1.25, fz - tz * 1.25, rot, roomTrim));
    statics.push(cbox(2.9, 0.3, 0.3, fx, 2.55, fz, rot, roomTrim));
  }

  /* lobby panels: the vendor record, the directory, the framing */
  const wallPanel = (angle, y, w, h, title, lines, accent) => {
    const mesh = makePanel(w, h, title, lines, accent);
    mesh.position.set(Math.cos(angle) * (R_OUT - 0.4), y, Math.sin(angle) * (R_OUT - 0.4));
    group.add(mesh);
    mesh.lookAt(0, INT_Y + y, 0);
    panels.push(mesh);
    return mesh;
  };
  const d0 = state.districts.find((x) => x.id === vendor.district);
  wallPanel(SPAWN_ANGLE, 1.72, 6.4, 3.0, vendor.name.toUpperCase().slice(0, 34), [
    `${d0 ? d0.functionName + ' · ' + d0.tier : ''} district · ${vendor.offeringCount} offering${vendor.offeringCount > 1 ? 's' : ''}`,
    `Status: ${STATUS_TEXT[vendor.statusClass]}`,
    researched
      ? 'Brand palette: researched from this vendor\'s public brand identity.'
      : 'Brand palette: not yet researched; this building wears the federal finish.',
    'Colours only, as evocation: no logo, wordmark, or trade dress is reproduced.',
    '',
    'Rooms: one per offering, up the spiral ramp, one floor per room.',
    'The lobby door marked EXIT returns you to the boulevard.',
  ], accentCss);
  wallPanel(SPAWN_ANGLE - 0.66, 1.72, 5.4, 3.0, 'DIRECTORY', [
    ...vendor.offerings.map((o, j) => `L${j + 1}  ${o.product}`),
  ], accentCss);
  wallPanel(EXIT_ANGLE + 0.62, 1.7, 5.6, 2.9, 'ABOUT THIS MODEL', [FRAMING], accentCss);
  {
    const exitSign = makePanel(3.4, 0.9, 'EXIT — BOULEVARD', [], '#ffd9a0');
    exitSign.position.set(Math.cos(EXIT_ANGLE) * (R_OUT - 0.4), 2.82, Math.sin(EXIT_ANGLE) * (R_OUT - 0.4));
    group.add(exitSign); exitSign.lookAt(0, INT_Y + 2.82, 0);
    panels.push(exitSign);
  }
  /* column name band: the vendor's name, nominative, around the core */
  {
    const c = document.createElement('canvas'); c.width = 2048; c.height = 128;
    const x = c.getContext('2d');
    x.fillStyle = '#141a26'; x.fillRect(0, 0, 2048, 128);
    x.fillStyle = researched ? brand.accent : '#ffb36b';
    x.font = '700 64px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(vendor.name.toUpperCase().slice(0, 42), 1024, 66);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping; t.repeat.x = 2;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(R_CORE + 0.06, R_CORE + 0.06, 1.05, 24, 1, true),
      new THREE.MeshBasicMaterial({ map: t }));
    band.position.y = 1.75;
    group.add(band); panels.push(band);
  }

  /* rooms */
  const roomRecs = [];
  for (const room of layout.rooms) {
    const o = room.offering, A = room.angle, rot = Math.PI / 2 - A, fy = room.floorY;
    const build = o.room.buildGroup ? state.catalog.builds[o.room.buildGroup] : null;
    const cen = chPoint(A, rMid, 0, 0, 0);
    // chamber shell: floor, ceiling, outer wall, side walls, inner wall with door gap
    statics.push(cbox(CH_HALF_W * 2 + 1.2, 0.16, chDepth + 1.2, cen.x, fy - 0.06, cen.z, rot, FED.floor));
    statics.push(cbox(CH_HALF_W * 2 + 1.2, 0.16, chDepth + 1.2, cen.x, fy + FH - 0.02, cen.z, rot, roomWallSide));
    statics.push(cbox(CH_HALF_W * 2 + 1.2, FH, 0.3, chPoint(A, rMid, 0, 0, chDepth / 2 + 0.45).x, fy + FH / 2, chPoint(A, rMid, 0, 0, chDepth / 2 + 0.45).z, rot, roomWall));
    for (const s of [-1, 1]) {
      const sp = chPoint(A, rMid, s * (CH_HALF_W + 0.5), 0, 0);
      statics.push(cbox(0.3, FH, chDepth + 1.2, sp.x, fy + FH / 2, sp.z, rot, roomWallSide));
      const ip = chPoint(A, rMid, s * (CH_HALF_W + 0.5), 0, -chDepth / 2 - 0.45);
      statics.push(cbox(0.3, FH, 0.3, ip.x, fy + FH / 2, ip.z, rot, roomWallSide));
    }
    for (const s of [-1, 1]) {
      const segW = CH_HALF_W + 0.6 - 1.2;
      const ip = chPoint(A, rMid, s * (1.2 + segW / 2), 0, -chDepth / 2 - 0.45);
      statics.push(cbox(segW, FH, 0.3, ip.x, fy + FH / 2, ip.z, rot, roomWall));
    }
    const lp = chPoint(A, rMid, 0, 0, -chDepth / 2 - 0.45);
    statics.push(cbox(2.4, FH - 2.3, 0.3, lp.x, fy + 2.3 + (FH - 2.3) / 2, lp.z, rot, roomWall));
    // door frame in the room trim (the scheme's accent)
    for (const s of [-1, 1]) {
      const fp = chPoint(A, rMid, s * 1.28, 0, -chDepth / 2 - 0.3);
      statics.push(cbox(0.24, 2.3, 0.5, fp.x, fy + 1.15, fp.z, rot, roomTrim));
    }
    statics.push(cbox(2.8, 0.26, 0.5, lp.x, fy + 2.42, lp.z, rot, roomTrim));
    /* furniture by archetype (federal pieces, cheap boxes) */
    const F = (w, h, d, px, pz, col, py) => {
      const p = chPoint(A, rMid, px, 0, pz);
      statics.push(cbox(w, h, d, p.x, fy + (py !== undefined ? py : h / 2), p.z, rot, col));
    };
    const deskC = new THREE.Color(0x5a4632), metalC = new THREE.Color(0x6a7076), rackC = new THREE.Color(0x22262e);
    if (room.archetype === 'ops-center') {
      F(3.6, 0.75, 1.1, -2.0, -0.6, deskC); F(3.6, 0.75, 1.1, 2.0, -0.6, deskC);
      F(0.95, 0.55, 0.08, -2.6, -0.6, FED.dark, 1.05); F(0.95, 0.55, 0.08, -1.4, -0.6, FED.dark, 1.05);
      F(0.95, 0.55, 0.08, 1.4, -0.6, FED.dark, 1.05); F(0.95, 0.55, 0.08, 2.6, -0.6, FED.dark, 1.05);
      F(5.6, 0.9, 0.7, 0, -3.6, FED.granite);
    } else if (room.archetype === 'server-hall') {
      for (const sx of [-2.3, 2.3]) for (const sz of [-2.5, 0, 2.5]) {
        F(0.95, 2.2, 0.85, sx, sz, rackC);
        const sp = chPoint(A, rMid, sx + (sx < 0 ? 0.52 : -0.52), 0, sz);
        const sg = coloredGeom(xg(new THREE.BoxGeometry(0.05, 0.07, 0.6), sp.x, fy + 1.55, sp.z, rot), new THREE.Color(0x7ee2a8));
        strips.push(sg);
        const sg2 = coloredGeom(xg(new THREE.BoxGeometry(0.05, 0.07, 0.6), sp.x, fy + 1.05, sp.z, rot), new THREE.Color(0x7ee2a8));
        strips.push(sg2);
      }
    } else if (room.archetype === 'lab') {
      F(3.4, 0.9, 1.2, -1.9, -0.6, metalC); F(3.4, 0.9, 1.2, 1.9, -0.6, metalC);
      for (const sx of [-3.6, 3.6]) {
        const pp = chPoint(A, rMid, sx, 0, 2.3);
        statics.push(coloredGeom(xg(new THREE.CylinderGeometry(0.26, 0.32, 2.3, 10), pp.x, fy + 1.15, pp.z, 0), FED.granite));
        const pivot = new THREE.Group();
        pivot.position.set(pp.x, fy + 2.35, pp.z);
        const bar = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 0.07),
          new THREE.MeshBasicMaterial({ color: researched ? bAcc.getHex() : 0xffb36b }));
        bar.position.x = 0.85;
        pivot.add(bar); group.add(pivot); bars.push(pivot);
      }
    } else if (room.archetype === 'meeting-space') {
      F(3.8, 0.14, 1.7, 0, -0.2, FED.granite, 0.78);
      F(0.5, 0.75, 1.5, 0, -0.2, deskC, 0.37);
      for (const cx of [-1.5, 0, 1.5]) { F(0.52, 0.95, 0.52, cx, -1.45, deskC); F(0.52, 0.95, 0.52, cx, 1.05, deskC); }
    } else if (room.archetype === 'ledger-office') {
      F(2.6, 0.8, 1.1, 0, -1.0, deskC);
      for (const sx of [-3.1, 0, 3.1]) {
        F(2.7, 2.3, 0.5, sx, -4.15, new THREE.Color(0x54432c));
        F(2.5, 0.1, 0.06, sx, -3.87, FED.limestone, 1.5);
        F(2.5, 0.1, 0.06, sx, -3.87, FED.limestone, 0.8);
      }
    } else {
      F(2.6, 0.8, 1.1, 0, -1.0, deskC);
      F(0.85, 1.85, 0.6, -4.5, -2.2, FED.granite); F(0.85, 1.85, 0.6, 4.5, -2.2, FED.granite);
    }
    /* wall panels: record (outer wall), functions/controls (left), terminal (right) */
    const mkP = (px, pz, w, h, title, lines, tx, tz) => {
      const mesh = makePanel(w, h, title, lines, accentCss);
      const pos = chPoint(A, rMid, px, fy + 1.68, pz);
      mesh.position.copy(pos);
      group.add(mesh);
      const tgt = chPoint(A, rMid, tx, fy + 1.68, tz);
      mesh.lookAt(tgt.x, INT_Y + fy + 1.68, tgt.z);
      panels.push(mesh);
      return mesh;
    };
    mkP(0, chDepth / 2 + 0.22, 6.6, 3.0, 'SERVICE RECORD', recordLines(o, vendor), 0, -1);
    mkP(-(CH_HALF_W + 0.28), 0.4, 4.7, 2.9, 'FUNCTIONS & CONTROLS', functionsLines(o, build), 0, 0.4);
    const term = mkP(CH_HALF_W + 0.28, 0.4, 4.7, 2.9, 'TERMINAL — REFERENCE BUILD', terminalLines(o, build), 0, 0.4);
    /* door sign + status plaque, in the ring */
    {
      const lines = capLines(wrapText(o.product, 30), 2);
      const c = document.createElement('canvas'); c.width = 1024; c.height = 448;
      const x = c.getContext('2d');
      x.fillStyle = '#' + signBg.getHexString(); x.fillRect(0, 0, 1024, 448);
      x.fillStyle = '#' + roomTrim.getHexString(); x.fillRect(0, 0, 1024, 26);
      x.fillStyle = '#eef3fa'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.font = '700 62px sans-serif';
      lines.forEach((ln, i) => x.fillText(ln, 512, 130 + i * 78 - (lines.length - 1) * 39));
      x.font = '34px sans-serif'; x.fillStyle = o.authorization_status === 'FedRAMP Certified' ? STATUS_COLORS.certified : STATUS_COLORS.other;
      x.fillText(`${o.tier} · ${o.authorization_status}`, 512, 330);
      x.font = '28px sans-serif'; x.fillStyle = '#9fb0c3';
      x.fillText(ARCHETYPE_LABEL[room.archetype], 512, 385);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.58), new THREE.MeshBasicMaterial({ map: t }));
      sign.position.set(Math.cos(A) * (R_OUT - 0.42), fy + 2.5, Math.sin(A) * (R_OUT - 0.42));
      group.add(sign); sign.lookAt(0, INT_Y + fy + 2.5, 0);
      panels.push(sign);
      const plaque = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.2, 0.1),
        new THREE.MeshBasicMaterial({ color: o.authorization_status === 'FedRAMP Certified' ? 0x58b368 : 0xe0a458 }));
      const pp = chPoint(A, rMid, 1.75, fy + 1.45, -chDepth / 2 - 0.32);
      plaque.position.copy(pp); plaque.rotation.y = rot;
      group.add(plaque); panels.push(plaque);
    }
    roomRecs.push({ room, build, termPanel: term, termLines: term.userData.panelLines });
  }

  const staticMesh = new THREE.Mesh(mergeGeoms(statics),
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  group.add(staticMesh);
  statics.forEach((g) => g.dispose());
  let stripMesh = null;
  if (strips.length) {
    stripMesh = new THREE.Mesh(mergeGeoms(strips), new THREE.MeshBasicMaterial({ vertexColors: true }));
    group.add(stripMesh);
    strips.forEach((g) => g.dispose());
  }
  scene.add(group);
  interiorLight.color.copy(mixColor(new THREE.Color(0xffd9a0), researched ? bPri : new THREE.Color(0xffd9a0), researched ? 0.35 : 0));
  interiorLight.intensity = 60;
  return {
    vendor, layout, group, floorY: 0, onFlight: -1, atExit: false,
    rooms: roomRecs, stripMat: stripMesh ? stripMesh.material : null, bars,
    boardTimer: 0, boardIdx: 0, hudSub: document.getElementById('hudSub').textContent,
    saved: null,
  };
}

function enterBuilding(vendor) {
  if (state.interior || !vendor || vendor.kind !== 'building') return;
  const rec = buildInterior(vendor);
  rec.saved = { x: player.x, z: player.z, yaw: player.yaw, pitch: player.pitch };
  state.interior = rec;
  worldGroup.visible = false;
  player.x = Math.cos(SPAWN_ANGLE) * 8.8;
  player.z = Math.sin(SPAWN_ANGLE) * 8.8;
  player.y = INT_Y + EYE;
  player.pitch = 0;
  const tx = Math.cos(SPAWN_ANGLE) * R_OUT, tz = Math.sin(SPAWN_ANGLE) * R_OUT;
  player.yaw = Math.atan2(-(tx - player.x), -(tz - player.z));
  document.getElementById('hudSub').textContent = `${vendor.name} — inside · ${vendor.offeringCount} rooms up the spiral`;
  /* help lifecycle: the first entry swaps the tutorial to its indoor
   * variant; later entries simply dismiss it (the action it described
   * has been performed). */
  if (!helpSeen.indoor) { helpSeen.indoor = true; showHelp('in'); }
  else hideHelp();
}
function exitBuilding() {
  const rec = state.interior;
  if (!rec) return;
  rec.group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
    }
  });
  scene.remove(rec.group);
  interiorLight.intensity = 0;
  player.x = rec.saved.x; player.z = rec.saved.z;
  player.yaw = rec.saved.yaw; player.pitch = rec.saved.pitch;
  player.y = EYE;
  worldGroup.visible = true;
  document.getElementById('hudSub').textContent = rec.hudSub;
  state.interior = null;
  hideHelp();
}
function resolveInteriorMove(prevX, prevZ) {
  const rec = state.interior, layout = rec.layout;
  let lx = player.x, lz = player.z;
  const cur = rec.floorY;
  if (!interiorAllowedAt(layout, lx, lz, cur)) {
    if (interiorAllowedAt(layout, lx, prevZ, cur)) lz = prevZ;
    else if (interiorAllowedAt(layout, prevX, lz, cur)) lx = prevX;
    else { lx = prevX; lz = prevZ; }
  }
  player.x = lx; player.z = lz;
  const hs = interiorHeightAt(layout, lx, lz, cur, typeof rec.onFlight === 'number' ? rec.onFlight : -1);
  rec.floorY = hs.y;
  rec.onFlight = hs.flight;
  player.y = INT_Y + rec.floorY + EYE;
  rec.atExit = rec.floorY < 0.01 &&
    angDiff(angNorm(Math.atan2(lz, lx)), EXIT_ANGLE) <= 0.35 && Math.hypot(lx, lz) >= R_OUT - 4.5;
  interiorLight.position.set(lx, INT_Y + rec.floorY + 3.1, lz);
  rec.currentRoom = chamberAtH(layout, lx, lz, rec.floorY);
}
function animateInterior(dt) {
  const rec = state.interior;
  if (!rec) return;
  const t = performance.now() / 1000;
  if (rec.stripMat) {
    const s = 0.72 + 0.28 * Math.sin(t * 2.6);
    rec.stripMat.color.setScalar(s);
  }
  for (const b of rec.bars) b.rotation.y += dt * 0.9;
  rec.boardTimer += dt;
  if (rec.boardTimer > 0.9) {
    rec.boardTimer = 0;
    if (rec.currentRoom !== undefined && rec.currentRoom >= 0) {
      const rr = rec.rooms[rec.currentRoom];
      if (rr && rr.room.archetype === 'ops-center' && rr.termPanel) {
        rec.boardIdx = (rec.boardIdx + 1) % Math.max(rr.termLines.length, 1);
        rr.termPanel.userData.redrawPanel(rec.boardIdx);
      }
    }
  }
}
/* ---------------- platform-matched prompts + help lifecycle ----------------
 * Standing rule (Aries, Nov 14, 2026): prompts name only the controls
 * the visitor's device actually has. There is no E key on a cellphone
 * or in VR, so touch visitors get tap language and tappable doors;
 * keyboard visitors keep the WASD / E copy. Phase 3 (WebXR) prompts
 * will speak controller / gaze language under the same rule.
 *
 * The help block is a tutorial, not a permanent overlay: it shows on
 * arrival outdoors, shows its indoor variant on first entry into a
 * building, fades after a short dwell or once the action it describes
 * is performed, and a persistent "?" button recalls the variant for
 * the space the visitor is in. The header title and the clean-room
 * framing note are not tutorial text and never fade. */
const IS_TOUCH = !!((window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
  || 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0);
const HELP_DWELL_MS = 7000;
const HELP_COPY = {
  out: {
    kb: 'WASD / arrows to walk, mouse to look (click the world to lock the mouse), Shift to move fast.<br>' +
      'Click a building for its record. Enter a building from its record card, or walk to its door and press <b>E</b>. ' +
      'Inside, one spiral ramp climbs past every service room; the lobby door marked EXIT (or <b>E</b> beside it) returns you to the boulevard. ' +
      'Everything is one spiral away: follow the boulevard out from the plaza.',
    touch: 'Left thumb stick to walk, drag right side to look. Tap a building for its record. ' +
      'Enter from its record card, or walk to its door and tap the door to go in. ' +
      'Inside, one spiral ramp climbs past every service room; tap the lobby door marked EXIT to return to the boulevard. ' +
      'Everything is one spiral away: follow the boulevard out from the plaza.',
  },
  in: {
    kb: 'WASD / arrows to walk, mouse to look, Shift to move fast.<br>' +
      'One spiral ramp climbs past every service room; each room opens off the coil on its own floor. ' +
      'The lobby door marked EXIT (or <b>E</b> beside it) returns you to the boulevard.',
    touch: 'Left thumb stick to walk, drag right side to look. ' +
      'One spiral ramp climbs past every service room; each room opens off the coil on its own floor. ' +
      'Tap the lobby door marked EXIT to return to the boulevard.',
  },
};
const hintEl = document.getElementById('hint');
const helpBtn = document.getElementById('helpBtn');
let helpTimer = 0;
let helpSpace = 'out';
const helpSeen = { indoor: false };
function showHelp(space) {
  helpSpace = space || (state.interior ? 'in' : 'out');
  hintEl.innerHTML = HELP_COPY[helpSpace][IS_TOUCH ? 'touch' : 'kb'];
  hintEl.classList.remove('faded');
  window.clearTimeout(helpTimer);
  helpTimer = window.setTimeout(hideHelp, HELP_DWELL_MS);
}
function hideHelp() {
  window.clearTimeout(helpTimer);
  hintEl.classList.add('faded');
}
helpBtn.addEventListener('click', () => showHelp(state.interior ? 'in' : 'out'));

/* door geometry shared by the prompt, the tap target, and the hooks:
 * the door point is the same point the E-prompt measures from. */
function doorPoint(v) {
  const fx = Math.sin(v.rotationY), fz = Math.cos(v.rotationY);
  return {
    x: v.position.x + fx * (v.size.d / 2 + 1.5), y: 2.4,
    z: v.position.z + fz * (v.size.d / 2 + 1.5),
  };
}
function projectToScreen(x, y, z) {
  const p = new THREE.Vector3(x, y, z).project(camera);
  if (p.z > 1 || p.z < -1) return null;
  return { x: (p.x * 0.5 + 0.5) * window.innerWidth, y: (-p.y * 0.5 + 0.5) * window.innerHeight };
}
const TAP_DOOR_RADIUS = 120; // px around the door's screen position
/* A tap is a real input, not a lesser click: indoors, a tap while
 * standing at the EXIT door leaves; outdoors, a tap on the door of
 * the building whose door zone the visitor stands in enters it. Any
 * other tap falls through to the existing picking (record cards). */
function handleTap(x, y) {
  if (state.interior) {
    if (state.interior.atExit) exitBuilding();
    return;
  }
  const dv = state.doorVendor;
  if (dv) {
    const dp = doorPoint(dv);
    const sp = projectToScreen(dp.x, dp.y, dp.z);
    if (sp && Math.hypot(x - sp.x, y - sp.y) <= TAP_DOOR_RADIUS) {
      card.style.display = 'none';
      enterBuilding(dv);
      return;
    }
  }
  pickAt(x, y);
}

/* door prompts, refreshed on the stats timer */
const promptEl = document.getElementById('prompt');
function updatePrompt() {
  if (state.interior) {
    if (state.interior.atExit) {
      promptEl.innerHTML = IS_TOUCH ? 'Tap — Exit to the boulevard' : '<b>E</b> — Exit to the boulevard';
      promptEl.style.display = 'block';
    } else promptEl.style.display = 'none';
    state.doorVendor = null;
    return;
  }
  let best = null, bd = 49;
  for (const v of state.buildings) {
    const fx = Math.sin(v.rotationY), fz = Math.cos(v.rotationY);
    const dx = v.position.x + fx * (v.size.d / 2 + 1.5) - player.x;
    const dz = v.position.z + fz * (v.size.d / 2 + 1.5) - player.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bd) { bd = d2; best = v; }
  }
  state.doorVendor = best;
  if (best) {
    promptEl.innerHTML = IS_TOUCH ? `Tap the door — Enter ${best.name}` : `<b>E</b> — Enter ${best.name}`;
    promptEl.style.display = 'block';
  } else promptEl.style.display = 'none';
}

/* ---------------- controls: keyboard, pointer lock, touch ---------------- */
const keys = {};
window.addEventListener('keydown', (ev) => {
  keys[ev.code] = true;
  if (ev.code === 'KeyE' && !ev.repeat) {
    if (state.interior) { if (state.interior.atExit) exitBuilding(); }
    else if (state.doorVendor) {
      const v = state.doorVendor;
      card.style.display = 'none';
      enterBuilding(v);
    }
  }
});
window.addEventListener('keyup', (ev) => { keys[ev.code] = false; });
const debugMove = { f: 0, b: 0, l: 0, r: 0 };
const stick = { active: false, id: -1, ox: 0, oy: 0, mx: 0, mz: 0 };
const stickEl = document.getElementById('stick');
const stickKnob = document.getElementById('stickKnob');
let lookTouch = { id: -1, lx: 0, ly: 0 };
let downInfo = null;
let lastTouchTapAt = 0;

renderer.domElement.addEventListener('click', (ev) => {
  /* a tap already handled by the touch path must not be replayed as a
   * mouse click (it could re-pick, or request pointer lock indoors) */
  if (performance.now() - lastTouchTapAt < 700) return;
  if (document.pointerLockElement === renderer.domElement) {
    pickAt(window.innerWidth / 2, window.innerHeight / 2);
  } else if (!pickAt(ev.clientX, ev.clientY)) {
    renderer.domElement.requestPointerLock();
  }
});
document.addEventListener('pointerlockchange', () => {
  document.getElementById('crosshair').style.display =
    document.pointerLockElement === renderer.domElement ? 'block' : 'none';
});
document.addEventListener('mousemove', (ev) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  player.yaw -= ev.movementX * 0.0022;
  player.pitch -= ev.movementY * 0.0022;
  player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch));
});
renderer.domElement.addEventListener('touchstart', (ev) => {
  for (const t of ev.changedTouches) {
    if (t.clientX < window.innerWidth * 0.45 && stick.id === -1) {
      stick.active = true; stick.id = t.identifier; stick.ox = t.clientX; stick.oy = t.clientY; stick.mx = 0; stick.mz = 0;
      stickEl.style.display = 'block';
      stickEl.style.left = (t.clientX - 55) + 'px'; stickEl.style.top = (t.clientY - 55) + 'px';
      stickKnob.style.left = '33px'; stickKnob.style.top = '33px';
    } else if (lookTouch.id === -1) {
      lookTouch = { id: t.identifier, lx: t.clientX, ly: t.clientY };
    }
    /* the tap clock is the events' own timestamps, not handler time:
     * under render load a frame can run between the two handlers and
     * stretch a handler-time delta past the tap window, dropping a
     * genuine tap (measured: a 206 ms tap read as 2,566 ms) */
    downInfo = { x: t.clientX, y: t.clientY, t: ev.timeStamp };
  }
  ev.preventDefault();
}, { passive: false });
renderer.domElement.addEventListener('touchmove', (ev) => {
  for (const t of ev.changedTouches) {
    if (stick.active && t.identifier === stick.id) {
      const dx = t.clientX - stick.ox, dy = t.clientY - stick.oy;
      const m = Math.hypot(dx, dy), max = 48;
      const s = m > max ? max / m : 1;
      stick.mx = (dx * s) / max; stick.mz = (dy * s) / max;
      stickKnob.style.left = (33 + dx * s) + 'px'; stickKnob.style.top = (33 + dy * s) + 'px';
    } else if (t.identifier === lookTouch.id) {
      player.yaw -= (t.clientX - lookTouch.lx) * 0.005;
      player.pitch -= (t.clientY - lookTouch.ly) * 0.005;
      player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch));
      lookTouch.lx = t.clientX; lookTouch.ly = t.clientY;
    }
  }
  ev.preventDefault();
}, { passive: false });
renderer.domElement.addEventListener('touchend', (ev) => {
  for (const t of ev.changedTouches) {
    if (t.identifier === stick.id) { stick.active = false; stick.id = -1; stick.mx = 0; stick.mz = 0; stickEl.style.display = 'none'; }
    if (t.identifier === lookTouch.id) lookTouch.id = -1;
    if (downInfo && ev.timeStamp - downInfo.t < 260 && Math.hypot(t.clientX - downInfo.x, t.clientY - downInfo.y) < 9) {
      lastTouchTapAt = performance.now();
      handleTap(t.clientX, t.clientY);
    }
  }
  downInfo = null;
});

function stepMovement(dt) {
  let f = 0, r = 0;
  if (keys.KeyW || keys.ArrowUp) f += 1;
  if (keys.KeyS || keys.ArrowDown) f -= 1;
  if (keys.KeyD || keys.ArrowRight) r += 1;
  if (keys.KeyA || keys.ArrowLeft) r -= 1;
  f += debugMove.f - debugMove.b;
  r += debugMove.r - debugMove.l;
  if (stick.active) { f += -stick.mz; r += stick.mx; }
  const m = Math.hypot(f, r);
  if (m < 0.001) return;
  const s = Math.min(1, 1 / m);
  f *= s; r *= s;
  const speed = WALK_SPEED * ((keys.ShiftLeft || keys.ShiftRight) ? FAST_MULT : 1);
  const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
  // camera forward on the ground plane is (-sin yaw, -cos yaw); right is (cos yaw, -sin yaw)
  player.x += (-sin * f + cos * r) * speed * dt;
  player.z += (-cos * f - sin * r) * speed * dt;
}

/* ---------------- stats + debug hooks ---------------- */
const statsbar = document.getElementById('statsbar');
function currentStats() {
  const info = renderer.info.render;
  return {
    vendorsRendered: state.catalog ? state.catalog.meta.vendors : 0,
    buildingsInstanced: state.buildings.length,
    lots: state.lots.length,
    offeringsIndexed: state.catalog ? state.catalog.meta.offerings : 0,
    districts: state.districts.length,
    litWindowInstances: state.winCount || 0,
    brandResearched: state.catalog ? state.catalog.vendors.filter((v) => v.brand && v.brand.source === 'researched').length : 0,
    brandDefault: state.catalog ? state.catalog.vendors.filter((v) => v.brand && v.brand.source === 'default').length : 0,
    drawCalls: info.calls,
    triangles: info.triangles,
    fps: state.fps,
    camera: { x: Math.round(player.x * 10) / 10, z: Math.round(player.z * 10) / 10 },
    exteriorDrawCalls: state.exteriorDrawCalls,
    interior: state.interior ? {
      vendor: state.interior.vendor.name,
      roomsBuilt: state.interior.rooms.length,
      floor: Math.round(state.interior.floorY / FH),
      levels: state.interior.layout.levels,
      drawCalls: info.calls,
      triangles: info.triangles,
    } : null,
  };
}
window.__BASE_STATS__ = () => currentStats();
window.__BASE__ = {
  stats: () => currentStats(),
  /* platform-prompt + help-lifecycle hooks */
  help: () => ({
    isTouch: IS_TOUCH,
    space: helpSpace,
    faded: hintEl.classList.contains('faded'),
    visible: !hintEl.classList.contains('faded') && hintEl.textContent.trim().length > 0,
    opacity: Number(getComputedStyle(hintEl).opacity),
    text: hintEl.textContent.replace(/\s+/g, ' ').trim(),
    prompt: promptEl.style.display === 'block' ? promptEl.textContent : null,
    signals: {
      pointerCoarse: !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches),
      ontouchstart: 'ontouchstart' in window,
      maxTouchPoints: navigator.maxTouchPoints || 0,
    },
  }),
  door: () => {
    const dv = state.doorVendor;
    if (!dv) return null;
    const p = doorPoint(dv);
    return { name: dv.name, world: p, screen: projectToScreen(p.x, p.y, p.z) };
  },
  getCamera: () => ({ x: player.x, z: player.z, y: player.y, yaw: player.yaw, pitch: player.pitch }),
  setCamera: ({ x, z, y, yawDeg, pitchDeg }) => {
    if (x !== undefined) player.x = x;
    if (z !== undefined) player.z = z;
    player.y = y !== undefined ? y : EYE;
    if (yawDeg !== undefined) player.yaw = yawDeg * Math.PI / 180;
    if (pitchDeg !== undefined) player.pitch = pitchDeg * Math.PI / 180;
  },
  lookAt: (x, z) => {
    const dx = x - player.x, dz = z - player.z;
    player.yaw = Math.atan2(-dx, -dz);
  },
  lookAtPoint: (x, y, z) => {
    const dx = x - player.x, dy = y - player.y, dz = z - player.z;
    player.yaw = Math.atan2(-dx, -dz);
    player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  },
  /* Phase 2 hooks */
  enterBuilding: (nameOrId) => {
    const v = state.catalog.vendors.find((x) => x.id === nameOrId || x.name === nameOrId);
    if (v) enterBuilding(v);
    return !!state.interior;
  },
  exitBuilding: () => { exitBuilding(); return !state.interior; },
  interiorState: () => state.interior ? {
    vendor: state.interior.vendor.name,
    roomsBuilt: state.interior.rooms.length,
    floor: Math.round(state.interior.floorY / FH),
    levels: state.interior.layout.levels,
    floorY: state.interior.floorY,
    atExit: state.interior.atExit,
    currentRoom: state.interior.currentRoom === undefined ? -1 : state.interior.currentRoom,
  } : null,
  interiorTeleport: ({ x, z, floorY }) => {
    if (!state.interior) return false;
    state.interior.floorY = floorY;
    state.interior.onFlight = -1; // a teleport breaks surface continuity
    player.x = x; player.z = z;
    player.y = INT_Y + floorY + EYE;
    return true;
  },
  interiorPoints: () => {
    if (!state.interior) return null;
    const layout = state.interior.layout;
    const P = (lx, y, lz) => ({ x: lx, y: INT_Y + y, z: lz });
    const lobbyPos = { x: Math.cos(SPAWN_ANGLE) * 8.8, z: Math.sin(SPAWN_ANGLE) * 8.8 };
    const fj = Math.min(1, Math.max(layout.levels - 1, 0));
    const fa0 = fj === 0 ? 0.2 : doorAngle(fj - 1), fa1 = doorAngle(fj);
    const fam = fa0 + (fa1 - fa0) / 2;
    return {
      lobby: {
        floorY: 0,
        pos: P(lobbyPos.x, EYE, lobbyPos.z),
        look: P(Math.cos(SPAWN_ANGLE) * R_OUT, EYE + 0.3, Math.sin(SPAWN_ANGLE) * R_OUT),
      },
      spiral: {
        floorY: fj * FH + FH / 2,
        pos: P(Math.cos(fam) * (R_OUT - 2.9), fj * FH + EYE + 0.6, Math.sin(fam) * (R_OUT - 2.9)),
        look: P(Math.cos(fa1) * (R_OUT - 1.2), (fj + 1) * FH + EYE + 0.4, Math.sin(fa1) * (R_OUT - 1.2)),
      },
      rooms: layout.rooms.map((room) => {
        const A = room.angle, rMid = (CH_IN + CH_OUT) / 2;
        const posL = chPoint(A, rMid, 0, 0, -1.6), lookL = chPoint(A, rMid, 0, 0, (CH_OUT - CH_IN) / 2);
        return {
          product: room.offering.product, archetype: room.archetype, floorY: room.floorY,
          pos: P(posL.x, room.floorY + EYE, posL.z),
          look: P(lookL.x, room.floorY + EYE + 0.2, lookL.z),
        };
      }),
    };
  },
  roomData: (nameOrId) => {
    const v = state.catalog.vendors.find((x) => x.id === nameOrId || x.name === nameOrId);
    if (!v) return null;
    return v.offerings.map((o) => ({
      product: o.product,
      room: o.room,
      build: o.room.buildGroup ? state.catalog.builds[o.room.buildGroup] : null,
    }));
  },
  setMove: ({ forward = 0, back = 0, left = 0, right = 0 }) => {
    debugMove.f = forward; debugMove.b = back; debugMove.l = left; debugMove.r = right;
  },
  samplePixels: (w = 96, h = 96) => {
    renderer.render(scene, camera);
    const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
    const ctx = c2.getContext('2d');
    ctx.drawImage(renderer.domElement, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const bg = [data[0], data[1], data[2]];
    let nonBg = 0, bright = 0;
    const colors = new Set();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 24) nonBg++;
      if (r + g + b > 200) bright++;
      colors.add((r >> 4) + ',' + (g >> 4) + ',' + (b >> 4));
    }
    const total = w * h;
    return { nonBgFraction: nonBg / total, brightFraction: bright / total, distinctColors: colors.size, bg };
  },
};

/* ---------------- main loop ---------------- */
const clock = new THREE.Clock();
let fpsAccum = 0, fpsCount = 0, fpsTimer = 0, labelTimer = 0, statsTimer = 0;
function nearestDistrictName() {
  if (Math.hypot(player.x, player.z) < 112) return 'Central Plaza';
  let best = null, bd = Infinity;
  for (const d of state.districts) {
    const dist = Math.hypot(d.center.x - player.x, d.center.z - player.z);
    if (dist < bd) { bd = dist; best = d; }
  }
  if (best && bd <= best.radius) return `${best.functionName} · ${best.tier}`;
  return 'The Boulevard';
}
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.1);
  const prevX = player.x, prevZ = player.z;
  stepMovement(dt);
  if (state.interior) {
    resolveInteriorMove(prevX, prevZ);
    animateInterior(dt);
  }
  camera.position.set(player.x, player.y, player.z);
  camera.rotation.set(player.pitch, player.yaw, 0);
  renderer.render(scene, camera);
  state.frames++;
  if (!state.interior && state.ready) state.exteriorDrawCalls = renderer.info.render.calls;
  fpsAccum += dt; fpsCount++; fpsTimer += dt; labelTimer += dt; statsTimer += dt;
  if (fpsTimer > 0.5) { state.fps = Math.round(fpsCount / Math.max(fpsAccum, 0.001)); fpsAccum = 0; fpsCount = 0; fpsTimer = 0; }
  if (labelTimer > 0.12) { labelTimer = 0; if (state.ready) updateLabels(); }
  if (statsTimer > 0.5) {
    statsTimer = 0;
    if (state.ready) {
      const s = currentStats();
      if (state.interior) {
        statsbar.textContent = `${state.interior.vendor.name} — interior · floor ${Math.round(state.interior.floorY / FH)} of ${state.interior.layout.levels} · ${s.drawCalls} draw calls · ${Math.round(s.triangles / 1000)}k triangles · ${s.fps} fps`;
      } else {
        statsbar.textContent = `${nearestDistrictName()} · ${s.drawCalls} draw calls · ${Math.round(s.triangles / 1000)}k triangles · ${s.fps} fps`;
      }
      updatePrompt();
    }
  }
}
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

boot().catch((err) => {
  document.getElementById('loading').textContent = 'Failed to build the Base: ' + err.message;
  console.error(err);
});
loop();
