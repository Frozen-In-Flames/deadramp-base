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
  card.style.display = 'block';
}
function pickAt(clientX, clientY) {
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

/* ---------------- controls: keyboard, pointer lock, touch ---------------- */
const keys = {};
window.addEventListener('keydown', (ev) => { keys[ev.code] = true; });
window.addEventListener('keyup', (ev) => { keys[ev.code] = false; });
const debugMove = { f: 0, b: 0, l: 0, r: 0 };
const stick = { active: false, id: -1, ox: 0, oy: 0, mx: 0, mz: 0 };
const stickEl = document.getElementById('stick');
const stickKnob = document.getElementById('stickKnob');
let lookTouch = { id: -1, lx: 0, ly: 0 };
let downInfo = null;

renderer.domElement.addEventListener('click', (ev) => {
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
    downInfo = { x: t.clientX, y: t.clientY, t: performance.now() };
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
    if (downInfo && performance.now() - downInfo.t < 260 && Math.hypot(t.clientX - downInfo.x, t.clientY - downInfo.y) < 9) {
      pickAt(t.clientX, t.clientY);
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
  };
}
window.__BASE_STATS__ = () => currentStats();
window.__BASE__ = {
  stats: () => currentStats(),
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
  stepMovement(dt);
  camera.position.set(player.x, player.y, player.z);
  camera.rotation.set(player.pitch, player.yaw, 0);
  renderer.render(scene, camera);
  state.frames++;
  fpsAccum += dt; fpsCount++; fpsTimer += dt; labelTimer += dt; statsTimer += dt;
  if (fpsTimer > 0.5) { state.fps = Math.round(fpsCount / Math.max(fpsAccum, 0.001)); fpsAccum = 0; fpsCount = 0; fpsTimer = 0; }
  if (labelTimer > 0.12) { labelTimer = 0; if (state.ready) updateLabels(); }
  if (statsTimer > 0.5) {
    statsTimer = 0;
    if (state.ready) {
      const s = currentStats();
      statsbar.textContent = `${nearestDistrictName()} · ${s.drawCalls} draw calls · ${Math.round(s.triangles / 1000)}k triangles · ${s.fps} fps`;
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
