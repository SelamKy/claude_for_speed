/* =====================================================================
   Claude for Speed — atmosfer: hava durumu ve günün saati
   ---------------------------------------------------------------------
   Dört ortam: Gündüz, Gün Batımı, Gece, Yağmur.

   Tasarım kararı: her ortam bir SAYI TABLOSUDUR, ayrı bir sahne değil.
   Işıklar, sis, gökyüzü gradyanı, asfalt malzemesi, bina pencerelerinin
   parlaklığı ve farlar aynı düğüm kümesinden beslenir; geçişte tüm
   değerler birlikte lerp'lenir. Böylece ortam değiştirmek nesne
   yaratmaz/atmaz — kare süresi sabit kalır ve sızıntı olmaz.

   Yağmurun "ıslak asfalt" görünümü ekran-uzayı yansıma (SSR) ile değil,
   iki ucuz numarayla yapılır: asfalt malzemesinin metalness/roughness
   değerleri cam gibi ayarlanır (sahne IBL'i zaten yüklü) ve yolun hemen
   üstüne, mesafeyle kayan additive bir "yansıma şeridi" düzlemi serilir.
   ===================================================================== */

import * as THREE from 'three';

/* ============================== ön ayarlar ============================ */

/**
 * Sis okunabilirlik tabanı.
 *
 * Hava durumu ne olursa olsun sis, oyuncunun tepki verdiği bölgeyi (yaklaşan
 * trafik, rakip, şerit çizgileri) kapatmamalı. `minNear` sisin en erken
 * başlayabileceği mesafe, `minFar` tam kapanmanın en erken olabileceği
 * mesafedir; `_apply()` her karede bu tabanı zorlar. Ön ayarlar daha AÇIK
 * (daha uzak) değerler verebilir — taban yalnızca aşağıdan sınırlar, yani
 * "yağmurda görüş düşsün" isteği bile ekranı süte çeviremez.
 */
export const FOG_READABILITY = { minNear: 220, minFar: 820 };

/* Yolun IBL'den (RoomEnvironment) aldığı yansıma şiddeti — SABİT.
   Eskiden `1 + wetSheen * 1.4` ile 2.4'e kadar çıkıyordu; ıslak ön ayarda
   bu, stüdyo tavanının aracın altında beyaz bir havuz olarak yansıması
   demekti. Sabit ve ölçülü bir değer, yolu aydınlatma işini hemisphere +
   directional ışıklara bırakır. */
const ROAD_ENV_INTENSITY = 0.6;

/** @typedef {keyof typeof PRESETS} EnvId */
export const PRESETS = {
  day: {
    name: 'Gündüz',
    fog: 0xa9c6e6, fogNear: 250, fogFar: 900,
    skyTop: 0x2f7fd4, skyBottom: 0xd6e8fb,
    hemiSky: 0xd8ecff, hemiGround: 0x8a94a3, hemiIntensity: 1.55,
    keyColor: 0xfff6e2, keyIntensity: 2.5, keyPos: [-70, 130, 70],
    rimColor: 0x9fc4ff, rimIntensity: 0.28,
    exposure: 1.0,
    roadTint: 0xffffff, roadRough: 0.94, roadMetal: 0.02,
    barrierTint: 0xffffff,
    glow: 0.0, headlights: 0.0, streetLamp: 0.0, stars: 0.0, rain: 0.0,
  },
  sunset: {
    name: 'Gün Batımı',
    fog: 0xb9714a, fogNear: 235, fogFar: 860,
    skyTop: 0x1d3a6b, skyBottom: 0xff9d4d,
    hemiSky: 0xffc79a, hemiGround: 0x3a2b33, hemiIntensity: 1.0,
    keyColor: 0xffb066, keyIntensity: 2.2, keyPos: [-140, 26, -60],
    rimColor: 0xff5fa2, rimIntensity: 0.7,
    exposure: 1.06,
    roadTint: 0xffd0a8, roadRough: 0.82, roadMetal: 0.12,
    barrierTint: 0xffd7b0,
    glow: 0.22, headlights: 0.35, streetLamp: 0.35, stars: 0.06, rain: 0.0,
  },
  night: {
    name: 'Gece',
    fog: 0x0b1220, fogNear: 225, fogFar: 840,
    skyTop: 0x02040a, skyBottom: 0x101c33,
    hemiSky: 0x6f9fd8, hemiGround: 0x080b12, hemiIntensity: 0.42,
    keyColor: 0x9fb8e8, keyIntensity: 0.30, keyPos: [-40, 90, 40],
    rimColor: 0xff5fa2, rimIntensity: 0.62,
    exposure: 1.18,
    roadTint: 0x515c70, roadRough: 0.80, roadMetal: 0.16,
    barrierTint: 0x9fb2d0,
    glow: 1.0, headlights: 1.0, streetLamp: 1.0, stars: 1.0, rain: 0.0,
  },
  rain: {
    name: 'Yağmur',
    fog: 0x1a232f, fogNear: 220, fogFar: 820,
    skyTop: 0x0b1119, skyBottom: 0x2b3644,
    hemiSky: 0x8ea6c0, hemiGround: 0x0d1219, hemiIntensity: 0.68,
    keyColor: 0xa9bdd6, keyIntensity: 0.45, keyPos: [-30, 100, 20],
    rimColor: 0x5fd0ff, rimIntensity: 0.45,
    exposure: 1.05,
    /* Islak asfalt PÜRÜZLÜ kalır. Eski değerler (rough 0.14 / metal 0.62)
       yolu ayna yapıyordu: stüdyo IBL'i (RoomEnvironment) aracın altında
       ekranı yakan beyaz bir havuz olarak yansıyordu. */
    roadTint: 0x3d4854, roadRough: 0.55, roadMetal: 0.22,
    barrierTint: 0xb8ccdf,
    glow: 0.72, headlights: 1.0, streetLamp: 0.9, stars: 0.0, rain: 1.0,
  },
};

export const ENV_IDS = Object.keys(PRESETS);

/**
 * Garaj ayarını gerçek bir ortama çevirir.
 * 'auto' seçiliyse yarış tohumundan türetilir — sunucu tohumu iki istemciye de
 * aynı gittiği için iki oyuncu aynı havayı görür.
 */
export function pickEnvironment(setting, seed = 0) {
  if (PRESETS[setting]) return setting;
  const n = (seed >>> 0) % 1000;
  // Ağırlık: gece %35, gün batımı %25, gündüz %25, yağmur %15
  if (n < 350) return 'night';
  if (n < 600) return 'sunset';
  if (n < 850) return 'day';
  return 'rain';
}

/* =========================== küçük yardımcılar ======================== */

const lerp = (a, b, k) => a + (b - a) * k;

/**
 * Bir malzemeyi ortam tonuyla ÇARPAR (üzerine yazmaz).
 *
 * Yol yüzeyi, banket ve bariyerlerin kendi taban renkleri var; hepsine aynı
 * rengi atamak asfaltla banketi tek düze bir yüzeye çevirirdi. Taban renk ilk
 * dokunuşta saklanır, sonrasında yalnızca çarpan değişir.
 */
function tint(m, color) {
  if (!m || !m.color) return;
  let base = m.userData.__baseColor;
  if (!base) base = m.userData.__baseColor = m.color.clone();
  m.color.copy(base).multiply(color);
}

/** Bir ön ayarın sayısal alanlarını düz bir nesneye kopyalar. */
function snapshot(preset) {
  return {
    fog: new THREE.Color(preset.fog),
    fogNear: preset.fogNear, fogFar: preset.fogFar,
    skyTop: new THREE.Color(preset.skyTop),
    skyBottom: new THREE.Color(preset.skyBottom),
    hemiSky: new THREE.Color(preset.hemiSky),
    hemiGround: new THREE.Color(preset.hemiGround),
    hemiIntensity: preset.hemiIntensity,
    keyColor: new THREE.Color(preset.keyColor),
    keyIntensity: preset.keyIntensity,
    keyPos: new THREE.Vector3().fromArray(preset.keyPos),
    rimColor: new THREE.Color(preset.rimColor),
    rimIntensity: preset.rimIntensity,
    exposure: preset.exposure,
    roadTint: new THREE.Color(preset.roadTint),
    roadRough: preset.roadRough, roadMetal: preset.roadMetal,
    barrierTint: new THREE.Color(preset.barrierTint),
    glow: preset.glow, headlights: preset.headlights, streetLamp: preset.streetLamp,
    stars: preset.stars, rain: preset.rain,
  };
}

function blend(out, from, to, k) {
  out.fog.copy(from.fog).lerp(to.fog, k);
  out.skyTop.copy(from.skyTop).lerp(to.skyTop, k);
  out.skyBottom.copy(from.skyBottom).lerp(to.skyBottom, k);
  out.hemiSky.copy(from.hemiSky).lerp(to.hemiSky, k);
  out.hemiGround.copy(from.hemiGround).lerp(to.hemiGround, k);
  out.keyColor.copy(from.keyColor).lerp(to.keyColor, k);
  out.rimColor.copy(from.rimColor).lerp(to.rimColor, k);
  out.roadTint.copy(from.roadTint).lerp(to.roadTint, k);
  out.barrierTint.copy(from.barrierTint).lerp(to.barrierTint, k);
  out.keyPos.copy(from.keyPos).lerp(to.keyPos, k);
  for (const key of ['fogNear', 'fogFar', 'hemiIntensity', 'keyIntensity', 'rimIntensity',
    'exposure', 'roadRough', 'roadMetal', 'glow', 'headlights', 'streetLamp',
    'stars', 'rain']) {
    out[key] = lerp(from[key], to[key], k);
  }
  return out;
}

/* ============================ gökyüzü kubbesi ========================= */

const SKY_VERT = `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = `
  uniform vec3 topColor;
  uniform vec3 bottomColor;
  uniform float horizon;
  varying vec3 vDir;
  void main() {
    float h = smoothstep(-0.08, 0.55, vDir.y * horizon);
    gl_FragColor = vec4(mix(bottomColor, topColor, h), 1.0);
  }
`;

function makeSky() {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0x2f7fd4) },
      bottomColor: { value: new THREE.Color(0xd6e8fb) },
      horizon: { value: 1.0 },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 24, 14), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return { mesh, mat };
}

/* ================================ yıldızlar =========================== */

function makeStars(count = 900) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Yalnızca ufkun üstü: alt yarımküre zaten yolun altında kalır.
    const u = Math.random() * Math.PI * 2;
    const v = Math.acos(1 - Math.random() * 0.9);
    const r = 780;
    pos[i * 3] = r * Math.sin(v) * Math.cos(u);
    pos[i * 3 + 1] = r * Math.cos(v) * 0.75 + 60;
    pos[i * 3 + 2] = r * Math.sin(v) * Math.sin(u);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xdce8ff, size: 2.6, sizeAttenuation: false,
    transparent: true, opacity: 0, depthWrite: false, fog: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = -999;
  return { points, mat };
}

/* ================================ yağmur ============================== */

/** Dikey çizgi sprite'ı — kare nokta yerine damla izi verir. */
function rainTexture() {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 64);
  grd.addColorStop(0, 'rgba(190,225,255,0)');
  grd.addColorStop(0.5, 'rgba(214,238,255,0.95)');
  grd.addColorStop(1, 'rgba(190,225,255,0)');
  g.fillStyle = grd;
  g.fillRect(3, 0, 2, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const RAIN = { count: 2600, box: { x: 90, y: 46, z: 200 }, fall: 58 };

function makeRain() {
  const pos = new Float32Array(RAIN.count * 3);
  for (let i = 0; i < RAIN.count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * RAIN.box.x;
    pos[i * 3 + 1] = Math.random() * RAIN.box.y;
    pos[i * 3 + 2] = (Math.random() - 0.5) * RAIN.box.z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200);

  const mat = new THREE.PointsMaterial({
    map: rainTexture(), color: 0xcfe6ff, size: 1.5, sizeAttenuation: true,
    transparent: true, opacity: 0, depthWrite: false, fog: true,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, mat, positions: pos };
}

/* ============================== atmosfer ============================== */

export class Atmosphere {
  /**
   * @param {object} deps
   * @param {THREE.Scene} deps.scene
   * @param {THREE.WebGLRenderer} deps.renderer
   * @param {THREE.Camera} deps.camera
   * @param {THREE.HemisphereLight} deps.hemi
   * @param {THREE.DirectionalLight} deps.key
   * @param {THREE.DirectionalLight} deps.rim
   */
  constructor({ scene, renderer, camera, hemi, key, rim }) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.hemi = hemi;
    this.key = key;
    this.rimLight = rim;

    this.id = 'night';
    this._from = snapshot(PRESETS.night);
    this._to = snapshot(PRESETS.night);
    this._cur = snapshot(PRESETS.night);
    this._k = 1;
    this._speed = 1 / 1.1;             // geçiş süresi ≈ 1.1 sn

    this.sky = makeSky();
    this.stars = makeStars();
    this.rain = makeRain();

    scene.add(this.sky.mesh, this.stars.points, this.rain.points);

    /** Bağlanan dış nesneler — `bind()` ile doldurulur. */
    this.roadMaterials = [];
    this.barrierMaterials = [];
    this.lampMaterials = [];
    this.scenery = null;

    this._apply();
  }

  /**
   * Atmosferin süreceği dış nesneleri bağlar. Yol her yarışta yeniden
   * kurulduğu için bu, `buildRoad()` sonrasında tekrar çağrılabilir.
   */
  bind({ roadMaterials, barrierMaterials, lampMaterials, scenery, roadWidth } = {}) {
    if (roadMaterials) this.roadMaterials = roadMaterials;
    if (barrierMaterials) this.barrierMaterials = barrierMaterials;
    if (lampMaterials) this.lampMaterials = lampMaterials;
    if (scenery !== undefined) this.scenery = scenery;
    void roadWidth;                    // ıslak parlaklık düzlemi kaldırıldı
    this._apply();
  }

  /** @param {EnvId} id */
  set(id, immediate = false) {
    const preset = PRESETS[id] ? id : 'night';
    if (preset === this.id && this._k >= 1) return;
    this.id = preset;
    // Geçiş, bulunduğumuz ANLIK değerlerden başlar (yarım kalmış bir geçişin
    // ortasında ortam değiştirilse bile sıçrama olmasın diye).
    this._from = blend(snapshot(PRESETS[preset]), this._cur, this._cur, 0);
    this._to = snapshot(PRESETS[preset]);
    this._k = immediate ? 1 : 0;
    if (immediate) this._cur = snapshot(PRESETS[preset]);
    this._apply();
  }

  get current() { return this._cur; }
  get preset() { return PRESETS[this.id]; }
  /** Yağmur/gece yoğunluğu — FX katmanı ve HUD bunu okur. */
  get headlightLevel() { return this._cur.headlights; }
  get isWet() { return this._cur.rain > 0.4; }

  update(dt, { distance = 0, speed = 0 } = {}) {
    if (this._k < 1) {
      this._k = Math.min(1, this._k + dt * this._speed);
      blend(this._cur, this._from, this._to, this._k * this._k * (3 - 2 * this._k));
      this._apply();
    }

    const cam = this.camera.position;
    this.sky.mesh.position.copy(cam);
    this.stars.points.position.copy(cam);

    /* --- yağmur: kamera etrafındaki kutuda sarmalanan damlalar --------- */
    if (this._cur.rain > 0.02) {
      const p = this.rain.positions;
      const g = this.rain.points.geometry.getAttribute('position');
      const fall = RAIN.fall * dt;
      // Hız arttıkça damlalar geriye doğru savrulur — kokpitten bakınca
      // yağmurun "içine girdiğini" hissettiren asıl detay bu.
      const drift = Math.min(speed, 110) * dt * 0.55;
      for (let i = 0; i < RAIN.count; i++) {
        const iy = i * 3 + 1;
        p[iy] -= fall;
        p[i * 3 + 2] -= drift;
        if (p[iy] < 0) {
          p[iy] += RAIN.box.y;
          p[i * 3] = (Math.random() - 0.5) * RAIN.box.x;
          p[i * 3 + 2] = (Math.random() - 0.5) * RAIN.box.z;
        } else if (p[i * 3 + 2] < -RAIN.box.z / 2) {
          p[i * 3 + 2] += RAIN.box.z;
        }
      }
      g.needsUpdate = true;
      this.rain.points.position.set(cam.x, 0, cam.z + RAIN.box.z * 0.28);
      this.rain.points.visible = true;
    } else {
      this.rain.points.visible = false;
    }

    /* Islak yol artık YALNIZCA malzemeden okunur (roadRough / roadMetal).
       Yola serilen additive beyaz düzlem ve far demetleri sökülmüştür:
       ikisi de aracın altında göz alan bir ışık lekesi bırakıyordu.
       `distance` imzada kalır — çağıranlar (solo/network döngüsü) onu
       geçmeye devam ediyor, atmosferin artık kaydıracağı bir doku yok. */
    void distance;
  }

  /** Anlık değerleri sahneye yazar. */
  _apply() {
    const c = this._cur;

    // Okunabilirlik tabanı: ön ayarlar (ve aralarındaki geçişler) sisi
    // FOG_READABILITY'nin altına indiremez. `far`, `near`'dan en az 400 m
    // ötede tutulur; aksi halde dar bir bantta sis duvar gibi kapanırdı.
    const fogNear = Math.max(FOG_READABILITY.minNear, c.fogNear);
    const fogFar = Math.max(FOG_READABILITY.minFar, c.fogFar, fogNear + 400);

    // Sis kaldırıldı: hiçbir ön ayar `scene.fog` oluşturmaz.
    this.scene.fog = null;
    void fogNear; void fogFar;
    if (this.scene.background && this.scene.background.isColor) {
      this.scene.background.copy(c.fog);
    }

    this.sky.mat.uniforms.topColor.value.copy(c.skyTop);
    this.sky.mat.uniforms.bottomColor.value.copy(c.skyBottom);

    this.hemi.color.copy(c.hemiSky);
    this.hemi.groundColor.copy(c.hemiGround);
    this.hemi.intensity = c.hemiIntensity;

    this.key.color.copy(c.keyColor);
    this.key.intensity = c.keyIntensity;
    this.key.position.copy(c.keyPos);

    this.rimLight.color.copy(c.rimColor);
    this.rimLight.intensity = c.rimIntensity;

    this.renderer.toneMappingExposure = c.exposure;

    for (const m of this.roadMaterials) {
      if (!m) continue;
      tint(m, c.roadTint);
      if ('roughness' in m) m.roughness = c.roadRough;
      if ('metalness' in m) m.metalness = c.roadMetal;
      if ('envMapIntensity' in m) m.envMapIntensity = ROAD_ENV_INTENSITY;
    }
    for (const m of this.barrierMaterials) tint(m, c.barrierTint);
    for (const m of this.lampMaterials) {
      if (!m) continue;
      // Lambalar MeshBasicMaterial: yoğunluğu renkle taşırız.
      m.color.setRGB(1, 0.85, 0.63).multiplyScalar(0.12 + c.streetLamp * 0.88);
    }

    this.stars.mat.opacity = c.stars;
    this.stars.points.visible = c.stars > 0.02;
    this.rain.mat.opacity = 0.42 * c.rain;

    if (this.scenery) this.scenery.setNightGlow(c.glow);

    // Ekran katmanı (CSS yağmur perdesi + renk sıcaklığı).
    document.body.dataset.env = this.id;
    document.documentElement.style.setProperty('--rain', c.rain.toFixed(3));
  }

  dispose() {
    for (const obj of [this.sky.mesh, this.stars.points, this.rain.points]) {
      this.scene.remove(obj);
      obj.geometry.dispose();
      obj.material.dispose();
    }
  }
}
