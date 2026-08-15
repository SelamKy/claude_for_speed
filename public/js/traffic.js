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

import { CAR, CONFIG, COLORS, TRAFFIC_MODELS, VIEW } from './config.js';
import { el, feed } from './dom.js';
import { G } from './state.js';
import { world, fx } from './scene.js';
import { instantiate, prefabs, driveWheels } from './loader.js';
import { playerCar } from './garage-link.js';
import { socket } from './network.js';

/* Model + boya varyantı başına bir havuz: hangi aracın hangi model ve renkte
   olduğunu sunucu söyler, böylece iki oyuncu da aynı aracı aynı görür. */
const trafficPools = new Map();     // "npc2:3" -> THREE.Group[]

/** Modelden türetilen çarpışma yarı-boyutları (her istemcide birebir aynı). */
export const trafficHit = new Map();       // "npc2" -> { halfWidth, halfLength }

function poolKey(model, variant) { return `${model}:${variant}`; }

export function spawnTrafficMesh(model, variant) {
  const name = TRAFFIC_MODELS.includes(model) ? model : TRAFFIC_MODELS[0];
  const v = ((variant | 0) % COLORS.traffic.length + COLORS.traffic.length) % COLORS.traffic.length;
  const key = poolKey(name, v);

  const pool = trafficPools.get(key);
  if (pool && pool.length) {
    const pooled = pool.pop();
    pooled.visible = true;
    return pooled;
  }

  // Trafik modelleri arka planda iniyor; yarış onlar bitmeden başlayabilir.
  // O karede araç çizilmez, bir sonrakinde tekrar denenir — çağıran `null`
  // dönüşünü zaten karşılıyor. (Eskiden burada her karede istisna atılıyordu.)
  if (!prefabs[name]) return null;

  const mesh = instantiate(prefabs[name], { paint: COLORS.traffic[v], tailLamps: true, lod: true });
  mesh.userData.poolKey = key;
  world.add(mesh);
  return mesh;
}

export function releaseTrafficMesh(car) {
  car.visible = false;
  const key = car.userData.poolKey || poolKey(TRAFFIC_MODELS[0], 0);
  if (!trafficPools.has(key)) trafficPools.set(key, []);
  const pool = trafficPools.get(key);
  if (pool.length < 5) pool.push(car);
  else world.remove(car);
}

export function hitFor(model) {
  return trafficHit.get(model) || { halfWidth: CAR.halfWidth, halfLength: CAR.halfLength };
}

/* ============================== trafik tick ============================ */

export function trafficZ(car, raceTime) {
  return car.z + car.speed * (raceTime - car.raceTime) / 1000;
}

export function tickTraffic(raceTime, dt) {
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

export function checkCollisions(raceTime) {
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
