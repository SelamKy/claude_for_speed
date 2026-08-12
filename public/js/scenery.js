/* =====================================================================
   Claude for Speed — çevre / manzara sistemi
   ---------------------------------------------------------------------
   `new_york_buildings.glb` içindeki 19 ayrı bina yol kenarına sonsuz
   akan bir şehir silueti olarak dizilir.

   Yaklaşım:
     • GLB bir kez yüklenir; her üst düzey düğüm ("emp_state", "christler",
       "flatiron"…) tek bir *prefab*'a indirgenir: malzeme başına birleşik
       geometri, tabanı y = 0'da, X/Z'de ortalanmış, 1 metre yüksekliğe
       normalleştirilmiş.
     • Çizim, malzeme başına TEK bir InstancedMesh ile yapılır. 90 bina
       ekranda olsa bile çizim çağrısı sayısı ~22'de sabit kalır.
     • Yol, 60 m'lik parçalara (chunk) bölünür. Oyuncu ilerledikçe geride
       kalan parçalar listeden düşer, öndekiler eklenir ve instans
       matrisleri YALNIZCA parça kümesi değiştiğinde yeniden yazılır —
       yani her karede değil. Yeni nesne yaratılmaz, atılmaz: sızıntı yok.
     • Bir parçanın içeriği tamamen `chunkIndex`'in saf bir fonksiyonudur
       (tamsayı hash), yani şehir her koşuda aynı yerde durur ve iki
       istemci aynı silueti görür.
     • GLB yüklenemezse `buildFallback()` devreye girer: aynı arayüzü
       sunan, kanvasla üretilmiş pencereli kutu binalar.
   ===================================================================== */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* ============================== ayarlar =============================== */

export const SCENERY = {
  chunkLength: 60,          // m — bir parçanın uzunluğu
  drawAhead: 780,           // m — kameranın önünde canlı tutulan mesafe
  drawBehind: 110,          // m — kameranın arkasında
  perChunkFront: 2,         // parça başına ön sıra bina (yol kenarı), yön başına
  perChunkBack: 1,          // parça başına arka sıra bina (siluet), yön başına
  frontOffset: [13, 27],    // yol kenarından uzaklık aralığı (m)
  backOffset: [46, 104],
  frontHeight: [18, 62],    // ön sıra bina yüksekliği (m)
  backHeight: [55, 165],
  minWidth: 11,             // bu kadar inceyse ölçek büyütülür (m)
  capacity: 14,             // bina tipi başına eşzamanlı instans tavanı
};

/* ============================ yardımcılar ============================= */

/** 32-bit tamsayı karıştırıcı (murmur son adımı) — platformlar arası aynı. */
function hash32(n) {
  n = (n | 0) ^ 0x9e3779b9;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return (n ^ (n >>> 16)) >>> 0;
}

/** [0,1) — (chunk, salt) çiftinden deterministik. */
function rand(chunk, salt) {
  return hash32(Math.imul(chunk, 0x27d4eb2f) ^ Math.imul(salt + 1, 0x165667b1)) / 4294967296;
}

const lerp = (a, b, k) => a + (b - a) * k;

/* ====================== GLB -> bina prefabları ======================== */

/**
 * Bir mesh'i dünya matrisi pişirilmiş, birleştirilebilir geometriye çevirir.
 * Sadece position/normal/uv taşınır — mergeGeometries'in istediği asgari küme.
 */
function bake(mesh) {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  if (!pos) return null;

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', pos.clone());
  out.setAttribute('normal', g.getAttribute('normal')
    ? g.getAttribute('normal').clone()
    : new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));
  out.setAttribute('uv', g.getAttribute('uv')
    ? g.getAttribute('uv').clone()
    : new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
  if (g.index) out.setIndex(g.index.clone());
  out.applyMatrix4(mesh.matrixWorld);
  if (!g.getAttribute('normal')) out.computeVertexNormals();
  return out;
}

/**
 * Bir malzemeyi bina cephesi için uygun hale getirir.
 *
 * `emissiveMap`'i taban rengi dokusuna bağlamak ucuz ama şaşırtıcı derecede
 * ikna edici bir "gece penceresi" numarasıdır: doku zaten koyu duvar +
 * parlak cam deseni taşıdığı için emissiveIntensity yükseltildiğinde
 * yalnızca camlar yanar. Gündüz atmosfer katmanı yoğunluğu 0'a çeker.
 */
function facadeMaterial(src) {
  const m = new THREE.MeshStandardMaterial({
    map: src.map || null,
    color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
    roughness: 0.86,
    metalness: 0.06,
    side: THREE.FrontSide,      // GLB'de her şey doubleSided; tek yüz yeterli
  });
  if (src.map) {
    m.emissiveMap = src.map;
    m.emissive = new THREE.Color(0xffd9a8);
    m.emissiveIntensity = 0;
  }
  m.name = src.name || 'facade';
  return m;
}

/**
 * GLB sahnesini bina prefablarına böler.
 * @returns {Array<{name:string, parts:Array<{geometry, material}>, size:THREE.Vector3}>}
 */
export function buildBuildingPrefabs(gltf) {
  const src = gltf.scene;
  src.updateWorldMatrix(true, true);

  // Sketchfab dışa aktarımı tek bir kök zinciri kurar; gerçek binalar en çok
  // çocuğu olan düğümün altındadır. Ada bakmak yerine yapıyı arıyoruz.
  let root = src;
  while (root.children.length === 1 && root.children[0].children.length) {
    root = root.children[0];
  }

  const prefabs = [];
  const box = new THREE.Box3();

  for (const node of root.children) {
    /** @type {Map<THREE.Material, THREE.BufferGeometry[]>} */
    const groups = new Map();
    node.updateWorldMatrix(true, true);
    node.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      const geo = bake(o);
      if (!mat || !geo) return;
      if (!groups.has(mat)) groups.set(mat, []);
      groups.get(mat).push(geo);
    });
    if (!groups.size) continue;

    // Normalleştirme: X/Z'de ortala, tabanı y = 0'a indir, 1 m yüksekliğe ölçekle.
    box.makeEmpty();
    for (const geos of groups.values()) {
      for (const g of geos) { g.computeBoundingBox(); box.union(g.boundingBox); }
    }
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const unit = 1 / Math.max(size.y, 1e-6);

    const parts = [];
    for (const [mat, geos] of groups) {
      let merged = null;
      try {
        const anyIndexed = geos.some((g) => g.index);
        const allIndexed = geos.every((g) => g.index);
        const batch = anyIndexed && !allIndexed ? geos.map((g) => g.toNonIndexed()) : geos;
        merged = mergeGeometries(batch, false);
        if (merged && batch !== geos) for (const g of batch) g.dispose();
      } catch { merged = null; }
      if (!merged) merged = geos[0];
      for (const g of geos) if (g !== merged) g.dispose();

      merged.translate(-centre.x, -box.min.y, -centre.z);
      merged.scale(unit, unit, unit);
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      parts.push({ geometry: merged, material: facadeMaterial(mat) });
    }

    prefabs.push({
      name: node.name || `bina${prefabs.length}`,
      parts,
      size: new THREE.Vector3(size.x * unit, 1, size.z * unit),   // birim yükseklikte
    });
  }

  // Kaynak tamponlara artık referans yok.
  src.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });

  return prefabs;
}

/* ======================= yedek (fallback) binalar ===================== */

/** Kanvasla çizilmiş pencere ızgarası — GLB olmadan da şehir gibi görünsün. */
function windowTexture(seed) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#171d2b'; g.fillRect(0, 0, 64, 128);
  let s = seed;
  const nx = 5, ny = 14;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      s = hash32(s + x * 31 + y * 131);
      const on = (s % 100) < 62;
      g.fillStyle = on ? '#f4e3b8' : '#0e1320';
      g.fillRect(4 + x * 12, 6 + y * 8.6, 7, 5);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** GLB yüklenemediğinde aynı arayüzü sunan basit kutu binalar. */
export function buildFallbackPrefabs(count = 8) {
  const prefabs = [];
  for (let i = 0; i < count; i++) {
    const w = 0.22 + (i % 4) * 0.06;
    const d = 0.20 + ((i * 3) % 5) * 0.05;
    const geo = new THREE.BoxGeometry(w, 1, d);
    geo.translate(0, 0.5, 0);
    const tex = windowTexture(1000 + i * 7919);
    tex.repeat.set(2, 6);
    const mat = new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex, emissive: new THREE.Color(0xffd9a8),
      emissiveIntensity: 0, roughness: 0.9, metalness: 0.05,
    });
    mat.name = `yedek${i}`;
    prefabs.push({
      name: `yedek${i}`,
      parts: [{ geometry: geo, material: mat }],
      size: new THREE.Vector3(w, 1, d),
    });
  }
  return prefabs;
}

/* ============================ manzara alanı =========================== */

const TMP_MAT = new THREE.Matrix4();
const TMP_POS = new THREE.Vector3();
const TMP_QUAT = new THREE.Quaternion();
const TMP_SCALE = new THREE.Vector3();
const TMP_EULER = new THREE.Euler();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Yol kenarındaki sonsuz bina alanı.
 *
 * Kullanım:
 *   const field = new SceneryField(prefabs, world);
 *   field.setRoadWidth(14);
 *   field.update(playerDistance);          // her karede — çoğu kare bedava
 *   field.setNightGlow(0.8);               // atmosfer katmanından
 *   field.dispose();
 */
export class SceneryField {
  /**
   * @param {Array} prefabs        buildBuildingPrefabs() ya da buildFallbackPrefabs() çıktısı
   * @param {THREE.Object3D} parent
   */
  constructor(prefabs, parent) {
    this.prefabs = prefabs;
    this.parent = parent;
    this.group = new THREE.Group();
    this.group.name = 'scenery';
    parent.add(this.group);

    this.roadHalfWidth = 7;
    this.enabled = true;
    this.glow = 0;
    this._firstChunk = null;
    this._lastChunk = null;
    this._counts = new Int32Array(prefabs.length);

    /** @type {Array<Array<THREE.InstancedMesh>>} tip -> malzeme başına instans meshleri */
    this.meshes = prefabs.map((p) => p.parts.map(({ geometry, material }) => {
      const im = new THREE.InstancedMesh(geometry, material, SCENERY.capacity);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Instansların gerçek zarfı taban geometriden çok daha büyük; kendi
      // hesabıyla yanlış eleme yapmasın diye frustum elemesi kapalı.
      im.frustumCulled = false;
      im.count = 0;
      im.castShadow = false;
      im.receiveShadow = false;
      this.group.add(im);
      return im;
    }));

    /** Gece pencere parlaması için tüm malzemelerin düz listesi. */
    this.materials = [];
    for (const p of prefabs) for (const part of p.parts) this.materials.push(part.material);
  }

  /** Yol yarı genişliği; binalar bunun dışına yerleşir. */
  setRoadWidth(halfWidth) {
    if (this.roadHalfWidth === halfWidth) return;
    this.roadHalfWidth = halfWidth;
    this._firstChunk = null;               // yeniden diz
  }

  /** 0 = gündüz (sönük), 1 = gece (camlar yanıyor). */
  setNightGlow(k) {
    if (Math.abs(this.glow - k) < 0.01) return;
    this.glow = k;
    for (const m of this.materials) {
      if (m.emissiveMap) m.emissiveIntensity = k;
    }
  }

  setVisible(on) {
    this.enabled = on;
    this.group.visible = on;
  }

  /** Parça kümesini sıfırlar — yeni yarış başlarken çağrılır. */
  reset() {
    this._firstChunk = null;
    this._lastChunk = null;
  }

  /**
   * Oyuncunun mesafesine göre alanı günceller.
   * Parça aralığı değişmediyse hiçbir iş yapmaz (karelerin ~%97'si).
   */
  update(distance) {
    if (!this.enabled) return;
    const c = SCENERY.chunkLength;
    const first = Math.floor((distance - SCENERY.drawBehind) / c);
    const last = Math.floor((distance + SCENERY.drawAhead) / c);
    if (first === this._firstChunk && last === this._lastChunk) return;
    this._firstChunk = first;
    this._lastChunk = last;
    this._layout(first, last);
  }

  /** Aralıktaki her parçayı gezip instans matrislerini baştan yazar. */
  _layout(first, last) {
    const counts = this._counts;
    counts.fill(0);
    const nTypes = this.prefabs.length;
    if (!nTypes) return;

    for (let chunk = first; chunk <= last; chunk++) {
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? -1 : 1;
        const rows = SCENERY.perChunkFront + SCENERY.perChunkBack;
        for (let k = 0; k < rows; k++) {
          const back = k >= SCENERY.perChunkFront;
          const salt = s * 41 + k * 97;

          // Seyrekleştirme: her yuva %14 ihtimalle boş kalır ki şehir
          // duvar gibi kesintisiz olmasın, aralardan ufuk görünsün.
          if (rand(chunk, salt + 5) < 0.14) continue;

          // Tip seçimi: dolu olan tipe düşersek sıradaki boş tipe kay.
          let type = Math.floor(rand(chunk, salt) * nTypes) % nTypes;
          let tries = 0;
          while (counts[type] >= SCENERY.capacity && tries++ < nTypes) {
            type = (type + 1) % nTypes;
          }
          if (counts[type] >= SCENERY.capacity) continue;

          const prefab = this.prefabs[type];
          const [hLo, hHi] = back ? SCENERY.backHeight : SCENERY.frontHeight;
          let scale = lerp(hLo, hHi, rand(chunk, salt + 1));
          // Çok ince kalan kuleleri kalınlaştır (yükseklikleri de büyür).
          const w = Math.max(prefab.size.x, prefab.size.z) * scale;
          if (w < SCENERY.minWidth) scale *= SCENERY.minWidth / Math.max(w, 1e-6);

          const [oLo, oHi] = back ? SCENERY.backOffset : SCENERY.frontOffset;
          const off = lerp(oLo, oHi, rand(chunk, salt + 2));
          const x = side * (this.roadHalfWidth + off + Math.max(prefab.size.x, prefab.size.z) * scale * 0.5);
          const z = (chunk + (k + 0.5) / rows) * SCENERY.chunkLength
            + (rand(chunk, salt + 3) - 0.5) * SCENERY.chunkLength * 0.45;
          const yaw = Math.floor(rand(chunk, salt + 4) * 4) * (Math.PI / 2);

          TMP_POS.set(x, 0, z);
          TMP_EULER.set(0, yaw, 0);
          TMP_QUAT.setFromEuler(TMP_EULER);
          TMP_SCALE.setScalar(scale);
          TMP_MAT.compose(TMP_POS, TMP_QUAT, TMP_SCALE);

          const slot = counts[type]++;
          for (const im of this.meshes[type]) im.setMatrixAt(slot, TMP_MAT);
        }
      }
    }

    for (let t = 0; t < nTypes; t++) {
      const used = counts[t];
      for (const im of this.meshes[t]) {
        // Kullanılmayan yuvaları sıfır ölçeğe çek: `count` düşse bile
        // sürücü eski matrisi okumasın.
        for (let i = used; i < im.count; i++) im.setMatrixAt(i, HIDDEN);
        im.count = used;
        im.instanceMatrix.needsUpdate = true;
      }
    }
  }

  dispose() {
    for (const row of this.meshes) {
      for (const im of row) {
        this.group.remove(im);
        im.dispose();
        im.geometry.dispose();
        if (im.material.map) im.material.map.dispose();
        im.material.dispose();
      }
    }
    this.meshes.length = 0;
    this.materials.length = 0;
    this.parent.remove(this.group);
  }
}
