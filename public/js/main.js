/* =====================================================================
   Claude for Speed — istemci giriş noktası
   ---------------------------------------------------------------------
   Dünya düzeni:
     +Z = gidiş yönü (bir aracın "mesafe"si aslında onun z değeridir)
     +X = sağ, +Y = yukarı, zemin y = 0 düzleminde, birim metredir.

   Determinizm: trafiği sunucu yönetir. Her aracın konumu, sunucunun
   yayınladığı spawn olayının ve paylaşılan yarış saatinin saf bir
   fonksiyonudur:
       z(t) = spawn.z + spawn.speed * (t - spawn.raceTime)
   böylece iki istemci trafiği hiç senkronize etmeden aynı yolu çizer.

   ---------------------------------------------------------------------
   MODÜL HARİTASI (eski tek dosyalık `public/game.js`'in bölünmüş hâli;
   game.js yedek olarak yerinde duruyor, artık yüklenmiyor):

     config.js       sabitler, model kayıtları, sürüş/nitro/kamera ayarları
     dom.js          arayüz düğüm önbelleği + toast / feed
     state.js        paylaşılan oyun durumu (G, input)
     scene.js        renderer, sahne, kamera, ışıklar, yol, alt sistem bağları
     loader.js       GLTF/DRACO hattı, prefab kurulumu, örnekleme, animasyon
     garage-link.js  garaj seçimi -> sürüş sabitleri + pistteki araçlar
     traffic.js      trafik havuzu, konum, çarpışma
     player.js       fizik, hız eğrisi, jetonlar, kamera, HUD, kontroller
     network.js      socket.io saat/oda/maç olayları, hayalet, geri sayım
     main.js         açılış sırası, varlık yükleme ve oyun döngüsü (bu dosya)

   Modül grafiğinde `network -> player -> traffic -> network` şeklinde tek
   bir halka var (socket ile fizik birbirini çağırıyor). Hiçbir modülün ÜST
   DÜZEY kodu halkanın karşı tarafından bir bağ OKUMADIĞI için değerlendirme
   sırası güvenlidir; karşılıklı erişimlerin hepsi fonksiyon gövdelerinde,
   yani her iki modül de değerlendikten sonra gerçekleşir.
   ===================================================================== */

import * as THREE from 'three';

import { SceneryField, buildBuildingPrefabs, buildFallbackPrefabs } from './scenery.js';
import { Atmosphere } from './atmosphere.js';
import { Fx } from './fx.js';
import { buildProceduralPrefab } from './vehicles.js';
import { GarageScreen } from './garage-ui.js';
import { garage, VEHICLE_BY_ID } from './garage.js';

import {
  DEBUG, CONFIG, MODELS, SCENERY_MODEL, TRAFFIC_MODELS, ESSENTIAL_KEYS, DRIVE, NITRO,
} from './config.js';
import { el, show, toast } from './dom.js';
import { G, input } from './state.js';
import {
  renderer, scene, camera, world, hemi, key, rim,
  buildRoad, updateRoad, laneX, bindWorldSystems, applyEnvironment,
  atmosphere, scenery, fx, setAtmosphere, setScenery, setFx,
} from './scene.js';
import {
  LOAD_KEYS, prefabs, progress, loadGLTF, buildPrefab, measureLift,
  paintLoadBar, setLoadProgress, setBarKeys, setTrafficReady, setAssetsReady,
} from './loader.js';
import {
  playerCar, rivalCar, garageScreen, setGarageScreen,
  makeCar, rebuildCars, applyLoadout, refreshLobbyLoadout,
  loadoutChanged, closeGarage,
} from './garage-link.js';
import { trafficHit, tickTraffic, checkCollisions } from './traffic.js';
import {
  resetRace, startRacing, tickPlayer, tickCamera, updateHUD,
  holdSteer, laneShift, checkNearMiss, tickPickups, coinField,
} from './player.js';
import {
  net, sendState, sendLoadout, joinRoom, tickRival, updateCountdown,
} from './network.js';

/* ============================== çizim ================================== */

const clock = new THREE.Clock();
let fpsAcc = 0, fpsFrames = 0;

// Kamera her zaman sabit adımlarla güncellenir; düşük FPS'te büyük/dengesiz
// dt sıçramaları shake/lerp hesaplarını titretmesin diye (frame-rate bağımsız).
const CAM_FIXED_DT = 1 / 60;
const CAM_MAX_CATCHUP = CAM_FIXED_DT * 5; // "spiral of death" birikmesini önler
let camAccumulator = 0;

function frame() {
  requestAnimationFrame(frame);
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.033);
  const now = performance.now();

  // FPS sayacı KIRPILMAMIŞ dt ile beslenir. `dt` 33 ms'de sınırlı olduğu için
  // onunla hesaplamak, oyun 5 fps'e düşse bile ekranda hep "30" yazdırırdı —
  // yani sayaç tam da işe yarayacağı anda kör kalırdı.
  fpsAcc += rawDt; fpsFrames++;
  if (fpsAcc >= 0.5) {
    el.fps.textContent = String(Math.round(fpsFrames / fpsAcc));
    fpsAcc = 0; fpsFrames = 0;
  }

  // Garaj açıkken ana sahne hiç çizilmez: tek maliyet önizleme penceresidir.
  if (garageScreen && garageScreen.open) {
    garageScreen.renderFrame(dt);
    return;
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
    checkNearMiss(G.raceTime, now);
    tickPickups(dt);
    tickRival(dt);
    sendState(now);
    updateHUD();
  }

  updateRoad(G.me.distance);
  if (scenery) scenery.update(G.me.distance);
  if (atmosphere) atmosphere.update(dt, { distance: G.me.distance, speed: G.me.speed });
  if (fx) fx.update(dt);

  // Sabit zaman adımıyla kamera/shake güncelle; düşen FPS'te dt büyüyüp
  // titreşimi büyütmesin diye adım sayısı sınırlı, kalan pay bir sonraki kareye taşınır.
  camAccumulator = Math.min(camAccumulator + dt, CAM_MAX_CATCHUP);
  while (camAccumulator >= CAM_FIXED_DT) {
    tickCamera(CAM_FIXED_DT);
    camAccumulator -= CAM_FIXED_DT;
  }

  renderer.render(scene, camera);
}

/* ---------------------------- garaj olayları --------------------------- */

// Garajda yapılan her değişiklik anında sürüşe, lobiye ve rakibe yansısın.
garage.subscribe(() => {
  applyLoadout();
  refreshLobbyLoadout();
  sendLoadout();

  // Garaj AÇIKKEN pistteki aracı yeniden kurmuyoruz: önizleme kendi modelini
  // yönetiyor ve renk sürgüsü saniyede onlarca olay üretiyor. Kapanışta
  // `onClose` zaten kuruyor. Diğer her yol (kaydedilmiş durumun yüklenmesi,
  // konsol/otomasyon, ileride eklenecek hızlı seçim) buradan yakalanır.
  if (garageScreen && garageScreen.open) return;
  if (loadoutChanged()) rebuildCars();
});

/* ================================ açılış =============================== */

/**
 * Manzara modelini yükler ve bina prefablarını kurar.
 *
 * Bu adım ASLA açılışı düşürmez: dosya 404 verse, bozuk olsa ya da GPU
 * bellek ayıramasa bile `buildFallbackPrefabs()` devreye girip kanvasla
 * üretilmiş pencereli kutu binalarla aynı arayüzü sağlar. Yarış her
 * durumda başlar.
 */
async function loadScenery() {
  try {
    const gltf = await loadGLTF(SCENERY_MODEL);
    const built = buildBuildingPrefabs(gltf);
    if (!built.length) throw new Error('modelde bina bulunamadı');
    if (DEBUG) console.log(`[manzara] ${built.length} bina prefabı hazır`);
    return built;
  } catch (err) {
    console.warn('[manzara] new_york_buildings.glb yüklenemedi, yedek geometriye düşülüyor', err);
    toast('Bina modeli yüklenemedi — basit siluetlere geçildi.', 'err');
    return buildFallbackPrefabs();
  } finally {
    progress.scenery = 1;
    setLoadProgress();
  }
}

/**
 * Trafik modelleri, seçilmemiş oyuncu aracı ve manzara — lobiye hiçbir
 * oyunun bunlara ihtiyacı olmadan girilebilir. Arka planda paralel iner;
 * bitince araçları (varsa) geriye doldurur ve manzarayı bağlar.
 */
function loadDeferredAssets(keys) {
  // Manzara kimseyi bloklamaz: indiği anda kendi kendine sahneye girer.
  loadScenery().then((sceneryPrefabs) => {
    setScenery(new SceneryField(sceneryPrefabs, world));
    bindWorldSystems();
  });

  // Trafik + ertelenmiş araçlar: hepsi aynı anda iner, her biri kendi
  // indirmesi biter bitmez prefab'a dönüşür (ağ ile CPU örtüşür).
  const ready = Promise.all(keys.map(async (k) => {
    try {
      const gltf = await loadGLTF(MODELS[k]);
      prefabs[k] = buildPrefab(gltf, MODELS[k], { dropInterior: true });
    } catch (err) {
      console.warn(`[model] ${MODELS[k].url} yüklenemedi`, err);
      buildFallbackFor(k);
    }
    progress[k] = 1;
    setLoadProgress();
  })).then(() => {
    // Trafik çarpışma kutuları modelin gerçek ölçüsünden türetilir; iki istemci
    // de aynı modelden aynı sayıyı hesaplar, yani çarpışmalar da senkron kalır.
    for (const name of TRAFFIC_MODELS) {
      if (!prefabs[name]) continue;
      const u = prefabs[name].userData;
      trafficHit.set(name, {
        halfWidth: Math.min(u.width * 0.5 * 0.80, 1.0),
        halfLength: u.length * 0.5 * 0.92,
      });
    }
    // Rakip/oyuncu ertelenmiş bir model bekliyorduysa şimdi tamamla.
    if (loadoutChanged()) rebuildCars();
  });

  setTrafficReady(ready);
  setAssetsReady(ready);
  return ready;
}

/**
 * Bir .glb indirilemediğinde devreye giren yedek: o modeli kullanan aracın
 * `proc` tarifi varsa prosedürel gövdesini kurar. Normal akışta ÇAĞRILMAZ —
 * garajdaki araçların hepsi gerçek modeli gösterir.
 */
function buildFallbackFor(modelKey) {
  for (const v of Object.values(VEHICLE_BY_ID)) {
    if (v.model !== modelKey || !v.proc || prefabs[v.id]) continue;
    prefabs[v.id] = buildProceduralPrefab(v.proc, { measureLift });
    toast(`${v.name} modeli inemedi — basit gövdeye geçildi.`, 'err');
  }
}

async function boot() {
  buildRoad();

  // Sadece ilk karede görünecek modeller senkron: seçili oyuncu aracı ve
  // varsayılan rakip (bmw -> 'player'). Trafik ve manzara arka planda iner.
  // ESSENTIAL_KEYS config.js'te hesaplandı — <link rel=preload> ile aynı liste.
  const essentialKeys = ESSENTIAL_KEYS;
  const deferredKeys = LOAD_KEYS.filter((k) => !essentialKeys.includes(k));

  // Çubuk yalnız bu iki dosyayı ölçer, böylece gerçekten %100'e ulaşır ve
  // lobiye geçiş anında olur (eskiden %37'de kesilip atlıyordu).
  setBarKeys(essentialKeys);
  setLoadProgress();

  await Promise.all(essentialKeys.map(async (k) => {
    try {
      const gltf = await loadGLTF(MODELS[k]);
      prefabs[k] = buildPrefab(gltf, MODELS[k], { dropInterior: true });
    } catch (err) {
      // Tek bir model inemedi diye açılış düşmesin: o aracın prosedürel
      // yedeği varsa ona düş, yoksa prefabFor() başka bir modele kayar.
      console.warn(`[model] ${MODELS[k].url} yüklenemedi`, err);
      buildFallbackFor(k);
    }
    progress[k] = 1;
    setLoadProgress();
  }));

  // Prosedürel araçlar: indirilecek dosyası olmayan araçlar (şu an yok —
  // garajdaki her araç gerçek modeli kullanıyor).
  for (const v of Object.values(VEHICLE_BY_ID)) {
    if (v.body !== 'proc') continue;
    prefabs[v.id] = buildProceduralPrefab(v.proc, { measureLift });
  }

  // Trafik + manzara + ertelenmiş araç modelini arka planda başlat; lobiyi
  // bunların bitmesini beklemeden gösteriyoruz.
  setAssetsReady(loadDeferredAssets(deferredKeys));

  /* --- alt sistemler --------------------------------------------------- */
  const atmo = new Atmosphere({ scene, renderer, camera, hemi, key, rim });
  setAtmosphere(atmo);

  /* Sis tamamen kaldırıldı; `Atmosphere._apply()` artık `scene.fog`'u null
     tutuyor. Arka plan / ufuk rengi ön ayarla güncellenmeye devam eder. */
  atmo._apply();

  setFx(new Fx(world, el.speedlines));

  rebuildCars();
  if (rivalCar) rivalCar.visible = false;

  bindWorldSystems();
  applyEnvironment(true);

  applyLoadout();
  refreshLobbyLoadout();
  resetRace();
  frame();

  // Çekirdek varlıklar hazır: çubuğu rAF beklemeden %100'e yaz ve geç.
  paintLoadBar();
  show(el.loading, false);
  show(el.lobby, true);

  // Garaj ekranı ilk karede görünmez; kurulumu lobiyi bekletmesin.
  // (openGarage() zaten hazır değilse kibarca uyarıyor.)
  setGarageScreen(new GarageScreen({
    renderer,
    // Garaj önizlemesi pistteki araçla AYNI kurulum hattını kullanır —
    // orada gördüğün boya, cam filmi ve jant yarışta birebir aynı çıkar.
    makeCar: (vehicleId, look) => makeCar(vehicleId, look, { lod: false }),
    onEnvironmentChange: () => applyEnvironment(),
    onClose: () => {
      closeGarage();
      refreshLobbyLoadout();
      if (loadoutChanged()) rebuildCars();
    },
  }));

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

/* ============================ hata ayıklama ============================ */

/* `?debug=1` ile açılan test kancası. Otomatik duman testleri (headless
   tarayıcı) tek başına bir yarış başlatıp manzara/parçacık/atmosfer
   yollarının gerçekten çalıştığını buradan doğruluyor. Normal oyunda bu
   nesne hiç oluşturulmaz. */
if (DEBUG) {
  window.__cfs = {
    G, DRIVE, NITRO, CONFIG,

    /** Sunucusuz, tek kişilik bir yarış başlatır. */
    startSolo(seed = 12345) {
      G.seed = seed;
      G.startAt = net.now();
      show(el.lobby, false);
      show(el.gameover, false);
      show(el.countdown, false);
      buildRoad();
      bindWorldSystems();
      applyEnvironment(true);
      resetRace();

      // Seyrek trafik: sıyırma ve çarpışma yolları çalışsın ama koşu
      // ilk 100 metrede bitmesin diye yalnızca dış şeritlerde.
      let id = 1;
      for (let z = 160; z < 3000; z += 130) {
        G.traffic.set(id, {
          id, lane: id % 2 ? 0 : CONFIG.laneCount - 1,
          laneX: laneX(id % 2 ? 0 : CONFIG.laneCount - 1),
          z, speed: 22, model: TRAFFIC_MODELS[id % TRAFFIC_MODELS.length],
          variant: id % 4, raceTime: 0, obj: null,
        });
        id++;
      }
      startRacing();
    },

    setEnv(envId, immediate = false) { if (atmosphere) atmosphere.set(envId, immediate); },

    /** Sahnedeki araçların gerçekten hangi detay seviyesinde çizildiğini raporlar. */
    cars() {
      const scan = (root, label) => {
        if (!root) return { label, missing: true };
        let meshes = 0, tris = 0, lods = 0;
        const mats = new Set();
        root.traverse((o) => {
          if (o.isLOD) lods++;
          if (!o.isMesh || !o.geometry) return;
          meshes++;
          const g = o.geometry;
          tris += (g.index ? g.index.count : (g.getAttribute('position')?.count || 0)) / 3;
          mats.add(o.userData.materialName || (o.material && o.material.name) || '?');
        });
        return {
          label, vehicle: root.userData.vehicleId, visible: root.visible,
          meshes, tris: Math.round(tris), lods, materials: mats.size,
          wheels: (root.userData.wheels || []).length,
          z: Math.round(root.position.z),
        };
      };
      return [scan(playerCar, 'player'), scan(rivalCar, 'rival')];
    },

    /**
     * Oyun mantığını SABİT adımlarla, çizimden bağımsız olarak ilerletir.
     *
     * Yazılım rasterleştirici (headless CI) altında gerçek kare hızı 1-2 fps'e
     * düşüyor; sürüş fiziğini gerçek zamanda test etmek imkânsız hale geliyor.
     * Bu yardımcı, aynı tick fonksiyonlarını 60 Hz'lik sanal bir saatle
     * çağırarak mesafe / nitro / jeton / sıyırma yollarının doğruluğunu
     * çizim hızından bağımsız olarak ölçülebilir kılar.
     */
    drive({ seconds = 5, throttle = true, nitro = false, weave = 0 } = {}) {
      const dt = 1 / 60;
      const steps = Math.round(seconds / dt);
      G.phase = 'racing';
      input.throttle = throttle;
      input.nitro = nitro;
      for (let i = 0; i < steps; i++) {
        if (weave && i % Math.round(weave / dt) === 0) {
          laneShift(G.me.targetLane <= 0 ? 1 : -1);
        }
        G.raceTime = i * dt * 1000;
        tickPlayer(dt);
        tickTraffic(G.raceTime, dt);
        checkNearMiss(G.raceTime, i * dt * 1000);
        tickPickups(dt);
        if (scenery) scenery.update(G.me.distance);
      }
      input.throttle = false;
      input.nitro = false;
      return this.snapshot();
    },

    snapshot() {
      const info = renderer.info.render;
      let sceneryInstances = 0;
      if (scenery) for (const row of scenery.meshes) if (row[0]) sceneryInstances += row[0].count;
      return {
        phase: G.phase,
        vehicle: garage.selected,
        env: atmosphere ? atmosphere.id : null,
        distance: Math.round(G.me.distance),
        speedKph: Math.round(G.me.speed * 3.6),
        topSpeedKph: Math.round(DRIVE.maxSpeed * 3.6),
        nitro: Number(G.me.nitro.toFixed(2)),
        purse: {
          distance: Math.round(G.purse.distance),
          pickups: G.purse.pickups,
          nearMiss: G.purse.nearMiss,
        },
        coins: garage.coins,
        traffic: G.traffic.size,
        sceneryInstances,
        coinsOnRoad: coinField ? coinField.count : 0,
        drawCalls: info.calls,
        triangles: info.triangles,
        fps: Number(el.fps.textContent),
      };
    },
  };
}
