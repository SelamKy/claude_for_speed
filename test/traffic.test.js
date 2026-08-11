const { CONFIG, makeRng, spawnTraffic, scheduleNextSpawn, trafficZAt } = require('../server.js');

/** Sürücüyü taklit et: iki oyuncu farklı hızlarda ilerlesin. */
function simulate(seed, { durationMs = 150000, leadSpeed = 68, rearSpeed = 58 } = {}) {
  const room = { code: 'T' + seed, rng: makeRng(seed), trafficSeq: 0, traffic: [], nextSpawnAt: 1400 };
  const events = [];
  let attempts = 0, vetoed = 0, peakActive = 0;
  while (room.nextSpawnAt <= durationMs) {
    const t = room.nextSpawnAt;
    const frontier = { lead: leadSpeed * t / 1000, rear: rearSpeed * t / 1000 };
    attempts++;
    const e = spawnTraffic(room, t, frontier);
    if (e) events.push({ ...e, frontier }); else vetoed++;
    peakActive = Math.max(peakActive, room.traffic.length);
    scheduleNextSpawn(room, t);
  }
  return { events, attempts, vetoed, peakActive, durationMs, leadSpeed, rearSpeed };
}

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name.padEnd(46) + detail);
  if (!ok) fails++;
};

/* 1 — determinizm */
const a = simulate(12345), b = simulate(12345), c = simulate(99999);
const k = (r) => JSON.stringify(r.events.map(e => [e.id, e.lane, e.z, e.speed, e.model, e.variant, e.raceTime]));
check('aynı tohum -> birebir aynı trafik', k(a) === k(b), a.events.length + ' araç');
check('farklı tohum -> farklı trafik', k(a) !== k(c));

/* 2 — yoğunluk */
const perMin = a.events.length / (a.durationMs / 60000);
check('yoğunluk makul (25-60 araç/dk)', perMin > 25 && perMin < 60,
  perMin.toFixed(1) + '/dk, ' + a.vetoed + '/' + a.attempts + ' veto, en fazla ' + a.peakActive + ' canlı');

/* 3 — aynı şeritteki araçlar arası mesafe, İKİSİ DE oyun penceresindeyken */
let worst = Infinity, viol = 0;
for (let i = 0; i < a.events.length; i++) {
  for (let j = i + 1; j < a.events.length; j++) {
    const x = a.events[i], y = a.events[j];
    if (x.lane !== y.lane) continue;
    for (let t = Math.max(x.raceTime, y.raceTime); t < a.durationMs; t += 200) {
      const rear = a.rearSpeed * t / 1000, lead = a.leadSpeed * t / 1000;
      const zx = trafficZAt(x, t), zy = trafficZAt(y, t);
      const live = (z) => z > rear - 60 && z < lead + 420;   // oyuncuların görebildiği bant
      if (!live(zx) || !live(zy)) continue;
      const d = Math.abs(zx - zy);
      if (d < worst) worst = d;
      if (d < CONFIG.MIN_LANE_GAP - 0.5) viol++;
    }
  }
}
check('aynı şeritte asla ' + CONFIG.MIN_LANE_GAP + ' m altına düşmez', viol === 0,
  'en dar an ' + (worst === Infinity ? 'n/a' : worst.toFixed(1) + ' m'));

/* 4 — hiçbir anda yol tamamen kapanmaz */
let worstWall = 0;
for (let t = 2000; t < a.durationMs; t += 200) {
  const rear = a.rearSpeed * t / 1000;
  const live = a.events.filter(e => e.raceTime <= t)
    .map(e => ({ lane: e.lane, z: trafficZAt(e, t) }))
    .filter(e => e.z > rear - 60 && e.z < rear + 500);
  for (const probe of live) {
    const lanes = new Set(live.filter(e => Math.abs(e.z - probe.z) < CONFIG.BLOCK_WINDOW).map(e => e.lane));
    worstWall = Math.max(worstWall, lanes.size);
  }
}
check('yol asla tamamen kapanmaz (>=1 şerit açık)', worstWall < CONFIG.LANE_COUNT,
  'en kötü durumda ' + worstWall + '/' + CONFIG.LANE_COUNT + ' şerit kapalı');

/* 5 — trafik yarışın sonuna kadar sürüyor mu (eski hata: bir süre sonra kesiliyordu) */
const lastQuarter = a.events.filter(e => e.raceTime > a.durationMs * 0.75).length;
check('trafik son çeyrekte de üretiliyor', lastQuarter > 10, lastQuarter + ' araç');
const aheadOfLead = a.events.every(e => e.z >= e.frontier.lead + CONFIG.SPAWN_AHEAD - 0.001);
check('her araç önde giden oyuncunun ilerisinde doğuyor', aheadOfLead);

/* 6 — dağılımlar */
const tally = (f) => a.events.reduce((m, e) => (m[f(e)] = (m[f(e)] || 0) + 1, m), {});
const models = tally(e => e.model), lanes = tally(e => e.lane);
const modelCounts = CONFIG.TRAFFIC_MODELS.map(m => models[m] || 0);
check('üç NPC modeli de kullanılıyor', modelCounts.every(n => n > a.events.length * 0.15),
  JSON.stringify(models));
check('dört şerit de kullanılıyor', Object.keys(lanes).length === CONFIG.LANE_COUNT, JSON.stringify(lanes));
check('renk varyantları dağılıyor', Object.keys(tally(e => e.variant)).length === CONFIG.TRAFFIC_COLORS,
  JSON.stringify(tally(e => e.variant)));

/* 7 — farklı sürüş temposunda da sağlam */
for (const [lead, rear] of [[45, 42], [82, 50], [60, 60]]) {
  const s = simulate(777, { leadSpeed: lead, rearSpeed: rear });
  check('tempo ' + lead + '/' + rear + ' m/s -> makul akış',
    s.events.length > 40 && s.peakActive <= CONFIG.MAX_ACTIVE_TRAFFIC,
    s.events.length + ' araç, en fazla ' + s.peakActive + ' canlı');
}

console.log('\n' + (fails ? fails + ' TEST BAŞARISIZ' : 'tüm testler geçti'));
process.exit(fails ? 1 : 0);
