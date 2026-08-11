/* =====================================================================
   Traffic Duel — istemci  (Trafik Düellosu)
   ---------------------------------------------------------------------
   Dünya düzeni:
     +Z = gidiş yönü (bir aracın "mesafe"si aslında onun z değeridir)
     +X = sağ, +Y = yukarı, zemin y = 0 düzleminde, birim metredir.

   Determinizm: trafiği sunucu yönetir. Her aracın konumu, sunucunun
   yayınladığı spawn olayının ve paylaşılan yarış saatinin saf bir
   fonksiyonudur:
       z(t) = spawn.z + spawn.speed * (t - spawn.raceTime)
   böylece iki istemci trafiği hiç senkronize etmeden aynı yolu çizer.
   ===================================================================== */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ============================== sabitler =============================== */

const DEBUG = new URLSearchParams(location.search).has('debug');

const THREE_VERSION = '0.161.0';
const DRACO_PATH = `https://unpkg.com/three@${THREE_VERSION}/examples/jsm/libs/draco/`;

/* Değerler gönderilen .glb dosyalarından ölçüldü. `faceYaw` her modeli
   burnu +Z'ye bakacak şekilde döndürür:
     BMW  — farlar z = -1.65, stoplar z = +1.94   -> 180° çevir
     npc1 — farlar x = -113, stoplar x = +194     -> +90° çevir (uzun eksen X)
     npc2 — beyaz far x = +2.63, kırmızı x = -2.74 -> -90° çevir (uzun eksen X)
     npc3 — kırmızı cam z = -0.02                 -> zaten doğru
   `paint` gövde boyası malzemesidir; düz bir renk değişimi temiz bir
   takım/trafik liveresi verir. */
const MODELS = {
  player: {
    key: 'player',
    url: '/models/bmw_m3_competition.glb',
    faceYaw: Math.PI,
    paint: /^Material\.032$/,
    length: 4.72,
    weight: 0.49,           // yükleme çubuğundaki payı (indirme boyutuna göre)
    interiorSkin: 0.15,     // tam gövde kabuğu kalsın: bu araç ekranı doldurur
  },

  /* --- trafik modelleri: sunucu her spawn için birini seçer -------------- */
  npc1: {
    key: 'npc1',
    url: '/models/npc1.glb',
    faceYaw: Math.PI / 2,
    paint: /^body$/,
    length: 4.90,           // minibüs gövdeli, geniş
    weight: 0.22,
    interiorSkin: 0.12,
    // Sahne süsleri: modelin yanında gelen duvar fenerleri ve pişmiş gölge
    // düzlemi. Bunlar araç kabuğunu şişirdiği için ÖLÇÜMDEN ÖNCE atılır.
    dropMaterials: /^(shadow|lantern_wall)/i,
  },
  npc2: {
    key: 'npc2',
    url: '/models/npc2.glb',
    faceYaw: -Math.PI / 2,
    paint: /^body$/,
    length: 4.86,
    weight: 0.26,
    interiorSkin: 0.10,
    // Deri döşeme ve kabin süsü — yanından 250 km/s ile geçilen bir araçta
    // görünmez, ama örnek başına ~50 bin üçgen tutar.
    dropMaterials: /^(leather|Gold)/i,
  },
  npc3: {
    key: 'npc3',
    url: '/models/npc3.glb',
    faceYaw: 0,
    paint: /^phong1$/,
    length: 4.20,           // Audi TT gövdesi, kısa
    weight: 0.03,
    interiorSkin: 0.10,
    dropMaterials: /^internal$/i,
  },
};

/** Sunucunun `model` alanında gönderebileceği trafik modelleri. */
const TRAFFIC_MODELS = ['npc1', 'npc2', 'npc3'];

/** Bir aracın alçak poligonlu vekiline geçtiği mesafe (m). */
const LOD_SWAP = 70;
const LOD_CULL = 420;

const CAR = {
  halfWidth: 0.92,
  halfLength: 2.24,
  hitScaleX: 0.86,          // affedici arcade çarpışma kutusu
  hitScaleZ: 0.92,
};

const DRIVE = {
  startSpeed: 42,           // yeşil ışıkta m/s
  maxSpeed: 82,
  minSpeed: 8,
  accel: 15,
  brake: 34,
  coast: 5.5,
  laneChangeSpeed: 10.5,    // m/s yanal hız tavanı
  laneSnap: 6.2,            // şerit merkezine çeken yay katsayısı
  steerResponse: 11,        // yanal hızın hedefe oturma hızı (1/s)
  laneRepeatMs: 260,        // tuşu basılı tutunca şerit şerit kayma
};

/* Gövde animasyonu. Açılar radyan; hepsi tuş bırakılınca lerp ile nötre döner. */
const BODY = {
  rollMax: THREE.MathUtils.degToRad(5.5),   // Z ekseni yatışı (istenen 4-6°)
  yawMax: THREE.MathUtils.degToRad(7),      // Y ekseni hafif savrulma
  pitchMax: THREE.MathUtils.degToRad(1.2),  // gaz/fren dalışı (fazlası kaportayı
                                            // asfalta yaklaştırıp telafi payını
                                            // gözle görülür hale getiriyor)
  steerAttack: 9.5,         // direksiyon sinyalinin yüklenme hızı (1/s)
  steerRelease: 6.0,        // ve nötre dönüş hızı (1/s)
  rollAttack: 7.0,
  rollRelease: 5.0,
  yawRate: 9.0,
  pitchRate: 6.0,
};

const WHEEL = {
  steerMax: THREE.MathUtils.degToRad(12),   // ön tekerin Y ekseni dönüşü
  maxOmega: 34,             // rad/s — üstü strobe (araba tekeri) etkisi yapar
};

const NET = {
  syncIntervalMs: 2000,
  stateHz: 30,
  interpDelayMs: 120,       // hayaleti bu kadar geçmişte çiz
  bufferMs: 1500,
};

const VIEW = {
  camBack: 8.6,
  camHeight: 3.35,
  camLookAhead: 16,
  fovBase: 62,
  fovMax: 84,
  drawAhead: 340,           // örneklemeye değer trafik mesafesi (m)
  drawBehind: 90,
};

/* Yedekler — sunucunun `config` paketiyle üzerine yazılır. */
let CONFIG = {
  laneCount: 4,
  laneWidth: 3.5,
  spawnAhead: 250,
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

/* ============================== ağ katmanı ============================= */

const socket = io({ transports: ['websocket'], upgrade: false });

const net = {
  offset: 0,          // serverNow ≈ Date.now() + offset
  bestRtt: Infinity,
  ping: 0,
  synced: false,       // ilk örnekten sonra true — sonraki düzeltmeler yumuşatılır
  now: () => Date.now() + net.offset,
};

function syncClock() {
  const sent = Date.now();
  socket.emit('time:sync', sent, (res) => {
    if (!res) return;
    const rtt = Date.now() - sent;
    net.ping = rtt;
    // Offseti gördüğümüz en az gecikmeli örnekten koru.
    if (rtt <= net.bestRtt) {
      net.bestRtt = rtt;
      const measured = res.serverTime + rtt / 2 - Date.now();
      // Sert atama yerine yumuşak düzeltme: trafik/rakip zaman çizgisi ani
      // ofset sıçramalarıyla ileri/geri ışınlanmasın (teleport/rubber-band önlemi).
      net.offset = net.synced ? net.offset + (measured - net.offset) * 0.2 : measured;
      net.synced = true;
    }
    // En iyi örneği yavaşça unut ki rota değişirse saat yeniden kilitlensin.
    net.bestRtt = net.bestRtt * 1.05 + 1;
  });
}
setInterval(syncClock, NET.syncIntervalMs);

/* ============================= oyun durumu ============================= */

const G = {
  phase: 'boot',            // boot | lobby | room | countdown | racing | over
  ready: false,
  youId: null,
  roomCode: null,
  players: [],
  seed: 0,
  startAt: 0,               // yarış zamanı 0 anının sunucu epoch ms'i
  raceTime: 0,

  me: {
    distance: 0, speed: 0, x: 0, lane: 1, targetLane: 1,
    lateral: 0, steer: 0, roll: 0, yaw: 0, pitch: 0,
    crashed: false, finished: false, spin: 0,
  },
  rival: {
    id: null, buffer: [], distance: 0, x: 0, speed: 0, lateral: 0,
    steer: 0, crashed: false, visible: false,
  },

  traffic: new Map(),       // id -> { id, lane, laneX, z, speed, model, variant, raceTime, obj }
  lastStateSent: 0,
};

const input = { throttle: false, brakeKey: false, left: false, right: false };
let laneRepeatAt = 0;

/* ============================== renderer =============================== */

const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, powerPreference: 'high-performance', stencil: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.0));
renderer.shadowMap.enabled = false;
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070b14);
scene.fog = new THREE.Fog(0x070b14, 120, 460);

const camera = new THREE.PerspectiveCamera(VIEW.fovBase, innerWidth / innerHeight, 0.4, 1400);
camera.position.set(0, VIEW.camHeight, -VIEW.camBack);

/* Stüdyo benzeri IBL — böylece boya ve krom gerçekten metal gibi okunur. */
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

/* ================================= yol ================================= */

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

/** Bir kez canvasa çizilip UV kaydırmasıyla akıtılan kesikli şerit çizgileri. */
function makeMarkingTexture() {
  const lanes = CONFIG.laneCount;
  const px = 256;                       // doku 20 m'lik tek bir döşemedir
  const c = document.createElement('canvas');
  c.width = px; c.height = px;
  const g = c.getContext('2d');
  g.fillStyle = '#0d1119'; g.fillRect(0, 0, px, px);

  // hafif asfalt taneciği
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.035})`;
    g.fillRect(Math.random() * px, Math.random() * px, 1.5, 1.5);
  }

  const laneW = px / lanes;
  // iç kesikli çizgiler
  g.fillStyle = '#e9f3ff';
  for (let i = 1; i < lanes; i++) {
    const x = i * laneW - 1.5;
    g.fillRect(x, 8, 3, px * 0.42);
  }
  // dış sürekli çizgiler
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

  // banketler
  const shoulder = new THREE.Mesh(
    new THREE.PlaneGeometry(w + 26, len),
    new THREE.MeshStandardMaterial({ color: 0x090c14, roughness: 1 })
  );
  shoulder.rotation.x = -Math.PI / 2;
  shoulder.position.y = -0.04;
  road.group.add(shoulder);

  // bariyerler ve parlayan kenar şeritleri
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

  // geri dönüştürülen aydınlatma direkleri
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

  // paralaks siluet blokları
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

  // bitiş köprüsü
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

/* ============================ model hattı ============================== */

const loader = new GLTFLoader();
{
  // .glb dosyaları Draco ile sıkıştırıldı (157 MB -> ~11 MB).
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_PATH);
  loader.setDRACOLoader(draco);
}

const LOAD_KEYS = ['player', ...TRAFFIC_MODELS];
const progress = Object.fromEntries(LOAD_KEYS.map((k) => [k, 0]));
const prefabs = {};

function setLoadProgress() {
  const pct = Math.round(
    LOAD_KEYS.reduce((sum, k) => sum + progress[k] * MODELS[k].weight, 0) * 100
  );
  el.loadBar.style.width = `${Math.min(100, pct)}%`;
  el.loadLabel.textContent = pct < 100 ? `Araçlar yükleniyor… %${pct}` : 'Otoyol hazırlanıyor…';
}

function loadGLTF(cfg) {
  return new Promise((resolve, reject) => {
    loader.load(
      cfg.url,
      (gltf) => resolve(gltf),
      (evt) => {
        // Sunucu Content-Length göndermiyorsa total 0 gelir.
        progress[cfg.key] = evt.total
          ? Math.min(1, evt.loaded / evt.total)
          : Math.min(0.95, progress[cfg.key] + 0.02);
        setLoadProgress();
      },
      reject
    );
  });
}

/* --- tekerlek tespiti -------------------------------------------------- */

/* Tekerleği ADINDAN bulmaya çalışmıyoruz. BMW modelinde neredeyse her
   malzeme "3erg20_stitch_WHEEL.001_N" diye adlandırılmış (sanatçı tüm atlası
   tekerlek dokusundan türetmiş), yani ada bakan bir kural aracın taban sacını
   da tekerlek sanıyor. Onun yerine saf geometri: aday parçalar dört çeyreğe
   bölünür ve her parça GERÇEKTEN tekerleğe benziyorsa kabul edilir. */
const WHEEL_SHAPE = {
  lowFraction: 0.45,     // ağırlık merkezi kabuğun alt %45'inde olmalı
  roundness: 0.62,       // yükseklik / boy oranı — teker yuvarlaktır
  thinness: 0.85,        // aks boyunca kalınlık, çapın bu katından az olmalı
  minDiameter: 0.06,     // araç boyunun oranı olarak
  maxDiameter: 0.22,
  noiseTris: 30,         // bu kadar küçük çeyrek parçaları yok say
  noiseFraction: 0.02,
};

/**
 * Bir meshi dünya matrisi pişirilmiş, birleştirilebilir bir geometriye çevirir.
 * Sadece birleştirebildiğimiz öznitelikleri (position/normal/uv) taşır.
 */
function bakeGeometry(mesh, matrix) {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  if (!pos) return null;

  const baked = new THREE.BufferGeometry();
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
  return baked;
}

/**
 * Tekerlekleri gövdeden ayırıp her birini kendi ekseni etrafında dönebilen bir
 * pivot grubuna koyar. Tüketilen parçaları `used` kümesinde geri döndürür ki
 * gövde birleştirmesi onları tekrar eklemesin.
 *
 * Modellerin hiçbiri aynı şekilde kurulmuş değil: npc1'de dört ayrı `wheel_0x`
 * düğümü var, npc2 ve npc3 dört tekerleği tek bir mesh'te birleştirmiş, BMW'de
 * ise 250 parçanın hepsi aynı anlamsız ada sahip. Ortak payda geometridir:
 * her aday parça ÜÇGEN ÜÇGEN dört çeyreğe bölünür, sonra ortaya çıkan
 * parçaların hepsi tekerlek biçiminde mi diye bakılır (yuvarlak, aks boyunca
 * ince, araç boyuna oranla makul çapta). Böyle olmayan bir parça — taban sacı,
 * egzoz, tavandaki yedek lastik — gövdede kalır.
 */
function extractWheels(parts, shell, lateralAxis, lengthAxis) {
  const centre = shell.getCenter(new THREE.Vector3());
  const size = shell.getSize(new THREE.Vector3());
  const lat = { x: 0, y: 1, z: 2 }[lateralAxis];
  const lon = { x: 0, y: 1, z: 2 }[lengthAxis];
  const cLat = centre.getComponent(lat);
  const cLon = centre.getComponent(lon);
  const lowY = shell.min.y + size.y * WHEEL_SHAPE.lowFraction;
  const minDia = size[lengthAxis] * WHEEL_SHAPE.minDiameter;
  const maxDia = size[lengthAxis] * WHEEL_SHAPE.maxDiameter;

  // çeyrek -> Map(malzeme -> geometri[])
  const buckets = [new Map(), new Map(), new Map(), new Map()];
  const used = new Set();
  const partBox = new THREE.Box3();

  for (const part of parts) {
    // Ucuz ön eleme: tekerlek asla kaportanın üst yarısında olmaz.
    partBox.setFromObject(part.mesh);
    if (partBox.getCenter(new THREE.Vector3()).y > lowY) continue;

    const baked = bakeGeometry(part.mesh, part.matrix);
    if (!baked) continue;
    const flat = baked.index ? baked.toNonIndexed() : baked;
    if (flat !== baked) baked.dispose();

    const src = {
      position: flat.getAttribute('position'),
      normal: flat.getAttribute('normal'),
      uv: flat.getAttribute('uv'),
    };
    const triCount = src.position.count / 3;

    // Üçgenleri ağırlık merkezine göre sol/sağ × ön/arka çeyreklere ayır.
    const out = [[], [], [], []];
    for (let t = 0; t < triCount; t++) {
      const i = t * 3;                 // üçgenin ilk köşesinin köşe indeksi
      let sLat = 0, sLon = 0;
      for (let v = 0; v < 3; v++) {
        sLat += src.position.getComponent(i + v, lat);
        sLon += src.position.getComponent(i + v, lon);
      }
      const q = (sLat / 3 > cLat ? 2 : 0) + (sLon / 3 > cLon ? 1 : 0);
      out[q].push(i);
    }

    // Her çeyrek parçası tekerleğe benziyor mu? Biri bile benzemiyorsa parça
    // gövdeye geri döner — yarısını kesip almak modelde delik bırakırdı.
    let looksLikeWheel = false;
    let rejected = false;
    for (let q = 0; q < 4 && !rejected; q++) {
      if (!out[q].length) continue;
      if (out[q].length < WHEEL_SHAPE.noiseTris &&
          out[q].length < triCount * WHEEL_SHAPE.noiseFraction) continue;

      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (const i of out[q]) {
        for (let v = 0; v < 3; v++) {
          for (let c = 0; c < 3; c++) {
            const val = src.position.getComponent(i + v, c);
            if (val < lo[c]) lo[c] = val;
            if (val > hi[c]) hi[c] = val;
          }
        }
      }
      const sLatE = hi[lat] - lo[lat];
      const sY = hi[1] - lo[1];
      const sLonE = hi[lon] - lo[lon];
      const dia = Math.max(sY, sLonE);
      const round = Math.min(sY, sLonE) / Math.max(dia, 1e-9);

      if (round > WHEEL_SHAPE.roundness &&
          sLatE < dia * WHEEL_SHAPE.thinness &&
          dia > minDia && dia < maxDia) {
        looksLikeWheel = true;
      } else {
        rejected = true;
      }
    }

    if (rejected || !looksLikeWheel) { flat.dispose(); continue; }
    used.add(part);

    const material = Array.isArray(part.mesh.material) ? part.mesh.material[0] : part.mesh.material;
    for (let q = 0; q < 4; q++) {
      if (!out[q].length) continue;
      const n = out[q].length * 3;
      const geo = new THREE.BufferGeometry();
      for (const name of ['position', 'normal', 'uv']) {
        const a = src[name];
        const itemSize = a.itemSize;
        const arr = new Float32Array(n * itemSize);
        let w = 0;
        for (const i of out[q]) {
          for (let v = 0; v < 3; v++) {
            for (let c = 0; c < itemSize; c++) arr[w++] = a.getComponent(i + v, c);
          }
        }
        geo.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
      }
      if (!buckets[q].has(material)) buckets[q].set(material, []);
      buckets[q].get(material).push({ geo, part });
    }
    flat.dispose();
  }
  // `used` yakınlık elemesinden SONRA kesinleşir (aşağıda `keptParts`).

  const wheels = [];
  const box = new THREE.Box3();
  const keptParts = new Set();

  for (let q = 0; q < 4; q++) {
    if (!buckets[q].size) continue;

    // Pivot, kümenin ORTAK kutusundan değil, EN BÜYÜK çaplı parçasından
    // türetilir. Ortak kutu fren kaliperi gibi eksen dışı parçalar yüzünden
    // gerçek aksın yanına kayar ve teker dönerken göze batacak kadar yalpalar;
    // en dıştaki lastik halkası ise tanımı gereği aksa göre ortalıdır.
    let tyre = null, tyreDia = -1;
    for (const entries of buckets[q].values()) {
      for (const { geo } of entries) {
        geo.computeBoundingBox();
        const s = geo.boundingBox.getSize(new THREE.Vector3());
        const dia = Math.max(s.y, s[lengthAxis]);
        if (dia > tyreDia) { tyreDia = dia; tyre = geo.boundingBox; }
      }
    }
    const pivotAt = tyre.getCenter(new THREE.Vector3());
    const qSize = tyre.getSize(new THREE.Vector3());

    /* Lastiğin zarfının dışında kalan parçalar aslında tekerlek değildir
       (süspansiyon kolu, davlumbaz, çamurluk içi…). Burada bırakılırlarsa
       teker döndükçe etrafında yörüngeye girerler — npc2'de arka sol tekere
       yapışan bir plastik parça gövdeyi 15 cm sallıyordu. Gövdeye iade. */
    const near = (bb) => {
      const c = bb.getCenter(new THREE.Vector3());
      const radial = Math.hypot(c.y - pivotAt.y, c[lengthAxis] - pivotAt[lengthAxis]);
      return radial < tyreDia * 0.55 &&
        Math.abs(c[lateralAxis] - pivotAt[lateralAxis]) < tyreDia * 0.9;
    };

    const pivot = new THREE.Group();
    pivot.position.copy(pivotAt);
    // Y (direksiyon) DIŞTA, aks ekseni (dönüş) İÇTE kalsın.
    pivot.rotation.order = 'YXZ';

    box.makeEmpty();
    for (const [material, entries] of buckets[q]) {
      for (const { geo, part } of entries) {
        if (!near(geo.boundingBox)) { geo.dispose(); continue; }
        box.union(geo.boundingBox);
        keptParts.add(part);
        geo.translate(-pivotAt.x, -pivotAt.y, -pivotAt.z);
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, material);
        mesh.userData.materialName = material ? material.name : '';
        pivot.add(mesh);
      }
    }
    if (!pivot.children.length) continue;

    pivot.userData = {
      isWheel: true,
      spinAxis: lateralAxis,
      radius: Math.max(qSize.y, qSize[lengthAxis]) / 2,
      bottom: box.min.y,
      lon: pivotAt[lengthAxis],
    };
    wheels.push(pivot);
  }

  // Hiçbir parçası tekerlek olarak kalmayan mesh gövdeye geri döner.
  return { wheels, used: keptParts };
}

/**
 * Kaporta yatıp daldığında asfaltın altına ne kadar ineceğini ÖLÇER.
 *
 * Sınır kutusunun alt köşelerinden hesaplamak çok kötümser: gerçek bir aracın
 * en alçak noktası aynı anda hem en geniş hem en uzun uçta değildir. Kutu
 * hesabı BMW'de 17 cm kaldırma istiyordu — araba zıplıyormuş gibi görünürdü.
 * Bunun yerine gerçek köşe noktaları üzerinden, açı ızgarasının her düğümünde
 * gereken kaldırma bir kez ölçülür; çalışma anında aradaki değerler doğrusal
 * olarak bulunur. Fonksiyon dışbükey olduğu için ara değerler daima güvenli
 * tarafta (biraz fazla) kalır.
 *
 * @returns {{ roll:number[], pitch:number[], lift:number[][] }}
 */
function measureLift(bodyNorm, rollCentre, rollMax, pitchMax) {
  const rolls = [0, rollMax * 0.5, rollMax];
  const pitches = [-pitchMax, 0, pitchMax];

  // Köşe noktalarını bodyPivot uzayına taşı; her 11. köşe yeterli çözünürlük.
  bodyNorm.updateMatrixWorld(true);
  const pts = [];
  const v = new THREE.Vector3();
  bodyNorm.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.getAttribute('position');
    if (!pos) return;
    const stride = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      pts.push(v.x, v.y, v.z);
    }
  });

  const lift = rolls.map((roll) => pitches.map((pitch) => {
    let worst = 0;
    // Euler sırası YXZ -> önce yatış (Z), sonra dalış (X).
    for (const sign of [1, -1]) {
      const s = Math.sin(roll * sign), cR = Math.cos(roll * sign);
      const sP = Math.sin(pitch), cP = Math.cos(pitch);
      for (let i = 0; i < pts.length; i += 3) {
        const y = (pts[i] * s + pts[i + 1] * cR) * cP - pts[i + 2] * sP;
        const ground = rollCentre + y;
        if (ground < worst) worst = ground;
      }
    }
    return -worst;             // >= 0: asfaltın altına inen miktar
  }));

  return { roll: rolls, pitch: pitches, lift };
}

/**
 * Sketchfab tarzı bir GLTF'i (yüzlerce minik mesh) malzeme başına bir mesh'e
 * indirger. Çizim çağrılarını ~250'den ~40'a düşürür ve her trafik örneğinin
 * aynı geometriyi paylaşmasını sağlar.
 *
 * `dropInterior`, sınır kutusu tamamen aracın kabuğunun içinde kalan meshleri
 * atar (koltuklar, gösterge paneli, motor, turbo tesisatı). Tamamen geometrik
 * bir ölçüt olduğu için sanatçının isimlendirmesine bağlı değildir.
 */
function buildPrefab(gltf, cfg, { dropInterior = true } = {}) {
  const src = gltf.scene;
  src.updateWorldMatrix(true, true);

  /* 1 — parçaları topla, sahne süslerini daha ölçmeden at ------------------ */
  const parts = [];
  src.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (cfg.dropMaterials && mats.every((m) => m && cfg.dropMaterials.test(m.name || ''))) return;
    parts.push({ mesh: o, mats, matrix: o.matrixWorld.clone() });
  });

  /* 2 — geriye kalanın kabuğu; artık sadece araç var ---------------------- */
  const box = new THREE.Box3();
  const shell = new THREE.Box3();
  shell.makeEmpty();
  for (const p of parts) { box.setFromObject(p.mesh); shell.union(box); }

  const size = shell.getSize(new THREE.Vector3());
  const centre = shell.getCenter(new THREE.Vector3());
  // faceYaw ±90° ise model uzun kenarı X boyunca modellenmiş demektir.
  const lengthAxis = Math.abs(Math.sin(cfg.faceYaw)) > 0.5 ? 'x' : 'z';
  const lateralAxis = lengthAxis === 'x' ? 'z' : 'x';

  /* 3 — tekerlekleri ayıkla; geri kalanı gövdedir -------------------------- */
  const { wheels, used } = extractWheels(parts, shell, lateralAxis, lengthAxis);
  const bodyParts = parts.filter((p) => !used.has(p));

  /* 4 — gövdeyi malzeme başına birleştir ---------------------------------- */
  const skin = cfg.interiorSkin ?? 0.15;
  const inner = shell.clone();
  inner.min.x += size.x * skin; inner.max.x -= size.x * skin;
  inner.min.z += size.z * skin; inner.max.z -= size.z * skin;
  inner.min.y += size.y * skin * 0.7; inner.max.y = shell.min.y + size.y * 0.74;

  /** @type {Map<THREE.Material, THREE.BufferGeometry[]>} */
  const groups = new Map();
  let dropped = 0;

  function push(mat, geo) {
    if (!mat || !geo) return;
    if (!groups.has(mat)) groups.set(mat, []);
    groups.get(mat).push(geo);
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

  for (const { mesh, mats, matrix } of bodyParts) {
    if (dropInterior && mats.length === 1) {
      box.setFromObject(mesh);
      if (inner.containsBox(box)) { dropped++; continue; }
    }

    const baked = bakeGeometry(mesh, matrix);
    if (!baked) continue;
    const g = mesh.geometry;

    if (mats.length > 1 && g.groups.length) {
      // Çok malzemeli geometriyi böl ki her dilim doğru kovaya girsin.
      for (const grp of g.groups) {
        push(mats[grp.materialIndex] || mats[0], sliceGeometry(baked, grp.start, grp.count));
      }
      baked.dispose();
    } else {
      push(mats[0], baked);
    }
  }

  const body = new THREE.Group();
  let tris = 0;
  for (const [mat, geos] of groups) {
    // mergeGeometries partinin tamamında tutarlı bir index durumu ister.
    const anyIndexed = geos.some((g) => g.index);
    const allIndexed = geos.every((g) => g.index);
    const batch = anyIndexed && !allIndexed ? geos.map((g) => g.toNonIndexed()) : geos;

    let merged = null;
    try { merged = mergeGeometries(batch, false); } catch { merged = null; }
    if (!merged) {
      // Malzemeyi tamamen kaybetmektense birleştirmeden ekle.
      for (const g of batch) body.add(new THREE.Mesh(g, mat));
      continue;
    }
    merged.computeBoundingSphere();
    tris += (merged.index ? merged.index.count : merged.getAttribute('position').count) / 3;
    for (const g of batch) g.dispose();   // veri artık `merged` içinde

    const mesh = new THREE.Mesh(merged, mat);
    mesh.userData.materialName = mat.name;
    mesh.frustumCulled = true;
    body.add(mesh);
  }

  /* 5 — normalleştir: burun +Z, X'te ortalı, LASTİKLER y = 0'da ----------- */
  const rig = new THREE.Group();
  rig.rotation.y = cfg.faceYaw;
  const wheelGroup = new THREE.Group();
  for (const w of wheels) wheelGroup.add(w);
  rig.add(body, wheelGroup);
  rig.updateMatrixWorld(true);

  const bb = new THREE.Box3().setFromObject(rig);
  const bbSize = bb.getSize(new THREE.Vector3());
  const scale = cfg.length / bbSize.z;

  // Zemin referansı: tekerlek varsa lastiğin en alt noktası, yoksa kabuğun
  // dibi. Böylece alçak bir difüzör aracı havada bırakmaz, kaporta da asfalta
  // gömülmez. (Y ekseni faceYaw'dan etkilenmediği için model uzayı = bu uzay.)
  const groundY = wheels.length
    ? Math.min(...wheels.map((w) => w.userData.bottom))   // model uzayında mutlak
    : bb.min.y;

  const offset = new THREE.Vector3(
    -((bb.min.x + bb.max.x) / 2) * scale,
    -groundY * scale,
    -((bb.min.z + bb.max.z) / 2) * scale
  );

  rig.remove(body, wheelGroup);

  const height = bbSize.y * scale;
  const width = bbSize.x * scale;
  const rollCentre = height * 0.38;     // gövdenin yattığı eksenin yüksekliği

  /* Hiyerarşi:
       holder
        ├── bodyPivot   (yatış Z / dalış X — sadece kaporta)
        │    └── bodyNorm  (faceYaw + ölçek + kaydırma)
        └── wheelRoot   (aynı normalleştirme, ama yatmaz: lastikler yolda kalır)
  */
  const holder = new THREE.Group();

  const bodyNorm = new THREE.Group();
  bodyNorm.rotation.y = cfg.faceYaw;
  bodyNorm.scale.setScalar(scale);
  bodyNorm.position.set(offset.x, offset.y - rollCentre, offset.z);
  bodyNorm.add(body);

  // Kaldırma tablosunu bodyPivot'a EKLEMEDEN önce ölç: bu sayede noktalar
  // pivotun kendi uzayında çıkar, pivotun yüksekliği iki kez sayılmaz.
  const liftTable = measureLift(bodyNorm, rollCentre, BODY.rollMax, BODY.pitchMax);

  const bodyPivot = new THREE.Group();
  bodyPivot.name = 'bodyPivot';
  bodyPivot.position.y = rollCentre;
  bodyPivot.rotation.order = 'YXZ';
  bodyPivot.add(bodyNorm);
  holder.add(bodyPivot);

  const wheelRoot = new THREE.Group();
  wheelRoot.name = 'wheelRoot';
  wheelRoot.rotation.y = cfg.faceYaw;
  wheelRoot.scale.setScalar(scale);
  wheelRoot.position.copy(offset);
  wheelRoot.add(wheelGroup);
  holder.add(wheelRoot);

  /* 6 — dönüş yönü ve ön/arka ayrımı -------------------------------------- */
  // Model uzayındaki yanal eksenin faceYaw'dan sonraki dünya-X bileşeni.
  const spinSign = Math.sign(
    lateralAxis === 'x' ? Math.cos(cfg.faceYaw) : Math.sin(cfg.faceYaw)
  ) || 1;
  // Model uzayında +Z'ye dönüşecek yön boyunca burun tarafı.
  const frontSign = lengthAxis === 'x' ? -Math.sin(cfg.faceYaw) : Math.cos(cfg.faceYaw);
  const centreLon = centre[lengthAxis];
  for (const w of wheels) {
    w.userData.isFront = (w.userData.lon - centreLon) * frontSign > 0;
  }

  holder.userData = {
    width,
    height,
    length: bbSize.z * scale,
    rollCentre,
    liftTable,
    spinSign,
    paintRe: cfg.paint,
    wheelRadius: wheels.length
      ? (wheels.reduce((s, w) => s + w.userData.radius, 0) / wheels.length) * scale
      : 0.33,
  };

  if (DEBUG) {
    console.log(
      `[prefab] ${cfg.url}: ${groups.size} malzeme, ${Math.round(tris / 1000)}k üçgen, ` +
      `${dropped} iç mesh atıldı, ${wheels.length} tekerlek ` +
      `(ön: ${wheels.filter((w) => w.userData.isFront).length}), ` +
      `uzun eksen ${lengthAxis}, dönüş yönü ${spinSign}`
    );
  }

  // Orijinal meshlere artık referans yok (gövde birleştirildi, tekerlekler
  // kopyalandı); tamponlarını serbest bırak.
  src.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });

  return holder;
}

/* --- örnekler ---------------------------------------------------------- */

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
 * LOD_SWAP metreden sonra kullanılan ~80 üçgenlik vekil. O mesafede araç
 * birkaç düzine piksel yüksekliğindedir, yani siluet ve renkten başkası
 * hayatta kalmaz — ama arka plandaki araç başına ~200 bin üçgen kazandırır.
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

/** Bir prefabı klonlar; boyasını paylaşılan malzemeye dokunmadan değiştirir. */
function instantiate(prefab, { paint, underglow, tailGlow, lod = false } = {}) {
  const { width, height, length, paintRe, rollCentre, liftTable, spinSign, wheelRadius } = prefab.userData;

  const src = prefab.clone(true);
  const bodyPivot = src.getObjectByName('bodyPivot');
  const wheelRoot = src.getObjectByName('wheelRoot');

  // Boya sadece kaportaya uygulanır — jantlar ve diskler kendi rengini korur.
  if (paint != null && paintRe) {
    bodyPivot.traverse((o) => {
      if (!o.isMesh) return;
      if (!paintRe.test(o.userData.materialName || o.material.name || '')) return;
      o.material = o.material.clone();
      o.material.color = new THREE.Color(paint);
      o.material.metalness = Math.max(o.material.metalness ?? 0, 0.55);
      o.material.roughness = Math.min(o.material.roughness ?? 1, 0.28);
      if ('clearcoat' in o.material) o.material.clearcoat = 1;
    });
  }

  const car = new THREE.Group();
  car.add(bodyPivot);

  if (lod) {
    // Kaporta uzakta kutuya düşer; tekerlekler de o mesafede tamamen kapanır.
    const bodyNorm = bodyPivot.children[0];
    bodyPivot.remove(bodyNorm);

    const levels = new THREE.LOD();
    levels.addLevel(bodyNorm, 0);
    const low = makeLowPoly(paint ?? 0x9aa3b2, width, height, length);
    low.position.y = -rollCentre;   // vekil lastikleri y = 0'a göre çizilir
    levels.addLevel(low, LOD_SWAP);
    levels.addLevel(new THREE.Object3D(), LOD_CULL);
    bodyPivot.add(levels);

    const wheelLod = new THREE.LOD();
    wheelLod.addLevel(wheelRoot, 0);
    wheelLod.addLevel(new THREE.Object3D(), LOD_SWAP);
    car.add(wheelLod);
  } else {
    car.add(wheelRoot);
  }

  const wheels = [];
  wheelRoot.traverse((o) => { if (o.userData && o.userData.isWheel) wheels.push(o); });

  addShadow(car, width, length);
  if (underglow != null) addUnderglow(car, underglow, width, length);
  if (tailGlow) addTailGlow(car, length);

  car.userData = {
    width, height, length, rollCentre, liftTable, spinSign, wheelRadius,
    bodyPivot, wheels, spin: 0,
  };

  if (DEBUG) {
    const hw = Math.min(width * 0.5 * 0.86, 1.0);
    const hl = length * 0.5 * 0.92;
    car.add(new THREE.Box3Helper(new THREE.Box3(
      new THREE.Vector3(-hw, 0, -hl), new THREE.Vector3(hw, height, hl)
    ), 0x00ff88));
  }
  return car;
}

/* ------------------------- tekerlek animasyonu ------------------------- */

/**
 * Tekerlekleri araç hızıyla ileri döndürür; ön tekerlekler direksiyon
 * sinyaline göre Y ekseninde hafifçe kırılır.
 *
 * @param {THREE.Group} car    instantiate() çıktısı
 * @param {number} speed       m/s cinsinden ileri hız
 * @param {number} steer       -1 (sol) .. +1 (sağ)
 * @param {number} dt          saniye
 */
function driveWheels(car, speed, steer, dt) {
  const u = car.userData;
  if (!u || !u.wheels || !u.wheels.length) return;

  // Gerçek açısal hız 82 m/s'de ~250 rad/s eder; 60 fps'de bu Nyquist'in çok
  // ötesinde kalır ve teker geri dönüyormuş gibi görünür. Tavanla sınırlıyoruz.
  const omega = Math.min(Math.abs(speed) / Math.max(u.wheelRadius, 0.15), WHEEL.maxOmega);
  u.spin = (u.spin + omega * Math.sign(speed || 1) * u.spinSign * dt) % (Math.PI * 2);

  const steerAngle = THREE.MathUtils.clamp(steer, -1, 1) * WHEEL.steerMax;
  for (const w of u.wheels) {
    w.rotation[w.userData.spinAxis] = u.spin;
    if (w.userData.isFront) w.rotation.y = steerAngle;
  }
}

/** measureLift tablosundan ara değer okur (yatış simetrik olduğu için |roll|). */
function liftAt(table, roll, pitch) {
  if (!table) return 0;
  const { roll: rs, pitch: ps, lift } = table;
  const pick = (arr, v) => {
    let i = 0;
    while (i < arr.length - 2 && v > arr[i + 1]) i++;
    const span = arr[i + 1] - arr[i] || 1;
    return [i, THREE.MathUtils.clamp((v - arr[i]) / span, 0, 1)];
  };
  const [ri, rk] = pick(rs, Math.abs(roll));
  const [pi, pk] = pick(ps, THREE.MathUtils.clamp(pitch, ps[0], ps[ps.length - 1]));
  const a = THREE.MathUtils.lerp(lift[ri][pi], lift[ri][pi + 1], pk);
  const b = THREE.MathUtils.lerp(lift[ri + 1][pi], lift[ri + 1][pi + 1], pk);
  return Math.max(0, THREE.MathUtils.lerp(a, b, rk));
}

/**
 * Kaportayı yatırır / daldırır ve gövdeyi asfaltın üstünde tutar.
 * Tekerlekler bodyPivot'un dışında olduğu için yola yapışık kalır.
 */
function poseBody(car, roll, pitch) {
  const u = car.userData;
  const pivot = u.bodyPivot;
  if (!pivot) return;
  pivot.rotation.z = roll;
  pivot.rotation.x = pitch;
  // Yatarken alçakta kalan eşik asfaltı kesmesin diye tam gerektiği kadar kaldır.
  pivot.position.y = u.rollCentre + liftAt(u.liftTable, roll, pitch);
}

/* =============================== araçlar =============================== */

let playerCar = null;
let rivalCar = null;

/* Model + boya varyantı başına bir havuz: hangi aracın hangi model ve renkte
   olduğunu sunucu söyler, böylece iki oyuncu da aynı aracı aynı görür. */
const trafficPools = new Map();     // "npc2:3" -> THREE.Group[]

/** Modelden türetilen çarpışma yarı-boyutları (her istemcide birebir aynı). */
const trafficHit = new Map();       // "npc2" -> { halfWidth, halfLength }

function poolKey(model, variant) { return `${model}:${variant}`; }

function spawnTrafficMesh(model, variant) {
  const name = TRAFFIC_MODELS.includes(model) ? model : TRAFFIC_MODELS[0];
  const v = ((variant | 0) % COLORS.traffic.length + COLORS.traffic.length) % COLORS.traffic.length;
  const key = poolKey(name, v);

  const pool = trafficPools.get(key);
  if (pool && pool.length) {
    const pooled = pool.pop();
    pooled.visible = true;
    return pooled;
  }

  const mesh = instantiate(prefabs[name], { paint: COLORS.traffic[v], tailGlow: true, lod: true });
  mesh.userData.poolKey = key;
  world.add(mesh);
  return mesh;
}

function releaseTrafficMesh(car) {
  car.visible = false;
  const key = car.userData.poolKey || poolKey(TRAFFIC_MODELS[0], 0);
  if (!trafficPools.has(key)) trafficPools.set(key, []);
  const pool = trafficPools.get(key);
  if (pool.length < 5) pool.push(car);
  else world.remove(car);
}

function hitFor(model) {
  return trafficHit.get(model) || { halfWidth: CAR.halfWidth, halfLength: CAR.halfLength };
}

/* =========================== oyun yaşam döngüsü ======================== */

function resetRace() {
  G.me = {
    distance: 0, speed: 0, x: laneX(1), lane: 1, targetLane: 1,
    lateral: 0, steer: 0, roll: 0, yaw: 0, pitch: 0,
    crashed: false, finished: false, spin: 0,
  };
  G.rival.buffer.length = 0;
  G.rival.distance = 0; G.rival.x = laneX(2); G.rival.lateral = 0; G.rival.steer = 0;
  G.rival.crashed = false; G.rival.visible = true;

  for (const car of G.traffic.values()) if (car.obj) releaseTrafficMesh(car.obj);
  G.traffic.clear();

  if (playerCar) {
    playerCar.position.set(laneX(1), 0, 0);
    playerCar.rotation.set(0, 0, 0);
    poseBody(playerCar, 0, 0);
  }
  if (rivalCar) {
    rivalCar.position.set(laneX(2), 0, 0);
    rivalCar.rotation.set(0, 0, 0);
    poseBody(rivalCar, 0, 0);
    rivalCar.visible = true;
  }

  el.progTotal.textContent = `/ ${CONFIG.finishDistance} m`;
  el.feed.innerHTML = '';
}

function startRacing() {
  G.phase = 'racing';
  G.me.speed = DRIVE.startSpeed;
  show(el.countdown, false);
  show(el.hud, true);
}

/* ============================== çizim ================================== */

const clock = new THREE.Clock();
let fpsAcc = 0, fpsFrames = 0;
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3(0, VIEW.camHeight, -VIEW.camBack);
let shake = 0;

// Kamera her zaman sabit adımlarla güncellenir; düşük FPS'te büyük/dengesiz
// dt sıçramaları shake/lerp hesaplarını titretmesin diye (frame-rate bağımsız).
const CAM_FIXED_DT = 1 / 60;
const CAM_MAX_CATCHUP = CAM_FIXED_DT * 5; // "spiral of death" birikmesini önler
let camAccumulator = 0;

function tickPlayer(dt) {
  const me = G.me;

  // Yarış bitti (ya da çizgiyi geçtik): yavaşlayarak dur.
  if (!me.crashed && (G.phase === 'over' || me.finished)) {
    me.speed = Math.max(0, me.speed - 18 * dt);
    me.distance += me.speed * dt;
    me.steer = THREE.MathUtils.damp(me.steer, 0, BODY.steerRelease, dt);
    me.roll = THREE.MathUtils.damp(me.roll, 0, BODY.rollRelease, dt);
    me.yaw = THREE.MathUtils.damp(me.yaw, 0, BODY.yawRate, dt);
    me.pitch = THREE.MathUtils.damp(me.pitch, 0, BODY.pitchRate, dt);
    if (playerCar) {
      playerCar.position.set(me.x, 0, me.distance);
      playerCar.rotation.y = me.yaw;
      poseBody(playerCar, me.roll, me.pitch);
      driveWheels(playerCar, me.speed, me.steer, dt);
    }
    return;
  }

  if (me.crashed) {
    me.speed = Math.max(0, me.speed - 26 * dt);
    me.spin += dt * me.speed * 0.22;
    me.distance += me.speed * dt;
    if (playerCar) {
      playerCar.rotation.y = me.spin;
      playerCar.position.set(me.x, 0, me.distance);
      poseBody(playerCar, Math.sin(me.spin * 2) * 0.12, 0);
      driveWheels(playerCar, me.speed, 0, dt);
    }
    return;
  }

  /* --- boyuna ---------------------------------------------------------- */
  if (input.throttle) me.speed += DRIVE.accel * dt;
  else if (input.brakeKey) me.speed -= DRIVE.brake * dt;
  else me.speed -= DRIVE.coast * dt;
  me.speed = THREE.MathUtils.clamp(me.speed, DRIVE.minSpeed, DRIVE.maxSpeed);
  me.distance += me.speed * dt;

  /* --- yanal: şerit merkezine yay, hız tavanıyla sınırlı ---------------- */
  const goal = laneX(me.targetLane);
  const delta = goal - me.x;
  const desired = THREE.MathUtils.clamp(
    delta * DRIVE.laneSnap, -DRIVE.laneChangeSpeed, DRIVE.laneChangeSpeed
  );
  me.lateral = THREE.MathUtils.damp(me.lateral, desired, DRIVE.steerResponse, dt);
  me.x += me.lateral * dt;
  me.lane = Math.round(me.x / CONFIG.laneWidth + (CONFIG.laneCount - 1) / 2);

  /* --- direksiyon sinyali ----------------------------------------------
     Ağırlıklı olarak gerçek yanal hızdan, biraz da basılı tuştan gelir.
     Tuş bırakılıp araç şeridine oturunca yanal hız sıfırlanır, dolayısıyla
     sinyal de kendiliğinden nötre lerp'lenir.                            */
  const keyInput = (input.left ? 1 : 0) - (input.right ? 1 : 0);
  const steerTarget = THREE.MathUtils.clamp(
    (me.lateral / DRIVE.laneChangeSpeed) * 0.85 + keyInput * 0.25, -1, 1
  );
  const steerRate = Math.abs(steerTarget) > Math.abs(me.steer) ? BODY.steerAttack : BODY.steerRelease;
  me.steer = THREE.MathUtils.damp(me.steer, steerTarget, steerRate, dt);

  /* --- gövde duruşu ----------------------------------------------------- */
  // Yatış: sağa dönüşte gövde dışa, yani SOLA yatar -> +Z dönüşü.
  const rollTarget = me.steer * BODY.rollMax;
  const rollRate = Math.abs(rollTarget) > Math.abs(me.roll) ? BODY.rollAttack : BODY.rollRelease;
  me.roll = THREE.MathUtils.damp(me.roll, rollTarget, rollRate, dt);

  // Savrulma: burun gerçek hız vektörünü takip eder (atan2), tavanla kısılır.
  const yawTarget = THREE.MathUtils.clamp(
    Math.atan2(me.lateral, Math.max(me.speed, 1)), -BODY.yawMax, BODY.yawMax
  );
  me.yaw = THREE.MathUtils.damp(me.yaw, yawTarget, BODY.yawRate, dt);

  // Dalış: frende burun aşağı, gazda hafif geri yatar.
  const pitchTarget = (input.brakeKey ? 1 : input.throttle ? -0.55 : 0) * BODY.pitchMax;
  me.pitch = THREE.MathUtils.damp(me.pitch, pitchTarget, BODY.pitchRate, dt);

  if (playerCar) {
    playerCar.position.set(me.x, 0, me.distance);
    playerCar.rotation.y = me.yaw;
    poseBody(playerCar, me.roll, me.pitch);
    driveWheels(playerCar, me.speed, me.steer, dt);
  }
}

function trafficZ(car, raceTime) {
  return car.z + car.speed * (raceTime - car.raceTime) / 1000;
}

function tickTraffic(raceTime, dt) {
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
    if (near && !car.obj) car.obj = spawnTrafficMesh(car.model, car.variant || 0);
    else if (!near && car.obj) { releaseTrafficMesh(car.obj); car.obj = null; }

    if (car.obj) {
      car.obj.position.set(car.laneX, 0, z);
      driveWheels(car.obj, car.speed, 0, dt);
      visible++;
    }
    car.lastZ = z;
  }
  el.trafficCount.textContent = String(visible);
}

function checkCollisions(raceTime) {
  const me = G.me;
  if (me.crashed || me.finished || G.phase !== 'racing') return;

  const myHalfW = CAR.halfWidth * CAR.hitScaleX;
  const myHalfL = CAR.halfLength * CAR.hitScaleZ;

  for (const car of G.traffic.values()) {
    const z = car.lastZ ?? trafficZ(car, raceTime);
    const hit = hitFor(car.model);
    const dz = z - me.distance;
    if (Math.abs(dz) > hit.halfLength + myHalfL) continue;
    if (Math.abs(car.laneX - me.x) > hit.halfWidth + myHalfW) continue;
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
  feed('KAZA YAPTIN', 'bad');
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
    // Paketler kesilirse kısa süre ekstrapole et.
    const a = buf[0];
    const ahead = THREE.MathUtils.clamp((renderAt - a.t) / 1000, 0, 0.4);
    x = a.x;
    distance = a.distance + a.speed * ahead;
  }

  const prevX = G.rival.x;
  G.rival.x = x;
  G.rival.distance = distance;

  // Hayaletin yanal hızını yumuşat: ham fark ağ titremesiyle sıçrar.
  const drift = (x - prevX) / Math.max(dt, 1e-3);
  G.rival.lateral = THREE.MathUtils.damp(G.rival.lateral, drift, 8, dt);

  const steerTarget = THREE.MathUtils.clamp(G.rival.lateral / DRIVE.laneChangeSpeed, -1, 1);
  G.rival.steer = THREE.MathUtils.damp(G.rival.steer, steerTarget, BODY.steerRelease, dt);

  rivalCar.position.set(x, 0, distance);
  rivalCar.rotation.y = THREE.MathUtils.clamp(
    Math.atan2(G.rival.lateral, Math.max(G.rival.speed, 1)), -BODY.yawMax, BODY.yawMax
  );
  poseBody(rivalCar, G.rival.steer * BODY.rollMax, 0);
  driveWheels(rivalCar, G.rival.speed, G.rival.steer, dt);

  // Uzaktayken hayaleti sil ki trafiği gizlemesin.
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
  // Virajda kamerayı da azıcık yatır — dönüşü ekranda hissettirir.
  camera.rotation.z = THREE.MathUtils.damp(camera.rotation.z, -me.steer * 0.028, 6, dt);

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
    heading: G.me.yaw,
  });
}

function frame() {
  requestAnimationFrame(frame);
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.033);
  const now = performance.now();

  fpsAcc += dt; fpsFrames++;
  if (fpsAcc >= 0.5) {
    el.fps.textContent = String(Math.round(fpsFrames / fpsAcc));
    fpsAcc = 0; fpsFrames = 0;
  }

  if (G.phase === 'countdown') {
    updateCountdown();
    // Emniyet kemeri: match:start gecikir ya da düşerse saate göre başla.
    if (net.now() - G.startAt > 300) startRacing();
  }

  if (G.phase === 'racing' || G.phase === 'over') {
    G.raceTime = net.now() - G.startAt;
    holdSteer(now);
    tickPlayer(dt);
    tickTraffic(G.raceTime, dt);
    checkCollisions(G.raceTime);
    tickRival(dt);
    sendState(now);
    updateHUD();
  }

  updateRoad(G.me.distance);

  // Sabit zaman adımıyla kamera/shake güncelle; düşen FPS'te dt büyüyüp
  // titreşimi büyütmesin diye adım sayısı sınırlı, kalan pay bir sonraki kareye taşınır.
  camAccumulator = Math.min(camAccumulator + dt, CAM_MAX_CATCHUP);
  while (camAccumulator >= CAM_FIXED_DT) {
    tickCamera(CAM_FIXED_DT);
    camAccumulator -= CAM_FIXED_DT;
  }

  renderer.render(scene, camera);
}

/* ============================== geri sayım ============================= */

let lastCount = null;

function updateCountdown() {
  const left = G.startAt - net.now();
  const n = Math.ceil(left / 1000);

  if (left <= 0) {
    if (lastCount !== 'GO') {
      lastCount = 'GO';
      el.countNumber.textContent = 'BAŞLA!';
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

/* ================================ girdi ================================ */

function laneShift(dir) {
  if (G.phase !== 'racing' || G.me.crashed || G.me.finished) return;
  G.me.targetLane = THREE.MathUtils.clamp(G.me.targetLane + dir, 0, CONFIG.laneCount - 1);
  laneRepeatAt = performance.now() + DRIVE.laneRepeatMs;
}

/** Tuşu basılı tutmak şerit şerit kaydırır — tek tek tıklamak gerekmez. */
function holdSteer(now) {
  const dir = (input.left ? 1 : 0) - (input.right ? 1 : 0);
  if (!dir || now < laneRepeatAt) return;
  laneShift(dir);
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code.startsWith('Arrow')) e.preventDefault();
  if (e.repeat) return;
  switch (e.code) {
    case 'KeyA': case 'ArrowLeft':  input.left = true;  laneShift(1);  break;
    case 'KeyD': case 'ArrowRight': input.right = true; laneShift(-1); break;
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

// dokunmatik: sol/sağ yarıya dokun şerit değiştir, basılı tut gaz ver
let touchStart = null;
canvas.addEventListener('touchstart', (e) => {
  touchStart = { x: e.touches[0].clientX, t: Date.now() };
  input.throttle = true;
}, { passive: true });
canvas.addEventListener('touchend', (e) => {
  input.throttle = false;
  if (!touchStart) return;
  const dx = (e.changedTouches[0].clientX - touchStart.x);
  if (Math.abs(dx) > 28) laneShift(-Math.sign(dx));
  else if (Date.now() - touchStart.t < 220) laneShift(touchStart.x < innerWidth / 2 ? 1 : -1);
  touchStart = null;
}, { passive: true });

/* ============================== lobi arayüzü =========================== */

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
      ? (p.id === G.youId ? `${p.name} (sen)` : p.name)
      : 'Bekleniyor…';
    const state = slot.querySelector('.pstate');
    state.textContent = p ? (p.ready ? 'Hazır' : 'Hazır Değil') : '';
    state.classList.toggle('ready', !!(p && p.ready));
  });

  const me = room.players.find((p) => p.id === G.youId);
  G.ready = !!(me && me.ready);
  el.btnReady.textContent = G.ready ? 'Bekleniyor…' : 'Hazır';
  el.btnReady.classList.toggle('is-ready', G.ready);
  el.btnReady.disabled = room.players.length < 2;

  el.lobbyStatus.textContent = room.players.length < 2
    ? 'Davet bağlantısını paylaş — iki oyuncu da hazır olunca yarış başlar.'
    : (G.ready ? 'Rakip Bekleniyor...' : 'İki araç da gridde. Hazır ol!');

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
      toast(res ? res.message : 'Sunucuya ulaşılamadı.', 'err');
      show(el.lobbyEntry, true);
      show(el.lobbyRoom, false);
      history.replaceState(null, '', '/');
      return;
    }
    G.youId = res.you.id;
    net.offset = res.serverTime - Date.now();
    net.synced = true;
    renderRoom(res.room);
    enterRoomView();
    history.replaceState(null, '', res.inviteUrl);
  });
}

el.btnCreate.addEventListener('click', () => joinRoom(null));

el.joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = el.joinCode.value.trim().toUpperCase();
  if (code.length !== 6) { toast('Oda kodu 6 karakter olmalı.', 'err'); return; }
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
  el.copyText.textContent = 'Kopyalandı!';
  toast('Davet bağlantısı kopyalandı', 'ok');
  setTimeout(() => (el.copyText.textContent = 'Bağlantıyı Kopyala'), 1600);
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
    el.rematchStatus.textContent = 'Rakip Bekleniyor...';
  });
});

el.btnQuit.addEventListener('click', () => {
  show(el.gameover, false);
  show(el.hud, false);
  enterRoomView();
});

/* ========================== soket olay işleyicileri ==================== */

socket.on('connect', () => {
  syncClock();
  if (G.phase === 'boot') return;   // modeller hâlâ yükleniyor, katılım sonra
  if (!G.roomCode) show(el.lobbyEntry, true);
});

socket.on('disconnect', () => {
  toast('Sunucu bağlantısı kesildi.', 'err');
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
  toast(`${p.name} odaya katıldı`, 'ok');
});

socket.on('room:playerLeft', (p) => {
  toast(`${p.name} odadan ayrıldı`, 'err');
  G.rival.visible = false;
  if (rivalCar) rivalCar.visible = false;
});

socket.on('match:countdown', (data) => {
  CONFIG = { ...CONFIG, ...data.config };
  G.seed = data.seed;
  G.startAt = data.startAt;
  // Bu paketle gelen zaman çiftini taze bir saat düzeltmesi olarak kabul et.
  net.offset = data.serverTime - Date.now();
  net.synced = true;

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
    speed: evt.speed,
    model: TRAFFIC_MODELS.includes(evt.model) ? evt.model : TRAFFIC_MODELS[0],
    variant: evt.variant, raceTime: evt.raceTime, obj: null,
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
  feed(`Rakip Kaza Yaptı — ${p.distance} m`, 'good');
});

socket.on('player:finished', (p) => {
  if (p.id === G.youId) {
    G.me.finished = true;
    feed('BİTİŞ!', 'good');
  } else {
    feed(`${p.name} bitiş çizgisini geçti`, 'bad');
  }
});

socket.on('match:over', (data) => {
  G.phase = 'over';
  const won = data.winnerId && data.winnerId === G.youId;
  const meResult = data.results.find((r) => r.id === G.youId);

  el.resultTitle.textContent = data.winnerId ? (won ? 'KAZANDIN!' : 'KAYBETTİN!') : 'BERABERE';
  el.resultTitle.className = `result-title ${data.winnerId ? (won ? 'win' : 'lose') : ''}`;

  // "Kaza Yaptın" / "Rakip Kaza Yaptı" — kaybın sebebini net söyle.
  let sub = {
    finish: 'Damalı bayrak.',
    'all-out': 'İki araç da kaza yaptı.',
    'opponent-left': 'Rakibinin bağlantısı koptu.',
  }[data.reason] || '';
  if (data.reason === 'crash') sub = meResult && meResult.crashed ? 'Kaza Yaptın' : 'Rakip Kaza Yaptı';
  el.resultSub.textContent = sub;

  el.resultList.innerHTML = '';
  data.results.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = [
      r.id === G.youId ? 'is-you' : 'is-rival',
      r.id === data.winnerId ? 'is-winner' : '',
    ].join(' ');
    const status = r.finished ? `${(r.finishTime / 1000).toFixed(2)} sn`
      : r.crashed ? 'kaza' : 'hayatta';
    li.innerHTML =
      `<span class="rk">${i + 1}</span>` +
      `<span class="nm">${r.name}${r.id === G.youId ? ' (sen)' : ''}</span>` +
      `<span class="st">${r.distance} m · ${status} · ${r.score} G</span>`;
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
    el.rematchStatus.textContent = 'Rakibin yeniden oynamak istiyor!';
    toast('Rakip yeniden oynamaya hazır', 'ok');
  }
});

socket.on('room:error', ({ message }) => toast(message, 'err'));

/* ================================ açılış =============================== */

async function boot() {
  buildRoad();

  const gltfs = {};
  await Promise.all(
    LOAD_KEYS.map(async (k) => { gltfs[k] = await loadGLTF(MODELS[k]); })
  );
  for (const k of LOAD_KEYS) progress[k] = 1;
  setLoadProgress();

  // Ağır birleştirme adımından önce yükleme çubuğunun boyanmasına izin ver.
  await new Promise((r) => setTimeout(r, 30));

  for (const k of LOAD_KEYS) {
    prefabs[k] = buildPrefab(gltfs[k], MODELS[k], { dropInterior: true });
  }

  // Trafik çarpışma kutuları modelin gerçek ölçüsünden türetilir; iki istemci
  // de aynı modelden aynı sayıyı hesaplar, yani çarpışmalar da senkron kalır.
  for (const name of TRAFFIC_MODELS) {
    const u = prefabs[name].userData;
    trafficHit.set(name, {
      halfWidth: Math.min(u.width * 0.5 * 0.80, 1.0),
      halfLength: u.length * 0.5 * 0.92,
    });
  }

  playerCar = instantiate(prefabs.player, { paint: COLORS.you, underglow: COLORS.you });
  rivalCar = instantiate(prefabs.player, { paint: COLORS.rival, underglow: COLORS.rival, lod: true });
  rivalCar.visible = false;
  world.add(playerCar, rivalCar);

  resetRace();
  frame();

  show(el.loading, false);
  show(el.lobby, true);

  // Davet bağlantıları doğrudan odaya düşer.
  const code = new URLSearchParams(location.search).get('room');
  G.phase = 'lobby';
  if (code && /^[A-Z0-9]{6}$/i.test(code)) {
    show(el.lobbyEntry, false);
    show(el.lobbyRoom, true);
    el.lobbyStatus.textContent = 'Odaya katılınıyor…';
    joinRoom(code.toUpperCase());
  }
}

boot().catch((err) => {
  console.error(err);
  el.loadLabel.textContent = 'Oyun dosyaları yüklenemedi. Konsolu kontrol et.';
  toast('Varlıklar yüklenemedi — konsola bak.', 'err');
});
