/* =====================================================================
   scene.js — renderer, sahne, kamera, ışıklar ve yol
   ---------------------------------------------------------------------
   `game.js`'teki "renderer" ve "yol" bölümlerinin birebir karşılığı,
   artı boot() içinde kurulan alt sistemlerin (atmosfer / manzara / fx)
   paylaşılan tutamakları.

   Alt sistemler burada yaşar çünkü hepsi SAHNEYE aittir ve neredeyse
   her modül onlara erişir. `game.js` bunları modül kapsamında `let` ile
   tutuyordu; ES modüllerinde dışa aktarılan bağlar salt okunur olduğu
   için atama `setAtmosphere()/setScenery()/setFx()` üzerinden yapılır.
   Okuma tarafı canlı bağ sayesinde birebir aynı çalışır.
   ===================================================================== */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { CONFIG, COLORS, VIEW } from './config.js';
import { G } from './state.js';
import { garage } from './garage.js';
import { pickEnvironment } from './atmosphere.js';

/* ============================== renderer =============================== */

export const canvas = document.getElementById('scene');

export const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, powerPreference: 'high-performance', stencil: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.0));
renderer.shadowMap.enabled = false;
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1220);
/* Sis tamamen kapalı. Ham, arcade bir görüntü isteniyor: uzak siluetler,
   ufuk ve arka plan hiçbir mesafede solmaz, çizim ufku ne gösteriyorsa
   net gösterir. `boot()` içinde atmosfer kurulurken de kilitli tutulur —
   ortam ön ayarları (gece/yağmur/gün batımı) sisi geri getiremez. */
scene.fog = null;

export const camera = new THREE.PerspectiveCamera(VIEW.fovBase, innerWidth / innerHeight, 0.4, 1400);
camera.position.set(0, VIEW.camHeight, -VIEW.camBack);

/* Stüdyo benzeri IBL — böylece boya ve krom gerçekten metal gibi okunur. */
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.06).texture;
  pmrem.dispose();
}

export const hemi = new THREE.HemisphereLight(0x8fc6ff, 0x0a0e18, 1.15);
scene.add(hemi);

export const key = new THREE.DirectionalLight(0xdbe9ff, 1.5);
key.position.set(-40, 70, 40);
scene.add(key);

export const rim = new THREE.DirectionalLight(0xff5fa2, 0.55);
rim.position.set(30, 18, -50);
scene.add(rim);

/* Alt sistemler. Hepsi boot() içinde kurulur; burada yalnızca bildiriliyorlar
   ki `instantiate()` gibi erken tanımlanan fonksiyonlar onlara erişebilsin. */
/** @type {import('./atmosphere.js').Atmosphere|null} */
export let atmosphere = null;
/** @type {import('./scenery.js').SceneryField|null} */
export let scenery = null;
/** @type {import('./fx.js').Fx|null} */
export let fx = null;

export function setAtmosphere(v) { atmosphere = v; }
export function setScenery(v) { scenery = v; }
export function setFx(v) { fx = v; }

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* ============================ GPU ön ısıtma ============================
   Bir malzeme sahneye girdikten sonra İLK ÇİZİLDİĞİ karede iki pahalı iş
   yapılır: shader programı derlenir (sürücüye göre 5-40 ms) ve dokuları
   GPU'ya yüklenir (2K bir PBR seti için onlarca ms). Trafik aracı yarışın
   ortasında doğduğu için bu maliyet doğrudan kare süresine biniyordu —
   "trafik doğunca takılma" tam olarak buydu.

   Ön ısıtma ikisini de yarış başlamadan, yükleme ekranındayken yaptırır.
   Havuzdaki araçlar `visible = false` olsa bile ısınır: `renderer.compile`
   malzemeleri `traverse` ile toplar, `traverseVisible` ile değil. */
const TEXTURE_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
  'alphaMap', 'bumpMap', 'displacementMap', 'lightMap', 'specularMap', 'envMap',
  'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
  'sheenColorMap', 'sheenRoughnessMap', 'iridescenceMap', 'transmissionMap',
];

/**
 * `root` altındaki her malzemenin dokularını yükler ve shader programlarını
 * derler. Işık / ortam / sis durumu HER ZAMAN gerçek sahneden okunur, yani
 * derlenen program yarışta kullanılacak programın birebir aynısıdır.
 *
 * @param {THREE.Object3D} [root]  ısıtılacak alt ağaç (öntanımlı: tüm sahne)
 * @returns {Promise<void>}        programlar kullanıma hazır olduğunda çözülür
 */
export function prewarm(root = scene) {
  // Dünya matrisleri güncel olmazsa derleme sırasında düğümler atlanabilir.
  scene.updateMatrixWorld(true);

  const seen = new Set();
  root.traverse((o) => {
    if (!o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      for (const slot of TEXTURE_SLOTS) {
        const tex = m[slot];
        if (!tex || !tex.isTexture) continue;
        // Tek tek sarmalanır: bozuk/boş bir doku bütün ısıtmayı düşürmesin.
        try { renderer.initTexture(tex); } catch (err) { /* yoksay */ }
      }
    }
  });

  try {
    if (typeof renderer.compileAsync === 'function') {
      // Ana iş parçacığını kilitlemez; KHR_parallel_shader_compile varsa
      // sürücü programları gerçekten paralel derler.
      return Promise.resolve(renderer.compileAsync(root, camera, scene));
    }
    renderer.compile(root, camera, scene);
  } catch (err) {
    console.warn('[sahne] ön ısıtma tamamlanamadı', err);
  }
  return Promise.resolve();
}

/* ================================= yol ================================= */

export const world = new THREE.Group();
scene.add(world);

export const road = {
  group: new THREE.Group(),
  surface: null,
  markings: null,
  barriers: [],
  poles: [],
  blocks: [],
  segmentLength: 400,
};
world.add(road.group);

export function roadWidth() { return CONFIG.laneCount * CONFIG.laneWidth; }
export function laneX(lane) { return (lane - (CONFIG.laneCount - 1) / 2) * CONFIG.laneWidth; }

/** Bir kez canvasa çizilip UV kaydırmasıyla akıtılan kesikli şerit çizgileri. */
function makeMarkingTexture() {
  const lanes = CONFIG.laneCount;
  const px = 256;                       // doku 20 m'lik tek bir döşemedir
  const c = document.createElement('canvas');
  c.width = px; c.height = px;
  const g = c.getContext('2d');
  // Taban asfalt tonu ORTA gri: atmosfer katmanı malzemenin `color` çarpanını
  // gündüz 1'e, gece ~0.3'e çekerek aynı dokudan hem parlak hem karanlık yol
  // üretebilsin. Doku baştan koyu olsaydı gündüz aydınlatılamazdı.
  g.fillStyle = '#3b4048'; g.fillRect(0, 0, px, px);

  // hafif asfalt taneciği
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`;
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

export function buildRoad() {
  road.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  road.group.clear();
  if (road.markings) road.markings.dispose();
  road.barriers.length = 0; road.poles.length = 0; road.blocks.length = 0;
  road.surfaceMaterials = [];
  road.lampMaterials = [];

  const w = roadWidth();
  const len = road.segmentLength * 2;

  road.markings = makeMarkingTexture();
  road.markings.repeat.set(1, len / 20);

  /* `envMapIntensity` BİLEREK 1'in altında: sahnenin IBL'i stüdyo kutusu
     (RoomEnvironment) ve tavanı beyaz. Yol yatay bir düzlem olduğu için
     yüksek bir şiddet, o beyaz tavanı aracın altında göz alan bir ışık
     havuzu olarak yansıtıyordu. Yolu aydınlatma işi hemisphere + directional
     ışıkların; IBL yalnızca hafif bir ortam katkısı veriyor.
     (Atmosfer ön ayarları da aynı sabiti yazar — bkz. atmosphere.js.) */
  const surfaceMat = new THREE.MeshStandardMaterial({
    map: road.markings, roughness: 0.92, metalness: 0.0, envMapIntensity: 0.6,
  });
  road.surface = new THREE.Mesh(new THREE.PlaneGeometry(w, len, 1, 1), surfaceMat);
  road.surface.rotation.x = -Math.PI / 2;
  road.group.add(road.surface);
  road.surfaceMaterials.push(surfaceMat);

  // banketler
  const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 1 });
  const shoulder = new THREE.Mesh(new THREE.PlaneGeometry(w + 26, len), shoulderMat);
  shoulder.rotation.x = -Math.PI / 2;
  shoulder.position.y = -0.04;
  road.group.add(shoulder);
  road.surfaceMaterials.push(shoulderMat);

  // bariyerler ve parlayan kenar şeritleri
  const railMat = new THREE.MeshStandardMaterial({ color: 0x39465e, roughness: 0.6, metalness: 0.35 });
  road.barrierMaterials = [railMat];
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.85, len), railMat);
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
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2c3548, roughness: 0.8 });
  const lampGeo = new THREE.BoxGeometry(1.6, 0.18, 0.5);
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
  road.lampMaterials.push(lampMat);
  road.barrierMaterials.push(poleMat);
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

  // Eski paralaks siluet blokları KALDIRILDI: yerlerini scenery.js'in
  // gerçek New York binaları aldı (bkz. SceneryField). İki sistem birlikte
  // çalışsaydı kutular binaların içinden geçerdi.

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

export function updateRoad(distance) {
  road.group.position.z = distance;
  road.markings.offset.y = -distance / 20;

  const spacing = 34;
  road.poles.forEach((g, i) => {
    const base = Math.floor((distance - 60) / spacing) * spacing;
    g.position.z = base + i * spacing / 2 - distance;
  });

  const toFinish = CONFIG.finishDistance - distance;
  road.gantry.visible = toFinish < 420 && toFinish > -30;
  if (road.gantry.visible) road.gantry.position.z = toFinish;
}

/* ========================= dünya alt sistemleri ======================== */

/** Yol her yarışta yeniden kurulduğu için atmosferin bağlarını tazeler. */
export function bindWorldSystems() {
  if (!atmosphere) return;
  atmosphere.bind({
    roadMaterials: road.surfaceMaterials,
    barrierMaterials: road.barrierMaterials,
    lampMaterials: road.lampMaterials,
    scenery,
    roadWidth: roadWidth(),
  });
  if (scenery) scenery.setRoadWidth(roadWidth() / 2 + 2.2);
}

/** Ortamı seç ve uygula. 'auto' ise yarış tohumundan türetilir. */
export function applyEnvironment(immediate = false) {
  G.env = pickEnvironment(garage.state.environment, G.seed);
  if (atmosphere) atmosphere.set(G.env, immediate);
}
