/* =====================================================================
   config.js — sabitler, model kayıtları ve sürüş ayarları
   ---------------------------------------------------------------------
   Bu modülün İÇİNDE oyun mantığı yoktur; sadece bütün alt sistemlerin tek
   bir kaynaktan okuduğu değerler durur. `game.js`'teki "sabitler" bölümünün
   birebir karşılığıdır.

   Dikkat: `CONFIG` sunucu tarafından üzerine yazılan TEK sabittir. ES modül
   dışa aktarımları salt okunur bağlar olduğu için yeniden atama burada,
   `mergeConfig()` üzerinden yapılır — okuyucular canlı bağ sayesinde her
   zaman en güncel nesneyi görür.
   ===================================================================== */

import * as THREE from 'three';
import { garage, VEHICLE_BY_ID } from './garage.js';

export const DEBUG = new URLSearchParams(location.search).has('debug');

export const THREE_VERSION = '0.161.0';
export const DRACO_CDN = `https://unpkg.com/three@${THREE_VERSION}/examples/jsm/libs/draco/`;
{
  // Decoder CDN'ine TLS el sıkışması .glb indirmeleriyle aynı anda başlasın.
  const pc = document.createElement('link');
  pc.rel = 'preconnect';
  pc.href = 'https://unpkg.com';
  pc.crossOrigin = 'anonymous';
  document.head.appendChild(pc);
}

/* Değerler gönderilen .glb dosyalarından ölçüldü. `faceYaw` her modeli
   burnu +Z'ye bakacak şekilde döndürür:
     BMW      — farlar z = -1.65, stoplar z = +1.94   -> 180° çevir
     ilkaraba — kaput z = +4.65, bagaj z = -3.18      -> zaten doğru
     npc1 — farlar x = -113, stoplar x = +194     -> +90° çevir (uzun eksen X)
     npc2 — beyaz far x = +2.63, kırmızı x = -2.74 -> -90° çevir (uzun eksen X)
     npc3 — kırmızı cam z = -0.02                 -> zaten doğru
   `paint` gövde boyası malzemesidir; düz bir renk değişimi temiz bir
   takım/trafik liveresi verir. */
export const MODELS = {
  player: {
    key: 'player',
    url: '/models/bmw_m3_competition.glb',
    faceYaw: Math.PI,
    paint: /^Material\.032$/,
    length: 4.72,
    weight: 0.374,          // yükleme çubuğundaki payı (indirme boyutuna göre)
    interiorSkin: 0.15,     // tam gövde kabuğu kalsın: bu araç ekranı doldurur
  },

  /* Başlangıç aracı — Şehir Hatchback. Artık kutu geometrisi değil, gerçek
     model: models/ilkaraba.glb (Sketchfab "Cartoon Car", CC-BY-4.0).
     Ölçüm: kabuk 7.90 × 5.02 × 12.53 birim, kaput +Z ucunda -> faceYaw = 0.
     Boya malzemesi `car_body`; modelde zaten KHR_materials_clearcoat var,
     yani garajdaki "Parlak" kaplama vernik katmanını gerçekten sürüyor. */
  ilkaraba: {
    key: 'ilkaraba',
    url: '/models/ilkaraba.glb',
    faceYaw: 0,
    paint: /^car_body$/,
    length: 4.05,           // hatchback: garajın en kısa aracı
    weight: 0.845,          // 10.7 MB — çubuktaki payı buna göre
    interiorSkin: 0.15,     // kabini olmayan model: hiçbir parçası atılmaz
    /* Karikatür oranları: teker çapı gövde boyunun %24'ü, genel eşiğin
       (%22) üstünde. Bu tavan yükseltilmezse dört teker de "tekerlek
       değil" sayılıp gövdeye kaynar — ne dönerler ne de direksiyon
       kırarlar. %26 dört tekerleği alır, tamponu/egzozu almaz. */
    wheelShape: { maxDiameter: 0.26 },
  },

  /* Garajdaki ikinci gerçek model — Spor Coupe.
     Ölçüm: farlar z = +1.90, stoplar z = -2.14  -> burun zaten +Z, çevirme yok. */
  skyline: {
    key: 'skyline',
    url: '/models/nissan_skyline_gtr_r35.glb',
    faceYaw: 0,
    paint: /^r35_paint$/,
    length: 4.71,
    weight: 0.151,
    interiorSkin: 0.14,
    // Kabin döşemesi, gösterge ekranları ve motor/turbo tesisatı: yarış
    // kamerasından görünmez ama örnek başına yüz binlerce üçgen tutar.
    dropMaterials: /^(r35_(leather|carpet|cloth|engine|display|gauges|steeringwheel|interior|screen)|gtr_interior|Meo_turbo)/i,
  },

  /* --- trafik modelleri: sunucu her spawn için birini seçer -------------- */
  npc1: {
    key: 'npc1',
    url: '/models/npc1.glb',
    faceYaw: Math.PI / 2,
    paint: /^body$/,
    length: 4.90,           // minibüs gövdeli, geniş
    weight: 0.170,
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
    weight: 0.195,
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
    weight: 0.024,
    interiorSkin: 0.10,
    dropMaterials: /^internal$/i,
  },
};

/** Yol kenarı manzarası — araç değil, kendi hattı var. */
export const SCENERY_MODEL = { key: 'scenery', url: '/models/new_york_buildings.glb', weight: 0.086 };

/** Sunucunun `model` alanında gönderebileceği trafik modelleri. */
export const TRAFFIC_MODELS = ['npc1', 'npc2', 'npc3'];

/** Garajdaki gerçek (indirilen) araç modelleri. */
export const PLAYER_MODELS = ['player', 'skyline', 'ilkaraba'];

/** İlk karede GÖRÜNEN modeller: seçili araç + varsayılan rakip (bmw). */
export const ESSENTIAL_KEYS = [...new Set(
  ['player', VEHICLE_BY_ID[garage.selected]?.model].filter((k) => k && MODELS[k])
)];
{
  // Bu iki .glb'nin fetch'ini three.js/DRACO hazır olmadan başlat.
  // crossOrigin BİLEREK atanmadı: GLTFLoader'ın XHR'ıyla aynı CORS modu,
  // aksi halde tarayıcı dosyayı iki kez indirir.
  for (const k of ESSENTIAL_KEYS) {
    const l = document.createElement('link');
    l.rel = 'preload';
    l.as = 'fetch';
    l.href = MODELS[k].url;
    l.fetchPriority = 'high';
    document.head.appendChild(l);
  }
}

/** Bir aracın alçak poligonlu vekiline geçtiği mesafe (m). */
export const LOD_SWAP = 70;
export const LOD_CULL = 420;

export const CAR = {
  halfWidth: 0.92,
  halfLength: 2.24,
  hitScaleX: 0.86,          // affedici arcade çarpışma kutusu
  hitScaleZ: 0.92,
};

/* Araçtan bağımsız sürüş sabitleri. Araca BAĞLI olanlar (tavan hız, ivme,
   fren, yol tutuş, nitro) garajdan gelir ve `applyLoadout()` ile aşağıdaki
   DRIVE nesnesinin üzerine yazılır — oyun döngüsü tek bir kaynaktan okur. */
export const DRIVE = {
  startSpeed: 42,           // yeşil ışıkta m/s
  maxSpeed: 109.7,          // 395 km/h — araç seçimiyle değişir
  // Nitro dahil hiçbir kurulumun aşamayacağı tavan (439 km/h). Sunucunun
  // MAX_SPEED_SANITY eşiğinin altında kalması şart: aksi halde meşru bir
  // tam gaz anı "hile" sanılıp mesafe raporu kırpılırdı.
  hardMaxSpeed: 122,
  minSpeed: 8,
  accel: 15,
  brake: 34,
  coast: 5.5,
  laneChangeSpeed: 10.5,    // m/s yanal hız tavanı
  laneSnap: 6.2,            // şerit merkezine çeken yay katsayısı
  steerResponse: 11,        // yanal hızın hedefe oturma hızı (1/s)
  laneRepeatMs: 260,        // tuşu basılı tutunca şerit şerit kayma
};

/** Tabanlar: araç istatistikleri bunların üzerine ORAN olarak biner. */
export const DRIVE_BASE = {
  laneChangeSpeed: DRIVE.laneChangeSpeed,
  laneSnap: DRIVE.laneSnap,
  steerResponse: DRIVE.steerResponse,
  laneRepeatMs: DRIVE.laneRepeatMs,
};

/** Nitro davranışı — kapasite/dolum araçtan, his buradan gelir. */
export const NITRO = {
  capacity: 2.4,            // sn — dolu depo kaç saniye yanar
  refill: 0.18,             // birim/s (1 = tam depo)
  boost: 1.14,              // tavan hız çarpanı
  accelBoost: 2.35,         // ivme çarpanı
  minToFire: 0.12,          // bu seviyenin altında ateşlenemez
};

/* Gövde animasyonu. Açılar radyan; hepsi tuş bırakılınca lerp ile nötre döner. */
export const BODY = {
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

export const WHEEL = {
  steerMax: THREE.MathUtils.degToRad(12),   // ön tekerin Y ekseni dönüşü
  maxOmega: 34,             // rad/s — üstü strobe (araba tekeri) etkisi yapar
};

export const NET = {
  syncIntervalMs: 2000,
  stateHz: 30,
  interpDelayMs: 120,       // hayaleti bu kadar geçmişte çiz
  bufferMs: 1500,
};

export const VIEW = {
  camBack: 8.6,
  camHeight: 3.35,
  camLookAhead: 16,
  camBackSpeed: 2.6,        // hızla kameranın ekstra geri çekilmesi (m)
  camBackBoost: 2.2,        // nitroda ek geri çekilme (m)
  fovBase: 62,
  fovMax: 84,
  fovBoost: 7,              // nitroda ek görüş açısı (derece)
  drawAhead: 340,           // örneklemeye değer trafik mesafesi (m)
  drawBehind: 90,
};

/* Yoldan toplanan jetonlar. Konumları YARIŞ TOHUMUNDAN türetilir, yani
   sunucuya tek bir paket bile eklemeden iki istemci de aynı jetonları
   aynı yerde görür. */
export const PICKUP = {
  spacing: 190,             // m — iki jeton kümesi arası
  perCluster: 5,
  clusterGap: 11,           // küme içi jetonlar arası (m)
  radius: 0.55,
  height: 1.0,
  grabZ: 3.2,               // toplama kutusu (m)
  grabX: 1.5,
  drawAhead: 420,
};

/** Sıyırarak geçiş: bu kadar yakından geçmek jeton kazandırır. */
export const NEAR_MISS = { lateral: 2.35, longitudinal: 3.6, minSpeed: 26, streakMs: 2200 };

/* Yedekler — sunucunun `config` paketiyle üzerine yazılır. */
export let CONFIG = {
  laneCount: 4,
  laneWidth: 3.5,
  spawnAhead: 250,
  despawnBehind: 80,
  finishDistance: 6000,
};

/**
 * Sunucudan gelen oda/maç ayarlarını mevcut CONFIG'in üzerine yazar.
 *
 * `game.js` bunu satır içinde `CONFIG = { ...CONFIG, ...room.config }` diye
 * yapıyordu. Modüller arası dışa aktarımlar salt okunur olduğundan yeniden
 * atama burada kalmak zorunda; okuyucular canlı bağ üzerinden yeni nesneyi
 * kendiliğinden görür (davranış birebir aynı).
 */
export function mergeConfig(patch) {
  CONFIG = { ...CONFIG, ...patch };
  return CONFIG;
}

/* =========================== tek oyunculu mod =========================
   Tek Oyunculu koşuda sunucu yok: trafiği istemci üretir. Aşağıdaki
   değerler `server.js`'teki CONFIG'in trafik bölümünün BİREBİR aynısıdır
   (SPAWN_*, TRAFFIC_SPEED_*, MIN_LANE_GAP, BLOCK_WINDOW, RECYCLE_*,
   PASSABLE_*), böylece tek kişilik yol, iki kişilik yolla aynı ritimde
   ve aynı geçilebilirlik garantileriyle akar. Fizik, tavan hız (395 km/s),
   jetonlar ve 6000 m'lik bitiş `DRIVE` / `CONFIG` üzerinden ORTAKTIR —
   burada kopyalanmaz.                                                   */
export const SOLO = {
  countdownMs: 3000,        // sunucunun COUNTDOWN_MS'i
  firstSpawnAt: 1400,       // yeşil ışıktan sonraki nezaket payı (yarış ms)

  spawnIntervalMin: 420,
  spawnIntervalMax: 950,
  difficultyRampMs: 120000, // aralık bu sürede MIN'e doğru daralır
  trafficSpeedMin: 16,      // m/s
  trafficSpeedMax: 30,

  spawnAhead: 340,          // lider aracın kaç metre önünde doğar
  spawnJitter: 45,
  trafficColors: 4,

  minLaneGap: 42,           // aynı şeritteki iki araç arası (m)
  blockWindow: 38,          // bu bantta şerit "kapalı" sayılır
  minOpenLanes: 2,          // hiçbir zaman bundan azı açık kalmaz
  maxActive: 26,            // pistte aynı anda yaşayan araç tavanı

  activeWindow: 460,        // liderin önünde "görüş alanı" sayılan mesafe
  targetActiveMin: 6,       // görüş alanı bu sayının altına düşerse doldur
  targetActiveMax: 10,

  recycleBehind: 180,       // geride kalan araç bu mesafeden sonra geri dönüştürülür
  recycleAheadMin: 30,
  recycleAheadMax: 120,

  passableHorizonMs: 40000, // yol tıkanıklığı kontrolünde ileriye bakış
  passableStepMs: 700,
  nominalPlayerSpeed: 55,   // m/s — oyuncu durmuşken varsayılan cephe
};

export const COLORS = {
  you: 0x22e0ff,
  rival: 0xff3d81,
  traffic: [0xb8bec9, 0x2b3550, 0x8c1f2c, 0xdad3c2],
};
