/* =====================================================================
   traffic.js — trafik araçları: havuz, konum, çarpışma
   ---------------------------------------------------------------------
   `game.js`'teki trafik havuzu ve trafik tick'inin birebir karşılığı.

   Determinizm: trafiği SUNUCU üretir. İstemci hiçbir araç doğurmaz;
   yalnızca `traffic:spawn` olayında gelen tanımı saklar ve konumunu saf
   bir fonksiyonla hesaplar:

       z(t) = spawn.z + spawn.speed * (t - spawn.raceTime)

   Bu yüzden iki istemci trafiği hiç senkronize etmeden bitişe (6000 m)
   kadar aynı yolu çizer ve aynı çarpışmaları görür. Çarpışma yarı
   boyutları da modelin gerçek ölçüsünden türetilir — yani iki istemci
   aynı .glb'den aynı sayıyı hesaplar.

   NOT: bu modül `network.js`'ten yalnızca `socket`i alır (kaza bildirimi
   için) ve `network.js` bu modülden hiçbir şey almaz. Aradaki halka
   `player.js` üzerinden kapanıyor; hiçbir modülün ÜST DÜZEY kodu karşı
   taraftan bir bağ okumadığı için değerlendirme sırası güvenlidir.
   ===================================================================== */

import { CAR, CONFIG, COLORS, TRAFFIC_MODELS, VIEW, DEBUG, SOLO } from './config.js';
import { el, feed } from './dom.js';
import { G } from './state.js';
import { world, fx, prewarm } from './scene.js';
import {
  instantiate, prefabs, driveWheels, setCarPaint, onAssetsReady,
} from './loader.js';
import { playerCar } from './garage-link.js';
import { socket } from './network.js';

/* ============================= mesh havuzu =============================
   Eskiden trafik mesh'leri UÇUŞTA üretiliyordu: araç görüş alanına girdiği
   karede `instantiate()` çağrılıyor, o da prefabı derin klonluyor (düğüm
   başına `userData` için JSON gidiş-dönüşü), kaporta malzemesini klonluyor,
   gölge düzlemi ve stop lambası için yeni geometri + yeni malzeme üretiyordu.
   Havuz model+renk başına 5 ile sınırlıydı; dolduğunda araç sahneden SÖKÜLÜP
   atılıyordu — yani biraz sonra sıfırdan yeniden kurulacaktı.

   Sonuç tam da trafik yoğunlaştığı anda ortaya çıkıyordu: kare başına birkaç
   milisaniyelik tahsis + ilk çizimde shader derlemesi + doku yüklemesi.

   Yeni düzen:
     • Havuz YÜKLEME EKRANINDA, model başına sabit sayıda araçla kurulur.
     • Araçlar `world`a bir kez eklenir ve BİR DAHA sökülmez; doğum/ölüm
       yalnızca `visible` bayrağıdır.
     • Renk varyantı, önceden üretilmiş PAYLAŞILAN malzemeyi takmaktan
       ibarettir (`setCarPaint`) — tahsis yok, derleme yok.
     • Yoğunluk ASLA kısılmaz: havuz yetmezse sessizce büyür. Ön tahsis
       `SOLO.maxActive`in üstünde olduğu için bu yol pratikte hiç çalışmaz,
       ama tavanın trafiği seyreltmesi kabul edilemez.                        */

/** Yükleme ekranında önceden kurulan araç sayısı (modeller arasında bölünür). */
export const TRAFFIC_POOL_SIZE = 21;      // 3 model × 7; pistte en fazla ~10 görünür

/* Havuz büyümesinin üst sınırı — kaçak bir döngü belleği yemesin. Tavan
   `SOLO.maxActive`ten türetilir: TEK bir model bile pistteki bütün canlı
   araçları tek başına karşılayabilsin, yani sınır hiçbir senaryoda trafiği
   seyreltmesin. Yoğunluk ayarı değişirse bu da kendiliğinden büyür. */
const POOL_HARD_CAP = Math.max(48, SOLO.maxActive * TRAFFIC_MODELS.length);

/** model -> { free: THREE.Group[], total: number } */
const pools = new Map();
let poolTotal = 0;
let warmed = false;

function poolFor(model) {
  let p = pools.get(model);
  if (!p) { p = { free: [], total: 0 }; pools.set(model, p); }
  return p;
}

/** Havuza tek bir araç kurar (ön tahsiste ve taşma hâlinde çağrılır). */
function buildPooled(model, variant) {
  const prefab = prefabs[model];
  if (!prefab || poolTotal >= POOL_HARD_CAP) return null;

  const car = instantiate(prefab, {
    paint: COLORS.traffic[variant],
    tailLamps: true,
    lod: true,
    shadows: false,      // trafik gölge haritasına girmez — temas lekesi yeter
    sharePaint: true,    // aynı model+renk bütün araçlarda TEK malzeme
  });
  car.userData.poolModel = model;
  car.userData.variant = variant;
  car.userData.parked = true;
  car.visible = false;
  // Park hâlinde matris hesabı YOK: `matrixWorldAutoUpdate = false` olduğunda
  // `updateMatrixWorld` bu dala hiç inmez — parkta bekleyen bir araç kare
  // başına tek bir boole sınamasına mal olur.
  car.matrixAutoUpdate = false;
  car.matrixWorldAutoUpdate = false;
  world.add(car);

  const p = poolFor(model);
  p.total++;
  p.free.push(car);
  poolTotal++;
  return car;
}

/**
 * Trafik havuzunu önceden kurar ve GPU'yu ısıtır.
 *
 * Trafik prefabları hazır olur olmaz kendiliğinden çağrılır
 * (`loader.js` → `onAssetsReady`), yani `main.js`'in açılış sırasına
 * dokunmadan, yükleme ekranı süresince tamamlanır.
 *
 * Renkler araçlara SIRAYLA dağıtılır: model başına 7 araç, 4 renk varyantı →
 * her (model, renk) kombinasyonunun malzemesi ön ısıtma anında sahnede
 * gerçekten asılıdır, dolayısıyla hepsi derlenir. Yarış sırasında yeni
 * malzeme üretilmesi gereken bir durum kalmaz.
 *
 * @returns {Promise<void>}
 */
export function prewarmTrafficPool(size = TRAFFIC_POOL_SIZE) {
  const models = TRAFFIC_MODELS.filter((m) => prefabs[m]);
  if (!models.length) return Promise.resolve();

  const perModel = Math.max(1, Math.ceil(size / models.length));
  const variants = COLORS.traffic.length;

  for (const model of models) {
    const p = poolFor(model);
    for (let i = p.total; i < perModel; i++) {
      if (!buildPooled(model, i % variants)) break;
    }
  }
  warmed = true;

  if (DEBUG) {
    console.log(`[trafik] havuz hazır: ${poolTotal} araç `
      + `(${models.map((m) => `${m}×${poolFor(m).total}`).join(', ')}), `
      + `${variants} renk varyantı, canlı araç tavanı ${SOLO.maxActive}`);
  }

  // Shader derlemesi ve doku yüklemesi burada biter, yarışın ortasında değil.
  return prewarm(world).then(() => {
    if (DEBUG) console.log('[trafik] GPU ön ısıtma tamam');
  });
}

// Trafik prefabları hazır olur olmaz havuzu kur.
onAssetsReady(() => { prewarmTrafficPool(); });

/** Modelden türetilen çarpışma yarı-boyutları (her istemcide birebir aynı). */
export const trafficHit = new Map();       // "npc2" -> { halfWidth, halfLength }

/**
 * Havuzdan bir araç alır, istenen renge boyar ve görünür kılar.
 * Havuz tükenmediği sürece yarış sırasında HİÇBİR tahsis yapmaz.
 */
export function spawnTrafficMesh(model, variant) {
  const name = TRAFFIC_MODELS.includes(model) ? model : TRAFFIC_MODELS[0];
  const v = ((variant | 0) % COLORS.traffic.length + COLORS.traffic.length) % COLORS.traffic.length;

  // Trafik modelleri arka planda iniyor; yarış onlar bitmeden başlayabilir.
  // O karede araç çizilmez, bir sonrakinde tekrar denenir — çağıran `null`
  // dönüşünü zaten karşılıyor.
  if (!prefabs[name]) return null;

  const p = poolFor(name);
  let car = p.free.pop();

  if (!car) {
    // Havuz tükendi: trafiği SEYRELTMEK yerine havuzu büyüt.
    if (!buildPooled(name, v)) return null;
    car = p.free.pop();
    if (!car) return null;
    if (DEBUG) console.warn(`[trafik] havuz yetmedi — ${name} için ${p.total}. araç kuruldu`);
  }

  if (car.userData.variant !== v) {
    setCarPaint(car, COLORS.traffic[v]);
    car.userData.variant = v;
  }
  car.userData.parked = false;
  car.matrixAutoUpdate = true;
  car.matrixWorldAutoUpdate = true;
  car.visible = true;
  return car;
}

/** Aracı havuza geri park eder — sahneden SÖKMEZ, hiçbir şey bırakmaz. */
export function releaseTrafficMesh(car) {
  if (!car || car.userData.parked) return;      // çift bırakmaya karşı korumalı
  car.userData.parked = true;
  car.visible = false;
  car.matrixAutoUpdate = false;
  car.matrixWorldAutoUpdate = false;
  poolFor(car.userData.poolModel || TRAFFIC_MODELS[0]).free.push(car);
}

/** Teşhis: havuzun o anki durumu (`?debug=1` kancası ve duman testleri için). */
export function trafficPoolStats() {
  const per = {};
  let free = 0;
  for (const [model, p] of pools) {
    per[model] = { total: p.total, free: p.free.length };
    free += p.free.length;
  }
  return { warmed, total: poolTotal, free, inUse: poolTotal - free, per };
}

/** Model ölçüsü henüz hazır değilken kullanılan kutu (paylaşılan, salt okunur). */
const FALLBACK_HIT = { halfWidth: CAR.halfWidth, halfLength: CAR.halfLength };

export function hitFor(model) {
  return trafficHit.get(model) || FALLBACK_HIT;
}

/* ============================== trafik tick ============================ */

export function trafficZ(car, raceTime) {
  return car.z + car.speed * (raceTime - car.raceTime) / 1000;
}

/** HUD'a en son yazılan araç sayısı — aynı sayı iki kez yazılmasın diye. */
let lastVisibleCount = -1;

export function tickTraffic(raceTime, dt) {
  const d = G.me.distance;
  const behind = d - VIEW.drawBehind;
  const ahead = d + VIEW.drawAhead;
  const cull = d - CONFIG.despawnBehind - VIEW.drawBehind;
  let visible = 0;

  for (const car of G.traffic.values()) {
    const z = trafficZ(car, raceTime);

    if (z < cull || z > d + 900) {
      if (car.obj) { releaseTrafficMesh(car.obj); car.obj = null; }
      G.traffic.delete(car.id);
      continue;
    }

    const near = z > behind && z < ahead;
    if (near && !car.obj) car.obj = spawnTrafficMesh(car.model, car.variant || 0);
    else if (!near && car.obj) { releaseTrafficMesh(car.obj); car.obj = null; }

    if (car.obj) {
      car.obj.position.set(car.laneX, 0, z);
      // Havuzdaki araçlar park hâlindeyken `matrixAutoUpdate` kapalı; sahnede
      // olanlarda açık, yani konum normal yoldan işlenir.
      driveWheels(car.obj, car.speed, 0, dt);
      visible++;
    }
    car.lastZ = z;
  }

  // HUD yazısı yalnızca DEĞİŞTİĞİNDE yazılır: her karede `textContent`e
  // dokunmak tarayıcıyı gereksiz yere düzen hesabına sokuyordu.
  if (visible !== lastVisibleCount) {
    lastVisibleCount = visible;
    el.trafficCount.textContent = String(visible);
  }
}

/**
 * Çarpışma: iki eksende AABB kesişimi, başka hiçbir şey yok.
 *
 * Mesh raycast'i ya da `Box3.setFromObject` YOK — ikisi de araç başına
 * yüzlerce köşe okur ve mesh havuzuyla birlikte kare süresini geri
 * şişirirdi. Yarı boyutlar modelden BİR KEZ ölçülüp (`trafficHit`) araç
 * kaydına iliştirilir; kare içindeki iş iki çıkarma ve iki karşılaştırmadır.
 */
export function checkCollisions(raceTime) {
  const me = G.me;
  if (me.crashed || me.finished || G.phase !== 'racing') return;

  const myHalfW = CAR.halfWidth * CAR.hitScaleX;
  const myHalfL = CAR.halfLength * CAR.hitScaleZ;
  const myX = me.x;
  const myZ = me.distance;

  for (const car of G.traffic.values()) {
    /* Kutu araç kaydında önbelleklenir: `hitFor` araması araç başına her
       karede değil, ömründe bir kez çalışır. Ölçüm HENÜZ hazır değilse
       (model arka planda iniyor) yedek kutu kullanılır ama SAKLANMAZ —
       yoksa o araç ömrü boyunca yanlış kutuyla yaşardı. */
    let hit = car.hit;
    if (!hit) {
      hit = trafficHit.get(car.model);
      if (hit) car.hit = hit;
      else hit = FALLBACK_HIT;
    }
    const z = car.lastZ ?? trafficZ(car, raceTime);

    // Ucuz eksen önce: trafiğin ezici çoğunluğu boyuna testte elenir.
    if (Math.abs(z - myZ) > hit.halfLength + myHalfL) continue;
    if (Math.abs(car.laneX - myX) > hit.halfWidth + myHalfW) continue;
    crash(car.id);
    break;
  }
}

export function crash(trafficId) {
  const me = G.me;
  me.crashed = true;
  // Tek Oyunculu koşuda oda yok: kazayı sunucuya bildirmenin karşılığı yok.
  if (!G.solo) socket.emit('player:crash', { trafficId });
  el.flash.classList.remove('hit');
  void el.flash.offsetWidth;
  el.flash.classList.add('hit');
  if (fx) {
    fx.crash();
    // Çarpma dumanı: kazanın nerede olduğunu gözle takip edilebilir kılar.
    const u = playerCar ? playerCar.userData : { width: 1.9, length: 4.6 };
    fx.tyreSmoke(
      { x: me.x, z: me.distance, yaw: me.yaw, halfWidth: u.width * 0.5, length: u.length },
      0.5, 1,
    );
  }
  feed('KAZA YAPTIN', 'bad');
  if (navigator.vibrate) navigator.vibrate(180);
}
