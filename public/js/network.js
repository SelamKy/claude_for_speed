/* =====================================================================
   network.js — Socket.io: saat eşitleme, oda yönetimi, maç olayları
   ---------------------------------------------------------------------
   `game.js`'teki "ağ katmanı", "lobi arayüzü", "geri sayım", "soket olay
   işleyicileri" ve rakip (hayalet) interpolasyonunun birebir karşılığı.

   Geri sayım ve hayalet aracı da burada, çünkü ikisi de doğrudan
   EŞİTLENMİŞ SAATE bağlı: geri sayım `G.startAt - net.now()` ile,
   hayalet ise `net.now() - NET.interpDelayMs` anındaki tampon örneğiyle
   çizilir. Onları saatten ayırmak iki modül arasında sürekli bir
   gidiş-geliş yaratırdı.
   ===================================================================== */

import * as THREE from 'three';

import {
  mergeConfig, NET, DRIVE, BODY, TRAFFIC_MODELS,
} from './config.js';
import { el, show, toast, feed, restartAnim } from './dom.js';
import { G } from './state.js';
import { buildRoad, bindWorldSystems, applyEnvironment } from './scene.js';
import { trafficReady, poseBody, driveWheels } from './loader.js';
import {
  rivalCar, rebuildCars, refreshLobbyLoadout, loadoutKey,
} from './garage-link.js';
import { resetRace, startRacing } from './player.js';
import { garage, REWARDS } from './garage.js';

/* ============================== ağ katmanı ============================= */

export const socket = io({ transports: ['websocket'], upgrade: false });

export const net = {
  offset: 0,          // serverNow ≈ Date.now() + offset
  bestRtt: Infinity,
  ping: 0,
  synced: false,       // ilk örnekten sonra true — sonraki düzeltmeler yumuşatılır
  now: () => Date.now() + net.offset,
};

export function syncClock() {
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

/* ============================ durum gönderimi ========================== */

export function sendState(now) {
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

/* ========================= rakip (hayalet) aracı ======================= */

export function tickRival(dt) {
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

/* ============================== geri sayım ============================= */

let lastCount = null;

/** Yeni bir geri sayım başlarken "son gösterilen sayı" hafızasını siler. */
export function resetCountdown() { lastCount = null; }

export function updateCountdown() {
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

/* ============================== lobi arayüzü =========================== */

export function inviteUrl(code) {
  return `${location.origin}/?room=${code}`;
}

export function renderRoom(room) {
  G.roomCode = room.code;
  G.players = room.players;
  mergeConfig(room.config);

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

  // Rakibin garaj donanımı değiştiyse hayalet aracı yeniden kur.
  const next = rival && rival.loadout ? rival.loadout : null;
  if (loadoutKey(next) !== loadoutKey(G.rival.loadout)) {
    G.rival.loadout = next;
    rebuildCars();
    if (rivalCar) rivalCar.visible = !!rival;
  }
}

/** Kendi donanımımızı odaya bildir (rakip aracımızı doğru görsün). */
export function sendLoadout() {
  if (!G.roomCode) return;
  socket.emit('player:loadout', {
    vehicle: garage.selected,
    look: garage.look(garage.selected),
  });
}

export function enterRoomView() {
  G.phase = 'room';
  show(el.lobby, true);
  show(el.lobbyEntry, false);
  show(el.lobbyRoom, true);
  show(el.hud, false);
  show(el.gameover, false);
}

export function joinRoom(code) {
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
    sendLoadout();
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

socket.on('match:countdown', async (data) => {
  mergeConfig(data.config);
  G.seed = data.seed;
  G.startAt = data.startAt;
  // Bu paketle gelen zaman çiftini taze bir saat düzeltmesi olarak kabul et.
  net.offset = data.serverTime - Date.now();
  net.synced = true;

  // Trafik arka planda henüz bitmediyse (ör. çok hızlı eşleşme), yarış her
  // istemcide aynı araçlarla başlasın diye SADECE onu bekleriz. Manzara
  // oynanışı etkilemez; hazır olduğunda sahneye kendi girer.
  if (trafficReady) await trafficReady;

  buildRoad();
  bindWorldSystems();
  applyEnvironment();
  resetRace();

  G.phase = 'countdown';
  resetCountdown();
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

/**
 * Koşuyu kapat ve jetonları kalıcı cüzdana yatır.
 *
 * `banked` bayrağı çift ödemeye karşı: `match:over` ile `player:finished`
 * arka arkaya gelebiliyor ve ikisi de burayı çağırabilir.
 */
export function bankRun({ won = false, finished = false, crashed = false } = {}) {
  const p = G.purse;
  if (p.banked) return null;
  p.banked = true;

  const lines = [
    { label: 'Mesafe', value: Math.round(p.distance) },
    { label: 'Jetonlar', value: Math.round(p.pickups) },
    { label: 'Sıyırma', value: Math.round(p.nearMiss) },
  ];
  if (finished) lines.push({ label: 'Bitiş', value: REWARDS.finishBonus });
  if (won) lines.push({ label: 'Galibiyet', value: REWARDS.winBonus });
  if (!crashed) lines.push({ label: 'Hasarsız', value: REWARDS.survivalBonus });

  const total = lines.reduce((s, l) => s + l.value, 0);
  garage.recordRun({ distance: G.me.distance, coins: total });
  garage.flush();
  return { lines, total };
}

export function renderPayout(payout) {
  if (!el.payout) return;
  if (!payout) { el.payout.innerHTML = ''; return; }
  el.payout.innerHTML =
    payout.lines.filter((l) => l.value > 0).map((l) =>
      `<span class="pay-item">${l.label}<b>+${l.value.toLocaleString('tr-TR')}</b></span>`).join('') +
    `<span class="pay-item pay-total">Toplam<b>◈ ${payout.total.toLocaleString('tr-TR')}</b></span>`;
}

socket.on('match:over', (data) => {
  G.phase = 'over';
  const won = data.winnerId && data.winnerId === G.youId;
  const meResult = data.results.find((r) => r.id === G.youId);

  const payout = bankRun({
    won: !!won,
    finished: !!(meResult && meResult.finished),
    crashed: !!(meResult && meResult.crashed),
  });
  renderPayout(payout);
  refreshLobbyLoadout();

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
