/*
 * DeadRamp Base: spiral city exterior (Phase 1), interiors (Phase 2),
 * WebXR control layer (Phase 3).
 *
 * The whole world is generated at load from data/base-catalog.json
 * (exported from the DeadRamp registry by tools/export-catalog.js).
 * Zero hand-placed buildings. Layout math: see LAYOUT.md.
 *
 * Rendering discipline for the Quest 2 floor: buildings, lit-window
 * overlays, roof trims and gate pylons are each a single InstancedMesh;
 * ground discs and roads are each one merged geometry. Structure is
 * rig-based: the world hangs off `worldGroup`, the visitor off
 * `player` (position + yaw/pitch), and the camera rides in `rig`,
 * whose transform the player record drives. Phase 3 only replaced
 * the control layer, as planned: on flat screens the rig carries the
 * eye from player pitch/height; in WebXR the headset pose drives the
 * camera inside the same rig, and thumbstick locomotion feeds the
 * same movement model, so every behaviour (including the interior
 * spiral climb) is shared, not reimplemented.
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

/* Phase 3: WebXR is enabled from the start so a session can begin on
 * a visitor's gesture without rebuilding the renderer. Fixed
 * foveation is set to a conservative 0.6 (Three's own default is 1.0,
 * the maximum: full foveation trades a lot of peripheral resolution
 * for speed; 0.6 keeps the periphery readable while still easing the
 * Quest 2's fragment load). The manager applies the stored value to
 * the session's layer when a session starts. */
const XR_FOVEATION = 0.6;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFoveation(XR_FOVEATION);

const scene = new THREE.Scene();
const SKY = new THREE.Color(0x1b2436);
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 70, 560);

const FLAT_FOV = 68;
const camera = new THREE.PerspectiveCamera(FLAT_FOV, window.innerWidth / window.innerHeight, 0.1, 4000);
camera.rotation.order = 'YXZ';

/* The camera rig: the single bridge between the player record and
 * the view. The rig carries the player's ground position and yaw;
 * the camera's local transform is the eye. On flat screens the loop
 * sets the eye from player pitch at standing height. While an XR
 * session presents, the WebXR manager writes the headset pose into
 * the camera's local transform (in reference space) and reads the
 * rig as the pose's parent, so the visitor's physical head motion
 * and room-scale steps layer onto the same player position, and
 * entering or leaving VR never moves the visitor. */
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);

scene.add(new THREE.HemisphereLight(0x93b8dd, 0x2c241a, 1.30));
const sun = new THREE.DirectionalLight(0xffb36b, 1.8);
sun.position.set(-0.45, 0.38, 0.25).multiplyScalar(1000);
scene.add(sun);
const fill = new THREE.DirectionalLight(0x6f87b8, 0.45);
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
  /* Phase 3: WebXR session state. The player record above stays the
   * single source of truth for where the visitor is; this record is
   * only about the session itself. */
  xr: {
    supported: false,      // immersive-vr confirmed by feature detection
    requesting: false,     // a session request is in flight
    refSpace: null,        // reference space type the live session granted
    attempts: [],          // negotiation ladder steps tried, in order
    lastError: null,       // last session-request failure, if any
    headYaw: null,         // headset world yaw while presenting (movement frame)
    gazeMode: false,       // presenting with no tracked-pointer source
  },
  /* Phase 4: skybridges, the platform deck, construction states. All
   * three are generated from the catalog at load (catalog.merges,
   * catalog.platformLayer, per-vendor construction records); nothing
   * about them is hardcoded per vendor. */
  bridgeMesh: null, segBridge: [], deckPickables: [],
  phase4: { bridges: 0, bridgeSegments: 0, deckDecisions: 0, deckEntries: 0, constructionVendors: 0, siteworkInstances: 0, cranes: 0, netting: 0 },
  phase4Points: null,      // viewpoints of the three features, for verification
};

const TIER_TRIM = { l1: new THREE.Color(0xcd7f32), l2: new THREE.Color(0xcfd8dc), l3: new THREE.Color(0xffd700), untiered: new THREE.Color(0x546e7a) };
const GRAY = new THREE.Color(0x8a8d90);
const LIMESTONE = new THREE.Color(0xcfc9b8);
const WARM_GLASS = new THREE.Color(0xfff4e0);
/* The standing framing text: our rendition, their identity,
 * endorsement never implied. Since Nov 15, 2026 (Aries's
 * directive) it lives in exactly one place inside the experience,
 * the Settings panel under "About this model"; it is not repeated
 * on walls, panels, cards, or signs. The README keeps it as
 * repository documentation. */
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
    new THREE.MeshLambertMaterial({ color: 0x39463c }));
  ground.position.y = 0;
  worldGroup.add(ground);

  /* district ground discs, one merged geometry */
  const discs = [];
  for (const d of catalog.districts) {
    const c = hexColor(d.color).multiplyScalar(0.44);
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

  /* plaza + directory kiosk placeholder at the spiral centre.
   * The plaza is paved, not a bare disc: concentric granite inlay
   * rings at the quarter, half, and three-quarter radii and a
   * bronze-ringed granite medallion at the spiral centre, all
   * layout math, merged with the base disc into one mesh so the
   * arrival view reads as a federal plaza at no extra draw calls. */
  const PLAZA_R = 112;
  const paving = [
    coloredGeom(new THREE.CircleGeometry(PLAZA_R, 56).rotateX(-Math.PI / 2).translate(0, 0.04, 0), new THREE.Color(0x5c636c)),
    coloredGeom(new THREE.RingGeometry(PLAZA_R * 0.25 - 0.9, PLAZA_R * 0.25 + 0.9, 56).rotateX(-Math.PI / 2).translate(0, 0.052, 0), GRANITE_C),
    coloredGeom(new THREE.RingGeometry(PLAZA_R * 0.5 - 1.1, PLAZA_R * 0.5 + 1.1, 56).rotateX(-Math.PI / 2).translate(0, 0.052, 0), GRANITE_C),
    coloredGeom(new THREE.RingGeometry(PLAZA_R * 0.75 - 1.1, PLAZA_R * 0.75 + 1.1, 56).rotateX(-Math.PI / 2).translate(0, 0.052, 0), GRANITE_C),
    coloredGeom(new THREE.CircleGeometry(6.0, 40).rotateX(-Math.PI / 2).translate(0, 0.052, 0), GRANITE_C),
    coloredGeom(new THREE.RingGeometry(6.0, 6.9, 40).rotateX(-Math.PI / 2).translate(0, 0.058, 0), new THREE.Color(0x8c6a2f)),
  ];
  const plaza = new THREE.Mesh(mergeGeoms(paving), new THREE.MeshLambertMaterial({ vertexColors: true }));
  worldGroup.add(plaza);
  paving.forEach((g) => g.dispose());
  const kiosk = new THREE.Group();
  const kioskMat = new THREE.MeshLambertMaterial({ color: 0x36415a });
  const kioskAccent = new THREE.MeshLambertMaterial({ color: 0xffb36b });
  const base = new THREE.Mesh(new THREE.BoxGeometry(7, 3.4, 1.4), kioskMat); base.position.y = 1.7;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.35, 2.4), kioskAccent); roof.position.y = 3.6;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(7.6, 1.7),
    new THREE.MeshBasicMaterial({ map: textTexture(['DEADRAMP BASE', 'Directory · full kiosk in Phase 2']) }));
  sign.position.set(0, 4.6, 0.2);
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.1, 0.3), kioskMat); legL.position.set(-3.4, 4.05, 0);
  const legR = legL.clone(); legR.position.x = 3.4;
  kiosk.add(base, roof, sign, legL, legR);
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

  /* Phase 4: skybridges, the platform deck, construction states */
  buildPhase4(catalog);

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

/* ---------------- Phase 4: bridges, platform deck, construction ----
 * Skybridges: DeadRamp's record of merged portfolios is a record of
 * merged BUILDS, not merged vendors: 18 group builds declare in their
 * UNION-SPEC lineage that they do not start from zero, naming 19
 * parent edges under the Merge Rule. No vendor-to-vendor merge
 * exists anywhere in the record, so no bridge joins two buildings.
 * Each bridge joins the gates of the two districts where the child
 * and parent builds' offerings actually live (the exporter emits the
 * anchor districts; several builds anchor to a district named for
 * another category, because that is where the Marketplace files
 * their forks). The bridge's exhibit is its record card: the Merge
 * Rule, the two builds, and the spec the lineage came from.
 *
 * Platform deck: the 40 GAPS entries DeadRamp closed as re-scoped
 * belong to no vendor and no offering; they are properties of the
 * deployment platform, decided once in PLATFORM-LAYER.md. They get
 * one shared deck on the plaza carrying the six decisions and the
 * entry record, never buildings of their own.
 *
 * Construction states: a vendor's construction record is the share
 * of its own offerings not yet certified. That share of the tower is
 * scaffolded; a fully pending tower is scaffolded to the top and
 * netted; mixed towers are scaffolded part-way, over the finished
 * massing and lit windows below (the status weathering stays: this
 * extends it, it does not replace it). Cranes are district
 * equipment: the exporter flags the tallest fully-pipeline building
 * in each district with at least three of them. Signage is honest
 * and generic: UNDER CONSTRUCTION, no vendor artwork.
 *
 * Everything below is instanced or merged: one InstancedMesh for all
 * bridge segments, one for all sitework (scaffolds, barriers,
 * cranes, bridgehead pylons), one for netting shells, one for signs. */
const SITE_ORANGE = new THREE.Color(0xc96a1e);
const SITE_WHITE = new THREE.Color(0xe8e6df);
const SITE_STEEL = new THREE.Color(0xb9c4d4);
const SITE_DARK = new THREE.Color(0x20242c);
const GRANITE_C = new THREE.Color(0x4c5257);
const UP_V = new THREE.Vector3(0, 1, 0);

function curvePoint(a, c, b, t) {
  const u = 1 - t;
  return new THREE.Vector3(
    u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    u * u * a.z + 2 * u * t * c.z + t * t * b.z);
}
function instancedBoxes(list, material) {
  const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, list.length);
  const d = new THREE.Object3D();
  list.forEach((it, i) => {
    d.position.set(it.x, it.y, it.z);
    if (it.quat) d.quaternion.copy(it.quat); else d.quaternion.identity();
    d.scale.set(it.sx, it.sy, it.sz);
    d.updateMatrix();
    m.setMatrixAt(i, d.matrix);
    m.setColorAt(i, it.color);
  });
  m.instanceMatrix.needsUpdate = true;
  if (m.instanceColor) m.instanceColor.needsUpdate = true;
  m.frustumCulled = false;
  return m;
}

function buildPhase4(catalog) {
  const P4 = state.phase4;
  const sitework = [];   // scaffolds, barriers, cranes, bridgeheads
  const netting = [];    // one shell per fully-pending tower
  const signs = [];      // UNDER CONSTRUCTION boards
  const push = (list, x, y, z, sx, sy, sz, color, quat) =>
    list.push({ x, y, z, sx, sy, sz, color, quat: quat || null });
  const byId = new Map(state.districts.map((d) => [d.id, d]));

  /* --- skybridges, gate to gate, one per merge edge --- */
  const bridgeSegs = [];
  const usedGates = new Set();
  const m4 = new THREE.Matrix4();
  for (const e of catalog.merges) {
    const A = byId.get(e.parentDistrict), B = byId.get(e.childDistrict);
    if (!A || !B) continue;
    const p0 = new THREE.Vector3(A.gate.x, 26, A.gate.z);
    const p2 = new THREE.Vector3(B.gate.x, 26, B.gate.z);
    const dist = p0.distanceTo(p2);
    const peak = Math.min(150, Math.max(44, 26 + dist * 0.16));
    const p1 = new THREE.Vector3((p0.x + p2.x) / 2, peak, (p0.z + p2.z) / 2);
    e._mid = curvePoint(p0, p1, p2, 0.5);
    e._len = dist;
    const n = Math.max(8, Math.min(44, Math.round(dist / 26)));
    const slabCol = GRANITE_C.clone().lerp(new THREE.Color(B.color), 0.25);
    const railCol = TIER_TRIM[B.tier] || TIER_TRIM.untiered;
    for (let i = 0; i < n; i++) {
      const a = curvePoint(p0, p1, p2, i / n), b = curvePoint(p0, p1, p2, (i + 1) / n);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const len = a.distanceTo(b) * 1.08;
      const q = new THREE.Quaternion().setFromRotationMatrix(m4.lookAt(a, b, UP_V));
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      bridgeSegs.push({ x: mid.x, y: mid.y, z: mid.z, sx: 3.4, sy: 0.7, sz: len, color: slabCol, quat: q });
      state.segBridge.push(e);
      bridgeSegs.push({ x: mid.x + up.x * 0.62, y: mid.y + up.y * 0.62, z: mid.z + up.z * 0.62, sx: 3.9, sy: 0.3, sz: len, color: railCol, quat: q });
      state.segBridge.push(e);
    }
    usedGates.add(A.id); usedGates.add(B.id);
    P4.bridges++;
    P4.bridgeSegments += n;
  }
  if (bridgeSegs.length) {
    state.bridgeMesh = instancedBoxes(bridgeSegs, new THREE.MeshLambertMaterial({ color: 0xffffff }));
    worldGroup.add(state.bridgeMesh);
  }
  /* bridgehead pylons: a tower at each gate a bridge lands on */
  for (const id of usedGates) {
    const d = byId.get(id);
    push(sitework, d.gate.x, 13, d.gate.z, 2.4, 26, 2.4, GRANITE_C);
    push(sitework, d.gate.x, 26.6, d.gate.z, 3.2, 1.1, 3.2, new THREE.Color(0x8c6a2f));
  }

  /* --- construction states --- */
  for (const v of state.buildings) {
    const con = v.construction;
    if (!con || con.frac <= 0) continue;
    P4.constructionVendors++;
    const q = new THREE.Quaternion().setFromAxisAngle(UP_V, v.rotationY);
    const local = (list, lx, ly, lz, sx, sy, sz, color) => {
      const p = new THREE.Vector3(lx, 0, lz).applyQuaternion(q);
      push(list, v.position.x + p.x, ly, v.position.z + p.z, sx, sy, sz, color, q);
    };
    const hw = v.size.w / 2 + 0.55, hd = v.size.d / 2 + 0.55;
    const sh = Math.max(2.4, v.size.h * con.frac);
    for (const [cx, cz] of [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]]) {
      local(sitework, cx, sh / 2, cz, 0.18, sh, 0.18, SITE_STEEL);
    }
    const levels = Math.max(1, Math.round(sh / 2.3));
    for (let li = 1; li <= levels; li++) {
      const y = Math.min(sh, (sh / levels) * li);
      local(sitework, 0, y, -hd, hw * 2, 0.14, 0.14, SITE_STEEL);
      local(sitework, 0, y, hd, hw * 2, 0.14, 0.14, SITE_STEEL);
      local(sitework, -hw, y, 0, 0.14, 0.14, hd * 2, SITE_STEEL);
      local(sitework, hw, y, 0, 0.14, 0.14, hd * 2, SITE_STEEL);
    }
    for (let bi = -1; bi <= 1; bi++) {
      local(sitework, bi * (v.size.w / 3), 0.45, hd + 1.15, v.size.w / 3 - 0.3, 0.9, 0.22, bi === 0 ? SITE_WHITE : SITE_ORANGE);
    }
    signs.push(v);
    if (con.frac >= 0.999) {
      push(netting, v.position.x, v.size.h * 0.485, v.position.z,
        v.size.w + 1.3, v.size.h * 0.97, v.size.d + 1.3, SITE_ORANGE, q);
      P4.netting++;
    }
    if (con.crane) {
      P4.cranes++;
      const ch = v.size.h + 13;
      const cx = hw + 6.5, cz = hd * 0.2;
      local(sitework, cx, ch / 2, cz, 0.5, ch, 0.5, SITE_ORANGE);
      local(sitework, cx - (v.size.w / 2 + 7), ch - 1.2, cz, v.size.w + 14, 0.45, 0.45, SITE_ORANGE);
      local(sitework, cx + 4.5, ch - 1.2, cz, 8, 0.45, 0.45, SITE_ORANGE);
      local(sitework, cx + 4.5, ch - 2.7, cz, 1.4, 2.2, 1.4, GRANITE_C);
      const hx = -v.size.w * 0.2, drop = ch * 0.45;
      local(sitework, hx, ch - 1.2 - drop / 2, cz, 0.07, drop, 0.07, SITE_DARK);
      local(sitework, hx, ch - 1.2 - drop, cz, 0.85, 0.85, 0.85, SITE_ORANGE);
    }
  }
  P4.siteworkInstances = sitework.length;
  if (sitework.length) worldGroup.add(instancedBoxes(sitework, new THREE.MeshLambertMaterial({ color: 0xffffff })));
  if (netting.length) {
    worldGroup.add(instancedBoxes(netting, new THREE.MeshLambertMaterial({
      color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false,
    })));
  }
  if (signs.length) {
    const tex = textTexture(['UNDER CONSTRUCTION', 'authorization in process'],
      { w: 1024, h: 256, bg: '#2a1c08', fg: '#ffb36b', sub: '#e8d9b8' });
    const sm = new THREE.InstancedMesh(new THREE.PlaneGeometry(6.4, 1.6),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }), signs.length);
    const d = new THREE.Object3D();
    signs.forEach((v, i) => {
      const fx = Math.sin(v.rotationY), fz = Math.cos(v.rotationY);
      d.position.set(v.position.x + fx * (v.size.d / 2 + 2.3), 2.6, v.position.z + fz * (v.size.d / 2 + 2.3));
      d.quaternion.setFromAxisAngle(UP_V, v.rotationY);
      d.scale.set(1, 1, 1);
      d.updateMatrix();
      sm.setMatrixAt(i, d.matrix);
    });
    sm.instanceMatrix.needsUpdate = true;
    sm.frustumCulled = false;
    worldGroup.add(sm);
  }

  buildPlatformDeck(catalog, byId);
  computePhase4Points(catalog);
}

/* The platform deck: one shared structure on the plaza, west of
 * spawn and facing it (the anchor is a layout constant the exporter
 * emits). Federal materials, like the kiosk: granite slab, limestone
 * inlay, bronze trim. The six decisions stand as panels around a
 * central walkway; the directory board carries the entry record —
 * which GAPS sections the re-scoped entries belong to, and how many
 * each holds, counted from the catalog, never typed in. */
function buildPlatformDeck(catalog, byId) {
  const P4 = state.phase4;
  const pl = catalog.platformLayer;
  P4.deckDecisions = pl.decisions.length;
  P4.deckEntries = pl.rescoped.length;
  const A = pl.deckAnchor;
  const deck = new THREE.Group();
  deck.position.set(A.x, 0, A.z);
  deck.rotation.y = A.rotationY;

  const geoms = [];
  const slab = coloredGeom(new THREE.BoxGeometry(46, 1.1, 26), 0x4c5257); slab.translate(0, 0.55, 0); geoms.push(slab);
  const inlay = coloredGeom(new THREE.BoxGeometry(43, 0.14, 23), 0xcfc9b8); inlay.translate(0, 1.12, 0); geoms.push(inlay);
  for (const s of [-1, 1]) {
    const trim = coloredGeom(new THREE.BoxGeometry(46.6, 0.32, 0.55), 0x8c6a2f);
    trim.translate(0, 1.0, s * 13.05); geoms.push(trim);
  }
  const postAt = (x, z, top) => {
    const p = coloredGeom(new THREE.BoxGeometry(0.26, top - 1.1, 0.26), 0x4c5257);
    p.translate(x, (top + 1.1) / 2, z); geoms.push(p);
  };
  const panelX = [-14.5, 0, 14.5];
  pl.decisions.forEach((d, i) => {
    const row = i < 3 ? -5.5 : 5.5;
    postAt(panelX[i % 3] - 2.6, row, 3.4); postAt(panelX[i % 3] + 2.6, row, 3.4);
  });
  postAt(-4.9, -10.6, 6.4); postAt(4.9, -10.6, 6.4);       // directory board
  postAt(-5.2, -10.6, 8.6); postAt(5.2, -10.6, 8.6);       // header sign
  deck.add(new THREE.Mesh(mergeGeoms(geoms), new THREE.MeshLambertMaterial({ vertexColors: true })));

  pl.decisions.forEach((d, i) => {
    const row = i < 3 ? -5.5 : 5.5;
    const lines = [];
    if (d.controls) lines.push(`Controls: ${d.controls}`);
    lines.push(d.text);
    const p = makePanel(6.6, 3.5, `${d.n}. ${d.title}`.toUpperCase(), lines, '#ffb36b');
    p.position.set(panelX[i % 3], 3.55, row);
    p.rotation.y = row < 0 ? 0 : Math.PI;
    deck.add(p);
    state.deckPickables.push(p);
  });

  const bySection = new Map();
  for (const e of pl.rescoped) {
    if (!bySection.has(e.group)) bySection.set(e.group, { section: e.section, district: e.district, n: 0 });
    bySection.get(e.group).n++;
  }
  const boardLines = [
    `${pl.rescoped.length} catalogue gap entries were not built per group.`,
    'They are properties of the platform every service is',
    'deployed on, decided once, in writing, in',
    'PLATFORM-LAYER.md. The six panels on this deck',
    'state the decisions.',
    '',
    ...[...bySection.entries()].sort((a, b) => a[0] - b[0]).map(([g, s]) => {
      const d = byId.get(s.district);
      const dn = d ? `${d.functionName} ${d.tier}` : s.district;
      return `Group ${g} · ${s.section} — ${s.n} ${s.n === 1 ? 'entry' : 'entries'} (${dn} district)`;
    }),
    '',
    'Full record: GAPS.md in the DeadRamp repo, and the',
    "platformLayer record in this Base's catalog data.",
  ];
  const board = makePanel(11.4, 5.4, 'THE PLATFORM LAYER — CLOSED IN WRITING', boardLines, '#ffd9a0');
  board.position.set(0, 4.15, -10.6);
  deck.add(board);
  state.deckPickables.push(board);

  const sign = new THREE.Mesh(new THREE.PlaneGeometry(12.5, 2.3),
    new THREE.MeshBasicMaterial({
      map: textTexture(['PLATFORM LAYER', 'one shared deck · decided once, in writing'],
        { w: 1024, h: 192, bg: '#10141d', fg: '#ffd9a0', sub: '#9fb0c3' }),
      side: THREE.DoubleSide,
    }));
  sign.position.set(0, 7.7, -10.6);
  deck.add(sign);

  const hit = new THREE.Mesh(new THREE.BoxGeometry(46, 7, 26),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
  hit.position.y = 3.5;
  deck.add(hit);
  state.deckPickables.push(hit);
  worldGroup.add(deck);
}

/* Viewpoints of the three features, computed from the same data the
 * features are built from, so verification looks at what was built
 * rather than re-deriving where it should be. */
function computePhase4Points(catalog) {
  const A = catalog.platformLayer.deckAnchor;
  const fwd = new THREE.Vector3(Math.sin(A.rotationY), 0, Math.cos(A.rotationY));
  const pts = {
    deck: {
      pos: { x: A.x + fwd.x * 36, y: 1.7, z: A.z + fwd.z * 36 },
      look: { x: A.x, y: 3.4, z: A.z },
    },
  };
  let best = null;
  for (const e of catalog.merges) if (e._mid && (!best || e._len < best._len)) best = e;
  if (best) {
    const A2 = state.districts.find((d) => d.id === best.parentDistrict);
    const B2 = state.districts.find((d) => d.id === best.childDistrict);
    const chord = new THREE.Vector3(B2.gate.x - A2.gate.x, 0, B2.gate.z - A2.gate.z).normalize();
    const perp = new THREE.Vector3(-chord.z, 0, chord.x);
    pts.bridge = {
      edge: `${best.child}<-${best.parent}`,
      pos: { x: best._mid.x + perp.x * 60, y: best._mid.y + 14, z: best._mid.z + perp.z * 60 },
      look: { x: best._mid.x, y: best._mid.y, z: best._mid.z },
    };
  }
  const cv = state.buildings.find((v) => v.construction && v.construction.crane);
  if (cv) {
    const dp = doorPoint(cv);
    const fx = Math.sin(cv.rotationY), fz = Math.cos(cv.rotationY);
    pts.construction = {
      vendor: cv.name,
      pos: { x: dp.x + fx * 20, y: 1.7, z: dp.z + fz * 20 },
      look: { x: cv.position.x, y: cv.size.h * 0.55, z: cv.position.z },
    };
  }
  state.phase4Points = pts;
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
    /* legibility floor: a name at the edge of label range still
     * renders at better than half opacity (measured at spawn: every
     * visible vendor label sat at the old 0.20 floor). */
    const op = 0.55 + 0.45 * (1 - dist / LABEL_VENDOR_RANGE);
    placeLabel(el, v.position.x, v.size.h + 2.5, v.position.z, v.name, op);
  }
  let di = 0;
  for (const d of state.districts) {
    if (di >= districtLabels.length) break;
    const dx = d.center.x - px, dz = d.center.z - pz;
    const dist = Math.hypot(dx, dz);
    if (dist < LABEL_DISTRICT_RANGE) {
      placeLabel(districtLabels[di], d.gate.x, 11, d.gate.z, `${d.functionName} · ${d.tier}`, 0.6 + 0.4 * (1 - dist / LABEL_DISTRICT_RANGE));
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
    lotNote + `<ul>${rows}</ul>`;
  if (v.kind === 'building') {
    const btn = document.createElement('button');
    btn.className = 'enterBtn';
    btn.textContent = `Enter ${v.name}`;
    btn.addEventListener('click', () => { card.style.display = 'none'; enterBuilding(v); });
    cardBody.appendChild(btn);
  }
  card.style.display = 'block';
  /* In VR the DOM card is not visible inside the headset, so the
   * same record is drawn onto the in-world card (Phase 3 section). */
  if (renderer.xr.isPresenting) drawXRCard(v);
}
/* One raycast for every pointing device: mouse and touch set the
 * ray from the camera, the XR controller ray and the gaze ray set it
 * from their own poses; all of them resolve to the same vendor. */
function raycastBuildings() {
  if (state.interior) return null;
  if (state.bodyMesh) {
    const hits = raycaster.intersectObject(state.bodyMesh);
    if (hits.length && hits[0].instanceId !== undefined) return state.buildings[hits[0].instanceId];
  }
  const lotHits = raycaster.intersectObjects(state.lotMeshes);
  if (lotHits.length) return lotHits[0].object.userData.vendor;
  return null;
}
function pickAt(clientX, clientY) {
  if (state.interior) return false;
  const nx = (clientX / window.innerWidth) * 2 - 1;
  const ny = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera({ x: nx, y: ny }, camera);
  const v = raycastBuildings();
  if (v) { showCard(v); return true; }
  const f = raycastFeatures();
  if (f) { showFeatureCard(f); return true; }
  return false;
}

/* Phase 4 picking: bridges resolve through the segment instance id
 * to their merge edge; the deck resolves through its panels, board,
 * and footprint hitbox. Exteriors only, like building picking. */
function raycastFeatures() {
  if (state.interior) return null;
  if (state.bridgeMesh) {
    const hits = raycaster.intersectObject(state.bridgeMesh);
    if (hits.length && hits[0].instanceId !== undefined) {
      const e = state.segBridge[hits[0].instanceId];
      if (e) return { feature: 'bridge', edge: e };
    }
  }
  if (state.deckPickables.length) {
    const hits = raycaster.intersectObjects(state.deckPickables, true);
    if (hits.length) return { feature: 'deck' };
  }
  return null;
}
function showFeatureCard(f) {
  if (f.feature === 'bridge') showBridgeCard(f.edge);
  else showDeckCard();
}
function districtLabel(id) {
  const d = state.districts.find((x) => x.id === id);
  return d ? `${d.functionName} · ${d.tier}` : id;
}
const MERGE_KIND_TEXT = {
  merge: 'a union merge',
  'carry-down': 'a cross-tier carry, downward',
  'carry-up': 'a cross-tier carry, upward',
};
function showBridgeCard(e) {
  const rec = { feature: 'bridge', edge: e };
  state.selected = rec;
  cardBody.innerHTML =
    `<h3>Skybridge — ${MERGE_KIND_TEXT[e.kind] || 'a union merge'}</h3>` +
    `<div class="meta">${districtLabel(e.parentDistrict)} district ↔ ${districtLabel(e.childDistrict)} district</div>` +
    `<div class="note">The ${e.child} build (${e.childForks} forks) is built on the ${e.parent} build (${e.parentForks} forks): ` +
    `the parent build's control baseline is united with the child tier's own forks, per the lineage recorded in ${e.spec} in the DeadRamp repo. ` +
    `This bridge joins the gates of the two districts where those builds' offerings live.</div>` +
    `<div class="note">The merge is between DeadRamp's reference builds, not between vendors: no vendor in the record merged with another vendor. The Merge Rule it follows:</div>` +
    `<ul><li>Union of the parent baselines, never the intersection</li>` +
    `<li>The highest parent tier is inherited in full</li>` +
    `<li>Every merge carries a control traceability record</li>` +
    `<li>Process per NIST SP 800-218 (SSDF): provenance, review, verification</li></ul>`;
  card.style.display = 'block';
  if (renderer.xr.isPresenting) drawXRCard(rec);
}
function showDeckCard() {
  const rec = { feature: 'deck' };
  state.selected = rec;
  const pl = state.catalog.platformLayer;
  const bySection = new Map();
  for (const e of pl.rescoped) {
    if (!bySection.has(e.group)) bySection.set(e.group, { section: e.section, district: e.district, n: 0 });
    bySection.get(e.group).n++;
  }
  const decisions = pl.decisions.map((d) =>
    `<li><b>${d.title}</b>${d.controls ? ` (${d.controls})` : ''}</li>`).join('');
  const sections = [...bySection.entries()].sort((a, b) => a[0] - b[0]).map(([g, s]) =>
    `<li>Group ${g} · ${s.section} — ${s.n} ${s.n === 1 ? 'entry' : 'entries'} (${districtLabel(s.district)} district)</li>`).join('');
  cardBody.innerHTML =
    `<h3>The Platform Layer</h3>` +
    `<div class="meta">${pl.rescoped.length} re-scoped entries · ${pl.decisions.length} standing decisions · one shared deck</div>` +
    `<div class="note">These catalogue entries belong to no vendor and no offering. They are properties of the platform every service is deployed on, so DeadRamp decided them once, in writing, instead of building them per group. The Base gives them this deck, not buildings.</div>` +
    `<div class="meta">The six decisions (PLATFORM-LAYER.md):</div><ul>${decisions}</ul>` +
    `<div class="meta">The entries, by the GAPS section that closed them:</div><ul>${sections}</ul>`;
  card.style.display = 'block';
  if (renderer.xr.isPresenting) drawXRCard(rec);
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
 * The floors are cut over the coil (the well sector, wellSector):
 * each level's ring stops over the arriving and departing flights,
 * so the spiral is open to look up and down, and the flat-floor
 * candidate is withheld over exactly the cut sector.
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
const BAND_IN = R_OUT - 4.9;   // ramp band inner edge (interiorHeightAt's ramp band)
const BAND_OUT = R_OUT - 0.5;  // ramp band outer edge
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
/* The well: the sector of floor L's ramp band that is NOT floor.
 * Flight L-1 arrives at floor L and flight L departs from it, and
 * over both spans the band is open, so the coil reads as one
 * continuous spiral: no slab caps the ramp from above, no slab
 * hides it from the landing, and the ramp never pierces a floor.
 * The geometry cuts exactly this sector out of each floor's band
 * (buildInterior) and the height function withholds its flat
 * candidate over exactly the same sector (interiorHeightAt), so
 * the visitor stands only where floor visibly exists. Returns the
 * unwrapped [start, end] angles, or null outside 1..levels (the
 * lobby's ground disc is whole and is never cut). */
function wellSector(layout, L) {
  if (L < 1 || L > layout.levels) return null;
  const start = (L - 1) === 0 ? 0.2 : doorAngle(L - 2);
  const end = L < layout.levels ? doorAngle(L) : doorAngle(L - 1);
  return { start, end };
}
function inWell(layout, L, th) {
  const w = wellSector(layout, L);
  if (!w) return false;
  return angNorm(th - w.start) < (w.end - w.start);
}
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
    if (rel <= span && r >= BAND_IN && r <= BAND_OUT) {
      const h = j * FH + (rel / span) * FH;
      cand.push(h); rampCand.push({ h, j });
    }
    if (angDiff(th, a1) <= 0.18 && r >= R_OUT - 5.2 && r <= R_OUT + 0.6) cand.push((j + 1) * FH);
  }
  if (angDiff(th, EXIT_ANGLE) <= 0.3 && r >= R_OUT - 5.2) cand.push(0);
  /* The flat ring floor is a candidate only where the floor
   * physically is: everywhere outside the ramp band, and in the
   * band only outside the well sector of the floor being stood on
   * (the geometry cuts the same sector; see buildInterior). Inside
   * the well the ramp surfaces and the landing govern, so stepping
   * into the open well follows the coil down or up instead of
   * walking on air over it. Everywhere else the candidate is the
   * same value it has always been. */
  if (r >= R_WELL - 0.3 && r <= R_OUT + 0.3) {
    const L = Math.round(curFloor / FH);
    if (!(r >= BAND_IN && r <= BAND_OUT && inWell(layout, L, th))) cand.push(L * FH);
  }
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
/* Helical ramp ribbon between angles a0..a1, heights y0..y1.
 * Winding and normals both matter here, and both were wrong in the
 * first build: the triangles wound so the ribbon's front face
 * pointed DOWN while the stored normals claimed (0, 1, 0) up. The
 * interior material is double-sided, and Three flips the shading
 * normal on back faces, so the walking surface was shaded with a
 * downward normal: no sun, no sky hemisphere, and no point light
 * from above could ever reach it, and the coil rendered black at
 * every height (measured: 70 percent of the lower frame under
 * luminance 12 at flights 2 through 8, while the flight overhead,
 * seen from below on its front face, rendered bright: the world
 * was lit upside down). The fix winds the triangles so the front
 * face is the top, and stores the ribbon's true normal: for the
 * surface P(a, r) = (r cos a, y0 + s(a - a0), r sin a) with rise
 * per radian s, dP/da x dP/dr = (s sin a, r, -s cos a), which
 * points up and tilts against the slope. */
function rampGeom(a0, a1, y0, y1, rIn, rOut, color, yOff = 0) {
  const steps = Math.max(4, Math.ceil(Math.abs(a1 - a0) / 0.1));
  const pos = [], nor = [];
  const pt = (i, r) => {
    const t = i / steps, a = a0 + (a1 - a0) * t, y = y0 + (y1 - y0) * t + yOff;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  };
  const s = (y1 - y0) / (a1 - a0);
  const nrm = (i, r) => {
    const t = i / steps, a = a0 + (a1 - a0) * t;
    const vx = s * Math.sin(a), vy = r, vz = -s * Math.cos(a);
    const il = 1 / Math.hypot(vx, vy, vz);
    return [vx * il, vy * il, vz * il];
  };
  for (let i = 0; i < steps; i++) {
    const A = pt(i, rIn), B = pt(i, rOut), C = pt(i + 1, rIn), D = pt(i + 1, rOut);
    const nA = nrm(i, rIn), nB = nrm(i, rOut), nC = nrm(i + 1, rIn), nD = nrm(i + 1, rOut);
    pos.push(...A, ...C, ...B, ...B, ...C, ...D);
    nor.push(...nA, ...nC, ...nB, ...nB, ...nC, ...nD);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  return coloredGeom(g, color);
}
/* Flat annulus sector at height y between world angles a0..a1,
 * wound front-face-up with true up normals: the same construction
 * discipline as the ramp ribbons (the v0.3.13 lesson: a floor whose
 * front face points down is a floor no light can reach). Angles are
 * unwrapped; the trig wraps on its own. Used for the part of a
 * floor's ramp band that remains floor once the well sector is cut
 * (wellSector). */
function floorSectorGeom(a0, a1, y, rIn, rOut, color) {
  const steps = Math.max(4, Math.ceil(Math.abs(a1 - a0) / 0.1));
  const pos = [], nor = [];
  const pt = (i, r) => {
    const a = a0 + (a1 - a0) * (i / steps);
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  };
  for (let i = 0; i < steps; i++) {
    const A = pt(i, rIn), B = pt(i, rOut), C = pt(i + 1, rIn), D = pt(i + 1, rOut);
    pos.push(...A, ...C, ...B, ...B, ...C, ...D);
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
  /* Floors: whole across the inner annulus and the outer strip,
   * but in the ramp band each floor stops at its well sector (the
   * arriving and departing flights' spans, wellSector), so the
   * coil is one open spiral. Before this cut, a full ring at every
   * level capped the ramp below it and hid it from the landing
   * above: the visitor climbed under a ceiling and stood on what
   * read as flat floor (Aries's playtest, Nov 15, 2026). */
  for (let L = 1; L <= layout.levels; L++) {
    const w = wellSector(layout, L);
    statics.push(coloredGeom(xg(new THREE.RingGeometry(R_CORE, BAND_IN, 40).rotateX(-Math.PI / 2), 0, L * FH, 0, 0), FED.floor));
    statics.push(floorSectorGeom(w.end, w.start + Math.PI * 2, L * FH, BAND_IN, BAND_OUT, FED.floor));
    statics.push(coloredGeom(xg(new THREE.RingGeometry(BAND_OUT, R_OUT, 40).rotateX(-Math.PI / 2), 0, L * FH, 0, 0), FED.floor));
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

  /* lobby panels: the vendor record and the directory. Record data
   * only: the standing framing text is not a lobby feature (it
   * lives in the Settings panel; see the settings block below). */
  const panelTitles = [];
  const wallPanel = (angle, y, w, h, title, lines, accent) => {
    const mesh = makePanel(w, h, title, lines, accent);
    mesh.position.set(Math.cos(angle) * (R_OUT - 0.4), y, Math.sin(angle) * (R_OUT - 0.4));
    group.add(mesh);
    mesh.lookAt(0, INT_Y + y, 0);
    panels.push(mesh);
    panelTitles.push(title);
    return mesh;
  };
  const d0 = state.districts.find((x) => x.id === vendor.district);
  const lobbyLines = [
    `${d0 ? d0.functionName + ' · ' + d0.tier : ''} district · ${vendor.offeringCount} offering${vendor.offeringCount > 1 ? 's' : ''}`,
    `Status: ${STATUS_TEXT[vendor.statusClass]}`,
    '',
    'Rooms: one per offering, up the spiral ramp, one floor per room.',
    'The lobby door marked EXIT returns you to the boulevard.',
  ];
  wallPanel(SPAWN_ANGLE, 1.72, 6.4, 3.0, vendor.name.toUpperCase().slice(0, 34), lobbyLines, accentCss);
  wallPanel(SPAWN_ANGLE - 0.66, 1.72, 5.4, 3.0, 'DIRECTORY', [
    ...vendor.offerings.map((o, j) => `L${j + 1}  ${o.product}`),
  ], accentCss);
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
      panelTitles.push(title);
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
    panelTitles, lobbyLines,
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
 * keyboard visitors keep the WASD / E copy; and in WebXR every prompt
 * speaks controller / gaze language only (Phase 3). One resolver
 * decides the language, with XR first: a headset browser also reports
 * touch points, and while presenting the visitor holds controllers,
 * not a touchscreen.
 *
 * The help block is a tutorial, not a permanent overlay: it shows on
 * arrival outdoors, shows its indoor variant on first entry into a
 * building, fades after a short dwell or once the action it describes
 * is performed, and a persistent "?" button recalls the variant for
 * the space the visitor is in. In VR the same lifecycle drives an
 * in-world panel (the DOM block is invisible in a headset): it shows
 * and fades on the same schedule, and a controller squeeze recalls
 * it. The header title is not tutorial text and never fades. */
const IS_TOUCH = !!((window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
  || 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0);
function inputMode() {
  if (renderer.xr.isPresenting) return 'xr';
  return IS_TOUCH ? 'touch' : 'kb';
}
const HELP_DWELL_MS = 7000;
/* The XR help is written as wrapped lines first: the in-world panel
 * draws these lines verbatim, and the DOM block joins them, so the
 * two surfaces can never drift apart. */
const XR_HELP_LINES = {
  out: [
    'Left thumbstick to walk. Turn with the right',
    'thumbstick, or just turn your head.',
    'Point at a building and pull the trigger for',
    'its record. Stand at a door and pull the',
    'trigger to go in.',
    'Inside, one spiral ramp climbs past every',
    'service room. The lobby door marked EXIT',
    'takes you back to the boulevard.',
    'Squeeze a grip to recall this help.',
    'Everything is one spiral away.',
  ],
  in: [
    'Left thumbstick to walk. One spiral ramp',
    'climbs past every service room; each room',
    'opens off the coil on its own floor.',
    'Point and pull the trigger for a record.',
    'The lobby door marked EXIT, trigger beside',
    'it, returns you to the boulevard.',
    'Squeeze a grip to recall this help.',
  ],
};
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
    xr: XR_HELP_LINES.out.join(' '),
  },
  in: {
    kb: 'WASD / arrows to walk, mouse to look, Shift to move fast.<br>' +
      'One spiral ramp climbs past every service room; each room opens off the coil on its own floor. ' +
      'The lobby door marked EXIT (or <b>E</b> beside it) returns you to the boulevard.',
    touch: 'Left thumb stick to walk, drag right side to look. ' +
      'One spiral ramp climbs past every service room; each room opens off the coil on its own floor. ' +
      'Tap the lobby door marked EXIT to return to the boulevard.',
    xr: XR_HELP_LINES.in.join(' '),
  },
};
const hintEl = document.getElementById('hint');
const helpBtn = document.getElementById('helpBtn');
let helpTimer = 0;
let helpSpace = 'out';
const helpSeen = { indoor: false };
function showHelp(space) {
  helpSpace = space || (state.interior ? 'in' : 'out');
  hintEl.innerHTML = HELP_COPY[helpSpace][inputMode()];
  hintEl.classList.remove('faded');
  window.clearTimeout(helpTimer);
  helpTimer = window.setTimeout(hideHelp, HELP_DWELL_MS);
  if (renderer.xr.isPresenting) drawXRHelpPanel();
}
function hideHelp() {
  window.clearTimeout(helpTimer);
  hintEl.classList.add('faded');
}
helpBtn.addEventListener('click', () => showHelp(state.interior ? 'in' : 'out'));

/* ---------------- settings: the disclaimer's one home ----------------
 * Aries, Nov 15, 2026: a disclaimer is not an immersive feature, so
 * it is not repeated in every building. The framing text lives in
 * this one panel, under "About this model", and nowhere else in
 * the experience: no lobby plaque, no HUD note, no card footer, no
 * kiosk or deck plaque, no line inside the lobby record panel. The
 * button is a persistent affordance beside "?", in the same style;
 * it is not tutorial text and follows no fade lifecycle. In XR the
 * same panel rides the in-world panel system (drawXRSettingsPanel):
 * a grip squeeze moves help -> Settings -> closed, so the text is
 * reachable in the headset without a DOM. */
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
document.getElementById('settingsAbout').textContent = FRAMING;
let settingsOpen = false;
function showSettings() {
  settingsOpen = true;
  settingsPanel.style.display = 'block';
  hideHelp();
  if (renderer.xr.isPresenting) drawXRSettingsPanel();
}
function hideSettings() {
  settingsOpen = false;
  settingsPanel.style.display = 'none';
}
settingsBtn.addEventListener('click', () => { if (settingsOpen) hideSettings(); else showSettings(); });
document.getElementById('settingsClose').addEventListener('click', hideSettings);

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
  const mode = inputMode();
  if (state.interior) {
    if (state.interior.atExit) {
      promptEl.innerHTML = mode === 'xr' ? 'Trigger — Exit to the boulevard'
        : mode === 'touch' ? 'Tap — Exit to the boulevard' : '<b>E</b> — Exit to the boulevard';
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
    promptEl.innerHTML = mode === 'xr' ? `Trigger — Enter ${best.name}`
      : mode === 'touch' ? `Tap the door — Enter ${best.name}` : `<b>E</b> — Enter ${best.name}`;
    promptEl.style.display = 'block';
  } else promptEl.style.display = 'none';
}

/* ---------------- Phase 3: the WebXR control layer ----------------
 * Everything in this section is additive. The world, the interiors,
 * the movement model, and the player record are untouched; XR is a
 * third way of driving them, beside keyboard/mouse and touch:
 *
 * - The rig (created with the camera) carries the player's ground
 *   position and yaw. While presenting, the manager writes the
 *   headset pose into the camera's local transform, so the visitor
 *   IS the camera, and physical head turns and room-scale steps
 *   layer onto the same player position. Sessions begin and end
 *   without moving the visitor: position, yaw, interior, floor, and
 *   flight all carry across the boundary because none of them live
 *   in the session.
 * - Locomotion: the left thumbstick feeds the same movement
 *   integrator as every other input, at the same speeds, resolved by
 *   the same bounds and interiorHeightAt floor logic (the spiral
 *   climb works in VR exactly as on foot), with one difference of
 *   frame, not of model: movement is head-directed, resolved against
 *   the headset's world yaw. The right thumbstick snap-turns the
 *   player yaw in 45 degree steps (chosen over smooth turning: yaw
 *   acceleration the visitor did not make with their own head is the
 *   classic comfort failure, and the plan asks for comfort options).
 *   A thumbstick click is the fast modifier, Shift's analogue.
 * - Picking: controller rays (a line per controller, updated by the
 *   manager from the target-ray pose) with the trigger as select.
 *   The priority is the tap priority: a building under the ray opens
 *   its record; otherwise an armed door (door zone outdoors, EXIT
 *   indoors) activates. Records open on an in-world card, because
 *   the DOM card is invisible inside a headset. A grip squeeze
 *   recalls the help, or closes the record when one is open.
 * - Devices without controllers present a gaze ray from the head
 *   with a centre reticle: resting the gaze on a building, or
 *   resting it anywhere while a door prompt is armed, for a 1.2 s
 *   dwell activates it, with a cooldown so one dwell fires once.
 *   (Such devices also fire select events of their own where they
 *   have any button at all; both paths land in the same activation.)
 * - Prompts and help speak controller / gaze language only while
 *   presenting (inputMode() puts 'xr' first), and the help lifecycle
 *   is mirrored on an in-world panel on the same schedule.
 * - Comfort and performance: fixed foveation 0.6 (set at boot; the
 *   manager's own default is 1.0, maximum). No per-frame allocation
 *   in this layer: poses, rays, and dwell state live in module-scope
 *   temporaries, and panel canvases redraw only when their content
 *   changes. The merged/instanced draw strategy is untouched. */

/* in-world panels: children of the camera, drawn above the world
 * (depth test off), visible only while presenting */
function makeXRPlane(w, h, cw, chh, x, y, z, renderOrder) {
  const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = chh;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false }));
  mesh.position.set(x, y, z);
  mesh.renderOrder = renderOrder;
  mesh.visible = false;
  mesh.frustumCulled = false;
  camera.add(mesh);
  return { mesh, canvas, tex, lastText: null };
}
function drawXRPanel(p, title, lines) {
  const x = p.canvas.getContext('2d');
  const cw = p.canvas.width, chh = p.canvas.height;
  x.clearRect(0, 0, cw, chh);
  x.fillStyle = 'rgba(13, 17, 25, 0.93)'; x.fillRect(0, 0, cw, chh);
  x.strokeStyle = '#8c6a2f'; x.lineWidth = 3; x.strokeRect(1.5, 1.5, cw - 3, chh - 3);
  x.fillStyle = '#ffb36b'; x.fillRect(0, 0, cw, 64);
  x.fillStyle = '#0d1017'; x.font = '700 30px sans-serif'; x.textAlign = 'left'; x.textBaseline = 'middle';
  x.fillText(title, 26, 34);
  x.font = '27px sans-serif'; x.fillStyle = '#dbe4f0';
  lines.forEach((ln, i) => x.fillText(ln, 26, 108 + i * 38));
  p.tex.needsUpdate = true;
}
const xrHelpPlane = makeXRPlane(1.5, 0.70, 1024, 480, 0, 0.22, -2.0, 998);
const xrSettingsPlane = makeXRPlane(1.5, 0.70, 1024, 480, 0, 0.22, -2.0, 998);
const xrCardPlane = makeXRPlane(1.15, 0.76, 1024, 680, 0, -0.30, -1.8, 999);
const xrPromptPlane = makeXRPlane(1.05, 0.145, 1024, 140, 0, -0.68, -1.7, 1000);
function drawXRHelpPanel() {
  drawXRPanel(xrHelpPlane, 'DEADRAMP BASE — HELP', XR_HELP_LINES[helpSpace]);
}
/* The Settings panel in-world: same plane, same place as help (it
 * substitutes for it), carrying the framing text under its heading.
 * Reached by squeezing past the help; see onXRSqueeze. */
function drawXRSettingsPanel() {
  drawXRPanel(xrSettingsPlane, 'SETTINGS', ['ABOUT THIS MODEL', '', ...wrapText(FRAMING, 58)]);
}
function drawXRCard(v) {
  if (v && v.feature) { drawXRFeatureCard(v); return; }
  const d = state.districts.find((x) => x.id === v.district);
  const lines = [
    `${d ? d.functionName + ' · ' + d.tier : ''} district · ${v.offeringCount} offering${v.offeringCount > 1 ? 's' : ''}`,
    STATUS_TEXT[v.statusClass],
  ];
  for (const o of v.offerings.slice(0, 6)) lines.push('· ' + o.product);
  if (v.offerings.length > 6) lines.push(`… (+${v.offerings.length - 6} more on the full record)`);
  if (v.kind === 'building') lines.push('', 'Stand at its door and pull the trigger to enter.');
  else lines.push('', ...wrapText('Surveyed empty lot. This offering is one of the two the DeadRamp build holds as honestly unclassified, so the Base shows the lot, not a building.', 58));
  drawXRPanel(xrCardPlane, v.name.toUpperCase().slice(0, 40), lines);
}
/* Phase 4 records on the in-world card: the same facts as the flat
 * card, in the headset's own surface. */
function drawXRFeatureCard(rec) {
  if (rec.feature === 'bridge') {
    const e = rec.edge;
    const lines = [
      `${districtLabel(e.parentDistrict)}  →  ${districtLabel(e.childDistrict)}`,
      MERGE_KIND_TEXT[e.kind] || 'a union merge',
      `${e.child} (${e.childForks} forks) builds on`,
      `${e.parent} (${e.parentForks} forks)`,
      '',
      ...wrapText('The union is of the reference builds\u2019 control baselines under the Merge Rule: union, never intersection; the highest tier inherited in full. No vendor merged with another vendor.', 58),
    ];
    drawXRPanel(xrCardPlane, 'SKYBRIDGE — UNION MERGE', lines);
  } else {
    const pl = state.catalog.platformLayer;
    const lines = [`${pl.rescoped.length} entries · ${pl.decisions.length} standing decisions`, ''];
    for (const d of pl.decisions) lines.push('· ' + d.title);
    drawXRPanel(xrCardPlane, 'THE PLATFORM LAYER', lines);
  }
}
function drawXRPrompt(text) {
  const x = xrPromptPlane.canvas.getContext('2d');
  const cw = xrPromptPlane.canvas.width, chh = xrPromptPlane.canvas.height;
  x.clearRect(0, 0, cw, chh);
  x.fillStyle = 'rgba(13, 17, 25, 0.92)'; x.fillRect(0, 0, cw, chh);
  x.strokeStyle = '#4a6f9f'; x.lineWidth = 3; x.strokeRect(1.5, 1.5, cw - 3, chh - 3);
  x.fillStyle = '#eaf2ff'; x.font = '700 46px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text.length > 46 ? text.slice(0, 45) + '…' : text, cw / 2, chh / 2 + 2);
  xrPromptPlane.tex.needsUpdate = true;
}
/* gaze reticle: shown only in gaze mode, bronze while searching,
 * bright while a dwell is accumulating */
const gazeReticle = new THREE.Mesh(
  new THREE.RingGeometry(0.011, 0.017, 32),
  new THREE.MeshBasicMaterial({ color: 0x8c6a2f, side: THREE.DoubleSide, transparent: true, depthTest: false }));
gazeReticle.position.set(0, 0, -1.5);
gazeReticle.renderOrder = 1001;
gazeReticle.visible = false;
gazeReticle.frustumCulled = false;
camera.add(gazeReticle);

/* activation shared by the controller trigger and the gaze dwell:
 * the tap priority, in controller language */
const _xrOrigin = new THREE.Vector3();
const _xrDir = new THREE.Vector3();
const _xrQuat = new THREE.Quaternion();
function activateFromRay(origin, dir) {
  raycaster.set(origin, dir);
  const v = raycastBuildings();
  if (v) { showCard(v); return true; }
  const f = raycastFeatures();
  if (f) { showFeatureCard(f); return true; }
  if (state.interior) {
    if (state.interior.atExit) { exitBuilding(); return true; }
    return false;
  }
  if (state.doorVendor) {
    const dv = state.doorVendor;
    card.style.display = 'none';
    enterBuilding(dv);
    return true;
  }
  return false;
}
function onXRSelect(ev) {
  if (!renderer.xr.isPresenting) return;
  const c = ev.target;
  c.updateWorldMatrix(true, false);
  _xrOrigin.setFromMatrixPosition(c.matrixWorld);
  c.getWorldQuaternion(_xrQuat);
  _xrDir.set(0, 0, -1).applyQuaternion(_xrQuat);
  activateFromRay(_xrOrigin, _xrDir);
}
function onXRSqueeze() {
  if (!renderer.xr.isPresenting) return;
  /* the squeeze cycle: Settings closes first; with the help up, a
   * squeeze moves on to Settings (the disclaimer's one home, in the
   * headset as on the flat screen); then the record card; then the
   * help recall, as before */
  if (settingsOpen) { hideSettings(); return; }
  if (!hintEl.classList.contains('faded')) { showSettings(); return; }
  if (state.selected) {
    state.selected = null;
    card.style.display = 'none';
    xrCardPlane.mesh.visible = false;
    return;
  }
  showHelp(state.interior ? 'in' : 'out');
}
const xrControllers = [];
for (let i = 0; i < 2; i++) {
  const c = renderer.xr.getController(i);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -30)]),
    new THREE.LineBasicMaterial({ color: 0xffb36b, transparent: true, opacity: 0.55 }));
  line.visible = false;
  c.add(line);
  c.userData.connected = false;
  c.addEventListener('connected', (ev) => {
    c.userData.connected = true; c.userData.inputSource = ev.data; line.visible = true;
  });
  c.addEventListener('disconnected', () => {
    c.userData.connected = false; c.userData.inputSource = null; line.visible = false;
  });
  c.addEventListener('select', onXRSelect);
  c.addEventListener('squeeze', onXRSqueeze);
  rig.add(c);
  xrControllers.push(c);
}

/* the session itself: the button exists only when feature detection
 * proves immersive-vr is really there (never a dead button), and the
 * request negotiates the reference space down a ladder: local-floor
 * first, then local, then viewer, each failure ending the half-made
 * session cleanly before the next attempt */
const vrBtn = document.getElementById('vrBtn');
const XR_REF_LADDER = [
  { ref: 'local-floor', opts: { requiredFeatures: ['local-floor'] } },
  { ref: 'local', opts: { optionalFeatures: ['local-floor', 'bounded-floor'] } },
  { ref: 'viewer', opts: {} },
];
async function detectXR() {
  if (!('xr' in navigator) || !navigator.xr || typeof navigator.xr.isSessionSupported !== 'function') return;
  try {
    if (await navigator.xr.isSessionSupported('immersive-vr')) {
      state.xr.supported = true;
      vrBtn.style.display = 'block';
    }
  } catch (e) { /* no immersive XR here: the button simply never appears */ }
}
async function enterVR() {
  if (state.xr.requesting) return;
  if (renderer.xr.isPresenting) {
    const s = renderer.xr.getSession();
    if (s) { try { await s.end(); } catch (e) { /* already ending */ } }
    return;
  }
  if (!state.xr.supported) return;
  state.xr.requesting = true;
  state.xr.attempts = [];
  vrBtn.disabled = true;
  let lastErr = null;
  for (const step of XR_REF_LADDER) {
    state.xr.attempts.push(step.ref);
    let session = null;
    try {
      session = await navigator.xr.requestSession('immersive-vr', step.opts);
      renderer.xr.setReferenceSpaceType(step.ref);
      renderer.xr.setFoveation(XR_FOVEATION);
      await renderer.xr.setSession(session);
      state.xr.refSpace = step.ref;
      state.xr.lastError = null;
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (session) { try { await session.end(); } catch (e2) { /* best-effort cleanup */ } }
    }
  }
  state.xr.requesting = false;
  vrBtn.disabled = false;
  if (lastErr) state.xr.lastError = String((lastErr && lastErr.message) || lastErr);
}
vrBtn.addEventListener('click', enterVR);
detectXR();
renderer.xr.addEventListener('sessionstart', () => {
  vrBtn.textContent = 'Exit VR';
  if (state.selected) drawXRCard(state.selected);
  showHelp(state.interior ? 'in' : 'out');
  if (settingsOpen) showSettings(); // Settings substitutes for the help panel
});
renderer.xr.addEventListener('sessionend', () => {
  vrBtn.textContent = 'Enter VR';
  state.xr.refSpace = null;
  state.xr.gazeMode = false;
  state.xr.headYaw = null;
  xrMove.f = 0; xrMove.r = 0; xrMove.fast = false;
  xrCardPlane.mesh.visible = false;
  xrPromptPlane.mesh.visible = false;
  xrHelpPlane.mesh.visible = false;
  xrSettingsPlane.mesh.visible = false;
  gazeReticle.visible = false;
  /* The manager overwrote the camera's projection with the headset's
   * union frustum while presenting; hand the flat view its own back
   * so leaving VR restores the exact view the visitor left. */
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.fov = FLAT_FOV;
  camera.updateProjectionMatrix();
  showHelp(state.interior ? 'in' : 'out');
});

/* locomotion sampling: fills xrMove for stepMovement, snap-turns the
 * player yaw, and records the headset's world yaw as the movement
 * frame. Runs every frame; costs nothing when not presenting. */
const xrMove = { f: 0, r: 0, fast: false };
const SNAP_TURN = Math.PI / 4;
const XR_STICK_DEADZONE = 0.12;
let xrTurnArmed = true;
function sampleXRInput() {
  xrMove.f = 0; xrMove.r = 0; xrMove.fast = false;
  if (!renderer.xr.isPresenting) { state.xr.headYaw = null; return; }
  camera.getWorldDirection(_xrDir);
  state.xr.headYaw = Math.atan2(-_xrDir.x, -_xrDir.z);
  const session = renderer.xr.getSession();
  if (!session) { state.xr.gazeMode = true; return; }
  let trackedPointer = false;
  for (const src of session.inputSources) {
    if (src.targetRayMode === 'tracked-pointer') trackedPointer = true;
    const gp = src.gamepad;
    if (!gp || !gp.axes) continue;
    const ax = gp.axes;
    const sx = ax.length >= 4 ? ax[2] : (ax[0] || 0);
    const sy = ax.length >= 4 ? ax[3] : (ax[1] || 0);
    const stickPressed = !!(gp.buttons && gp.buttons[3] && gp.buttons[3].pressed);
    if (src.handedness === 'right') {
      if (xrTurnArmed && sx > 0.65) { player.yaw -= SNAP_TURN; xrTurnArmed = false; }
      else if (xrTurnArmed && sx < -0.65) { player.yaw += SNAP_TURN; xrTurnArmed = false; }
      else if (Math.abs(sx) < 0.3) xrTurnArmed = true;
      if (stickPressed) xrMove.fast = true;
    } else {
      if (Math.abs(sx) > XR_STICK_DEADZONE) xrMove.r += sx;
      if (Math.abs(sy) > XR_STICK_DEADZONE) xrMove.f += -sy;
      if (stickPressed) xrMove.fast = true;
    }
  }
  state.xr.gazeMode = !trackedPointer;
}

/* gaze dwell: the fallback for devices with no tracked pointer */
const XR_GAZE_DWELL_S = 1.2;
let gazeTargetKey = null, gazeDwellS = 0, gazeCooldownUntil = 0;
const _gazeOrigin = new THREE.Vector3();
function updateXRGaze(dt) {
  if (!renderer.xr.isPresenting || !state.xr.gazeMode) {
    gazeReticle.visible = false;
    gazeTargetKey = null; gazeDwellS = 0;
    return;
  }
  gazeReticle.visible = true;
  camera.getWorldPosition(_gazeOrigin);
  camera.getWorldDirection(_xrDir);
  raycaster.set(_gazeOrigin, _xrDir);
  const v = raycastBuildings();
  let key = null;
  if (v) key = 'pick:' + v.id;
  else if (state.interior && state.interior.atExit) key = 'exit';
  else if (!state.interior && state.doorVendor) key = 'enter:' + state.doorVendor.id;
  const now = performance.now();
  if (!key || key !== gazeTargetKey || now < gazeCooldownUntil) {
    gazeTargetKey = key;
    gazeDwellS = 0;
    gazeReticle.material.color.setHex(0x8c6a2f);
    return;
  }
  gazeDwellS += dt;
  gazeReticle.material.color.setHex(0xffd9a0);
  if (gazeDwellS >= XR_GAZE_DWELL_S) {
    gazeDwellS = 0;
    gazeCooldownUntil = now + 1500;
    activateFromRay(_gazeOrigin, _xrDir);
  }
}

/* per-frame rig + panel sync. The rig is the whole story of how the
 * visitor's body enters the world: position and yaw from the player
 * record (player.y is eye height, maintained by the same enter/exit
 * and floor logic in every mode), the eye set from player pitch on
 * flat screens, and left to the manager's headset pose in XR. */
function updateRig() {
  rig.position.set(player.x, player.y - EYE, player.z);
  rig.rotation.set(0, player.yaw, 0);
  if (!renderer.xr.isPresenting) {
    camera.position.set(0, EYE, 0);
    camera.rotation.set(player.pitch, 0, 0);
  }
}
function updateXRPeripherals(dt) {
  if (!renderer.xr.isPresenting) return; // sessionend hid every panel
  xrHelpPlane.mesh.visible = !hintEl.classList.contains('faded');
  xrSettingsPlane.mesh.visible = settingsOpen;
  xrCardPlane.mesh.visible = !!state.selected && card.style.display === 'block';
  const ptxt = promptEl.style.display === 'block' ? promptEl.textContent : '';
  xrPromptPlane.mesh.visible = ptxt.length > 0;
  if (xrPromptPlane.mesh.visible && xrPromptPlane.lastText !== ptxt) {
    xrPromptPlane.lastText = ptxt;
    drawXRPrompt(ptxt);
  }
  updateXRGaze(dt);
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
  if (xrMove.f || xrMove.r) { f += xrMove.f; r += xrMove.r; }
  const m = Math.hypot(f, r);
  if (m < 0.001) return;
  const s = Math.min(1, 1 / m);
  f *= s; r *= s;
  const speed = WALK_SPEED * (((keys.ShiftLeft || keys.ShiftRight) || xrMove.fast) ? FAST_MULT : 1);
  /* The movement frame: on flat screens, the player's own yaw. In
   * VR, the direction the visitor is actually facing (the headset's
   * world yaw, sampled each frame), so forward walks where they
   * look; speeds, bounds, and floor logic are unchanged. */
  const frameYaw = (renderer.xr.isPresenting && state.xr.headYaw !== null) ? state.xr.headYaw : player.yaw;
  const sin = Math.sin(frameYaw), cos = Math.cos(frameYaw);
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
    phase4: { ...state.phase4 },
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
  /* Phase 4: viewpoints of the three features + the feature records */
  phase4Points: () => state.phase4Points,
  phase4Pick: () => {
    const s = state.selected;
    if (!s || !s.feature) return null;
    return s.feature === 'bridge'
      ? { feature: 'bridge', child: s.edge.child, parent: s.edge.parent, kind: s.edge.kind }
      : { feature: 'deck' };
  },
  /* Phase 3: WebXR session state, for verification and debugging */
  xr: () => ({
    xrEnabled: renderer.xr.enabled,
    supported: state.xr.supported,
    presenting: renderer.xr.isPresenting,
    requesting: state.xr.requesting,
    refSpace: state.xr.refSpace,
    attempts: state.xr.attempts.slice(),
    lastError: state.xr.lastError,
    gazeMode: state.xr.gazeMode,
    headYaw: state.xr.headYaw,
    buttonVisible: vrBtn.style.display === 'block',
    buttonText: vrBtn.textContent,
    rig: { x: rig.position.x, y: rig.position.y, z: rig.position.z, yawDeg: Math.round(player.yaw * 180 / Math.PI) },
    panels: {
      help: xrHelpPlane.mesh.visible,
      settings: xrSettingsPlane.mesh.visible,
      card: xrCardPlane.mesh.visible,
      prompt: xrPromptPlane.mesh.visible,
      reticle: gazeReticle.visible,
    },
  }),
  /* platform-prompt + help-lifecycle hooks */
  help: () => ({
    isTouch: IS_TOUCH,
    mode: inputMode(),
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
  /* disclaimer consolidation hooks (Nov 15, 2026) */
  settings: () => ({
    open: settingsOpen,
    buttonExists: !!document.getElementById('settingsBtn'),
    panelVisible: settingsPanel.style.display === 'block',
    aboutText: document.getElementById('settingsAbout').textContent,
    hudFramingNote: !!document.getElementById('framingNote'),
  }),
  interiorPanels: () => state.interior ? {
    titles: state.interior.panelTitles.slice(),
    lobbyLines: state.interior.lobbyLines.slice(),
  } : null,
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
  const dt = Math.min(clock.getDelta(), 0.1);
  sampleXRInput();
  const prevX = player.x, prevZ = player.z;
  stepMovement(dt);
  if (state.interior) {
    resolveInteriorMove(prevX, prevZ);
    animateInterior(dt);
  }
  updateRig();
  updateXRPeripherals(dt);
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
/* setAnimationLoop, not requestAnimationFrame: it is the one loop
 * API that follows the visitor into an XR session (the manager
 * drives it from the session's own frame clock while presenting and
 * hands it back on session end), and it behaves identically to the
 * old RAF loop on flat screens. */
renderer.setAnimationLoop(loop);
