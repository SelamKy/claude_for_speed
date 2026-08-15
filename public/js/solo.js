/* =====================================================================
   solo.js — Tek Oyunculu mod (sunucusuz yarış)
   ---------------------------------------------------------------------
   Çok Oyunculu akışta yarışı SUNUCU yönetir: oda eşleşmesi, geri sayım,
   trafik doğumu ve maç sonu hep `server.js`'ten gelir. Tek Oyunculu modda
   ise hiçbir soket olayı beklenmez — bu modül sunucunun oyun döngüsündeki
   rolünü istemcide üstlenir:

     • eşleşmeyi/rakip beklemeyi atlar, oyuncuyu doğrudan start çizgisine
       koyar (orta şerit, `resetRace()` ile aynı yerleşim),
     • trafiği `server.js`'in üreticisinin BİREBİR portuyla üretir
       (aynı tohumlu PRNG, aynı şerit boşluğu / hız penceresi /
       geçilebilirlik ve geri dönüşüm kuralları), 6000 m boyunca,
     • kaza ya da bitiş çizgisinde koşuyu kapatır ve özet ekranını
       (mesafe, en yüksek hız, toplanan jeton, süre) gösterir.

   Fizik, kontroller, tavan hız (395 km/s), jetonlar, sıyırma, HUD ve
   kamera HİÇ KOPYALANMADI: `player.js` / `traffic.js` / `config.js`
   aynen kullanılır. Yani tek fark, olayların kaynağıdır.

   Çok Oyunculu tarafa dokunulmaz: bu modülün tamamı `G.solo` bayrağının
   arkasındadır ve tek bir soket paketi göndermez.
   ===================================================================== */

import { CONFIG, SOLO, TRAFFIC_MODELS, DRIVE } from './config.js';
import { el, show, toast, feed, lobbyStage } from './dom.js';
import { G } from './state.js';
import { buildRoad, bindWorldSystems, applyEnvironment } from './scene.js';
import { trafficReady } from './loader.js';
import { rivalCar, refreshLobbyLoadout } from './garage-link.js';
import { resetRace, startRacing } from './player.js';
import { net, resetCountdown, bankRun, renderPayout } from './network.js';
import { REWARDS } from './garage.js';

/* ============================ trafik üreticisi ========================= */

/** mulberry32 — `server.js`'teki `makeRng()` ile birebir aynı. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rng = null;
let records = [];        // sunucudaki `room.traffic` — aralık kararları için
let seq = 0;
let nextSpawnAt = 0;

/** Bir doğum kaydının `raceTime` anındaki z'si (m). */
function zAt(car, raceTime) {
  return car.z + (car.speed * (raceTime - car.raceTime)) / 1000;
}

/**
 * Yarışın "cephesi". Tek oyuncu olduğu için lider = takipçi = oyuncu.
 * Oyuncu kaza yapmış/bitirmişse sunucudaki gibi nominal hıza düşülür.
 */
function frontier(raceTime) {
  const live = !G.me.crashed && !G.me.finished;
  const d = live ? G.me.distance : (SOLO.nominalPlayerSpeed * raceTime) / 1000;
  return { lead: d, rear: d };
}

/** Oyuncunun geçtiği ya da ufka kaçan kayıtları emekli et. */
function prune(raceTime, f) {
  records = records.filter((car) => {
    const z = zAt(car, raceTime);
    return z > f.rear - (SOLO.recycleBehind + 40) && z < f.lead + 800;
  });
}

/** Geride kalan araçlar liderin önünde taze trafik olarak geri döner. */
function recycle(raceTime, f) {
  const stale = records.filter((car) => zAt(car, raceTime) < f.rear - SOLO.recycleBehind);
  if (!stale.length) return;

  const staleIds = new Set(stale.map((car) => car.id));
  records = records.filter((car) => !staleIds.has(car.id));

  for (let i = 0; i < stale.length; i++) {
    const ahead =
      SOLO.recycleAheadMin + rng() * (SOLO.recycleAheadMax - SOLO.recycleAheadMin);
    spawn(raceTime, f, ahead);
  }
}

/** Görüş penceresinde kaç araç var? */
function activeAhead(raceTime, f) {
  return records.filter((car) => {
    const z = zAt(car, raceTime);
    return z > f.lead - 20 && z < f.lead + SOLO.activeWindow;
  }).length;
}

/**
 * Bu araç eklenirse yol, koşu boyunca `minOpenLanes` şeritten daha dar
 * hale gelir mi? Her araç sabit hızda gittiği için ileriye örnekleyerek
 * kesin cevap verilebilir (`server.js` → `staysPassable`).
 */
function staysPassable(lanes, candidateLane, z, candidateSpeed) {
  for (let ahead = 0; ahead <= SOLO.passableHorizonMs; ahead += SOLO.passableStepMs) {
    const dt = ahead / 1000;
    const myZ = z + candidateSpeed * dt;

    let blocked = 0;
    for (let l = 0; l < CONFIG.laneCount; l++) {
      if (l === candidateLane) { blocked++; continue; }
      const busy = lanes[l].some((c) => Math.abs(c.z + c.speed * dt - myZ) < SOLO.blockWindow);
      if (busy) blocked++;
    }
    if (CONFIG.laneCount - blocked < SOLO.minOpenLanes) return false;
  }
  return true;
}

/**
 * Tek doğum denemesi — `server.js`'teki `spawnTraffic()`'in portu.
 * Kural sırası aynı: (1) şerit boşluğu, (2) boşluğu kapatmayan hız
 * penceresi, (3) yolun geçilebilir kalması. Veto yese bile aynı sayıda
 * PRNG çekilir, yani aynı tohum aynı yolu verir.
 */
function spawn(raceTime, f = frontier(raceTime), ahead = null) {
  const laneRoll = rng();
  const speedRoll = rng();
  const zRoll = rng();
  const modelRoll = rng();
  const colorRoll = rng();

  prune(raceTime, f);
  if (records.length >= SOLO.maxActive) return null;

  const z = ahead != null
    ? f.lead + ahead
    : f.lead + SOLO.spawnAhead + zRoll * SOLO.spawnJitter;
  let speed =
    SOLO.trafficSpeedMin + speedRoll * (SOLO.trafficSpeedMax - SOLO.trafficSpeedMin);

  const lanes = Array.from({ length: CONFIG.laneCount }, () => []);
  for (const car of records) {
    lanes[car.lane].push({ z: zAt(car, raceTime), speed: car.speed });
  }

  const firstChoice = Math.floor(laneRoll * CONFIG.laneCount) % CONFIG.laneCount;
  let lane = -1;

  for (let i = 0; i < CONFIG.laneCount; i++) {
    const candidate = (firstChoice + i) % CONFIG.laneCount;

    if (!lanes[candidate].every((c) => Math.abs(c.z - z) >= SOLO.minLaneGap)) continue;

    const lo = Math.max(SOLO.trafficSpeedMin,
      ...lanes[candidate].filter((c) => c.z < z).map((c) => c.speed));
    const hi = Math.min(SOLO.trafficSpeedMax,
      ...lanes[candidate].filter((c) => c.z > z).map((c) => c.speed));
    if (lo > hi) continue;
    const laneSpeed = Math.min(Math.max(speed, lo), hi);

    if (!staysPassable(lanes, candidate, z, laneSpeed)) continue;

    lane = candidate;
    speed = laneSpeed;
    break;
  }
  if (lane < 0) return null;

  const evt = {
    id: ++seq,
    lane,
    laneX: (lane - (CONFIG.laneCount - 1) / 2) * CONFIG.laneWidth,
    z: Number(z.toFixed(3)),
    speed: Number(speed.toFixed(3)),
    model: TRAFFIC_MODELS[Math.floor(modelRoll * TRAFFIC_MODELS.length) % TRAFFIC_MODELS.length],
    variant: Math.floor(colorRoll * SOLO.trafficColors) % SOLO.trafficColors,
    raceTime: Math.round(raceTime),
  };

  records.push(evt);
  // `traffic:spawn` soket olayıyla aynı kayıt — çizim ve çarpışma yolu ortak.
  G.traffic.set(evt.id, { ...evt, obj: null });
  return evt;
}

/**
 * Trafik üreticisini sıfırlar (yeni koşu). Dışa açık, çünkü otomatik
 * testler yolun 6000 m boyunca geçilebilir kaldığını sunucusuz doğruluyor.
 */
export function resetSoloTraffic(seed) {
  rng = makeRng(seed >>> 0);
  records = [];
  seq = 0;
  nextSpawnAt = SOLO.firstSpawnAt;
}

function scheduleNextSpawn(raceTime) {
  const ramp = Math.min(1, raceTime / SOLO.difficultyRampMs);
  const max =
    SOLO.spawnIntervalMax - (SOLO.spawnIntervalMax - SOLO.spawnIntervalMin) * ramp;
  nextSpawnAt += SOLO.spawnIntervalMin + rng() * (max - SOLO.spawnIntervalMin);
}

/* ============================== koşu döngüsü =========================== */

/**
 * Her karede `main.js`'ten çağrılır (yalnız `G.solo` iken). Sunucunun
 * `tickRoom()`'unun karşılığı: bitiş/kaza kontrolü + trafik beslemesi.
 */
export function tickSolo(raceTime) {
  if (!G.solo || G.phase !== 'racing') return;

  if (G.me.crashed) { endSolo({ crashed: true }); return; }
  if (G.me.distance >= CONFIG.finishDistance) {
    G.me.finished = true;
    feed('BİTİŞ!', 'good');
    endSolo({ finished: true });
    return;
  }

  const f = frontier(raceTime);

  let guard = 0;
  while (nextSpawnAt <= raceTime && guard++ < 6) {
    spawn(nextSpawnAt, f);
    scheduleNextSpawn(nextSpawnAt);
  }

  recycle(raceTime, f);

  let topUp = 0;
  while (activeAhead(raceTime, f) < SOLO.targetActiveMin && topUp++ < SOLO.targetActiveMax) {
    if (!spawn(raceTime, f)) break;
  }
}

/* ============================== koşu başlangıcı ======================== */

/**
 * Tek Oyunculu yarışı başlatır: oda yok, rakip yok, bekleme yok.
 *
 * Sıra `match:countdown` işleyicisiyle bilinçli olarak aynıdır — yol,
 * ortam ve yarış durumu aynı fonksiyonlarla kurulur; tek fark verilerin
 * sunucudan değil buradan gelmesi.
 */
export async function startSolo() {
  if (G.phase === 'countdown' || G.phase === 'racing') return;

  G.solo = true;
  G.roomCode = null;
  G.youId = null;
  G.players = [];
  G.ready = false;

  // Trafik modelleri hâlâ iniyorsa bekle: yol boş başlamasın.
  // (`match:countdown` de aynı sözü bekler — iki mod da dolu yolla başlar.)
  if (trafficReady) {
    if (el.btnSolo) el.btnSolo.disabled = true;
    await trafficReady;
    if (el.btnSolo) el.btnSolo.disabled = false;
  }

  G.seed = (Math.random() * 0xffffffff) >>> 0;
  resetSoloTraffic(G.seed);

  buildRoad();
  bindWorldSystems();
  applyEnvironment();
  resetRace();

  // Rakip yok: hayalet aracı tamamen kapat.
  G.rival.id = null;
  G.rival.visible = false;
  G.rival.distance = 0;
  G.rival.buffer.length = 0;
  if (rivalCar) rivalCar.visible = false;

  G.me.topSpeed = 0;

  G.startAt = net.now() + SOLO.countdownMs;
  G.phase = 'countdown';
  resetCountdown();
  el.lights.forEach((l) => l.classList.remove('on', 'go'));

  el.hud.classList.add('solo');
  show(el.lobby, false);
  show(el.gameover, false);
  show(el.countdown, true);
  show(el.hud, true);
  el.btnRematch.disabled = false;
  el.rematchStatus.textContent = '';
}

/* ============================== koşu sonu ============================== */

function statRow(label, value) {
  return `<li class="is-you is-stat"><span class="rk">◈</span>` +
    `<span class="nm">${label}</span><span class="st">${value}</span></li>`;
}

/**
 * Koşuyu kapatır ve özet ekranını doldurur.
 *
 * Kazanç hesabı Çok Oyunculu ile ORTAKTIR (`bankRun`): mesafe, jeton ve
 * sıyırma aynı katsayılarla ödenir, bitirme bonusu aynıdır. Rakip
 * olmadığı için galibiyet bonusu verilmez.
 */
function endSolo({ crashed = false, finished = false } = {}) {
  if (G.phase === 'over') return;
  G.phase = 'over';

  const elapsed = Math.max(0, G.raceTime);   // yarış saati 0 = yeşil ışık
  const payout = bankRun({ won: false, finished, crashed });
  renderPayout(payout);
  refreshLobbyLoadout();

  el.resultTitle.textContent = finished ? 'YARIŞI BİTİRDİN!' : 'KAZA YAPTIN';
  el.resultTitle.className = `result-title ${finished ? 'win' : 'lose'}`;
  el.resultSub.textContent = finished
    ? `Tek Oyunculu · ${CONFIG.finishDistance} m tamamlandı`
    : `Tek Oyunculu · ${Math.round(G.me.distance)} m sonra trafiğe çarptın`;

  const coins = Math.round(G.purse.pickups / REWARDS.perCoinPickup);
  el.resultList.innerHTML = [
    statRow('Mesafe', `${Math.round(G.me.distance)} m`),
    statRow('En Yüksek Hız', `${Math.round(G.me.topSpeed * 3.6)} km/s`),
    statRow('Toplanan Jeton', `${coins} adet`),
    statRow('Sıyırma Kazancı', `${Math.round(G.purse.nearMiss)} G`),
    statRow('Süre', `${(elapsed / 1000).toFixed(2)} sn`),
  ].join('');

  el.rematchStatus.textContent = `Tavan hız: ${Math.round(DRIVE.maxSpeed * 3.6)} km/s`;

  setTimeout(() => {
    if (!G.solo || G.phase !== 'over') return;
    show(el.hud, false);
    show(el.countdown, false);
    show(el.gameover, true);
  }, crashed ? 1200 : 900);
}

/** Tek Oyunculu modu bırakıp ana menüye döner. */
export function leaveSolo() {
  G.solo = false;
  G.phase = 'lobby';
  records = [];
  rng = null;
  el.hud.classList.remove('solo');
  show(el.hud, false);
  show(el.countdown, false);
  show(el.gameover, false);
  show(el.lobby, true);
  lobbyStage('mode');
  refreshLobbyLoadout();
}

/* ============================== arayüz bağları ========================= */

el.btnSolo?.addEventListener('click', () => {
  startSolo().catch((err) => {
    console.error(err);
    toast('Tek oyunculu yarış başlatılamadı — konsola bak.', 'err');
  });
});

el.btnMulti?.addEventListener('click', () => {
  G.solo = false;
  el.hud.classList.remove('solo');
  lobbyStage('entry');
});

el.btnBackMode?.addEventListener('click', () => lobbyStage('mode'));

// Oyun sonu ekranı iki modda da aynı düğmeleri kullanır; `network.js`'teki
// çok oyunculu işleyiciler `G.solo` iken kendilerini devre dışı bırakır.
el.btnRematch?.addEventListener('click', () => {
  if (!G.solo) return;
  startSolo().catch((err) => console.error(err));
});

el.btnQuit?.addEventListener('click', () => {
  if (!G.solo) return;
  leaveSolo();
});
