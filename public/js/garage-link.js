/* =====================================================================
   garage-link.js — garaj ile piste arasındaki bağ (arayüz + tornet)
   ---------------------------------------------------------------------
   `game.js`'teki "araçlar", "garaj bağlantısı" ve "garaj girişleri"
   bölümlerinin birebir karşılığı.

   Sorumluluğu: garajda seçilen araç / boya / yükseltmeleri alıp
     • sürüş sabitlerine yazmak (`applyLoadout`),
     • pistteki 3B araçları yeniden kurmak (`rebuildCars`),
     • çarpışma kutusunu gerçek modele göre güncellemek,
     • garaj ekranını (GarageScreen — tornet önizlemesi) açıp kapatmak.

   NOT: garaj EKONOMİSİ (araç listesi, yükseltmeler, cüzdan, kayıt) hâlâ
   `garage.js`'te; garaj EKRANI (tornet, sekmeler, dükkân) `garage-ui.js`'te.
   Bu modül yalnızca ikisini oyuna bağlar — o yüzden adı `garage-link`.
   ===================================================================== */

import { CAR, COLORS } from './config.js';
import { el, show, toast } from './dom.js';
import { G } from './state.js';
import { world, fx } from './scene.js';
import { instantiate, prefabs } from './loader.js';
import { garage, VEHICLE_BY_ID, computeStats } from './garage.js';
import { DRIVE, DRIVE_BASE, NITRO } from './config.js';

/* =============================== araçlar =============================== */

export let playerCar = null;
export let rivalCar = null;

/* ============================ garaj bağlantısı ========================= */

/** Şu anki aracın türetilmiş istatistikleri (araç tabanı + yükseltmeler). */
export let stats = computeStats(garage.selected, garage.entry(garage.selected).upgrades);

/** @type {import('./garage-ui.js').GarageScreen|null} */
export let garageScreen = null;

/** boot() garaj ekranını kurduğunda tutamağı buraya yazar. */
export function setGarageScreen(v) { garageScreen = v; }

/**
 * Bir araç kimliği için 3B prefab. Garajdaki araçların hepsi .glb; `prefabs[v.id]`
 * yalnızca indirme başarısız olduğunda (prosedürel yedek) dolar.
 */
export function prefabFor(vehicleId) {
  const v = VEHICLE_BY_ID[vehicleId];
  if (!v) return prefabs.player || null;
  if (v.body === 'glb') return prefabs[v.model] || prefabs[v.id] || null;
  return prefabs[v.id] || null;
}

/**
 * Garaj seçimini sürüş parametrelerine yazar.
 *
 * Yol tutuş (`grip`) tek bir sayıdan üç ayrı davranışa dağılır: yanal hız
 * tavanı, şerit merkezine çeken yayın sertliği ve tuşu basılı tutunca şerit
 * atlama sıklığı. Böylece "iyi yol tutuşlu" araç sadece hızlı kaymıyor,
 * şeride de daha çabuk oturuyor — his olarak fark edilir olan bu.
 */
export function applyLoadout() {
  const id = garage.selected;
  stats = computeStats(id, garage.entry(id).upgrades);

  DRIVE.maxSpeed = Math.min(stats.topSpeed, DRIVE.hardMaxSpeed);
  DRIVE.accel = stats.accel;
  DRIVE.brake = stats.brake;
  DRIVE.laneChangeSpeed = DRIVE_BASE.laneChangeSpeed * stats.grip;
  DRIVE.laneSnap = DRIVE_BASE.laneSnap * (0.72 + 0.28 * stats.grip);
  DRIVE.steerResponse = DRIVE_BASE.steerResponse * (0.75 + 0.25 * stats.grip);
  DRIVE.laneRepeatMs = DRIVE_BASE.laneRepeatMs / Math.max(0.6, stats.grip);

  NITRO.capacity = stats.nitro.capacity;
  NITRO.refill = stats.nitro.refill;
  NITRO.boost = stats.nitro.boost;
}

/** Garajdaki bir aracın tam donanımlı 3B örneği (garaj önizlemesi de bunu kullanır). */
export function makeCar(vehicleId, look, { lod = false } = {}) {
  const prefab = prefabFor(vehicleId);
  if (!prefab) return null;
  const car = instantiate(prefab, {
    look,
    tailLamps: true,
    lod,
  });
  car.userData.vehicleId = vehicleId;
  return car;
}

/** Bir aracı sahneden söker ve örneğe ait malzemeleri bırakır. */
export function retireCar(car) {
  if (!car) return;
  world.remove(car);
  car.traverse((o) => {
    if (o.isMesh && o.userData.__owned) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m?.dispose?.();
    }
  });
}

/** En son SAHNEYE kurulmuş donanımın imzası — gereksiz yeniden kurmayı önler. */
export let builtLoadout = '';

/** İki donanımın görsel olarak aynı olup olmadığını ucuza karşılaştırır. */
export function loadoutKey(l) {
  if (!l) return '';
  const k = l.look || {};
  return `${l.vehicle}|${k.finish}|${k.paint}|${k.underglow}|${k.underglowColor}|${k.tint}|${k.rim}`;
}

export function currentLoadoutKey() {
  return loadoutKey({ vehicle: garage.selected, look: garage.look(garage.selected) });
}

/**
 * Sahnedeki araçlar mevcut garaj seçiminden farklı mı?
 * (`game.js`'te her çağrı yerinde `currentLoadoutKey() !== builtLoadout`
 * yazılıydı; burada tek bir isimle toplandı, davranış aynı.)
 */
export function loadoutChanged() {
  return currentLoadoutKey() !== builtLoadout;
}

/**
 * Oyuncu ve rakip araçlarını mevcut donanıma göre (yeniden) kurar.
 * Araç değiştirmek, boya değiştirmek veya rakibin donanımı gelmek bunu tetikler.
 */
export function rebuildCars() {
  if (!prefabs.player) return;          // henüz yükleniyor
  builtLoadout = currentLoadoutKey();

  const keepPlayer = playerCar ? playerCar.position.clone() : null;
  retireCar(playerCar);
  retireCar(rivalCar);

  playerCar = makeCar(garage.selected, garage.look(garage.selected), { lod: false });
  if (playerCar) {
    world.add(playerCar);
    if (keepPlayer) playerCar.position.copy(keepPlayer);
  }

  // Rakip kendi donanımını bildirdiyse onu, bildirmediyse pembe amiral aracı.
  const rl = G.rival.loadout;
  const rivalId = rl && VEHICLE_BY_ID[rl.vehicle] ? rl.vehicle : 'bmw';
  const rivalLook = rl && rl.look ? rl.look : {
    finish: 'gloss', paint: COLORS.rival, underglow: true,
    underglowColor: COLORS.rival, tint: 1, rim: 'stock',
  };
  rivalCar = makeCar(rivalId, rivalLook, { lod: true });
  if (rivalCar) {
    world.add(rivalCar);
    rivalCar.visible = G.rival.visible;
  }

  updatePlayerHitbox();
}

/** Çarpışma kutusu seçili aracın gerçek ölçüsünden türetilir. */
export function updatePlayerHitbox() {
  if (!playerCar) return;
  CAR.halfWidth = Math.min(playerCar.userData.width * 0.5, 1.05);
  CAR.halfLength = playerCar.userData.length * 0.5;
}

/** Lobide "hangi araçla yarışıyorum" satırı. */
export function refreshLobbyLoadout() {
  const v = VEHICLE_BY_ID[garage.selected];
  if (el.lobbyCoins) el.lobbyCoins.textContent = `◈ ${Math.round(garage.coins).toLocaleString('tr-TR')}`;
  if (el.lobbyLoadout && v) {
    el.lobbyLoadout.textContent =
      `${v.name} · ${Math.round(stats.topSpeed * 3.6)} km/s · nitro ${stats.nitro.capacity.toFixed(1)} sn`;
  }
}

/* ---------------------------- garaj girişleri -------------------------- */

/**
 * Garaj, canvas'ın tamamını kendi çizimi için devralır. Bu yüzden altındaki
 * ekranlar (lobi, oyun sonu, HUD) DOM'dan gizlenir; kapanışta hangisinden
 * gelindiyse o geri açılır.
 */
let garageReturnTo = null;

export function openGarage() {
  if (!garageScreen) { toast('Garaj hâlâ hazırlanıyor…', 'err'); return; }
  garageReturnTo = el.gameover.classList.contains('hidden') ? 'lobby' : 'gameover';
  show(el.lobby, false);
  show(el.gameover, false);
  show(el.hud, false);
  if (fx) fx.speedLines.reset();
  garageScreen.show();
}

export function closeGarage() {
  if (garageReturnTo === 'gameover') show(el.gameover, true);
  else show(el.lobby, true);
  garageReturnTo = null;
}

el.btnGarage?.addEventListener('click', openGarage);
el.btnGarage2?.addEventListener('click', openGarage);
