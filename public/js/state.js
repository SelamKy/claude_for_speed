/* =====================================================================
   state.js — paylaşılan oyun durumu
   ---------------------------------------------------------------------
   `game.js`'te "oyun durumu" başlığı altında duran `G` ve `input`
   nesnelerinin birebir kopyası.

   Neden ayrı bir modül: `G` istisnasız her alt sistem tarafından okunur
   ve yazılır (fizik, trafik, ağ, HUD, garaj). Onu config/scene/network
   modüllerinden birinin içine koymak, geri kalan her modülü o modüle
   bağlar ve döngüsel import zincirleri doğurur. Yaprak bir durum modülü
   bu bağı tek yönlü tutar.

   Not: `G` ve `input` HİÇBİR ZAMAN yeniden atanmaz — alanları yerinde
   değiştirilir. Bu sayede canlı bağ semantiğine güvenmek gerekmez;
   `game.js`'teki `G.me = {...}` gibi alan atamaları aynen çalışır.
   ===================================================================== */

export const G = {
  phase: 'boot',            // boot | lobby | room | countdown | racing | over
  ready: false,
  youId: null,
  roomCode: null,
  players: [],
  seed: 0,
  startAt: 0,               // yarış zamanı 0 anının sunucu epoch ms'i
  raceTime: 0,

  me: {
    distance: 0, speed: 0, x: 0, lane: 1, targetLane: 1,
    lateral: 0, steer: 0, roll: 0, yaw: 0, pitch: 0,
    crashed: false, finished: false, spin: 0,
    nitro: 1, boosting: false,
  },
  rival: {
    id: null, buffer: [], distance: 0, x: 0, speed: 0, lateral: 0,
    steer: 0, crashed: false, visible: false, loadout: null,
  },

  traffic: new Map(),       // id -> { id, lane, laneX, z, speed, model, variant, raceTime, obj }
  lastStateSent: 0,

  /* --- koşu ekonomisi ------------------------------------------------- */
  env: 'night',
  purse: { distance: 0, pickups: 0, nearMiss: 0, streak: 0, streakAt: 0, total: 0, banked: false },
  pickups: new Map(),       // index -> { x, z, taken }
  nearMissed: new Set(),    // aynı trafik aracı iki kez sayılmasın
};

export const input = { throttle: false, brakeKey: false, left: false, right: false, nitro: false };
