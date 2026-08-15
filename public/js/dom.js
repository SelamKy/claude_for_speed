/* =====================================================================
   dom.js — arayüz düğüm önbelleği ve küçük bildirim yardımcıları
   ---------------------------------------------------------------------
   `game.js`'teki "DOM" bölümünün birebir karşılığı. Hiçbir şey import
   etmez; bu yüzden modül grafiğinin yaprağıdır ve döngüsel bağımlılık
   riski taşımaz.

   Modül `<script type="module">` ile yüklendiği için (defer davranışı)
   `getElementById` çağrıları belge ayrıştırıldıktan sonra çalışır.
   ===================================================================== */

const $ = (id) => document.getElementById(id);

export { $ };

export const el = {
  loading: $('loading'), loadBar: $('load-bar'), loadLabel: $('load-label'),
  lobby: $('lobby'), lobbyMode: $('lobby-mode'),
  lobbyEntry: $('lobby-entry'), lobbyRoom: $('lobby-room'),
  btnSolo: $('btn-solo'), btnMulti: $('btn-multi'), btnBackMode: $('btn-back-mode'),
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

  // garaj + yeni HUD
  btnGarage: $('btn-garage'), btnGarage2: $('btn-garage-2'),
  lobbyCoins: $('lobby-coins'), lobbyLoadout: $('lobby-loadout'),
  runCoins: $('run-coins'), purseCard: document.querySelector('.purse-card'),
  nitro: document.querySelector('.nitro'), nitroFill: $('nitro-fill'),
  payout: $('payout'),
};

export const show = (node, on) => node.classList.toggle('hidden', !on);

/* ------------------------------ lobi sahneleri -------------------------
   Lobi panelinin üç sahnesi var ve HER ZAMAN yalnız biri açıktır:
     mode  — ana menü (Tek Oyunculu / Çok Oyunculu)
     entry — çok oyunculu giriş (oda kur / odaya katıl)
     room  — oda görünümü (davet + hazır)
   Argümansız çağrı o an açık olan sahnenin adını döndürür.               */
let _stage = 'mode';

export function lobbyStage(which) {
  if (which) {
    _stage = which;
    show(el.lobbyMode, which === 'mode');
    show(el.lobbyEntry, which === 'entry');
    show(el.lobbyRoom, which === 'room');
  }
  return _stage;
}

export function toast(msg, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = msg;
  el.toasts.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 260);
  }, 3200);
}

export function feed(msg, kind = '') {
  const node = document.createElement('div');
  node.className = `evt ${kind}`;
  node.textContent = msg;
  el.feed.appendChild(node);
  setTimeout(() => node.remove(), 2600);
}

/** Bir CSS animasyonunu baştan oynatmaya zorlar (reflow tetikleyerek). */
export function restartAnim(node) {
  node.style.animation = 'none';
  void node.offsetWidth;
  node.style.animation = '';
}
