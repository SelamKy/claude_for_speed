/* =====================================================================
   Claude for Speed — Garaj ekranı (arayüz + 3B önizleme)
   ---------------------------------------------------------------------
   Önizleme İKİNCİ bir WebGL bağlamı açmaz. Ana renderer'ın canvas'ında,
   garaj panelindeki "sahne penceresi"nin ekran dikdörtgenine scissor +
   viewport kurulup oraya çizim yapılır. Böylece:
     • ikinci bir GL bağlamının maliyeti ve bağlam-kaybı riski yok,
     • yarışta yüklenen prefablar ve IBL doğrudan yeniden kullanılıyor,
     • garaj açıkken ana sahne hiç çizilmediği için kare süresi düşüyor.

   Ekran, `garage` deposunu dinler: satın alma/yükseltme yapıldığında
   depo `subscribe()` üzerinden haber verir ve arayüz kendini yeniler.
   Arayüz hiçbir zaman durumu doğrudan değiştirmez.
   ===================================================================== */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import {
  garage, VEHICLES, VEHICLE_BY_ID, UPGRADE_LIST, MAX_UPGRADE_LEVEL,
  PAINTS, FINISHES, UNDERGLOW_COLORS, TINTS, RIMS, ENVIRONMENTS,
  computeStats, maxStats, statBars,
} from './garage.js';

const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, '0')}`;
const coins = (n) => Math.round(n).toLocaleString('tr-TR');

/* ============================== ekran ================================= */

export class GarageScreen {
  /**
   * @param {object} deps
   * @param {THREE.WebGLRenderer} deps.renderer
   * @param {(vehicleId:string, look:object)=>THREE.Object3D|null} deps.makeCar
   *        Verilen araç için tam donanımlı bir 3B örnek üretir (game.js sağlar).
   * @param {(id:string)=>void} [deps.onEnvironmentChange]
   * @param {()=>void} [deps.onClose]
   */
  constructor({ renderer, makeCar, onEnvironmentChange, onClose }) {
    this.renderer = renderer;
    this.makeCar = makeCar;
    this.onEnvironmentChange = onEnvironmentChange || (() => {});
    this.onClose = onClose || (() => {});

    this.root = document.getElementById('garage');
    this.stage = document.getElementById('preview-stage');
    this.open = false;
    this.viewing = garage.selected;
    this.tab = 'stats';

    this._buildScene();
    this._cacheDom();
    this._bindEvents();

    this._unsubscribe = garage.subscribe(() => { if (this.open) this.refresh(); });
  }

  /* ------------------------------ 3B sahne --------------------------- */

  _buildScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0f1a);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 120);

    const hemi = new THREE.HemisphereLight(0xbcd8ff, 0x0b0f18, 1.1);
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-6, 9, 7);
    const fill = new THREE.DirectionalLight(0x5fd0ff, 1.0);
    fill.position.set(7, 3, -6);
    const rim = new THREE.DirectionalLight(0xff5fa2, 0.9);
    rim.position.set(2, 4, -9);
    this.scene.add(hemi, key, fill, rim);

    // Turntable: araç bunun altında durur, biz platformu döndürürüz.
    this.turntable = new THREE.Group();
    this.scene.add(this.turntable);

    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(3.6, 3.6, 0.08, 48),
      new THREE.MeshStandardMaterial({ color: 0x11172a, roughness: 0.35, metalness: 0.7 }),
    );
    disc.position.y = -0.04;
    this.scene.add(disc);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(3.6, 3.9, 64),
      new THREE.MeshBasicMaterial({ color: 0x22e0ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    this.scene.add(ring);
    this.ring = ring;

    this.car = null;
    this.spin = 0.6;          // rad — başlangıç açısı
    this.autoSpin = true;
    this.dragging = false;
  }

  /** Görüntülenen aracın 3B örneğini (yeniden) kurar. */
  _rebuildCar() {
    if (this.car) {
      this.turntable.remove(this.car);
      disposeTree(this.car);
      this.car = null;
    }
    const look = garage.look(this.viewing);
    const car = this.makeCar(this.viewing, look);
    if (!car) return;
    this.car = car;
    this.turntable.add(car);

    // Kamerayı aracın gerçek boyuna göre çerçevele — 4 m'lik hatchback de,
    // 5 m'lik kas araba da aynı dolulukta görünsün.
    const len = car.userData.length || 4.5;
    const h = car.userData.height || 1.4;
    this.camera.position.set(len * 1.12, h * 1.9, len * 1.72);
    this.camera.lookAt(0, h * 0.55, 0);
    this.ring.scale.setScalar(Math.max(0.85, len / 4.7));
  }

  /* ------------------------------- DOM ------------------------------- */

  _cacheDom() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      back: $('garage-back'),
      wallet: $('wallet-coins'),
      list: $('vehicle-list'),
      name: $('veh-name'),
      tag: $('veh-tag'),
      blurb: $('veh-blurb'),
      buy: $('btn-buy'),
      select: $('btn-select'),
      tabs: this.root.querySelectorAll('.tab'),
      panels: {
        stats: $('tab-stats'),
        tune: $('tab-tune'),
        style: $('tab-style'),
        env: $('tab-env'),
      },
      note: $('garage-note'),
    };
  }

  _bindEvents() {
    this.el.back.addEventListener('click', () => this.close());

    this.el.buy.addEventListener('click', () => {
      const res = garage.buy(this.viewing);
      this._note(res.ok ? `${VEHICLE_BY_ID[this.viewing].name} garajına girdi!` : res.reason, res.ok);
      if (res.ok) this._rebuildCar();
    });

    this.el.select.addEventListener('click', () => {
      if (garage.select(this.viewing)) this._note('Bu araçla yarışacaksın.', true);
    });

    this.el.tabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.tab = btn.dataset.tab;
        this.refresh();
      });
    });

    /* --- önizlemeyi sürükleyerek çevir ------------------------------- */
    const stage = this.stage;
    let lastX = 0;
    const down = (e) => {
      this.dragging = true;
      this.autoSpin = false;
      lastX = (e.touches ? e.touches[0].clientX : e.clientX);
      stage.setPointerCapture?.(e.pointerId ?? 1);
    };
    const move = (e) => {
      if (!this.dragging) return;
      const x = (e.touches ? e.touches[0].clientX : e.clientX);
      this.spin -= (x - lastX) * 0.009;
      lastX = x;
    };
    const up = () => {
      if (!this.dragging) return;
      this.dragging = false;
      // Kullanıcı bıraktıktan 2.5 sn sonra tabla kendi kendine dönmeye devam etsin.
      clearTimeout(this._spinTimer);
      this._spinTimer = setTimeout(() => { this.autoSpin = true; }, 2500);
    };
    stage.addEventListener('pointerdown', down);
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    stage.addEventListener('touchstart', down, { passive: true });
    stage.addEventListener('touchmove', move, { passive: true });
    stage.addEventListener('touchend', up);
  }

  _note(msg, good) {
    if (!this.el.note) return;
    this.el.note.textContent = msg || '';
    this.el.note.className = `garage-note ${good ? 'ok' : 'err'}`;
    clearTimeout(this._noteTimer);
    this._noteTimer = setTimeout(() => { this.el.note.textContent = ''; }, 2600);
  }

  /* ---------------------------- yaşam döngüsü ------------------------ */

  show() {
    this.open = true;
    this.viewing = garage.selected;
    this.root.classList.remove('hidden');
    document.body.classList.add('garage-open');
    this._rebuildCar();
    this.refresh();
  }

  close() {
    this.open = false;
    this.root.classList.add('hidden');
    document.body.classList.remove('garage-open');
    garage.flush();
    this.onClose();
  }

  dispose() {
    this._unsubscribe?.();
    if (this.car) disposeTree(this.car);
    this.scene.environment?.dispose();
  }

  /* ------------------------------ çizim ------------------------------ */

  /**
   * Ana renderer'ın canvas'ında sadece sahne penceresine çizer.
   *
   * Önce TÜM canvas düz koyu bir renge temizlenir: garaj ekranının kendi
   * arka planı yok (olsaydı canvas ile "sahne penceresi" arasına girip
   * aracı gizlerdi), dolayısıyla ekranın geri kalanının arkasındaki düz
   * zemini burada üretiyoruz. Ardından scissor ile yalnızca pencere
   * dikdörtgenine önizleme sahnesi çizilir.
   */
  renderFrame(dt) {
    if (!this.open) return;
    if (this.autoSpin && !this.dragging) this.spin += dt * 0.32;
    this.turntable.rotation.y = this.spin;

    const canvas = this.renderer.domElement;
    const rect = this.stage.getBoundingClientRect();
    const vw = canvas.clientWidth;
    const vh = canvas.clientHeight;

    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, vw, vh);
    this.renderer.setClearColor(0x070b14, 1);
    this.renderer.clear(true, true, false);

    if (rect.width < 8 || rect.height < 8) return;

    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();

    // setViewport/setScissor piksel oranını kendisi uyguladığı için CSS
    // birimleri veriyoruz; WebGL'in y ekseni aşağıdan yukarı olduğundan
    // dikdörtgenin ALT kenarını taban alıyoruz.
    const cssX = rect.left;
    const cssY = vh - rect.bottom;
    this.renderer.setViewport(cssX, cssY, rect.width, rect.height);
    this.renderer.setScissor(cssX, cssY, rect.width, rect.height);
    this.renderer.setScissorTest(true);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, vw, vh);
  }

  /* ------------------------------ yenileme --------------------------- */

  refresh() {
    if (!this.open) return;
    this.el.wallet.textContent = coins(garage.coins);
    this._renderList();
    this._renderStage();
    this._renderTabs();
  }

  _renderList() {
    const frag = document.createDocumentFragment();
    for (const v of VEHICLES) {
      const owned = garage.owns(v.id);
      const equipped = garage.selected === v.id;
      const card = document.createElement('button');
      card.className = [
        'veh-card',
        this.viewing === v.id ? 'viewing' : '',
        owned ? 'owned' : 'locked',
        equipped ? 'equipped' : '',
      ].join(' ');
      const lvl = UPGRADE_LIST.reduce((s, u) => s + garage.level(v.id, u.id), 0);
      card.innerHTML = `
        <span class="vc-top">
          <span class="vc-name">${v.name}</span>
          <span class="vc-tag">${v.tag}</span>
        </span>
        <span class="vc-bottom">
          ${owned
            ? `<span class="vc-owned">${equipped ? 'Seçili' : 'Garajda'}</span>`
            : `<span class="vc-price"><i class="coin">◈</i>${coins(v.price)}</span>`}
          <span class="vc-tune" title="Takılı yükseltme kademesi">${lvl}/${UPGRADE_LIST.length * MAX_UPGRADE_LEVEL}</span>
        </span>`;
      card.addEventListener('click', () => {
        if (this.viewing === v.id) return;
        this.viewing = v.id;
        this._rebuildCar();
        this.refresh();
      });
      frag.appendChild(card);
    }
    this.el.list.replaceChildren(frag);
  }

  _renderStage() {
    const v = VEHICLE_BY_ID[this.viewing];
    const owned = garage.owns(v.id);
    const equipped = garage.selected === v.id;

    this.el.name.textContent = v.name;
    this.el.tag.textContent = v.tag;
    this.el.blurb.textContent = v.blurb;

    this.el.buy.classList.toggle('hidden', owned);
    this.el.select.classList.toggle('hidden', !owned);

    if (!owned) {
      const can = garage.coins >= v.price;
      this.el.buy.textContent = `Satın Al · ◈ ${coins(v.price)}`;
      this.el.buy.disabled = !can;
      this.el.buy.title = can ? '' : 'Yeterli jetonun yok';
    } else {
      this.el.select.textContent = equipped ? 'Seçili Araç' : 'Bu Aracı Seç';
      this.el.select.disabled = equipped;
      this.el.select.className = `btn ${equipped ? '' : 'btn-primary'}`;
    }
  }

  _renderTabs() {
    this.el.tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === this.tab));
    for (const [id, node] of Object.entries(this.el.panels)) {
      node.classList.toggle('hidden', id !== this.tab);
    }
    ({
      stats: () => this._renderStats(),
      tune: () => this._renderTune(),
      style: () => this._renderStyle(),
      env: () => this._renderEnv(),
    })[this.tab]();
  }

  /* --- istatistik sekmesi -------------------------------------------- */

  _renderStats() {
    const id = this.viewing;
    const cur = computeStats(id, garage.entry(id).upgrades);
    const cap = maxStats(id);
    // Karşılaştırma her zaman ŞU AN SEÇİLİ araca göre yapılır: "bunu alırsam
    // ne değişir?" sorusunun tek anlamlı cevabı bu.
    const ref = computeStats(garage.selected, garage.entry(garage.selected).upgrades);

    const bars = statBars(cur);
    const capBars = statBars(cap);
    const refBars = statBars(ref);
    const same = id === garage.selected;

    const rows = bars.map((b, i) => {
      const delta = b.value - refBars[i].value;
      const arrow = same || Math.abs(delta) < 0.005 ? ''
        : `<span class="delta ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(Math.round(delta * 100))}</span>`;
      return `
        <li class="stat-row">
          <span class="stat-name">${b.name}</span>
          <span class="stat-bar">
            <i class="cap" style="width:${(capBars[i].value * 100).toFixed(1)}%"></i>
            <i class="fill" style="width:${(b.value * 100).toFixed(1)}%"></i>
          </span>
          <span class="stat-val">${b.text}${arrow}</span>
        </li>`;
    }).join('');

    this.el.panels.stats.innerHTML = `
      <ul class="stat-list">${rows}</ul>
      <p class="panel-hint">Soluk çubuk, tüm yükseltmeler takıldığında ulaşılabilecek tavanı gösterir.
        ${same ? '' : 'Oklar, şu an seçili araca göre farkı verir.'}</p>`;
  }

  /* --- yükseltme sekmesi --------------------------------------------- */

  _renderTune() {
    const id = this.viewing;
    const owned = garage.owns(id);

    const rows = UPGRADE_LIST.map((u) => {
      const lvl = garage.level(id, u.id);
      const price = garage.upgradePrice(id, u.id);
      const maxed = price == null;
      const afford = !maxed && garage.coins >= price;
      const pips = Array.from({ length: MAX_UPGRADE_LEVEL }, (_, i) =>
        `<i class="${i < lvl ? 'on' : ''}"></i>`).join('');
      return `
        <li class="tune-row" data-part="${u.id}">
          <span class="tune-icon">${u.icon}</span>
          <span class="tune-main">
            <span class="tune-name">${u.name} <b>Sv. ${lvl + (maxed ? 0 : 1)}</b></span>
            <span class="tune-desc">${u.desc}</span>
            <span class="tune-pips">${pips}</span>
          </span>
          <button class="btn btn-sm ${afford && owned ? 'btn-primary' : ''}"
                  ${maxed || !owned || !afford ? 'disabled' : ''}>
            ${maxed ? 'TAM' : `◈ ${coins(price)}`}
          </button>
        </li>`;
    }).join('');

    this.el.panels.tune.innerHTML = `
      <ul class="tune-list">${rows}</ul>
      ${owned ? '' : '<p class="panel-hint warn">Yükseltme takmak için önce aracı satın al.</p>'}`;

    this.el.panels.tune.querySelectorAll('.tune-row button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const part = btn.closest('.tune-row').dataset.part;
        const res = garage.upgrade(id, part);
        this._note(res.ok ? `${UPGRADES_NAME[part]} yükseltildi.` : res.reason, res.ok);
      });
    });
  }

  /* --- görünüm sekmesi ------------------------------------------------ */

  _renderStyle() {
    const id = this.viewing;
    const look = garage.look(id);

    const finishTabs = Object.values(FINISHES).map((f) =>
      `<button class="chip ${look.finish === f.id ? 'active' : ''}" data-finish="${f.id}">${f.name}</button>`).join('');

    const palette = (PAINTS[look.finish] || PAINTS.gloss).map((p) =>
      `<button class="swatch ${look.paint === p.color ? 'active' : ''}"
               style="--sw:${hex(p.color)}" title="${p.name}" data-paint="${p.color}"></button>`).join('');

    const glow = UNDERGLOW_COLORS.map((c) =>
      `<button class="swatch ${look.underglowColor === c.color ? 'active' : ''}"
               style="--sw:${hex(c.color)}" title="${c.name}" data-glow="${c.color}"></button>`).join('');

    const tints = TINTS.map((t) =>
      `<button class="chip ${look.tint === t.id ? 'active' : ''}" data-tint="${t.id}">${t.name}</button>`).join('');

    const rims = RIMS.map((r) =>
      `<button class="chip rim ${look.rim === r.id ? 'active' : ''}" data-rim="${r.id}">
         <i style="--sw:${hex(r.color)}"></i>${r.name}</button>`).join('');

    this.el.panels.style.innerHTML = `
      <div class="style-block">
        <h4>Kaplama</h4>
        <div class="chip-row">${finishTabs}</div>
        <div class="swatch-grid">${palette}</div>
      </div>
      <div class="style-block">
        <h4>Alt Neon
          <label class="switch">
            <input type="checkbox" id="glow-toggle" ${look.underglow ? 'checked' : ''} />
            <span></span>
          </label>
        </h4>
        <div class="swatch-grid ${look.underglow ? '' : 'dim'}">${glow}</div>
      </div>
      <div class="style-block">
        <h4>Cam Filmi</h4>
        <div class="chip-row">${tints}</div>
      </div>
      <div class="style-block">
        <h4>Jant</h4>
        <div class="chip-row">${rims}</div>
      </div>`;

    const panel = this.el.panels.style;
    const set = (patch) => {
      garage.setLook(id, patch);
      this._rebuildCar();
    };

    panel.querySelectorAll('[data-finish]').forEach((b) => b.addEventListener('click', () => {
      const f = b.dataset.finish;
      // Kaplama değişince paletteki en yakın rengi koru, yoksa ilkine düş.
      const pal = PAINTS[f] || PAINTS.gloss;
      const keep = pal.some((p) => p.color === look.paint) ? look.paint : pal[0].color;
      set({ finish: f, paint: keep });
    }));
    panel.querySelectorAll('[data-paint]').forEach((b) => b.addEventListener('click', () =>
      set({ paint: Number(b.dataset.paint) })));
    panel.querySelectorAll('[data-glow]').forEach((b) => b.addEventListener('click', () =>
      set({ underglow: true, underglowColor: Number(b.dataset.glow) })));
    panel.querySelectorAll('[data-tint]').forEach((b) => b.addEventListener('click', () =>
      set({ tint: Number(b.dataset.tint) })));
    panel.querySelectorAll('[data-rim]').forEach((b) => b.addEventListener('click', () =>
      set({ rim: b.dataset.rim })));
    panel.querySelector('#glow-toggle').addEventListener('change', (e) =>
      set({ underglow: e.target.checked }));
  }

  /* --- ortam sekmesi -------------------------------------------------- */

  _renderEnv() {
    const cur = garage.state.environment;
    this.el.panels.env.innerHTML = `
      <div class="env-grid">
        ${ENVIRONMENTS.map((e) => `
          <button class="env-card ${cur === e.id ? 'active' : ''}" data-env="${e.id}">
            <span class="env-swatch env-${e.id}"></span>
            <span class="env-name">${e.name}</span>
            <span class="env-hint">${e.hint}</span>
          </button>`).join('')}
      </div>
      <p class="panel-hint">“Otomatik” seçiliyken hava, yarışın tohumundan belirlenir —
        iki oyuncu da aynı gökyüzünü görür.</p>`;

    this.el.panels.env.querySelectorAll('[data-env]').forEach((b) =>
      b.addEventListener('click', () => {
        garage.setEnvironment(b.dataset.env);
        this.onEnvironmentChange(b.dataset.env);
      }));
  }
}

const UPGRADES_NAME = Object.fromEntries(UPGRADE_LIST.map((u) => [u.id, u.name]));

/* ============================== yardımcı ============================== */

/**
 * Bir önizleme aracını bırakır.
 *
 * GEOMETRİYE DOKUNULMAZ: `instantiate()` prefabı `clone(true)` ile üretir ve
 * klonlar tamponları prefabla PAYLAŞIR. Burada `geometry.dispose()` çağırmak
 * garajda bir kez araç değiştirdikten sonra pistteki modeli de boş tampona
 * düşürürdü. Atılabilecek tek şey, `applyLook()`un bu örneğe özel klonladığı
 * ve `__owned` ile işaretlediği malzemelerdir.
 */
function disposeTree(root) {
  root.traverse((o) => {
    if (!o.isMesh || !o.userData.__owned) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) m?.dispose?.();
  });
}
