/* Headless duman testi — modülerleştirmenin oyun mantığını bozmadığını doğrular.
 *
 *   node test/smoke.mjs            -> public/index.html neyi işaret ediyorsa onu test eder
 *
 * `?debug=1` kancasını (window.__cfs) kullanır: sunucusuz tek kişilik bir yarış
 * başlatır, fiziği sabit adımlarla ilerletir ve ölçülebilir bir anlık görüntü
 * döndürür. Çıktı JSON olarak stdout'a yazılır; iki sürümün çıktısı birebir
 * karşılaştırılabilir.
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
const PORT = Number(process.env.SMOKE_PORT) || 3210;
const PAGE_URL = `http://localhost:${PORT}/?debug=1`;

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

const bail = (msg, err) => {
  console.error(msg, err || '');
  server.kill();
  process.exit(1);
};

await sleep(1200);

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--ignore-certificate-errors',
  ],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true });

/* three.js normalde unpkg'den iner. Ağı kapalı bir ortamda (CI, kum havuzu)
   aynı sürümü yerele kurup yolunu SMOKE_VENDOR ile verebilirsin:

       npm i three@0.161.0 --prefix /tmp/three-vendor
       SMOKE_VENDOR=/tmp/three-vendor node test/smoke.mjs

   Klasör yoksa istekler doğrudan unpkg'ye gider. Oyun kodu ve index.html'in
   import map'i her iki durumda da hiç değişmez — sadece baytların kaynağı. */
const MIME = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
const useVendor = existsSync(path.join(VENDOR, 'node_modules', 'three', 'build', 'three.module.js'));
if (useVendor) await page.route('https://unpkg.com/**', async (route) => {
  const url = new URL(route.request().url());
  const rel = url.pathname.replace(/^\/three@[^/]+\//, '');
  const file = path.join(VENDOR, 'node_modules', 'three', rel);
  try {
    const body = await readFile(file);
    route.fulfill({
      status: 200,
      body,
      headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' },
    });
  } catch {
    route.fulfill({ status: 404, body: `vendored three.js miss: ${rel}` });
  }
});

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack ? e.stack : e)));
page.on('requestfailed', (r) => failedRequests.push(`${r.url()} :: ${r.failure()?.errorText}`));

try {
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // boot() bitti mi: yükleme ekranı gizlenip lobi açılınca.
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden') && !!window.__cfs,
    null,
    { timeout: 180000 }
  );

  const result = await page.evaluate(async () => {
    const out = {};
    const cfs = window.__cfs;

    out.bootSnapshot = cfs.snapshot();

    cfs.startSolo(12345);
    // Fiziği çizimden bağımsız, sabit 60 Hz ile 25 saniye ilerlet.
    out.driveA = cfs.drive({ seconds: 25, throttle: true, nitro: false, weave: 0 });
    out.carsAfterDrive = cfs.cars();

    // Nitro + şerit dokuması: sıyırma / jeton / nitro yolları da çalışsın.
    cfs.startSolo(4242);
    out.driveB = cfs.drive({ seconds: 25, throttle: true, nitro: true, weave: 1.5 });

    // Ortam geçişleri (atmosfer bağları).
    for (const env of ['day', 'sunset', 'rain', 'night']) {
      try { cfs.setEnv(env, true); } catch (e) { out.envError = String(e); }
    }
    out.envAfter = cfs.snapshot().env;

    // Birkaç gerçek kare çizilsin ki renderer yolu da sınansın.
    await new Promise((r) => {
      let n = 0;
      const step = () => (++n < 20 ? requestAnimationFrame(step) : r());
      requestAnimationFrame(step);
    });
    out.finalSnapshot = cfs.snapshot();
    return out;
  });

  // Gerçek zamanlı çizim: kaç kare, hata var mı.
  await sleep(1500);

  const report = {
    ok: pageErrors.length === 0,
    pageErrors,
    consoleErrors,
    failedRequests: failedRequests.filter((u) => !u.includes('favicon')),
    ...result,
  };
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  server.kill();
  process.exit(report.ok ? 0 : 2);
} catch (err) {
  console.log(JSON.stringify({ ok: false, crashed: String(err), pageErrors, consoleErrors, failedRequests }, null, 2));
  await browser.close().catch(() => {});
  bail('smoke test failed', err);
}
