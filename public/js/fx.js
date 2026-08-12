/* =====================================================================
   Claude for Speed — "juice" katmanı
   ---------------------------------------------------------------------
   Hız hissini taşıyan her şey burada:

     • ScreenShake  — hıza, ani ivmeye, nitroya ve çarpışmaya tepki veren
                      tek bir sarsıntı bütçesi.
     • SpeedLines   — CSS değişkenlerini süren warp/çizgi yoğunluğu.
     • Particles    — tek bir BufferGeometry + Points üzerinde çalışan,
                      halka tamponlu (ring buffer) evrensel parçacık havuzu.
                      Nitro alevi, egzoz isi ve lastik dumanı aynı havuzu
                      paylaşır: sahnede TEK çizim çağrısı, kare başına sıfır
                      bellek ayırma.
     • SkidMarks    — InstancedMesh üzerinde halka tamponlu fren izleri.
                      Yeni iz eskisinin üstüne yazar; bellek sabit kalır.

   Hepsi `dispose()` ile temiz kapanır ve yarış arası `reset()` ile
   sıfırlanır — art arda 20 rövanş atılsa da bellek büyümez.
   ===================================================================== */

import * as THREE from 'three';

/* ============================ ekran sarsıntısı ======================== */

export const SHAKE = {
  speedBase: 0.030,        // tavan hızda taban titreşim (m)
  accelKick: 0.55,         // ani ivmenin katkısı
  boostKick: 0.42,
  crash: 1.0,
  decay: 2.2,              // 1/s — darbe sönümü
  maxOffset: 0.85,         // m — kameranın kaçabileceği en fazla mesafe
};

/**
 * Kamera sarsıntısı. İki bileşen toplanır:
 *   - sürekli: hızla orantılı, yüksek frekanslı mikro titreşim
 *   - darbe:   kaza / nitro / ani gaz ile tetiklenip üstel sönen vuruş
 */
export class ScreenShake {
  constructor() {
    this.impulse = 0;
    this.offset = new THREE.Vector3();
    this._t = 0;
    this._prevSpeed = 0;
  }

  /** Tek seferlik darbe (0..1+). */
  punch(amount) {
    this.impulse = Math.min(1.6, this.impulse + amount);
  }

  reset() {
    this.impulse = 0;
    this.offset.set(0, 0, 0);
    this._prevSpeed = 0;
  }

  /**
   * @param {number} dt
   * @param {number} speed       m/s
   * @param {number} maxSpeed    m/s
   * @param {boolean} boosting
   */
  update(dt, speed, maxSpeed, boosting) {
    this._t += dt;

    // Ani ivme: hızın türevi eşiği aşınca kısa bir vuruş ekle.
    const accel = (speed - this._prevSpeed) / Math.max(dt, 1e-4);
    this._prevSpeed = speed;
    if (accel > 18) this.punch(Math.min(0.35, (accel - 18) / 90) * SHAKE.accelKick);
    if (boosting) this.punch(SHAKE.boostKick * dt);

    this.impulse = Math.max(0, this.impulse - dt * SHAKE.decay);

    const speedK = Math.max(0, Math.min(1, speed / Math.max(maxSpeed, 1)));
    // Üsttelleştirilmiş hız katkısı: düşük hızda kamera taş gibi sabit dursun.
    const hum = SHAKE.speedBase * speedK * speedK * speedK;
    const amp = Math.min(SHAKE.maxOffset, hum + this.impulse * this.impulse * 0.9);

    // Deterministik olmayan gürültü yerine iki farklı frekanslı sinüs:
    // kare hızından bağımsız, öngörülebilir ve "ucuz kamera" hissi vermiyor.
    const t = this._t;
    this.offset.set(
      (Math.sin(t * 61.7) * 0.6 + Math.sin(t * 23.3) * 0.4) * amp,
      (Math.sin(t * 47.1) * 0.6 + Math.sin(t * 31.9) * 0.4) * amp * 0.8,
      Math.sin(t * 17.3) * amp * 0.25,
    );
    return this.offset;
  }
}

/* ============================== hız çizgileri ========================= */

/**
 * Ekran üstündeki warp/çizgi katmanını sürer. Tüm iş CSS'te olduğu için
 * WebGL'e hiç dokunmaz; yalnızca iki özel özellik yazılır.
 */
export class SpeedLines {
  constructor(node) {
    this.node = node;
    this.lines = 0;
    this.warp = 0;
  }

  reset() {
    this.lines = 0; this.warp = 0;
    if (this.node) {
      this.node.style.setProperty('--speed-lines', '0');
      this.node.style.setProperty('--warp', '0');
    }
  }

  /**
   * @param {number} dt
   * @param {number} speedK   0..1 tavan hıza oran
   * @param {boolean} boosting
   */
  update(dt, speedK, boosting) {
    if (!this.node) return;
    // Çizgiler %55 hızdan sonra açılır; warp yalnızca nitroda veya son %12'de.
    const linesTarget = Math.max(0, (speedK - 0.55) / 0.45) ** 1.4;
    const warpTarget = boosting ? 1 : Math.max(0, (speedK - 0.88) / 0.12);

    const k = 1 - Math.exp(-8 * dt);
    this.lines += (linesTarget - this.lines) * k;
    this.warp += (warpTarget - this.warp) * (boosting ? 1 - Math.exp(-14 * dt) : k);

    this.node.style.setProperty('--speed-lines', this.lines.toFixed(3));
    this.node.style.setProperty('--warp', this.warp.toFixed(3));
  }
}

/* ============================ parçacık havuzu ========================= */

/** Yumuşak, merkezi parlak bir nokta — hem alev hem duman için taban. */
function particleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const PARTICLE_VERT = `
  attribute float aSize;
  attribute float aAlpha;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = color;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (300.0 / max(-mv.z, 1.0));
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FRAG = `
  uniform sampler2D uMap;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 tex = texture2D(uMap, gl_PointCoord);
    if (vAlpha <= 0.001) discard;
    gl_FragColor = vec4(vColor, tex.a * vAlpha);
  }
`;

/**
 * Halka tamponlu parçacık sistemi.
 *
 * Tüm parçacıklar tek bir Points nesnesinde yaşar; `emit()` en eski yuvanın
 * üstüne yazar. Böylece hiçbir zaman dizi büyümez, GC tetiklenmez ve sahnede
 * tek bir çizim çağrısı olur. Additive ve normal harman ayrı iki örnek
 * gerektirdiği için sınıf `blending` parametresi alır.
 */
export class ParticlePool {
  constructor(parent, {
    count = 900,
    blending = THREE.AdditiveBlending,
    depthWrite = false,
  } = {}) {
    this.count = count;
    this.cursor = 0;

    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.grow = new Float32Array(count);
    this.gravity = new Float32Array(count);
    this.peak = new Float32Array(count);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    // Parçacıklar oyuncunun etrafında dolaştığı için kendi zarfı yanıltıcı.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    // fog KAPALI olmalı. ShaderMaterial'de `fog: true`, renderer'ı
    // `uniforms.fogColor.value`'yu yazmaya iter; bizim uniform kümemizde
    // öyle bir alan olmadığı için her karede TypeError fırlatırdı. Zaten
    // tüm parçacıklar aracın 10 m çevresinde doğup ölüyor, yani sis
    // katkısı görünür bir fark yaratmazdı.
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: particleTexture() } },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite,
      blending,
      vertexColors: true,
      fog: false,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.geometry = geo;
    this.parent = parent;
    parent.add(this.points);
  }

  /**
   * Tek parçacık doğurur.
   * @param {object} o
   * @param {THREE.Vector3|{x,y,z}} o.position
   * @param {{x,y,z}} o.velocity
   * @param {number|THREE.Color} o.color
   * @param {number} o.size      piksel taban boyu
   * @param {number} o.life      saniye
   * @param {number} [o.drag]    1/s — hızın sönümü
   * @param {number} [o.grow]    saniyede boy artışı (çarpan)
   * @param {number} [o.gravity] m/s²  (+ yukarı)
   * @param {number} [o.peak]    0..1 — alfanın tepe yaptığı ömür oranı
   */
  emit({ position, velocity, color, size, life, drag = 2.4, grow = 1.4, gravity = 0, peak = 0.15 }) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    const i3 = i * 3;

    this.pos[i3] = position.x; this.pos[i3 + 1] = position.y; this.pos[i3 + 2] = position.z;
    this.vel[i3] = velocity.x; this.vel[i3 + 1] = velocity.y; this.vel[i3 + 2] = velocity.z;

    if (typeof color === 'number') {
      this.col[i3] = ((color >> 16) & 255) / 255;
      this.col[i3 + 1] = ((color >> 8) & 255) / 255;
      this.col[i3 + 2] = (color & 255) / 255;
    } else {
      this.col[i3] = color.r; this.col[i3 + 1] = color.g; this.col[i3 + 2] = color.b;
    }

    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.drag[i] = drag;
    this.grow[i] = grow;
    this.gravity[i] = gravity;
    this.peak[i] = peak;
    this.alpha[i] = 0.001;
  }

  update(dt) {
    const { pos, vel, size, alpha, life, maxLife, drag, grow, gravity, peak } = this;
    let live = 0;
    for (let i = 0; i < this.count; i++) {
      if (life[i] <= 0) { if (alpha[i] !== 0) alpha[i] = 0; continue; }
      live++;
      life[i] -= dt;
      if (life[i] <= 0) { alpha[i] = 0; continue; }

      const i3 = i * 3;
      const d = Math.max(0, 1 - drag[i] * dt);
      vel[i3] *= d; vel[i3 + 1] *= d; vel[i3 + 2] *= d;
      vel[i3 + 1] += gravity[i] * dt;

      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;

      size[i] *= 1 + (grow[i] - 1) * dt;

      // Alfa zarfı: hızlı açıl, yavaş kapan.
      const t = 1 - life[i] / maxLife[i];
      alpha[i] = t < peak[i] ? t / Math.max(peak[i], 1e-3) : 1 - (t - peak[i]) / (1 - peak[i]);
    }

    if (live || this._wasLive) {
      this.geometry.getAttribute('position').needsUpdate = true;
      this.geometry.getAttribute('color').needsUpdate = true;
      this.geometry.getAttribute('aSize').needsUpdate = true;
      this.geometry.getAttribute('aAlpha').needsUpdate = true;
    }
    this._wasLive = live > 0;
  }

  reset() {
    this.life.fill(0);
    this.alpha.fill(0);
    this.cursor = 0;
    this.geometry.getAttribute('aAlpha').needsUpdate = true;
  }

  dispose() {
    this.parent.remove(this.points);
    this.geometry.dispose();
    if (this.material.uniforms.uMap.value) this.material.uniforms.uMap.value.dispose();
    this.material.dispose();
  }
}

/* ============================== fren izleri =========================== */

/** Uçları yumuşayan koyu bir şerit — asfalta yapışan lastik izi. */
function skidTexture() {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 64);
  grd.addColorStop(0, 'rgba(0,0,0,0)');
  grd.addColorStop(0.2, 'rgba(0,0,0,0.85)');
  grd.addColorStop(0.8, 'rgba(0,0,0,0.85)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 16, 64);
  // kenar yumuşatma
  const side = g.createLinearGradient(0, 0, 16, 0);
  side.addColorStop(0, 'rgba(0,0,0,0.6)');
  side.addColorStop(0.5, 'rgba(0,0,0,0)');
  side.addColorStop(1, 'rgba(0,0,0,0.6)');
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = side; g.fillRect(0, 0, 16, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

export const SKID = {
  count: 320,          // halka tamponun boyu
  segment: 0.55,       // m — iki iz parçası arası
  width: 0.20,
  fade: 7.5,           // s — tam sönme süresi
};

/**
 * Fren/kayma izleri. Tek bir InstancedMesh; her yeni parça en eski yuvanın
 * üstüne yazılır, yani hafıza sabittir ve iz sayısı sınırlıdır.
 *
 * Solma neden ÖLÇEKLE yapılıyor: InstancedMesh örnek başına ALFA taşımaz —
 * `instanceColor` yalnızca RGB'yi çarpar. İzi renkle soldurmak, hava
 * durumuna göre değişen asfalt tonuna bağımlı olurdu (gündüz beyaza,
 * gece siyaha kaçardı). Ömrün son %35'inde şeridi inceltmek hem hava
 * bağımsız hem de gerçekten "lastik tozu dağılıyor" gibi okunuyor.
 * `instanceColor` ise sabit bir işe ayrılıyor: izin koyuluğu (kayma şiddeti).
 */
export class SkidMarks {
  constructor(parent) {
    const geo = new THREE.PlaneGeometry(SKID.width, SKID.segment * 1.25);
    geo.rotateX(-Math.PI / 2);

    // Renk beyaz: gerçek ton `setColorAt()` ile örnek başına verilir.
    const mat = new THREE.MeshBasicMaterial({
      map: skidTexture(), color: 0xffffff, transparent: true,
      depthWrite: false, opacity: 0.66, fog: true,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, SKID.count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.count = 0;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SKID.count * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    parent.add(this.mesh);
    this.parent = parent;

    this.cursor = 0;
    this.used = 0;
    this.age = new Float32Array(SKID.count);
    this.age.fill(Infinity);
    this.strength = new Float32Array(SKID.count);
    this.x = new Float32Array(SKID.count);
    this.z = new Float32Array(SKID.count);
    this.yaw = new Float32Array(SKID.count);
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3(1, 1, 1);
    this._lastZ = new Map();      // tekerlek anahtarı -> son iz bırakılan z
  }

  /**
   * Bir tekerlek izi bırakır — çağıran, mesafe eşiğini yönetmek zorunda
   * değildir: aynı tekerlek için ardışık çağrılar SKID.segment'ten yakınsa
   * yok sayılır.
   *
   * @param {string} wheelKey  'fl' | 'fr' | 'rl' | 'rr' gibi
   * @param {number} x
   * @param {number} z
   * @param {number} yaw       izin yönü (rad)
   * @param {number} strength  0..1 — koyuluk
   */
  lay(wheelKey, x, z, yaw, strength) {
    const last = this._lastZ.get(wheelKey);
    if (last != null && Math.abs(z - last) < SKID.segment) return;
    this._lastZ.set(wheelKey, z);

    const i = this.cursor;
    this.cursor = (this.cursor + 1) % SKID.count;
    this.used = Math.min(SKID.count, this.used + 1);
    this.mesh.count = this.used;

    const k = Math.max(0.12, Math.min(1, strength));
    this.strength[i] = k;
    this.x[i] = x; this.z[i] = z; this.yaw[i] = yaw;
    this.age[i] = 0;
    this._write(i, 1);

    // Şiddet ne kadar yüksekse iz o kadar koyu: beyaz taban rengi
    // (1 - 0.9k) ile çarpılır, k = 1'de neredeyse siyaha iner.
    this.mesh.setColorAt(i, TMP_COLOR.setScalar(1 - 0.9 * k));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** i numaralı izi `w` (0..1) genişlik çarpanıyla yazar. */
  _write(i, w) {
    this._p.set(this.x[i], 0.012, this.z[i]);
    this._e.set(0, this.yaw[i], 0);
    this._q.setFromEuler(this._e);
    this._s.set(w, 1, Math.max(w, 0.35));
    this._m.compose(this._p, this._q, this._s);
    this.mesh.setMatrixAt(i, this._m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt) {
    if (!this.used) return;
    const FADE_FROM = 0.65;                 // ömrün bu oranından sonra incel
    for (let i = 0; i < this.used; i++) {
      const age = this.age[i];
      if (age === Infinity) continue;
      this.age[i] = age + dt;
      const t = this.age[i] / SKID.fade;
      if (t >= 1) {
        this.age[i] = Infinity;
        this._write(i, 0);                  // sıfır ölçek = görünmez
      } else if (t > FADE_FROM) {
        this._write(i, 1 - (t - FADE_FROM) / (1 - FADE_FROM));
      }
    }
  }

  reset() {
    this.cursor = 0;
    this.used = 0;
    this.mesh.count = 0;
    this.age.fill(Infinity);
    this._lastZ.clear();
  }

  dispose() {
    this.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    if (this.mesh.material.map) this.mesh.material.map.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}

const TMP_COLOR = new THREE.Color();

/* ============================== FX yöneticisi ========================= */

const NITRO_COLORS = [0x9fd8ff, 0x5fb0ff, 0x2f6bff];
const SMOKE_COLOR = 0x9aa3ae;

const _v = new THREE.Vector3();

/**
 * Tüm efektleri tek çatı altında toplar; oyun döngüsü sadece bunu tanır.
 */
export class Fx {
  /**
   * @param {THREE.Object3D} world
   * @param {HTMLElement} speedlineNode
   */
  constructor(world, speedlineNode) {
    this.shake = new ScreenShake();
    this.speedLines = new SpeedLines(speedlineNode);
    this.flames = new ParticlePool(world, { count: 700, blending: THREE.AdditiveBlending });
    this.smoke = new ParticlePool(world, { count: 520, blending: THREE.NormalBlending });
    this.skid = new SkidMarks(world);
    this._nitroAcc = 0;
    this._smokeAcc = 0;
  }

  reset() {
    this.shake.reset();
    this.speedLines.reset();
    this.flames.reset();
    this.smoke.reset();
    this.skid.reset();
    this._nitroAcc = 0;
    this._smokeAcc = 0;
  }

  /**
   * Nitro alevi — aracın arkasından çıkan iki jet.
   * @param {object} car   { x, z, yaw, halfWidth, length, speed }
   * @param {number} dt
   * @param {number} strength 0..1
   */
  nitro(car, dt, strength = 1) {
    if (strength <= 0.01) return;
    // Kare hızından bağımsız doğum oranı: saniyede ~160 parçacık.
    this._nitroAcc += dt * 160 * strength;
    const n = Math.floor(this._nitroAcc);
    this._nitroAcc -= n;

    const sin = Math.sin(car.yaw), cos = Math.cos(car.yaw);
    for (let i = 0; i < n; i++) {
      const side = i % 2 ? 1 : -1;
      const ox = side * car.halfWidth * 0.52;
      const oz = -car.length * 0.5;
      const px = car.x + ox * cos + oz * sin;
      const pz = car.z - ox * sin + oz * cos;

      const spread = 1.6;
      const back = 12 + Math.random() * 10;
      _v.set(
        (Math.random() - 0.5) * spread - car.speed * 0.0 * sin,
        (Math.random() - 0.2) * 1.2,
        -back + car.speed * 0.02,
      );

      const t = Math.random();
      const color = NITRO_COLORS[t < 0.45 ? 0 : t < 0.8 ? 1 : 2];
      this.flames.emit({
        position: { x: px, y: 0.44 + Math.random() * 0.12, z: pz },
        velocity: _v,
        color,
        size: 9 + Math.random() * 9,
        life: 0.16 + Math.random() * 0.20,
        drag: 5.5,
        grow: 3.4,
        peak: 0.10,
      });
    }
  }

  /**
   * Lastik dumanı — sert şerit değişimi ve frende.
   * @param {object} car    { x, z, yaw, halfWidth, length }
   * @param {number} dt
   * @param {number} strength 0..1
   */
  tyreSmoke(car, dt, strength) {
    if (strength <= 0.02) return;
    this._smokeAcc += dt * 90 * strength;
    const n = Math.floor(this._smokeAcc);
    this._smokeAcc -= n;

    for (let i = 0; i < n; i++) {
      const side = i % 2 ? 1 : -1;
      const ox = side * car.halfWidth * 0.92;
      const oz = -car.length * 0.34;
      const sin = Math.sin(car.yaw), cos = Math.cos(car.yaw);
      _v.set(
        (Math.random() - 0.5) * 3.2 + side * 1.4,
        0.5 + Math.random() * 1.1,
        -3 - Math.random() * 5,
      );
      this.smoke.emit({
        position: {
          x: car.x + ox * cos + oz * sin,
          y: 0.16 + Math.random() * 0.1,
          z: car.z - ox * sin + oz * cos,
        },
        velocity: _v,
        color: SMOKE_COLOR,
        size: 16 + Math.random() * 14,
        life: 0.55 + Math.random() * 0.6,
        drag: 1.6,
        grow: 2.6,
        gravity: 0.5,
        peak: 0.25,
      });
    }
  }

  /** Dört tekerlek için fren izi bırakır. */
  laySkid(car, strength) {
    if (strength <= 0.05) return;
    const sin = Math.sin(car.yaw), cos = Math.cos(car.yaw);
    const lanes = [
      ['fl', -car.halfWidth * 0.88, car.length * 0.30],
      ['fr', car.halfWidth * 0.88, car.length * 0.30],
      ['rl', -car.halfWidth * 0.92, -car.length * 0.32],
      ['rr', car.halfWidth * 0.92, -car.length * 0.32],
    ];
    for (const [k, ox, oz] of lanes) {
      this.skid.lay(k, car.x + ox * cos + oz * sin, car.z - ox * sin + oz * cos, car.yaw, strength);
    }
  }

  crash() { this.shake.punch(SHAKE.crash); }

  update(dt) {
    this.flames.update(dt);
    this.smoke.update(dt);
    this.skid.update(dt);
  }

  dispose() {
    this.flames.dispose();
    this.smoke.dispose();
    this.skid.dispose();
  }
}
