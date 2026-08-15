/* İki istemcili uçtan uca test — modülerleştirmenin ağ / oda / maç
 * yollarını bozmadığını doğrular.
 *
 *   node test/multiplayer.mjs
 *
 * Akış:
 *   A oda kurar -> B kodla katılır -> ikisi de HAZIR -> match:countdown ->
 *   geri sayım -> racing -> A garajı açıp kapatır -> B ayrılır ->
 *   A'da match:over + ödeme tablosu.
 *
 * Bu, `network.js`, `garage-link.js` ve oyun döngüsünün gerçek bir
 * socket.io sunucusuyla birlikte çalıştığını gösterir.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const VENDOR = process.env.SMOKE_VENDOR || '/home/claude/three-vendor';
const PORT = Number(process.env.SMOKE_PORT) || 3212;
const BASE = `http://localhost:${PORT}`;

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
await sleep(1200);

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--no-sandbox', '--ignore-certificate-errors'],
});

/* three.js normalde unpkg'den iner; ağı kapalı ortamlarda SMOKE_VENDOR ile
   yerel bir kurulum gösterilebilir (bkz. test/smoke.mjs başlığı). */
const MIME = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
const useVendor = existsSync(path.join(VENDOR, 'node_modules', 'three', 'build', 'three.module.js'));
const errors = { A: [], B: [] };

async function openClient(tag) {
  // Küçük tuval: yazılım rasterleştirici piksel başına ödeme yapıyor.
  // İki sekme birden 1024x640 çizerken ana iş parçacığı öyle uzun süre
  // kilitleniyor ki socket.io'nun 20 sn'lik pingTimeout'u doluyor ve
  // istemci odadan düşüyor — test edilen mantıkla ilgisiz bir ortam
  // sınırlaması. 360x240'ta aynı kod yolları çalışır, kare bütçesi yeter.
  const page = await browser.newPage({ viewport: { width: 360, height: 240 } });
  // Yazılım rasterleştirici altında iki sekme birden ~1 fps'e düşüyor;
  // Playwright'ın etkileşim yoklamaları buna göre sabırlı olmalı.
  page.setDefaultTimeout(120000);
  if (useVendor) await page.route('https://unpkg.com/**', async (route) => {
    const u = new URL(route.request().url());
    const rel = u.pathname.replace(/^\/three@[^/]+\//, '');
    try {
      const body = await readFile(path.join(VENDOR, 'node_modules', 'three', rel));
      route.fulfill({ status: 200, body, headers: { 'content-type': MIME[path.extname(rel)] || 'application/octet-stream' } });
    } catch { route.fulfill({ status: 404, body: 'miss' }); }
  });
  page.on('pageerror', (e) => errors[tag].push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors[tag].push(m.text()); });
  await page.goto(`${BASE}/?debug=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden') && !!window.__cfs,
    null, { timeout: 180000 });
  return page;
}

/* Yazılım rasterleştirici altında sayfa ~1 fps çiziyor; Playwright'ın
   "görünür / kararlı mı" yoklamaları bileşik kare anlık görüntüsüne baktığı
   için bu hızda güvenilmez oluyor. Tıklamaları DOM üzerinden gönderiyoruz:
   gerçek bir `click` olayı üretilir, yani kayıtlı dinleyiciler aynen çalışır
   — sadece etkileşilebilirlik yoklaması atlanır. */
const click = (page, sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  if (!n) throw new Error(`yok: ${s}`);
  n.click();
}, sel);

const typeCode = (page, sel, value) => page.evaluate(([s, v]) => {
  const n = document.querySelector(s);
  n.value = v;
  n.dispatchEvent(new Event('input', { bubbles: true }));
}, [sel, value]);

const out = {};
const pages = {};
try {
  const A = await openClient('A');
  const B = await openClient('B');
  pages.A = A; pages.B = B;

  /* --- 1. garaj: aç, sekmeleri gez, kapat ------------------------------ */
  await click(A, '#btn-garage');
  await A.waitForFunction(() => !document.getElementById('garage').classList.contains('hidden'), null, { timeout: 15000 });
  out.garageOpened = true;
  out.garageVehicleCount = await A.evaluate(() => document.querySelectorAll('#vehicle-list .veh-card, #vehicle-list > *').length);
  for (const tab of ['tune', 'style', 'env', 'stats']) {
    await click(A, `.tab[data-tab="${tab}"]`);
    await sleep(120);
  }
  out.garageTabsOk = await A.evaluate(() => !document.getElementById('tab-stats').classList.contains('hidden'));
  await click(A, '#garage-back');
  await A.waitForFunction(() => document.getElementById('garage').classList.contains('hidden'), null, { timeout: 15000 });
  out.garageClosed = await A.evaluate(() => !document.getElementById('lobby').classList.contains('hidden'));

  /* --- 2. oda kur / katıl ---------------------------------------------- */
  // Ana menü artık mod seçimiyle açılıyor: önce "Çok Oyunculu" sahnesine geç.
  await click(A, '#btn-multi');
  await click(B, '#btn-multi');
  await A.waitForFunction(
    () => !document.getElementById('lobby-entry').classList.contains('hidden'),
    null, { timeout: 15000 });

  await click(A, '#btn-create');
  await A.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.getElementById('room-code').textContent || ''), null, { timeout: 20000 });
  const code = await A.evaluate(() => document.getElementById('room-code').textContent);
  out.roomCode = code;

  await typeCode(B, '#join-code', code);
  await click(B, '#btn-join');
  await B.waitForFunction((c) => window.__cfs.G.roomCode === c, code, { timeout: 30000 });
  // İki istemcide de oda listesi iki kişiye çıkmalı (room:update yolu).
  await A.waitForFunction(() => window.__cfs.G.players.length === 2, null, { timeout: 30000 });
  await B.waitForFunction(() => window.__cfs.G.players.length === 2, null, { timeout: 30000 });
  out.bothInRoom = true;
  out.slotNames = await A.evaluate(() =>
    [...document.querySelectorAll('#player-list .pname')].map((n) => n.textContent));

  /* --- 3. ikisi de hazır -> geri sayım -> yarış ------------------------- */
  // Hazır düğmesi iki oyuncu gelene kadar disabled — beklemeden tıklamak sessizce düşerdi.
  await A.waitForFunction(() => !document.getElementById('btn-ready').disabled, null, { timeout: 20000 });
  await B.waitForFunction(() => !document.getElementById('btn-ready').disabled, null, { timeout: 20000 });
  /* Faz geçişlerini sayfanın İÇİNDE kaydet. Geri sayım yalnızca 3 saniye
     sürüyor ve yazılım rasterleştiricide kare hızı ~1 fps; Playwright'ın
     rAF tabanlı yoklaması o pencereyi kaçırıyordu. setInterval kare
     hızından bağımsız çalışır, yani 'countdown' adımı kesin yakalanır. */
  const watchPhases = (p) => p.evaluate(() => {
    window.__phases = [window.__cfs.G.phase];
    setInterval(() => {
      const ph = window.__cfs.G.phase;
      if (window.__phases[window.__phases.length - 1] !== ph) window.__phases.push(ph);
    }, 25);
  });
  await watchPhases(A);
  await watchPhases(B);

  await click(A, '#btn-ready');
  await sleep(300);
  await click(B, '#btn-ready');

  await A.waitForFunction(() => window.__cfs.G.phase === 'racing', null, { timeout: 40000, polling: 100 });
  await B.waitForFunction(() => window.__cfs.G.phase === 'racing', null, { timeout: 40000, polling: 100 });
  out.racingReached = true;
  out.phaseSequence = {
    A: await A.evaluate(() => window.__phases),
    B: await B.evaluate(() => window.__phases),
  };
  out.countdownReached = out.phaseSequence.A.includes('countdown');
  out.countdownText = await A.evaluate(() => document.getElementById('count-number').textContent);

  // Gerçek zamanda birkaç saniye sür: paketler aksın, HUD güncellensin.
  await A.evaluate(() => { window.__cfs.G.me.speed = 60; });
  await sleep(9000);

  out.duringRace = {
    A: await A.evaluate(() => ({
      phase: window.__cfs.G.phase,
      distance: Math.round(window.__cfs.G.me.distance),
      rivalBuffer: window.__cfs.G.rival.buffer.length,
      rivalDistance: Math.round(window.__cfs.G.rival.distance),
      trafficSpawned: window.__cfs.G.traffic.size,
      hudSpeed: document.getElementById('speed').textContent,
      hudDistance: document.getElementById('prog-distance').textContent,
      gap: document.getElementById('gap').textContent,
      ping: document.getElementById('ping').textContent,
      pipActive: document.querySelectorAll('#lane-pips i.active').length,
    })),
    B: await B.evaluate(() => ({
      phase: window.__cfs.G.phase,
      distance: Math.round(window.__cfs.G.me.distance),
      rivalBuffer: window.__cfs.G.rival.buffer.length,
    })),
  };

  /* --- 4. şerit değiştir: girdi olayları gerçekten bağlı mı ------------- */
  const laneBefore = await A.evaluate(() => window.__cfs.G.me.targetLane);
  await A.keyboard.press('KeyA');
  await sleep(200);
  const laneAfter = await A.evaluate(() => window.__cfs.G.me.targetLane);
  out.laneChange = { before: laneBefore, after: laneAfter, moved: laneAfter !== laneBefore };

  /* --- 5. B ayrılır -> A'da match:over + ödeme -------------------------- */
  delete pages.B;
  await B.close();
  await A.waitForFunction(() => window.__cfs.G.phase === 'over', null, { timeout: 40000, polling: 100 });
  await sleep(1500);
  out.matchOver = await A.evaluate(() => ({
    phase: window.__cfs.G.phase,
    title: document.getElementById('result-title').textContent,
    sub: document.getElementById('result-sub').textContent,
    resultRows: document.getElementById('result-list').children.length,
    payoutHtmlLength: document.getElementById('payout').innerHTML.length,
    payoutHasTotal: document.getElementById('payout').innerHTML.includes('pay-total'),
    coinsBanked: window.__cfs.snapshot().coins,
    gameoverVisible: !document.getElementById('gameover').classList.contains('hidden'),
  }));

  out.errors = errors;
  out.ok = errors.A.length === 0 && errors.B.length === 0;
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
  server.kill();
  process.exit(out.ok ? 0 : 2);
} catch (err) {
  // Hata anında iki istemcinin de durumunu dök: hangi adımda tıkandığı
  // tahmine kalmasın.
  const dump = async (p, tag) => {
    try {
      out[`state_${tag}`] = await p.evaluate(() => ({
        phase: window.__cfs.G.phase,
        roomCode: window.__cfs.G.roomCode,
        players: window.__cfs.G.players.length,
        roomCodeText: document.getElementById('room-code').textContent,
        joinValue: document.getElementById('join-code').value,
        readyDisabled: document.getElementById('btn-ready').disabled,
        lobbyRoomHidden: document.getElementById('lobby-room').classList.contains('hidden'),
        lobbyStatus: document.getElementById('lobby-status').textContent,
        toasts: [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent),
      }));
    } catch { out[`state_${tag}`] = 'unavailable'; }
  };
  for (const [tag, p] of Object.entries(pages)) await dump(p, tag);
  console.log(JSON.stringify({ ok: false, crashed: String(err), out, errors }, null, 2));
  await browser.close().catch(() => {});
  server.kill();
  process.exit(1);
}
