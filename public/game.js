/* =====================================================================
   Traffic Duel — client
   ---------------------------------------------------------------------
   World convention:
     +Z = direction of travel (a car's "distance" is literally its z)
     +X = right, +Y = up, ground plane at y = 0, units are metres.

   Determinism: the server owns the traffic. Every car's position is a pure
   function of the spawn event it broadcast and the shared race clock:
       z(t) = spawn.z + spawn.speed * (t - spawn.raceTime)
   so both clients render an identical road without ever syncing traffic.
   ===================================================================== */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ============================== constants ============================== */

const DEBUG = new URLSearchParams(location.search).has('debug');

/* Measured from the shipped .glb files (bounding boxes are in real metres,
   Y-up). `faceYaw` rotates each model so its nose points down +Z:
     BMW  — headlights sit at z = -1.65, taillights at z = +1.94  -> flip 180°
     R35  — headlights sit at z = +1.89, taillights at z = -2.14  -> already OK
   `paint` is the body material (both are untextured baseColorFactor
   materials, so a straight colour swap gives us clean team liveries). */
const MODELS = {
  player: {
    url: '/models/bmw_m3_competition.glb',
    faceYaw: Math.PI,
    paint: /^Material\.032$/,
    length: 4.55,
    weight: 0.62,           // share of the loading bar
    interiorSkin: 0.15,     // keep the full body shell: this car fills the screen
  },
  traffic: {
    url: '/models/nissan_skyline_gtr_r35.glb',
    faceYaw: 0,
    paint: /^r35_paint$/,
    length: 4.75,
    weight: 0.38,
    interiorSkin: 0.10,
    // Engine bay, brake calipers and cabin trim — invisible on a car you pass
    // at 250 km/h, and worth ~110k triangles per instance.
    dropMaterials: /^(Meo_turbo|amdb11_|r35_leather|r35_leather_perf|r35_leather_stitching|r35_interior|r35_carpet|r35_cloth|r35_engines?|r35_steeringwheel|r35_gauges|r35_display|r35_screen|gtr_interior)/i,
  },
};

/** Distance (m) at which a car swaps to its low-poly proxy. */
const LOD_SWAP = 70;
const LOD_CULL = 420;

const CAR = {
  halfWidth: 0.92,
  halfLength: 2.24,
  hitScaleX: 0.86,          // forgiving arcade hitbox
  hitScaleZ: 0.92,
};

const DRIVE = {
  startSpeed: 42,           // m/s at green light
  maxSpeed: 82,
  minSpeed: 8,
  accel: 15,
  brake: 34,
  coast: 5.5,
  laneChangeSpeed: 9.5,     // m/s lateral
  laneSnap: 7.0,            // spring toward the lane centre
};

const NET = {
  syncIntervalMs: 2000,
  stateHz: 30,
  interpDelayMs: 120,       // render the ghost this far in the past
  bufferMs: 1500,
};

const VIEW = {
  camBack: 8.6,
  camHeight: 3.35,
  camLookAhead: 16,
  fovBase: 62,
  fovMax: 84,
  drawAhead: 340,           // metres of traffic we bother instantiating
  drawBehind: 90,
};

/* Fallbacks — overwritten by the server's `config` payload. */
let CONFIG = {
  laneCount: 4,
  laneWidth: 3.5,
  spawnAhead: 260,
  despawnBehind: 80,
  finishDistance: 6000,
};

const COLORS = {
  you: 0x22e0ff,
  rival: 0xff3d81,
  traffic: [0xb8bec9, 0x2b3550, 0x8c1f2c, 0xdad3c2],
};

/* ================================= DOM ================================= */

const $ = (id) => document.getElementById(id);
const el = {
  loading: $('loading'), loadBar: $('load-bar'), loadLabel: $('load-label'),
  lobby: $('lobby'), lobbyEntry: $('lobby-entry'), lobbyRoom: $('lobby-room'),
  btnCreate: $('btn-create'), joinForm: $('join-form'), joinCode: $('join-code'),
  roomCode: $('room-code'), inviteLink: $('invite-link'), btnCopy: $('btn-copy'),
  copyText: $('copy-text'), playerList: $('player-list'), btnReady: $('btn-ready'),
  btnLeave: $('btn-leave'), lobbyStatus: $('lobby-status'),
  countdown: $('countdown'), countNumber: $('count-number'), lights: document.querySelectorAll('.light'),
  hud: $('hud'), speed: $('speed'), arcFill: $('arc-fill'), progDistance: $('prog-distance'),
  progTotal: $('prog-total'), trackYou: $('track-you'), trackRival: $('track-rival'),
  gap: $('gap'), ping: $('ping'), fps: $('fps'), trafficCount: $('traffic-count'),
  lanePips: document.querySelectorAll('#lane-pips i'), flash: $('flash'), feed: $('event-feed'),
  gameover: $('gameover'), resultTitle: $('result-title'), resultSub: $('result-sub'),
  resultList: $('result-list'), btnRematch: $('btn-rematch'), btnQuit: $('btn-quit'),
  rematchStatus: $('rematch-status'), toasts: $('toasts'), speedlines: $('speedlines'),
};

const show = (node, on) => node.classList.toggle('hidden', !on);

function toast(msg, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = msg;
  el.toasts.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 260);
  }, 3200);
}

function feed(msg, kind = '') {
  const node = document.createElement('div');
  node.className = `evt ${kind}`;
  node.textContent = msg;
  el.feed.appendChild(node);
  setTimeout(() => node.remove(), 2600);
}

/* ============================ network layer ============================ */

const socket = io({ transports: ['websocket', 'polling'] });

const net = {
  offset: 0,          // serverNow ≈ Date.now() + offset
  bestRtt: Infinity,
  ping: 0,
  now: () => Date.now() + net.offset,
};

function syncClock() {
  const sent = Date.now();
  socket.emit('time:sync', sent, (res) => {
    if (!res) return;
    const rtt = Date.now() - sent;
    net.ping = rtt;
    // Keep the offset from the least-delayed sample we have seen.
    if (rtt <= net.bestRtt) {
      net.bestRtt = rtt;
      net.offset = res.serverTime + rtt / 2 - Date.now();
    }
    // Slowly forget the best sample so the clock can re-lock if the route changes.
    net.bestRtt = net.bestRtt * 1.05 + 1;
  });
}
setInterval(syncClock, NET.syncIntervalMs);

/* ============================== game state ============================= */

const G = {
  phase: 'boot',            // boot | lobby | room | countdown | racing | over
  ready: false,
  youId: null,
  roomCode: null,
  players: [],
  seed: 0,
  startAt: 0,               // server epoch ms of race time 0
  raceTime: 0,

  me: {
    distance: 0, speed: 0, x: 0, lane: 1, targetLane: 1,
    lateral: 0, crashed: false, finished: false, spin: 0,
  },
  rival: {
    id: null, buffer: [], distance: 0, x: 0, speed: 0,
    crashed: false, visible: false,
  },

  traffic: new Map(),       // id -> { id, lane, laneX, z, speed, variant, raceTime, obj }
  lastStateSent: 0,
};

const input = { throttle: false, brakeKey: false, left: false, right: false };

/* ============================== renderer =============================== */

const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, powerPreference: 'high-performance', stencil: false,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070b14);
scene.fog = new THREE.Fog(0x070b14, 120, 460);

const camera = new THREE.PerspectiveCamera(VIEW.fovBase, innerWidth / innerHeight, 0.4, 1400);
camera.position.set(0, VIEW.camHeight, -VIEW.camBack);

/* Studio-ish IBL so the car paint and chrome actually read as metal. */
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.06).texture;
  pmrem.dispose();
}

const hemi = new THREE.HemisphereLight(0x8fc6ff, 0x0a0e18, 1.15);
scene.add(hemi);

const key = new THREE.DirectionalLight(0xdbe9ff, 1.5);
key.position.set(-40, 70, 40);
scene.add(key);

const rim = new THREE.DirectionalLight(0xff5fa2, 0.55);
rim.position.set(30, 18, -50);
scene.add(rim);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* =============================== the road ============================== */

const world = new THREE.Group();
scene.add(world);

const road = {
  group: new THREE.Group(),
  surface: null,
  markings: null,
  barriers: [],
  poles: [],
  blocks: [],
  segmentLength: 400,
};
world.add(road.group);

function roadWidth() { return CONFIG.laneCount * CONFIG.laneWidth; }
function laneX(lane) { return (lane - (CONFIG.laneCount - 1) / 2) * CONFIG.laneWidth; }

/** Dashed lane markings drawn once into a canvas and scrolled by UV offset. */
function makeMarkingTexture() {
  const lanes = CONFIG.laneCount;
  const px = 256;                       // texture is one 20 m tile
  const c = document.createElement('canvas');
  c.width = px; c.height = px;
  const g = c.getContext('2d');
  g.fillStyle = '#0d1119'; g.fillRect(0, 0, px, px);

  // subtle asphalt speckle
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.035})`;
    g.fillRect(Math.random() * px, Math.random() * px, 1.5, 1.5);
  }

  const laneW = px / lanes;
  // interior dashes
  g.fillStyle = '#e9f3ff';
  for (let i = 1; i < lanes; i++) {
    const x = i * laneW - 1.5;
    g.fillRect(x, 8, 3, px * 0.42);
  }
  // solid edges
  g.fillRect(2, 0, 4, px);
  g.fillRect(px - 6, 0, 4, px);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildRoad() {
  road.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  road.group.clear();
  if (road.markings) road.markings.dispose();
  road.barriers.length = 0; road.poles.length = 0; road.blocks.length = 0;

  const w = roadWidth();
  const len = road.segmentLength * 2;

  road.markings = makeMarkingTexture();
  road.markings.repeat.set(1, len / 20);

  road.surface = new THREE.Mesh(
    new THREE.PlaneGeometry(w, len, 1, 1),
    new THREE.MeshStandardMaterial({ map: road.markings, roughness: 0.92, metalness: 0.0 })
  );
  road.surface.rotation.x = -Math.PI / 2;
  road.group.add(road.surface);

  // shoulders
  const shoulder = new THREE.Mesh(
    new THREE.PlaneGeometry(w + 26, len),
    new THREE.MeshStandardMaterial({ color: 0x090c14, roughness: 1 })
  );
  shoulder.rotation.x = -Math.PI / 2;
  shoulder.position.y = -0.04;
  road.group.add(shoulder);

  // guard rails, glowing edge strips
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(0.35, 0.85, len),
      new THREE.MeshStandardMaterial({ color: 0x1b2436, roughness: 0.6, metalness: 0.35 })
    );
    rail.position.set(side * (w / 2 + 1.4), 0.42, 0);
    road.group.add(rail);

    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.1, len),
      new THREE.MeshBasicMaterial({ color: side < 0 ? COLORS.you : COLORS.rival })
    );
    strip.position.set(side * (w / 2 + 1.22), 0.86, 0);
    road.group.add(strip);
    road.barriers.push(rail, strip);
  }

  // recycled light poles
  const poleGeo = new THREE.BoxGeometry(0.22, 8, 0.22);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x161d2b, roughness: 0.8 });
  const lampGeo = new THREE.BoxGeometry(1.6, 0.18, 0.5);
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
  for (let i = 0; i < 24; i++) {
    const g = new THREE.Group();
    const p = new THREE.Mesh(poleGeo, poleMat); p.position.y = 4;
    const l = new THREE.Mesh(lampGeo, lampMat); l.position.set(0, 7.9, 0);
    g.add(p, l);
    g.userData.side = i % 2 ? 1 : -1;
    g.position.x = g.userData.side * (w / 2 + 3.2);
    road.group.add(g);
    road.poles.push(g);
  }

  // parallax skyline blocks
  const blockMat = new THREE.MeshStandardMaterial({ color: 0x0c1220, roughness: 1 });
  for (let i = 0; i < 40; i++) {
    const h = 12 + Math.random() * 70;
    const b = new THREE.Mesh(new THREE.BoxGeometry(8 + Math.random() * 16, h, 8 + Math.random() * 16), blockMat);
    b.userData.side = i % 2 ? 1 : -1;
    b.userData.offset = 40 + Math.random() * 120;
    b.position.set(b.userData.side * b.userData.offset, h / 2, 0);
    road.group.add(b);
    road.blocks.push(b);
  }

  // finish gantry
  const gantry = new THREE.Group();
  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(w + 6, 0.9, 0.7),
    new THREE.MeshStandardMaterial({ color: 0x0f1626, emissive: 0x1b3a55, emissiveIntensity: 0.7 })
  );
  beam.position.y = 7.2;
  gantry.add(beam);
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.6, 7.2, 0.6),
      new THREE.MeshStandardMaterial({ color: 0x131b2b }));
    leg.position.set(side * (w / 2 + 2.6), 3.6, 0);
    gantry.add(leg);
  }
  const banner = new THREE.Mesh(
    new THREE.PlaneGeometry(w + 6, 1.6),
    new THREE.MeshBasicMaterial({ color: 0x35f2a0, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
  );
  banner.position.y = 5.9;
  gantry.add(banner);
  gantry.visible = false;
  road.gantry = gantry;
  road.group.add(gantry);
}

function updateRoad(distance) {
  road.group.position.z = distance;
  road.markings.offset.y = -distance / 20;

  const spacing = 34;
  road.poles.forEach((g, i) => {
    const base = Math.floor((distance - 60) / spacing) * spacing;
    g.position.z = base + i * spacing / 2 - distance;
  });

  const bSpacing = 90;
  road.blocks.forEach((b, i) => {
    const base = Math.floor((distance - 200) / bSpacing) * bSpacing;
    b.position.z = base + i * bSpacing / 2 - distance;
  });

  const toFinish = CONFIG.finishDistance - distance;
  road.gantry.visible = toFinish < 420 && toFinish > -30;
  if (road.gantry.visible) road.gantry.position.z = toFinish;
}

/* ============================ model pipeline =========================== */

const loader = new GLTFLoader();
const progress = { player: 0, traffic: 0 };
const prefabs = {};

function setLoadProgress() {
  const pct = Math.round(
    (progress.player * MODELS.player.weight + progress.traffic * MODELS.traffic.weight) * 100
  );
  el.loadBar.style.width = `${pct}%`;
  el.loadLabel.textContent = pct < 100 ? `Loading cars… ${pct}%` : 'Building the highway…';
}

function loadGLTF(cfg, kind) {
  return new Promise((resolve, reject) => {
    loader.load(
      cfg.url,
      (gltf) => resolve(gltf),
      (evt) => {
        // total is 0 when the server does not send Content-Length
        progress[kind] = evt.total ? Math.min(1, evt.loaded / evt.total) : Math.min(0.95, progress[kind] + 0.02);
        setLoadProgress();
      },
      reject
    );
  });
}

/**
 * Flattens a Sketchfab-style GLTF (hundreds of tiny meshes) into a handful of
 * merged meshes — one per material. Cuts draw calls from ~250 to ~40 and lets
 * every traffic instance share geometry.
 *
 * `dropInterior` removes any mesh whose bounding box sits entirely inside the
 * car's shell (seats, dashboard, engine, turbo plumbing). Purely geometric, so
 * it does not depend on how the artist named things.
 */
function buildPrefab(gltf, cfg, { dropInterior = true } = {}) {
  const src = gltf.scene;
  src.updateWorldMatrix(true, true);

  const parts = [];
  src.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    parts.push({ mesh: o, matrix: o.matrixWorld.clone() });
  });

  // Overall shell in model space. Anything whose bounding box fits entirely
  // inside `inner` cannot be seen from outside the car.
  const skin = cfg.interiorSkin ?? 0.15;
  const shell = new THREE.Box3().setFromObject(src);
  const size = shell.getSize(new THREE.Vector3());
  const inner = shell.clone();
  inner.min.x += size.x * skin; inner.max.x -= size.x * skin;
  inner.min.z += size.z * skin; inner.max.z -= size.z * skin;
  inner.min.y += size.y * skin * 0.7; inner.max.y = shell.min.y + size.y * 0.74;

  /** @type {Map<THREE.Material, THREE.BufferGeometry[]>} */
  const groups = new Map();
  const box = new THREE.Box3();
  let dropped = 0;

  for (const { mesh, matrix } of parts) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

    if (cfg.dropMaterials && mats.every((m) => m && cfg.dropMaterials.test(m.name || ''))) {
      dropped++; continue;
    }
    if (dropInterior && mats.length === 1) {
      box.setFromObject(mesh);
      if (inner.containsBox(box)) { dropped++; continue; }
    }

    // Bake world transform, keep only the attributes we can merge on.
    const baked = new THREE.BufferGeometry();
    const g = mesh.geometry;
    const pos = g.getAttribute('position');
    if (!pos) continue;

    baked.setAttribute('position', pos.clone());
    baked.setAttribute('normal', g.getAttribute('normal')
      ? g.getAttribute('normal').clone()
      : new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));
    baked.setAttribute('uv', g.getAttribute('uv')
      ? g.getAttribute('uv').clone()
      : new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
    if (g.index) baked.setIndex(g.index.clone());
    baked.applyMatrix4(matrix);
    if (!g.getAttribute('normal')) baked.computeVertexNormals();

    if (mats.length > 1 && g.groups.length) {
      // Split multi-material geometry so each slice joins the right bucket.
      for (const grp of g.groups) {
        push(mats[grp.materialIndex] || mats[0], sliceGeometry(baked, grp.start, grp.count));
      }
      baked.dispose();
    } else {
      push(mats[0], baked);
    }
  }

  function sliceGeometry(geo, start, count) {
    if (geo.index) {
      const cut = geo.clone();
      cut.clearGroups();
      cut.setIndex(new THREE.BufferAttribute(geo.index.array.slice(start, start + count), 1));
      const flat = cut.toNonIndexed();
      cut.dispose();
      return flat;
    }
    const out = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) {
      const a = geo.getAttribute(name);
      const n = a.itemSize;
      out.setAttribute(name, new THREE.BufferAttribute(a.array.slice(start * n, (start + count) * n), n));
    }
    return out;
  }

  function push(mat, geo) {
    if (!mat) return;
    if (!groups.has(mat)) groups.set(mat, []);
    groups.get(mat).push(geo);
  }

  const prefab = new THREE.Group();
  let tris = 0;
  for (const [mat, geos] of groups) {
    // mergeGeometries needs a consistent index state across the batch.
    const anyIndexed = geos.some((g) => g.index);
    const allIndexed = geos.every((g) => g.index);
    const batch = anyIndexed && !allIndexed ? geos.map((g) => g.toNonIndexed()) : geos;

    let merged = null;
    try { merged = mergeGeometries(batch, false); } catch { merged = null; }
    if (!merged) {
      // Fall back to un-merged meshes for this material rather than losing it.
      for (const g of batch) prefab.add(new THREE.Mesh(g, mat));
      continue;
    }
    merged.computeBoundingSphere();
    tris += (merged.index ? merged.index.count : merged.getAttribute('position').count) / 3;
    for (const g of batch) g.dispose();   // data now lives in `merged`

    const mesh = new THREE.Mesh(merged, mat);
    mesh.userData.materialName = mat.name;
    mesh.frustumCulled = true;
    prefab.add(mesh);
  }

  // Normalise: nose down +Z, centred on X, wheels on y = 0, scaled to length.
  prefab.rotation.y = cfg.faceYaw;
  prefab.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(prefab);
  const sz = bb.getSize(new THREE.Vector3());
  const scale = cfg.length / sz.z;

  const holder = new THREE.Group();
  holder.add(prefab);
  prefab.scale.setScalar(scale);
  prefab.position.set(
    -((bb.min.x + bb.max.x) / 2) * scale,
    -bb.min.y * scale,
    -((bb.min.z + bb.max.z) / 2) * scale
  );

  holder.userData = {
    width: sz.x * scale,
    height: sz.y * scale,
    length: sz.z * scale,
    paintRe: cfg.paint,
  };

  if (DEBUG) {
    console.log(`[prefab] ${cfg.url}: ${groups.size} materials, ${Math.round(tris / 1000)}k tris, ${dropped} interior meshes dropped`);
    console.log('[prefab] materials:', [...groups.keys()].map((m) => m.name));
  }

  // Original meshes are no longer referenced; free their buffers.
  for (const { mesh } of parts) mesh.geometry.dispose();

  return holder;
}

/* --- instances -------------------------------------------------------- */

const shadowTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grd.addColorStop(0, 'rgba(0,0,0,0.75)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

function addShadow(group, w, l) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 2.1, l * 1.5),
    new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, opacity: 0.85 })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.02;
  group.add(m);
}

function addUnderglow(group, color, w, l) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 1.9, l * 1.25),
    new THREE.MeshBasicMaterial({
      map: shadowTexture, color, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.05;
  group.add(m);
}

function addTailGlow(group, l) {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xff2a2a, transparent: true, opacity: 0.75,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  for (const side of [-1, 1]) {
    const q = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.16), mat);
    q.position.set(side * 0.62, 0.82, -l / 2 - 0.02);
    group.add(q);
  }
}

/**
 * ~80-triangle stand-in used past LOD_SWAP metres. At that distance a car is a
 * few dozen pixels tall, so the silhouette and colour are all that survive —
 * but it saves ~200k triangles per background car.
 */
const lowPolyCache = new Map();

function makeLowPoly(color, w, h, l) {
  const cacheKey = `${color}|${w.toFixed(2)}|${l.toFixed(2)}`;
  if (lowPolyCache.has(cacheKey)) return lowPolyCache.get(cacheKey).clone(true);

  const body = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0a0d14, roughness: 0.6 });
  const lamp = new THREE.MeshBasicMaterial({ color: 0xff2a2a });

  const g = new THREE.Group();
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(w * 0.94, h * 0.46, l * 0.98), body, 0, h * 0.30, 0);
  add(new THREE.BoxGeometry(w * 0.80, h * 0.40, l * 0.44), dark, 0, h * 0.70, -l * 0.06);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    add(new THREE.BoxGeometry(w * 0.10, h * 0.30, h * 0.30), dark,
      sx * w * 0.46, h * 0.15, sz * l * 0.32);
  }
  for (const sx of [-1, 1]) {
    add(new THREE.PlaneGeometry(w * 0.26, h * 0.08), lamp, sx * w * 0.3, h * 0.40, -l * 0.5 - 0.01);
  }

  lowPolyCache.set(cacheKey, g);
  return g.clone(true);
}

/** Clone a prefab, recolouring its paint material without touching the shared one. */
function instantiate(prefab, { paint, underglow, tailGlow, lod = false } = {}) {
  const inst = prefab.clone(true);
  const { width, height, length, paintRe } = prefab.userData;

  inst.traverse((o) => {
    if (!o.isMesh) return;
    if (paint != null && paintRe && paintRe.test(o.userData.materialName || o.material.name || '')) {
      o.material = o.material.clone();
      o.material.color = new THREE.Color(paint);
      o.material.metalness = Math.max(o.material.metalness ?? 0, 0.55);
      o.material.roughness = Math.min(o.material.roughness ?? 1, 0.28);
      if ('clearcoat' in o.material) o.material.clearcoat = 1;
    }
  });

  const car = new THREE.Group();
  if (lod) {
    // WebGLRenderer updates LOD levels itself while `autoUpdate` is on.
    const levels = new THREE.LOD();
    levels.addLevel(inst, 0);
    levels.addLevel(makeLowPoly(paint ?? 0x9aa3b2, width, height, length), LOD_SWAP);
    levels.addLevel(new THREE.Object3D(), LOD_CULL);
    car.add(levels);
  } else {
    car.add(inst);
  }
  addShadow(car, width, length);
  if (underglow != null) addUnderglow(car, underglow, width, length);
  if (tailGlow) addTailGlow(car, length);
  car.userData = { width, height, length };

  if (DEBUG) {
    const box = new THREE.Box3(
      new THREE.Vector3(-CAR.halfWidth * CAR.hitScaleX, 0, -CAR.halfLength * CAR.hitScaleZ),
      new THREE.Vector3(CAR.halfWidth * CAR.hitScaleX, height, CAR.halfLength * CAR.hitScaleZ)
    );
    car.add(new THREE.Box3Helper(box, 0x00ff88));
  }
  return car;
}

/* ============================== the cars =============================== */

let playerCar = null;
let rivalCar = null;

/* One pool per paint variant: the server tells us which variant a car is, so
   both players see the same colour on the same car. */
const trafficPools = COLORS.traffic.map(() => []);

function spawnTrafficMesh(variant) {
  const v = variant % COLORS.traffic.length;
  const pooled = trafficPools[v].pop();
  if (pooled) { pooled.visible = true; return pooled; }
  const mesh = instantiate(prefabs.traffic, { paint: COLORS.traffic[v], tailGlow: true, lod: true });
  mesh.userData.variant = v;
  world.add(mesh);
  return mesh;
}

function releaseTrafficMesh(car) {
  car.visible = false;
  const pool = trafficPools[car.userData.variant || 0];
  if (pool.length < 12) pool.push(car);
  else world.remove(car);
}

/* ============================ game lifecycle =========================== */

function resetRace() {
  G.me = { distance: 0, speed: 0, x: laneX(1), lane: 1, targetLane: 1, lateral: 0, crashed: false, finished: false, spin: 0 };
  G.rival.buffer.length = 0;
  G.rival.distance = 0; G.rival.x = laneX(2); G.rival.crashed = false; G.rival.visible = true;

  for (const car of G.traffic.values()) if (car.obj) releaseTrafficMesh(car.obj);
  G.traffic.clear();

  if (playerCar) { playerCar.position.set(laneX(1), 0, 0); playerCar.rotation.set(0, 0, 0); }
  if (rivalCar) { rivalCar.position.set(laneX(2), 0, 0); rivalCar.rotation.set(0, 0, 0); rivalCar.visible = true; }

  el.progTotal.textContent = `/ ${CONFIG.finishDistance} m`;
  el.feed.innerHTML = '';
}

function startRacing() {
  G.phase = 'racing';
  G.me.speed = DRIVE.startSpeed;
  show(el.countdown, false);
  show(el.hud, true);
}

/* ============================== rendering ============================== */

const clock = new THREE.Clock();
let fpsAcc = 0, fpsFrames = 0;
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3(0, VIEW.camHeight, -VIEW.camBack);
let shake = 0;

function tickPlayer(dt) {
  const me = G.me;

  // Race is decided (or we already crossed the line): coast to a stop.
  if (!me.crashed && (G.phase === 'over' || me.finished)) {
    me.speed = Math.max(0, me.speed - 18 * dt);
    me.distance += me.speed * dt;
    if (playerCar) playerCar.position.set(me.x, 0, me.distance);
    return;
  }

  if (me.crashed) {
    me.speed = Math.max(0, me.speed - 26 * dt);
    me.spin += dt * me.speed * 0.22;
    me.distance += me.speed * dt;
    if (playerCar) {
      playerCar.rotation.y = me.spin;
      playerCar.rotation.z = Math.sin(me.spin * 2) * 0.12;
      playerCar.position.set(me.x, 0, me.distance);
    }
    return;
  }

  // longitudinal
  if (input.throttle) me.speed += DRIVE.accel * dt;
  else if (input.brakeKey) me.speed -= DRIVE.brake * dt;
  else me.speed -= DRIVE.coast * dt;
  me.speed = THREE.MathUtils.clamp(me.speed, DRIVE.minSpeed, DRIVE.maxSpeed);
  me.distance += me.speed * dt;

  // lateral — spring toward the target lane centre
  const goal = laneX(me.targetLane);
  const delta = goal - me.x;
  const desired = THREE.MathUtils.clamp(delta * DRIVE.laneSnap, -DRIVE.laneChangeSpeed, DRIVE.laneChangeSpeed);
  me.lateral = THREE.MathUtils.damp(me.lateral, desired, 9, dt);
  me.x += me.lateral * dt;
  me.lane = Math.round(me.x / CONFIG.laneWidth + (CONFIG.laneCount - 1) / 2);

  if (playerCar) {
    playerCar.position.set(me.x, 0, me.distance);
    playerCar.rotation.y = THREE.MathUtils.damp(playerCar.rotation.y, -me.lateral * 0.055, 10, dt);
    playerCar.rotation.z = THREE.MathUtils.damp(playerCar.rotation.z, me.lateral * 0.035, 8, dt);
  }
}

function trafficZ(car, raceTime) {
  return car.z + car.speed * (raceTime - car.raceTime) / 1000;
}

function tickTraffic(raceTime) {
  const d = G.me.distance;
  let visible = 0;

  for (const car of G.traffic.values()) {
    const z = trafficZ(car, raceTime);

    if (z < d - CONFIG.despawnBehind - VIEW.drawBehind || z > d + 900) {
      if (car.obj) { releaseTrafficMesh(car.obj); car.obj = null; }
      G.traffic.delete(car.id);
      continue;
    }

    const near = z > d - VIEW.drawBehind && z < d + VIEW.drawAhead;
    if (near && !car.obj) car.obj = spawnTrafficMesh(car.variant || 0);
    else if (!near && car.obj) { releaseTrafficMesh(car.obj); car.obj = null; }

    if (car.obj) {
      car.obj.position.set(car.laneX, 0, z);
      visible++;
    }
    car.lastZ = z;
  }
  el.trafficCount.textContent = String(visible);
}

function checkCollisions(raceTime) {
  const me = G.me;
  if (me.crashed || me.finished || G.phase !== 'racing') return;

  const hw = CAR.halfWidth * CAR.hitScaleX * 2;   // combined half-extent (both cars)
  const hl = CAR.halfLength * CAR.hitScaleZ * 2;

  for (const car of G.traffic.values()) {
    const z = car.lastZ ?? trafficZ(car, raceTime);
    const dz = z - me.distance;
    if (dz > hl || dz < -hl) continue;
    if (Math.abs(car.laneX - me.x) > hw) continue;
    crash(car.id);
    break;
  }
}

function crash(trafficId) {
  const me = G.me;
  me.crashed = true;
  socket.emit('player:crash', { trafficId });
  el.flash.classList.remove('hit');
  void el.flash.offsetWidth;
  el.flash.classList.add('hit');
  shake = 1;
  feed('WRECKED', 'bad');
  if (navigator.vibrate) navigator.vibrate(180);
}

function tickRival(dt) {
  if (!rivalCar) return;
  const renderAt = net.now() - NET.interpDelayMs;
  const buf = G.rival.buffer;

  while (buf.length > 2 && buf[1].t <= renderAt) buf.shift();

  let x = G.rival.x, distance = G.rival.distance;
  if (buf.length >= 2) {
    const a = buf[0], b = buf[1];
    const span = Math.max(1, b.t - a.t);
    const k = THREE.MathUtils.clamp((renderAt - a.t) / span, 0, 1);
    x = THREE.MathUtils.lerp(a.x, b.x, k);
    distance = THREE.MathUtils.lerp(a.distance, b.distance, k);
    G.rival.speed = b.speed;
  } else if (buf.length === 1) {
    // Extrapolate briefly when packets stop arriving.
    const a = buf[0];
    const ahead = THREE.MathUtils.clamp((renderAt - a.t) / 1000, 0, 0.4);
    x = a.x;
    distance = a.distance + a.speed * ahead;
  }

  const prevX = G.rival.x;
  G.rival.x = x;
  G.rival.distance = distance;

  rivalCar.position.set(x, 0, distance);
  const drift = (x - prevX) / Math.max(dt, 1e-3);
  rivalCar.rotation.y = THREE.MathUtils.damp(rivalCar.rotation.y, -drift * 0.05, 8, dt);
  rivalCar.rotation.z = THREE.MathUtils.damp(rivalCar.rotation.z, drift * 0.03, 8, dt);

  // Fade the ghost when it is far away so it never hides traffic.
  const gap = Math.abs(distance - G.me.distance);
  rivalCar.visible = G.rival.visible && gap < 260;
}

function tickCamera(dt) {
  const me = G.me;
  const speedK = THREE.MathUtils.clamp((me.speed - DRIVE.minSpeed) / (DRIVE.maxSpeed - DRIVE.minSpeed), 0, 1);

  const want = new THREE.Vector3(
    me.x * 0.72,
    VIEW.camHeight + speedK * 0.35,
    me.distance - VIEW.camBack - speedK * 1.8
  );
  camPos.lerp(want, 1 - Math.exp(-7 * dt));

  if (shake > 0) {
    shake = Math.max(0, shake - dt * 1.6);
    const s = shake * shake * 0.85;
    camPos.x += (Math.random() - 0.5) * s;
    camPos.y += (Math.random() - 0.5) * s;
  }
  camera.position.copy(camPos);

  camTarget.set(me.x * 0.35, 1.15, me.distance + VIEW.camLookAhead);
  camera.lookAt(camTarget);

  const fov = VIEW.fovBase + (VIEW.fovMax - VIEW.fovBase) * speedK;
  if (Math.abs(camera.fov - fov) > 0.05) {
    camera.fov = THREE.MathUtils.damp(camera.fov, fov, 6, dt);
    camera.updateProjectionMatrix();
  }

  el.speedlines.style.setProperty('--speed-lines', (speedK * 0.9).toFixed(2));
}

function updateHUD() {
  const me = G.me;
  const kph = Math.round(me.speed * 3.6);
  el.speed.textContent = String(kph);

  const k = THREE.MathUtils.clamp(me.speed / DRIVE.maxSpeed, 0, 1);
  el.arcFill.style.strokeDashoffset = String(252 - 252 * k);
  el.arcFill.classList.toggle('redline', k > 0.88);

  el.progDistance.textContent = `${Math.round(me.distance)} m`;
  const pYou = THREE.MathUtils.clamp(me.distance / CONFIG.finishDistance, 0, 1) * 100;
  const pRival = THREE.MathUtils.clamp(G.rival.distance / CONFIG.finishDistance, 0, 1) * 100;
  el.trackYou.style.left = `${pYou}%`;
  el.trackRival.style.left = `${pRival}%`;

  const gap = me.distance - G.rival.distance;
  if (!G.rival.id) {
    el.gap.textContent = '—';
    el.gap.className = 'gap';
  } else {
    el.gap.textContent = `${gap >= 0 ? '+' : ''}${Math.round(gap)} m`;
    el.gap.className = `gap ${gap >= 0 ? 'ahead' : 'behind'}`;
  }

  el.lanePips.forEach((pip, i) => pip.classList.toggle('active', i === me.lane));

  el.ping.textContent = String(Math.round(net.ping));
  el.ping.className = net.ping > 220 ? 'bad' : net.ping > 110 ? 'warn' : '';
}

function sendState(now) {
  if (G.phase !== 'racing' || G.me.crashed || G.me.finished) return;
  if (now - G.lastStateSent < 1000 / NET.stateHz) return;
  G.lastStateSent = now;
  socket.volatile.emit('player:state', {
    distance: G.me.distance,
    x: G.me.x,
    lane: G.me.lane,
    speed: G.me.speed,
    heading: playerCar ? playerCar.rotation.y : 0,
  });
}

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now();

  fpsAcc += dt; fpsFrames++;
  if (fpsAcc >= 0.5) {
    el.fps.textContent = String(Math.round(fpsFrames / fpsAcc));
    fpsAcc = 0; fpsFrames = 0;
  }

  if (G.phase === 'countdown') {
    updateCountdown();
    // Safety net: if match:start is delayed or dropped, go on the clock.
    if (net.now() - G.startAt > 300) startRacing();
  }

  if (G.phase === 'racing' || G.phase === 'over') {
    G.raceTime = net.now() - G.startAt;
    tickPlayer(dt);
    tickTraffic(G.raceTime);
    checkCollisions(G.raceTime);
    tickRival(dt);
    sendState(now);
    updateHUD();
  }

  updateRoad(G.me.distance);
  tickCamera(dt);
  renderer.render(scene, camera);
}

/* ============================== countdown ============================== */

let lastCount = null;

function updateCountdown() {
  const left = G.startAt - net.now();
  const n = Math.ceil(left / 1000);

  if (left <= 0) {
    if (lastCount !== 'GO') {
      lastCount = 'GO';
      el.countNumber.textContent = 'GO';
      el.countNumber.classList.add('go');
      el.lights.forEach((l) => { l.classList.remove('on'); l.classList.add('go'); });
      restartAnim(el.countNumber);
    }
    return;
  }
  if (n !== lastCount) {
    lastCount = n;
    el.countNumber.textContent = String(Math.max(1, n));
    el.countNumber.classList.remove('go');
    restartAnim(el.countNumber);
    el.lights.forEach((l, i) => l.classList.toggle('on', i < 4 - n));
  }
}

function restartAnim(node) {
  node.style.animation = 'none';
  void node.offsetWidth;
  node.style.animation = '';
}

/* ================================ input ================================ */

function laneShift(dir) {
  if (G.phase !== 'racing' || G.me.crashed || G.me.finished) return;
  G.me.targetLane = THREE.MathUtils.clamp(G.me.targetLane + dir, 0, CONFIG.laneCount - 1);
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code.startsWith('Arrow')) e.preventDefault();
  if (e.repeat) return;
  switch (e.code) {
    case 'KeyA': case 'ArrowLeft':  input.left = true;  laneShift(-1); break;
    case 'KeyD': case 'ArrowRight': input.right = true; laneShift(1);  break;
    case 'KeyW': case 'ArrowUp':    input.throttle = true; break;
    case 'KeyS': case 'ArrowDown':  input.brakeKey = true; break;
    case 'Space':
      e.preventDefault();
      if (G.phase === 'room' && !el.btnReady.disabled) el.btnReady.click();
      break;
  }
});

addEventListener('keyup', (e) => {
  switch (e.code) {
    case 'KeyA': case 'ArrowLeft':  input.left = false; break;
    case 'KeyD': case 'ArrowRight': input.right = false; break;
    case 'KeyW': case 'ArrowUp':    input.throttle = false; break;
    case 'KeyS': case 'ArrowDown':  input.brakeKey = false; break;
  }
});

// touch: tap left/right half to change lane, hold to accelerate
let touchStart = null;
canvas.addEventListener('touchstart', (e) => {
  touchStart = { x: e.touches[0].clientX, t: Date.now() };
  input.throttle = true;
}, { passive: true });
canvas.addEventListener('touchend', (e) => {
  input.throttle = false;
  if (!touchStart) return;
  const dx = (e.changedTouches[0].clientX - touchStart.x);
  if (Math.abs(dx) > 28) laneShift(Math.sign(dx));
  else if (Date.now() - touchStart.t < 220) laneShift(touchStart.x < innerWidth / 2 ? -1 : 1);
  touchStart = null;
}, { passive: true });

/* ============================== lobby UI =============================== */

function inviteUrl(code) {
  return `${location.origin}/?room=${code}`;
}

function renderRoom(room) {
  G.roomCode = room.code;
  G.players = room.players;
  CONFIG = { ...CONFIG, ...room.config };

  el.roomCode.textContent = room.code;
  el.inviteLink.value = inviteUrl(room.code);

  const slots = el.playerList.querySelectorAll('.player-slot');
  slots.forEach((slot, i) => {
    const p = room.players[i];
    slot.classList.toggle('empty', !p);
    slot.querySelector('.pname').textContent = p
      ? (p.id === G.youId ? `${p.name} (you)` : p.name)
      : 'Waiting…';
    const state = slot.querySelector('.pstate');
    state.textContent = p ? (p.ready ? 'Ready' : 'Not ready') : '';
    state.classList.toggle('ready', !!(p && p.ready));
  });

  const me = room.players.find((p) => p.id === G.youId);
  G.ready = !!(me && me.ready);
  el.btnReady.textContent = G.ready ? 'Waiting…' : 'Ready up';
  el.btnReady.classList.toggle('is-ready', G.ready);
  el.btnReady.disabled = room.players.length < 2;

  el.lobbyStatus.textContent = room.players.length < 2
    ? 'Share the invite link — the race starts when both players are ready.'
    : (G.ready ? 'Waiting for your opponent…' : 'Both cars on the grid. Ready up!');

  const rival = room.players.find((p) => p.id !== G.youId);
  G.rival.id = rival ? rival.id : null;
  G.rival.visible = !!rival;
  if (rivalCar) rivalCar.visible = !!rival;
}

function enterRoomView() {
  G.phase = 'room';
  show(el.lobby, true);
  show(el.lobbyEntry, false);
  show(el.lobbyRoom, true);
  show(el.hud, false);
  show(el.gameover, false);
}

function joinRoom(code) {
  socket.emit('room:join', { room: code || undefined }, (res) => {
    if (!res || !res.ok) {
      toast(res ? res.message : 'Could not reach the server.', 'err');
      show(el.lobbyEntry, true);
      show(el.lobbyRoom, false);
      history.replaceState(null, '', '/');
      return;
    }
    G.youId = res.you.id;
    net.offset = res.serverTime - Date.now();
    renderRoom(res.room);
    enterRoomView();
    history.replaceState(null, '', res.inviteUrl);
  });
}

el.btnCreate.addEventListener('click', () => joinRoom(null));

el.joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = el.joinCode.value.trim().toUpperCase();
  if (code.length !== 6) { toast('Room codes are 6 characters.', 'err'); return; }
  joinRoom(code);
});

el.joinCode.addEventListener('input', () => {
  el.joinCode.value = el.joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

el.btnCopy.addEventListener('click', async () => {
  const url = el.inviteLink.value;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    el.inviteLink.select();
    document.execCommand('copy');
  }
  el.copyText.textContent = 'Copied!';
  toast('Invite link copied', 'ok');
  setTimeout(() => (el.copyText.textContent = 'Copy'), 1600);
});

el.btnReady.addEventListener('click', () => {
  const next = !G.ready;
  socket.emit('room:ready', next, (res) => {
    if (res && res.ok === false) toast(res.message, 'err');
  });
});

el.btnLeave.addEventListener('click', () => {
  socket.emit('room:leave', {}, () => {
    G.roomCode = null; G.youId = null; G.phase = 'lobby';
    history.replaceState(null, '', '/');
    show(el.lobbyRoom, false);
    show(el.lobbyEntry, true);
    show(el.gameover, false);
    show(el.hud, false);
  });
});

el.btnRematch.addEventListener('click', () => {
  socket.emit('room:rematch', {}, (res) => {
    if (res && res.ok === false) { toast(res.message, 'err'); return; }
    el.btnRematch.disabled = true;
    el.rematchStatus.textContent = 'Waiting for your opponent…';
  });
});

el.btnQuit.addEventListener('click', () => {
  show(el.gameover, false);
  show(el.hud, false);
  enterRoomView();
});

/* =========================== socket handlers =========================== */

socket.on('connect', () => {
  syncClock();
  if (G.phase === 'boot') return;   // models still loading, auto-join happens later
  if (!G.roomCode) show(el.lobbyEntry, true);
});

socket.on('disconnect', () => {
  toast('Disconnected from the server.', 'err');
  G.phase = 'lobby';
  show(el.hud, false);
  show(el.countdown, false);
  show(el.lobby, true);
  show(el.lobbyRoom, false);
  show(el.lobbyEntry, true);
});

socket.on('room:update', (room) => {
  if (!room || room.code !== G.roomCode) return;
  renderRoom(room);
  if (room.phase === 'waiting' && G.phase === 'over') enterRoomView();
});

socket.on('room:playerJoined', (p) => {
  toast(`${p.name} joined the room`, 'ok');
});

socket.on('room:playerLeft', (p) => {
  toast(`${p.name} left the room`, 'err');
  G.rival.visible = false;
  if (rivalCar) rivalCar.visible = false;
});

socket.on('match:countdown', (data) => {
  CONFIG = { ...CONFIG, ...data.config };
  G.seed = data.seed;
  G.startAt = data.startAt;
  // Trust the timestamp pair that came with this packet as a fresh clock fix.
  net.offset = data.serverTime - Date.now();

  buildRoad();
  resetRace();

  G.phase = 'countdown';
  lastCount = null;
  el.lights.forEach((l) => l.classList.remove('on', 'go'));
  show(el.lobby, false);
  show(el.gameover, false);
  show(el.countdown, true);
  show(el.hud, true);
  el.btnRematch.disabled = false;
  el.rematchStatus.textContent = '';
});

socket.on('match:start', (data) => {
  if (data && data.startAt) G.startAt = data.startAt;
  startRacing();
});

socket.on('traffic:spawn', (evt) => {
  G.traffic.set(evt.id, {
    id: evt.id, lane: evt.lane, laneX: evt.laneX, z: evt.z,
    speed: evt.speed, variant: evt.variant, raceTime: evt.raceTime, obj: null,
  });
});

socket.on('opponent:state', (s) => {
  if (s.id === G.youId) return;
  G.rival.id = s.id;
  const buf = G.rival.buffer;
  buf.push({ t: s.t, x: s.x, distance: s.distance, speed: s.speed || 0 });
  if (buf.length > 2 && buf[buf.length - 1].t - buf[0].t > NET.bufferMs) buf.shift();
});

socket.on('player:crashed', (p) => {
  if (p.id === G.youId) return;
  G.rival.crashed = true;
  feed(`${p.name} wrecked at ${p.distance} m`, 'good');
});

socket.on('player:finished', (p) => {
  if (p.id === G.youId) {
    G.me.finished = true;
    feed('FINISH', 'good');
  } else {
    feed(`${p.name} crossed the line`, 'bad');
  }
});

socket.on('match:over', (data) => {
  G.phase = 'over';
  const won = data.winnerId && data.winnerId === G.youId;

  el.resultTitle.textContent = data.winnerId ? (won ? 'YOU WIN' : 'YOU LOSE') : 'DRAW';
  el.resultTitle.className = `result-title ${data.winnerId ? (won ? 'win' : 'lose') : ''}`;
  el.resultSub.textContent = {
    finish: 'Chequered flag.',
    crash: 'Last car standing.',
    'all-out': 'Both cars wrecked.',
    'opponent-left': 'Your opponent disconnected.',
  }[data.reason] || '';

  el.resultList.innerHTML = '';
  data.results.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = [
      r.id === G.youId ? 'is-you' : 'is-rival',
      r.id === data.winnerId ? 'is-winner' : '',
    ].join(' ');
    const status = r.finished ? `${(r.finishTime / 1000).toFixed(2)} s`
      : r.crashed ? 'wrecked' : 'survived';
    li.innerHTML =
      `<span class="rk">${i + 1}</span>` +
      `<span class="nm">${r.name}${r.id === G.youId ? ' (you)' : ''}</span>` +
      `<span class="st">${r.distance} m · ${status} · ${r.score} W</span>`;
    el.resultList.appendChild(li);
  });

  setTimeout(() => {
    show(el.hud, false);
    show(el.countdown, false);
    show(el.gameover, true);
  }, 900);
});

socket.on('room:rematch', ({ by }) => {
  if (by !== G.youId) {
    el.rematchStatus.textContent = 'Your opponent wants a rematch!';
    toast('Opponent is ready for a rematch', 'ok');
  }
});

socket.on('room:error', ({ message }) => toast(message, 'err'));

/* ================================ boot ================================= */

async function boot() {
  buildRoad();

  const [playerGltf, trafficGltf] = await Promise.all([
    loadGLTF(MODELS.player, 'player'),
    loadGLTF(MODELS.traffic, 'traffic'),
  ]);
  progress.player = progress.traffic = 1;
  setLoadProgress();

  // Yield a frame so the loading bar paints before the (heavy) merge step.
  await new Promise((r) => setTimeout(r, 30));

  prefabs.player = buildPrefab(playerGltf, MODELS.player, { dropInterior: true });
  prefabs.traffic = buildPrefab(trafficGltf, MODELS.traffic, { dropInterior: true });

  playerCar = instantiate(prefabs.player, { paint: COLORS.you, underglow: COLORS.you });
  rivalCar = instantiate(prefabs.player, { paint: COLORS.rival, underglow: COLORS.rival, lod: true });
  rivalCar.visible = false;
  world.add(playerCar, rivalCar);

  resetRace();
  frame();

  show(el.loading, false);
  show(el.lobby, true);

  // Invite links land straight in the room.
  const code = new URLSearchParams(location.search).get('room');
  G.phase = 'lobby';
  if (code && /^[A-Z0-9]{6}$/i.test(code)) {
    show(el.lobbyEntry, false);
    show(el.lobbyRoom, true);
    el.lobbyStatus.textContent = 'Joining room…';
    joinRoom(code.toUpperCase());
  }
}

boot().catch((err) => {
  console.error(err);
  el.loadLabel.textContent = 'Failed to load the game assets. Check the console.';
  toast('Asset load failed — see console.', 'err');
});
