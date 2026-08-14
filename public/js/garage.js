/* =====================================================================
   Claude for Speed — Garaj & Dükkân (veri katmanı)
   ---------------------------------------------------------------------
   Bu dosyada THREE yoktur ve DOM'a dokunmaz: sadece ekonomi, sahiplik,
   yükseltmeler ve görsel tercihlerin saf modeli. Böylece hem oyun döngüsü
   hem garaj ekranı hem de testler aynı kaynaktan okur.

   Kalıcılık: tek bir localStorage anahtarı (`cfs.garage.v1`). Şema sürümü
   kayda gömülüdür; ileride alan eklenirse `migrate()` eskiyi taşır.
   ===================================================================== */

export const STORAGE_KEY = 'cfs.garage.v1';
const SCHEMA = 1;

/* ============================== araçlar =============================== */

/**
 * Taban istatistikler:
 *   topSpeed  m/s  — düz yolda tavan hız
 *   accel     m/s² — gaz ivmesi
 *   brake     m/s² — fren yavaşlaması
 *   grip      ×    — şerit değiştirme çevikliği çarpanı
 *   nitro     { capacity: s, boost: ×topSpeed, refill: birim/s }
 *
 * Ölçekleme kuralı: TAM yükseltmeli amiral araç, oyunun tarihsel tavan hızı
 * olan 109.7 m/s'e (395 km/h) oturur — 95 × (1 + 0.038×4) = 109.4. Böylece
 * yükseltmeler hissedilir bir ilerleme sunarken hiçbir kurulum sunucunun
 * MAX_SPEED_SANITY sınırını zorlamıyor; nitro payı da üstte kalıyor.
 *
 * `body` alanı istemcinin hangi 3B kaynağı kullanacağını söyler:
 *   'glb'  -> models/*.glb  (gerçek model)
 *   'proc' -> kod üretimi düşük poligonlu gövde (indirilecek dosya yok)
 */
export const VEHICLES = [
  {
    id: 'hatch',
    name: 'Şehir Hatchback',
    tag: 'Başlangıç',
    price: 0,
    body: 'glb',
    model: 'ilkaraba',
    // Ağ hatası için emniyet kemeri: `ilkaraba.glb` inemezse istemci bu
    // prosedürel gövdeye düşer ve oyun yine de açılır. Normal akışta HİÇ
    // üretilmez — game.js sadece catch dalında buna bakar.
    proc: { shape: 'hatch', length: 4.05, width: 1.76, height: 1.48, spoiler: false },
    stats: { topSpeed: 72, accel: 12.0, brake: 28, grip: 0.92, nitro: { capacity: 1.6, boost: 1.10, refill: 0.16 } },
    blurb: 'Ucuz, hafif ve affedici. Şehirden çıkmak için yeterli.',
  },
  {
    id: 'skyline',
    name: 'Spor Coupe',
    tag: 'GT-R',
    price: 13500,
    body: 'glb',
    model: 'skyline',
    stats: { topSpeed: 90, accel: 16.2, brake: 34, grip: 1.08, nitro: { capacity: 2.6, boost: 1.14, refill: 0.19 } },
    blurb: 'Dört çeker denge. Trafiğin arasından dikiş atar gibi geçer.',
  },
  {
    id: 'bmw',
    name: 'Süper Coupe',
    tag: 'Amiral',
    price: 29000,
    body: 'glb',
    model: 'player',
    stats: { topSpeed: 95, accel: 18.6, brake: 36, grip: 1.16, nitro: { capacity: 3.0, boost: 1.16, refill: 0.22 } },
    blurb: 'Garajın tepesi. Her yükseltme burada karşılığını veriyor.',
  },
];

export const VEHICLE_BY_ID = Object.fromEntries(VEHICLES.map((v) => [v.id, v]));

/* ============================ yükseltmeler ============================ */

/**
 * Dört kademe (arayüzde "Seviye 1…4"), dahili olarak 0…3.
 * `per` = kademe başına oransal kazanç.
 */
export const UPGRADES = {
  engine: {
    id: 'engine',
    name: 'Motor',
    desc: 'Tavan hız ve gaz tepkisi',
    icon: '⚙',
    prices: [1200, 3000, 6400, 12800],
    per: { topSpeed: 0.038, accel: 0.065 },
  },
  brakes: {
    id: 'brakes',
    name: 'Fren & Şasi',
    desc: 'Durma mesafesi ve yol tutuş',
    icon: '◎',
    prices: [900, 2400, 5200, 10400],
    per: { brake: 0.10, grip: 0.055 },
  },
  nitro: {
    id: 'nitro',
    name: 'Nitro',
    desc: 'Boost süresi ve dolum hızı',
    icon: '⚡',
    prices: [1100, 2800, 6000, 12000],
    per: { capacity: 0.20, refill: 0.17, boost: 0.012 },
  },
};

export const UPGRADE_LIST = Object.values(UPGRADES);
export const MAX_UPGRADE_LEVEL = 4;      // 0..4 → satın alınmış kademe sayısı

/* ========================== görsel özelleştirme ======================= */

export const FINISHES = {
  gloss: { id: 'gloss', name: 'Parlak', metalness: 0.85, roughness: 0.16, clearcoat: 1.0, emissive: 0 },
  matte: { id: 'matte', name: 'Mat', metalness: 0.20, roughness: 0.72, clearcoat: 0.0, emissive: 0 },
  neon: { id: 'neon', name: 'Neon', metalness: 0.45, roughness: 0.28, clearcoat: 0.6, emissive: 0.55 },
};

export const PAINTS = {
  gloss: [
    { name: 'Buz Mavisi', color: 0x22e0ff }, { name: 'Kobalt', color: 0x1d4ed8 },
    { name: 'Zehir Yeşili', color: 0x35f2a0 }, { name: 'Kan Kırmızısı', color: 0xc41b2b },
    { name: 'Turuncu Alev', color: 0xff6b1a }, { name: 'Altın', color: 0xd8a53a },
    { name: 'İnci Beyaz', color: 0xf2f5fb }, { name: 'Gece Siyahı', color: 0x0d1017 },
    { name: 'Mor Ametist', color: 0x7c3aed }, { name: 'Şampanya', color: 0xcdbb95 },
  ],
  matte: [
    { name: 'Mat Antrasit', color: 0x2a2f38 }, { name: 'Mat Kum', color: 0xb8a882 },
    { name: 'Mat Ordu Yeşili', color: 0x4a5540 }, { name: 'Mat Bordo', color: 0x5e1f28 },
    { name: 'Mat Lacivert', color: 0x1f2a44 }, { name: 'Mat Gri', color: 0x6b7280 },
    { name: 'Mat Krem', color: 0xd9cfbc }, { name: 'Mat Siyah', color: 0x131519 },
  ],
  neon: [
    { name: 'Neon Camgöbeği', color: 0x22ffe0 }, { name: 'Neon Macenta', color: 0xff2fa0 },
    { name: 'Neon Limon', color: 0xd4ff2f }, { name: 'Neon Menekşe', color: 0x9b5cff },
    { name: 'Neon Turuncu', color: 0xff7a1a }, { name: 'Neon Buz', color: 0x66d9ff },
    { name: 'Neon Yeşil', color: 0x3dff7a }, { name: 'Neon Kırmızı', color: 0xff3355 },
  ],
};

export const UNDERGLOW_COLORS = [
  { name: 'Camgöbeği', color: 0x22e0ff }, { name: 'Macenta', color: 0xff3d81 },
  { name: 'Yeşil', color: 0x35f2a0 }, { name: 'Mor', color: 0x8b5cf6 },
  { name: 'Turuncu', color: 0xff7a1a }, { name: 'Kırmızı', color: 0xff2d3d },
  { name: 'Beyaz', color: 0xdff2ff }, { name: 'Sarı', color: 0xffd23f },
];

export const TINTS = [
  { id: 0, name: 'Yok', opacity: 0.28, color: 0x9fc4e8 },
  { id: 1, name: 'Hafif', opacity: 0.52, color: 0x33465c },
  { id: 2, name: 'Koyu', opacity: 0.74, color: 0x141d29 },
  { id: 3, name: 'Limuzin', opacity: 0.93, color: 0x05080d },
];

export const RIMS = [
  { id: 'stock', name: 'Stok', color: 0x8f98a6, metalness: 0.75, roughness: 0.34, spokes: 5 },
  { id: 'chrome', name: 'Krom', color: 0xe8eef7, metalness: 1.0, roughness: 0.08, spokes: 5 },
  { id: 'gunmetal', name: 'Füme', color: 0x2b313c, metalness: 0.85, roughness: 0.42, spokes: 8 },
  { id: 'bronze', name: 'Bronz', color: 0xb07a34, metalness: 0.9, roughness: 0.26, spokes: 6 },
  { id: 'neon', name: 'Neon Kaplama', color: 0x22ffcc, metalness: 0.5, roughness: 0.2, spokes: 10 },
];

export const ENVIRONMENTS = [
  { id: 'auto', name: 'Otomatik', hint: 'Her yarışta değişir' },
  { id: 'day', name: 'Gündüz', hint: 'Açık gökyüzü' },
  { id: 'sunset', name: 'Gün Batımı', hint: 'Altın saat' },
  { id: 'night', name: 'Gece', hint: 'Farlar ve neon' },
  { id: 'rain', name: 'Yağmur', hint: 'Islak asfalt' },
];

/* =========================== ödül ayarları =========================== */

export const REWARDS = {
  perMetre: 0.05,          // 6 km tamamlamak ≈ 300 coin
  perCoinPickup: 25,       // yoldan toplanan jeton
  perNearMiss: 12,         // sıyırarak geçiş
  nearMissStreakBonus: 4,  // ardışık her sıyırma için ek
  finishBonus: 600,
  winBonus: 900,
  survivalBonus: 250,      // kaza yapmadan bitirme
};

/* ============================== durum ================================ */

function defaultState() {
  return {
    schema: SCHEMA,
    coins: 0,
    lifetimeCoins: 0,
    runs: 0,
    bestDistance: 0,
    owned: ['hatch'],
    selected: 'hatch',
    environment: 'auto',
    // araç kimliği -> { upgrades:{engine,brakes,nitro}, look:{...} }
    garage: {},
  };
}

function defaultEntry(vehicleId) {
  const i = VEHICLES.findIndex((v) => v.id === vehicleId);
  const palette = PAINTS.gloss;
  return {
    upgrades: { engine: 0, brakes: 0, nitro: 0 },
    look: {
      finish: 'gloss',
      paint: palette[(i < 0 ? 0 : i * 3) % palette.length].color,
      underglow: false,
      underglowColor: UNDERGLOW_COLORS[0].color,
      tint: 1,
      rim: 'stock',
    },
  };
}

/** Bilinmeyen/bozuk kayıtları sessizce onarır — oyun asla açılamamazlık etmesin. */
function migrate(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;

  const out = { ...base, ...raw, schema: SCHEMA };
  out.coins = Number.isFinite(raw.coins) ? Math.max(0, Math.floor(raw.coins)) : 0;
  out.lifetimeCoins = Number.isFinite(raw.lifetimeCoins) ? Math.max(0, Math.floor(raw.lifetimeCoins)) : out.coins;
  out.runs = Number.isFinite(raw.runs) ? Math.max(0, Math.floor(raw.runs)) : 0;
  out.bestDistance = Number.isFinite(raw.bestDistance) ? Math.max(0, raw.bestDistance) : 0;

  out.owned = Array.isArray(raw.owned) ? raw.owned.filter((id) => VEHICLE_BY_ID[id]) : [];
  if (!out.owned.includes('hatch')) out.owned.unshift('hatch');
  out.selected = VEHICLE_BY_ID[raw.selected] && out.owned.includes(raw.selected) ? raw.selected : out.owned[0];
  out.environment = ENVIRONMENTS.some((e) => e.id === raw.environment) ? raw.environment : 'auto';

  out.garage = {};
  for (const v of VEHICLES) {
    const src = (raw.garage && raw.garage[v.id]) || {};
    const def = defaultEntry(v.id);
    const up = src.upgrades || {};
    const look = src.look || {};
    out.garage[v.id] = {
      upgrades: {
        engine: clampLevel(up.engine),
        brakes: clampLevel(up.brakes),
        nitro: clampLevel(up.nitro),
      },
      look: {
        finish: FINISHES[look.finish] ? look.finish : def.look.finish,
        paint: Number.isFinite(look.paint) ? look.paint | 0 : def.look.paint,
        underglow: !!look.underglow,
        underglowColor: Number.isFinite(look.underglowColor) ? look.underglowColor | 0 : def.look.underglowColor,
        tint: TINTS[look.tint] ? look.tint : def.look.tint,
        rim: RIMS.some((r) => r.id === look.rim) ? look.rim : def.look.rim,
      },
    };
  }
  return out;
}

function clampLevel(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_UPGRADE_LEVEL, Math.floor(n)));
}

/* ============================== mağaza =============================== */

/**
 * Tek örnek (singleton) garaj deposu.
 * Değişiklikler `subscribe()` ile dinlenebilir; arayüz buna bağlanır.
 */
class Garage {
  constructor() {
    this.state = migrate(readStorage());
    this._listeners = new Set();
    this._writeTimer = 0;
  }

  /* --- kalıcılık ------------------------------------------------------ */

  save() {
    // Aynı karede onlarca kez çağrılabilir (renk sürgüsü); yazmayı topla.
    if (this._writeTimer) return;
    this._writeTimer = setTimeout(() => {
      this._writeTimer = 0;
      writeStorage(this.state);
    }, 120);
  }

  flush() {
    if (this._writeTimer) { clearTimeout(this._writeTimer); this._writeTimer = 0; }
    writeStorage(this.state);
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    for (const fn of this._listeners) {
      try { fn(this.state); } catch (err) { console.error('[garaj] dinleyici hatası', err); }
    }
  }

  _changed() { this.save(); this._emit(); }

  /* --- ekonomi -------------------------------------------------------- */

  get coins() { return this.state.coins; }

  addCoins(n) {
    const amount = Math.max(0, Math.round(n || 0));
    if (!amount) return 0;
    this.state.coins += amount;
    this.state.lifetimeCoins += amount;
    this._changed();
    return amount;
  }

  spend(n) {
    const amount = Math.max(0, Math.round(n || 0));
    if (this.state.coins < amount) return false;
    this.state.coins -= amount;
    this._changed();
    return true;
  }

  /* --- araçlar -------------------------------------------------------- */

  owns(id) { return this.state.owned.includes(id); }

  entry(id) {
    if (!this.state.garage[id]) this.state.garage[id] = defaultEntry(id);
    return this.state.garage[id];
  }

  get selected() { return this.state.selected; }
  get selectedVehicle() { return VEHICLE_BY_ID[this.state.selected] || VEHICLES[0]; }

  select(id) {
    if (!VEHICLE_BY_ID[id] || !this.owns(id)) return false;
    this.state.selected = id;
    this._changed();
    return true;
  }

  /** @returns {{ok:boolean, reason?:string}} */
  buy(id) {
    const v = VEHICLE_BY_ID[id];
    if (!v) return { ok: false, reason: 'Böyle bir araç yok.' };
    if (this.owns(id)) return { ok: false, reason: 'Bu araç zaten senin.' };
    if (this.state.coins < v.price) return { ok: false, reason: 'Yeterli jetonun yok.' };
    this.state.coins -= v.price;
    this.state.owned.push(id);
    this.state.selected = id;
    this._changed();
    return { ok: true };
  }

  /* --- yükseltmeler --------------------------------------------------- */

  level(vehicleId, part) { return this.entry(vehicleId).upgrades[part] || 0; }

  /** Bir sonraki kademenin fiyatı; azami kademedeyse null. */
  upgradePrice(vehicleId, part) {
    const spec = UPGRADES[part];
    const lvl = this.level(vehicleId, part);
    if (!spec || lvl >= MAX_UPGRADE_LEVEL) return null;
    const v = VEHICLE_BY_ID[vehicleId];
    // Daha hızlı araçların parçaları daha pahalı — ilerlemeyi düzleştirir.
    const tierScale = 1 + (VEHICLES.indexOf(v) * 0.28);
    return Math.round(spec.prices[lvl] * tierScale / 50) * 50;
  }

  upgrade(vehicleId, part) {
    const price = this.upgradePrice(vehicleId, part);
    if (price == null) return { ok: false, reason: 'Bu parça zaten tam.' };
    if (!this.owns(vehicleId)) return { ok: false, reason: 'Önce aracı satın al.' };
    if (this.state.coins < price) return { ok: false, reason: 'Yeterli jetonun yok.' };
    this.state.coins -= price;
    this.entry(vehicleId).upgrades[part] += 1;
    this._changed();
    return { ok: true, price };
  }

  /* --- görünüm -------------------------------------------------------- */

  look(vehicleId) { return this.entry(vehicleId).look; }

  setLook(vehicleId, patch) {
    Object.assign(this.entry(vehicleId).look, patch);
    this._changed();
  }

  setEnvironment(id) {
    if (!ENVIRONMENTS.some((e) => e.id === id)) return;
    this.state.environment = id;
    this._changed();
  }

  /* --- koşu sonu ------------------------------------------------------ */

  recordRun({ distance = 0, coins = 0 } = {}) {
    this.state.runs += 1;
    this.state.bestDistance = Math.max(this.state.bestDistance, distance);
    if (coins > 0) {
      this.state.coins += Math.round(coins);
      this.state.lifetimeCoins += Math.round(coins);
    }
    this._changed();
  }
}

/* ======================= türetilmiş istatistikler ===================== */

/**
 * Araç tabanı + yükseltmelerden sürüş parametrelerini hesaplar.
 * Oyun döngüsü DRIVE yerine bunu okur.
 *
 * @param {string} vehicleId
 * @param {{engine:number,brakes:number,nitro:number}} upgrades
 */
export function computeStats(vehicleId, upgrades = { engine: 0, brakes: 0, nitro: 0 }) {
  const v = VEHICLE_BY_ID[vehicleId] || VEHICLES[0];
  const b = v.stats;
  const e = clampLevel(upgrades.engine);
  const br = clampLevel(upgrades.brakes);
  const ni = clampLevel(upgrades.nitro);

  return {
    id: v.id,
    topSpeed: b.topSpeed * (1 + UPGRADES.engine.per.topSpeed * e),
    accel: b.accel * (1 + UPGRADES.engine.per.accel * e),
    brake: b.brake * (1 + UPGRADES.brakes.per.brake * br),
    grip: b.grip * (1 + UPGRADES.brakes.per.grip * br),
    nitro: {
      capacity: b.nitro.capacity * (1 + UPGRADES.nitro.per.capacity * ni),
      refill: b.nitro.refill * (1 + UPGRADES.nitro.per.refill * ni),
      boost: b.nitro.boost + UPGRADES.nitro.per.boost * ni,
    },
  };
}

/** Yükseltmeler tam takılsaydı ulaşılacak tavan — arayüzdeki gri "potansiyel" çubuğu. */
export function maxStats(vehicleId) {
  return computeStats(vehicleId, { engine: MAX_UPGRADE_LEVEL, brakes: MAX_UPGRADE_LEVEL, nitro: MAX_UPGRADE_LEVEL });
}

/**
 * Çubuk grafik için 0..1 aralığına normalize edilmiş dört gösterge.
 * Ölçek, garajdaki en iyi araç tam yükseltmeliyken 1'e yaklaşacak şekilde sabit.
 */
const SCALE = (() => {
  const best = maxStats(VEHICLES[VEHICLES.length - 1].id);
  return {
    topSpeed: best.topSpeed * 1.02,
    accel: best.accel * 1.02,
    grip: best.grip * 1.02,
    nitro: best.nitro.capacity * 1.02,
  };
})();

export function statBars(stats) {
  return [
    { key: 'topSpeed', name: 'Tavan Hız', value: stats.topSpeed / SCALE.topSpeed, text: `${Math.round(stats.topSpeed * 3.6)} km/s` },
    { key: 'accel', name: 'İvme', value: stats.accel / SCALE.accel, text: `${stats.accel.toFixed(1)} m/s²` },
    { key: 'grip', name: 'Yol Tutuş', value: stats.grip / SCALE.grip, text: `${Math.round(stats.grip * 100)}` },
    { key: 'nitro', name: 'Nitro', value: stats.nitro.capacity / SCALE.nitro, text: `${stats.nitro.capacity.toFixed(1)} sn` },
  ];
}

/* ============================ localStorage =========================== */

function readStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    // Gizli sekme / kota dolu / bozuk JSON — hiçbiri oyunu durdurmamalı.
    console.warn('[garaj] kayıt okunamadı, sıfırdan başlanıyor', err);
    return null;
  }
}

function writeStorage(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[garaj] kayıt yazılamadı', err);
  }
}

export const garage = new Garage();

// Sekme kapanırken bekleyen yazmayı zorla — son yarışın jetonu kaybolmasın.
addEventListener('pagehide', () => garage.flush());
addEventListener('visibilitychange', () => { if (document.hidden) garage.flush(); });
