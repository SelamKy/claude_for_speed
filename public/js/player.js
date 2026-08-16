/* =====================================================================
   player.js — araç fiziği, hız eğrisi, kamera, HUD ve kontroller
   ---------------------------------------------------------------------
   `game.js`'teki "yol jetonları", "koşu kazancı", "oyun yaşam döngüsü",
   "çizim" (oyuncu/kamera/HUD kısmı) ve "girdi" bölümlerinin birebir
   karşılığı.

   Fizik sırası bir karede şöyledir ve DEĞİŞMEDİ:
     nitro -> boyuna hız -> mesafe -> yanal (şerit yayı) -> direksiyon
     sinyali -> gövde duruşu (yatış / savrulma / dalış) -> mesh'e yaz.
   ===================================================================== */

import * as THREE from 'three';

import {
  CONFIG, DRIVE, NITRO, BODY, VIEW, PICKUP, NEAR_MISS,
} from './config.js';
import { el, show, feed } from './dom.js';
import { G, input } from './state.js';
import { canvas, camera, world, fx, scenery, laneX } from './scene.js';
import { poseBody, driveWheels } from './loader.js';
import {
  playerCar, rivalCar, garageScreen, applyLoadout,
} from './garage-link.js';
import { releaseTrafficMesh, trafficZ } from './traffic.js';
import { net } from './network.js';
import { REWARDS } from './garage.js';

/* ============================== yol jetonları ========================== */

/**
 * Jeton kümesi konumları yarış tohumundan türetilir — sunucuya tek bayt
 * eklemeden iki istemci de aynı jetonları aynı yerde görür.
 */
function pickupHash(i) {
  let n = (G.seed ^ Math.imul(i + 1, 0x9e3779b9)) | 0;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return (n ^ (n >>> 16)) >>> 0;
}

const coinGeo = new THREE.CylinderGeometry(PICKUP.radius, PICKUP.radius, 0.09, 14);
coinGeo.rotateX(Math.PI / 2);
const coinMat = new THREE.MeshStandardMaterial({
  color: 0xffc233, emissive: 0xffa000, emissiveIntensity: 0.75,
  metalness: 0.9, roughness: 0.22,
});
export let coinField = null;      // InstancedMesh — tüm jetonlar tek çizim çağrısı

const COIN_CAP = 60;
const _coinMat4 = new THREE.Matrix4();
const _coinQuat = new THREE.Quaternion();
const _coinEuler = new THREE.Euler();
const _coinPos = new THREE.Vector3();
const _coinScale = new THREE.Vector3(1, 1, 1);
const COIN_HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

function ensureCoinField() {
  if (coinField) return;
  coinField = new THREE.InstancedMesh(coinGeo, coinMat, COIN_CAP);
  coinField.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  coinField.frustumCulled = false;
  coinField.count = 0;
  world.add(coinField);
}

/** `index` numaralı kümedeki `k` numaralı jetonun dünya konumu. */
function coinAt(index, k) {
  const h = pickupHash(index);
  const lane = h % CONFIG.laneCount;
  const drift = ((h >>> 8) % 100) / 100;
  return {
    x: laneX(lane),
    z: (index + 1) * PICKUP.spacing + drift * 60 + k * PICKUP.clusterGap,
  };
}

export function resetPickups() {
  G.pickups.clear();
  if (coinField) coinField.count = 0;
}

export function tickPickups(dt) {
  ensureCoinField();
  const d = G.me.distance;
  const spin = performance.now() * 0.0021;

  const first = Math.max(0, Math.floor(d / PICKUP.spacing) - 1);
  const last = Math.floor((d + PICKUP.drawAhead) / PICKUP.spacing);

  let slot = 0;
  for (let index = first; index <= last && slot < COIN_CAP; index++) {
    for (let k = 0; k < PICKUP.perCluster && slot < COIN_CAP; k++) {
      const key = index * 16 + k;
      if (G.pickups.get(key) === true) continue;          // toplanmış
      const { x, z } = coinAt(index, k);
      if (z < d - 20 || z > d + PICKUP.drawAhead) continue;

      // Toplama: şerit ve mesafe kutusu — kaza kutusundan cömert.
      if (G.phase === 'racing' && !G.me.crashed && !G.me.finished &&
          Math.abs(z - d) < PICKUP.grabZ && Math.abs(x - G.me.x) < PICKUP.grabX) {
        G.pickups.set(key, true);   // bu kareden itibaren çizilmez
        collectCoin();
        continue;
      }

      _coinPos.set(x, PICKUP.height, z);
      _coinEuler.set(0, spin + k * 0.6, 0);
      _coinQuat.setFromEuler(_coinEuler);
      _coinMat4.compose(_coinPos, _coinQuat, _coinScale);
      coinField.setMatrixAt(slot++, _coinMat4);
    }
  }

  for (let i = slot; i < coinField.count; i++) coinField.setMatrixAt(i, COIN_HIDDEN);
  coinField.count = slot;
  coinField.instanceMatrix.needsUpdate = true;
  void dt;
}

/**
 * Jeton toplama: sayaç artar, o kadar. Parçacık patlaması, ışık halkası,
 * ekran parlaması yok — jeton `tickPickups()` tarafından bu kareden itibaren
 * zaten çizilmiyor (toplananlar `G.pickups` üzerinden atlanır), yani mesh
 * aynı anda sahneden düşer.
 */
function collectCoin() {
  G.purse.pickups += REWARDS.perCoinPickup;
  bumpPurse();
}

/* ============================== koşu kazancı ========================== */

export function runTotal() {
  const p = G.purse;
  return Math.round(p.distance + p.pickups + p.nearMiss);
}

export function bumpPurse() {
  if (!el.runCoins) return;
  el.runCoins.textContent = runTotal().toLocaleString('tr-TR');
  if (el.purseCard) {
    el.purseCard.classList.remove('bump');
    void el.purseCard.offsetWidth;
    el.purseCard.classList.add('bump');
  }
}

/**
 * Sıyırarak geçiş: yakından geçilen her trafik aracı bir kez sayılır ve
 * ardışık sıyırmalar seriye girerek katlanır.
 */
export function checkNearMiss(raceTime, now) {
  const me = G.me;
  if (me.crashed || me.finished || me.speed < NEAR_MISS.minSpeed) return;

  for (const car of G.traffic.values()) {
    if (G.nearMissed.has(car.id)) continue;
    const z = car.lastZ ?? trafficZ(car, raceTime);
    const dz = z - me.distance;
    // Aracı YENİ geçmiş olmalıyız: arkamızda ve yakın.
    if (dz > 0 || dz < -NEAR_MISS.longitudinal) continue;
    const dx = Math.abs(car.laneX - me.x);
    if (dx > NEAR_MISS.lateral) continue;

    G.nearMissed.add(car.id);
    const p = G.purse;
    p.streak = now - p.streakAt < NEAR_MISS.streakMs ? p.streak + 1 : 1;
    p.streakAt = now;
    const gain = REWARDS.perNearMiss + REWARDS.nearMissStreakBonus * (p.streak - 1);
    p.nearMiss += gain;
    bumpPurse();
    if (p.streak > 1) feed(`SIYIRDIN ×${p.streak}  +${gain}`, 'good');
    break;    // kare başına en fazla bir sayım — seri şişmesin
  }
}

/* =========================== oyun yaşam döngüsü ======================== */

export function resetRace() {
  applyLoadout();

  G.me = {
    distance: 0, speed: 0, x: laneX(1), lane: 1, targetLane: 1,
    lateral: 0, steer: 0, roll: 0, yaw: 0, pitch: 0,
    crashed: false, finished: false, spin: 0,
    nitro: 1, boosting: false, topSpeed: 0,
  };
  G.rival.buffer.length = 0;
  G.rival.distance = 0; G.rival.x = laneX(2); G.rival.lateral = 0; G.rival.steer = 0;
  G.rival.crashed = false; G.rival.visible = true;

  for (const car of G.traffic.values()) if (car.obj) releaseTrafficMesh(car.obj);
  G.traffic.clear();

  G.purse = { distance: 0, pickups: 0, nearMiss: 0, streak: 0, streakAt: 0, total: 0, banked: false };
  G.nearMissed.clear();
  resetPickups();
  bumpPurse();

  if (fx) fx.reset();
  if (scenery) scenery.reset();

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

export function startRacing() {
  G.phase = 'racing';
  G.me.speed = DRIVE.startSpeed;
  show(el.countdown, false);
  show(el.hud, true);
}

/* ========================== tekerlek sinyalleri ========================
   Yuvarlanma hızı fizikten türetilir, elle ayarlanmaz. `driveWheels`
   içindeki bağıntı:

       rollDelta = (ileriHız_m/s * dt) / tekerYarıçapı_m

   Buradan geçen `me.speed` ZATEN m/s'dir (DRIVE.* tablosunun tamamı m/s;
   HUD'daki km/h yalnızca gösterimde çarpılır), yarıçap da prefabın ölçülmüş
   gerçek yarıçapıdır. Yani bu iki değerin dışında hiçbir katsayı yok:
   teker, aracın gerçekten aldığı yol kadar döner.

   DİREKSİYON sinyali ise ham `me.steer` DEĞİL. Araç şerit merkezine
   oturduğunda yanal hız tam sıfıra inmez; geriye kalan ±0.02'lik artık
   sinyal düz yolda ön tekerleri sağa sola titretiyordu — "yalpalama"nın
   göze en çok batan kısmı buydu. Ölü bölge bu artığı keser, kalan aralığı
   yeniden [0,1]'e gerer ki tam kilit kaybolmasın.

   Gövde yatışını / savrulmasını besleyen `me.steer` DEĞİŞMEZ: temizlik
   yalnızca tekerleğe giden kopyaya uygulanır, sürüş hissi aynı kalır. */
const WHEEL_STEER_DEADZONE = 0.04;

function wheelSteer(steer) {
  const s = THREE.MathUtils.clamp(steer, -1, 1);
  const mag = Math.abs(s);
  if (mag <= WHEEL_STEER_DEADZONE) return 0;
  return Math.sign(s) * (mag - WHEEL_STEER_DEADZONE) / (1 - WHEEL_STEER_DEADZONE);
}

/* ============================== oyuncu tick ============================ */

export function tickPlayer(dt) {
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
      driveWheels(playerCar, me.speed, wheelSteer(me.steer), dt);
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

  /* --- nitro ------------------------------------------------------------
     Depo boşalınca boost kendiliğinden kesilir; tuş bırakılınca yavaşça
     dolar. Boost yalnızca gaz basılıyken anlamlı, ama fren yaparken bile
     depo dolmaz — nitroyu "bekleyip biriktirme" oyununa çevirmemek için. */
  const wantBoost = input.nitro && me.nitro > (me.boosting ? 0 : NITRO.minToFire);
  me.boosting = wantBoost && me.nitro > 0;
  if (me.boosting) {
    me.nitro = Math.max(0, me.nitro - dt / Math.max(NITRO.capacity, 0.1));
    if (me.nitro <= 0) me.boosting = false;
  } else if (!input.nitro) {
    me.nitro = Math.min(1, me.nitro + NITRO.refill * dt);
  }

  const topSpeed = Math.min(
    DRIVE.hardMaxSpeed,
    DRIVE.maxSpeed * (me.boosting ? NITRO.boost : 1),
  );

  /* --- boyuna ---------------------------------------------------------- */
  if (input.throttle || me.boosting) {
    // 300 km/h (83.3 m/s) üstünde aerodinamik direnç: tırmanış kademeli.
    const drag = me.speed > 83.3
      ? Math.max(0.12, (topSpeed - me.speed) / 26.4)
      : 1;
    const accel = DRIVE.accel * (me.boosting ? NITRO.accelBoost : 1);
    me.speed += accel * drag * dt;
  }
  else if (input.brakeKey) me.speed -= DRIVE.brake * dt;
  else me.speed -= DRIVE.coast * dt;
  // Boost bitince hız tavana doğru SÖNER, anında kesilmez.
  if (me.speed > topSpeed) me.speed = Math.max(topSpeed, me.speed - 26 * dt);
  me.speed = THREE.MathUtils.clamp(me.speed, DRIVE.minSpeed, topSpeed);

  // Koşu özeti için: bu yarışta görülen en yüksek hız (m/s).
  if (me.speed > me.topSpeed) me.topSpeed = me.speed;

  const before = me.distance;
  me.distance += me.speed * dt;
  G.purse.distance += (me.distance - before) * REWARDS.perMetre;

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
    // Yuvarlanma m/s'den, kırılma temizlenmiş sinyalden — ikisi de driveWheels'te.
    driveWheels(playerCar, me.speed, wheelSteer(me.steer), dt);
  }

  emitDrivingFx(dt);
}

/**
 * Sürüşün görsel "juice"u: nitro alevi, lastik dumanı ve fren izleri.
 *
 * Duman ve iz eşiği, sürücünün NE KADAR zorladığına bakar: hem sert fren
 * hem de hızlı şerit değişimi (yüksek yanal hız) lastiği kaydırır. İkisinin
 * büyüğü alınır, böylece frende dönerken efekt iki kez binmez.
 */
function emitDrivingFx(dt) {
  if (!fx || !playerCar) return;
  const me = G.me;
  const u = playerCar.userData;
  const car = {
    x: me.x, z: me.distance, yaw: me.yaw,
    halfWidth: u.width * 0.5, length: u.length, speed: me.speed,
  };

  if (me.boosting) fx.nitro(car, dt, 1);

  const slip = Math.abs(me.lateral) / Math.max(DRIVE.laneChangeSpeed, 1);
  const braking = input.brakeKey && me.speed > DRIVE.minSpeed * 2 ? 1 : 0;
  const strain = Math.max(slip > 0.55 ? (slip - 0.55) / 0.45 : 0, braking * 0.85);

  if (strain > 0.05) {
    fx.tyreSmoke(car, dt, strain);
    fx.laySkid(car, strain);
  }
}

/* ================================ kamera =============================== */

const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3(0, VIEW.camHeight, -VIEW.camBack);
const _camWant = new THREE.Vector3();

export function tickCamera(dt) {
  const me = G.me;
  const speedK = THREE.MathUtils.clamp(
    (me.speed - DRIVE.minSpeed) / Math.max(DRIVE.maxSpeed - DRIVE.minSpeed, 1), 0, 1);
  const boostK = me.boosting ? 1 : 0;

  // Hız arttıkça kamera geri çekilir ve biraz yükselir; nitroda ekstra geri.
  _camWant.set(
    me.x * 0.72,
    VIEW.camHeight + speedK * 0.35,
    me.distance - VIEW.camBack - speedK * VIEW.camBackSpeed - boostK * VIEW.camBackBoost,
  );
  camPos.lerp(_camWant, 1 - Math.exp(-7 * dt));

  camera.position.copy(camPos);
  if (fx) {
    const o = fx.shake.update(dt, me.speed, DRIVE.maxSpeed, me.boosting);
    camera.position.add(o);
  }

  camTarget.set(me.x * 0.35, 1.15, me.distance + VIEW.camLookAhead);
  camera.up.set(0, 1, 0);
  camera.lookAt(camTarget);

  const fov = VIEW.fovBase + (VIEW.fovMax - VIEW.fovBase) * speedK + VIEW.fovBoost * boostK;
  if (Math.abs(camera.fov - fov) > 0.05) {
    camera.fov = THREE.MathUtils.damp(camera.fov, fov, boostK ? 9 : 6, dt);
    camera.updateProjectionMatrix();
  }

  if (fx) fx.speedLines.update(dt, speedK, me.boosting);
}

/* ================================= HUD ================================= */

export function updateHUD() {
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

  if (el.nitroFill) {
    el.nitroFill.style.width = `${(me.nitro * 100).toFixed(1)}%`;
    el.nitro.classList.toggle('burning', me.boosting);
    el.nitro.classList.toggle('empty', me.nitro < NITRO.minToFire);
  }

  el.ping.textContent = String(Math.round(net.ping));
  el.ping.className = net.ping > 220 ? 'bad' : net.ping > 110 ? 'warn' : '';
}

/* ================================ girdi ================================ */

let laneRepeatAt = 0;

export function laneShift(dir) {
  if (G.phase !== 'racing' || G.me.crashed || G.me.finished) return;
  G.me.targetLane = THREE.MathUtils.clamp(G.me.targetLane + dir, 0, CONFIG.laneCount - 1);
  laneRepeatAt = performance.now() + DRIVE.laneRepeatMs;
}

/** Tuşu basılı tutmak şerit şerit kaydırır — tek tek tıklamak gerekmez. */
export function holdSteer(now) {
  const dir = (input.left ? 1 : 0) - (input.right ? 1 : 0);
  if (!dir || now < laneRepeatAt) return;
  laneShift(dir);
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Escape' && garageScreen && garageScreen.open) { garageScreen.close(); return; }
  if (garageScreen && garageScreen.open) return;     // garajda sürüş tuşları yok
  if (e.code.startsWith('Arrow')) e.preventDefault();
  if (e.repeat) return;
  switch (e.code) {
    case 'KeyA': case 'ArrowLeft':  input.left = true;  laneShift(1);  break;
    case 'KeyD': case 'ArrowRight': input.right = true; laneShift(-1); break;
    case 'KeyW': case 'ArrowUp':    input.throttle = true; break;
    case 'KeyS': case 'ArrowDown':  input.brakeKey = true; break;
    case 'ShiftLeft': case 'ShiftRight': input.nitro = true; break;
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
    case 'ShiftLeft': case 'ShiftRight': input.nitro = false; break;
  }
});

// Sekme arkaya alınırsa tuşlar "basılı kalmasın".
addEventListener('blur', () => {
  input.left = input.right = input.throttle = input.brakeKey = input.nitro = false;
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
