/* =====================================================================
   loader.js — GLTF / DRACO varlık hattı
   ---------------------------------------------------------------------
   `game.js`'teki "model hattı" bölümünün birebir karşılığı:

     .glb indir  ->  tekerlekleri ayıkla  ->  gövdeyi malzeme başına
     birleştir  ->  normalleştir (burun +Z, lastikler y = 0)  ->  PBR
     cilası  ->  prefab.

   Ayrıca prefabtan örnek üretme (`instantiate`) ve örneğe ait tekerlek /
   gövde animasyonu (`driveWheels`, `poseBody`) burada durur: hepsi aynı
   veri düzeninin (prefab.userData) tüketicisidir.
   ===================================================================== */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import {
  DEBUG, DRACO_CDN, MODELS, SCENERY_MODEL, PLAYER_MODELS, TRAFFIC_MODELS,
  BODY, WHEEL, LOD_SWAP, LOD_CULL,
} from './config.js';
import { el } from './dom.js';
import { renderer } from './scene.js';
import { applyLook } from './vehicles.js';

/* ============================ model hattı ============================== */

THREE.Cache.enabled = true; // aynı url ikinci kez ağdan inmesin

export const loader = new GLTFLoader();
{
  // .glb dosyaları Draco ile sıkıştırıldı (157 MB -> ~11 MB).
  // DRACO_PATH tanımsızdı (kırık referans, tüm önyüklemeyi düşürüyordu) —
  // three.js zaten unpkg'den geliyor, decoder de aynı CDN'den paralel iner.
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_CDN);
  draco.setDecoderConfig({ type: 'wasm' }); // JS fallback'i denemeden doğrudan wasm
  // Çözme işi worker'lara dağılır: ana iş parçacığı (ve yükleme çubuğu) donmaz.
  draco.setWorkerLimit(Math.min(4, navigator.hardwareConcurrency || 2));
  draco.preload();                          // wasm, .glb'lerle aynı anda iner
  loader.setDRACOLoader(draco);
}

export const LOAD_KEYS = [...PLAYER_MODELS, ...TRAFFIC_MODELS];
export const ALL_LOADS = { ...MODELS, scenery: SCENERY_MODEL };
export const progress = Object.fromEntries([...LOAD_KEYS, 'scenery'].map((k) => [k, 0]));
export const prefabs = {};
/** Çubuğun %100'ü = SADECE açılışı bloklayan varlıklar; boot() daraltır. */
export let barKeys = [...LOAD_KEYS, 'scenery'];
/** Yarışın gerçekten beklediği tek şey: trafik + ertelenmiş rakip modeli. */
export let trafficReady = null;
/** Geriye dönük ad — trafik hattına işaret eder. */
export let assetsReady = null;

/* Modül dışından yeniden atama gerektiren üç bağın yazıcıları. `game.js`
   bunları düz `let` olarak tutuyordu; ES modüllerinde dışa aktarılan bağlar
   salt okunur olduğu için atama burada kalır, okuma canlı bağla aynı kalır. */
export function setBarKeys(keys) { barKeys = keys; }
export function setAssetsReady(p) { assetsReady = p; }

/* Trafik modelleri indiği ANDA çalışması gereken işler (havuz ön tahsisi,
   GPU ön ısıtma) buraya kaydolur. Kanca burada duruyor çünkü `trafikReady`
   söz nesnesini yazan tek yer burası; böylece `traffic.js` kendi ön ısıtmasını
   `main.js`'e bir satır bile eklemeden kurabiliyor ve modül grafiği tek yönlü
   kalıyor (traffic -> loader, ters yönde bağ yok). */
const readyHooks = new Set();

function runReadyHooks() {
  for (const fn of [...readyHooks]) {
    readyHooks.delete(fn);
    try { fn(); } catch (err) { console.warn('[loader] varlık kancası hata verdi', err); }
  }
}

/** Trafik varlıkları hazır olduğunda (ya da zaten hazırsa hemen) `fn`i çağırır. */
export function onAssetsReady(fn) {
  if (typeof fn !== 'function') return;
  readyHooks.add(fn);
  if (trafficReady) trafficReady.then(runReadyHooks);
}

export function setTrafficReady(p) {
  trafficReady = p;
  if (p && typeof p.then === 'function') p.then(runReadyHooks);
}

let barQueued = false;
export function paintLoadBar() {
  barQueued = false;
  const total = barKeys.reduce((s, k) => s + ALL_LOADS[k].weight, 0) || 1;
  const pct = Math.min(100, Math.round(
    barKeys.reduce((s, k) => s + progress[k] * ALL_LOADS[k].weight, 0) / total * 100
  ));
  el.loadBar.style.width = `${pct}%`;
  el.loadLabel.textContent = pct < 100 ? `Araçlar yükleniyor… %${pct}` : 'Otoyol hazırlanıyor…';
}

/** onProgress saniyede yüzlerce kez tetiklenir — kareye yalnız bir kez boya. */
export function setLoadProgress() {
  if (barQueued) return;
  barQueued = true;
  requestAnimationFrame(paintLoadBar);
}

export function loadGLTF(cfg) {
  return new Promise((resolve, reject) => {
    loader.load(
      cfg.url,
      (gltf) => resolve(gltf),
      (evt) => {
        // Sunucu Content-Length göndermiyorsa total 0 gelir.
        progress[cfg.key] = evt.total
          ? Math.min(1, evt.loaded / evt.total)
          : Math.min(0.95, progress[cfg.key] + 0.02);
        setLoadProgress();
      },
      reject
    );
  });
}

/* --- tekerlek tespiti -------------------------------------------------- */

/* Tekerleği ADINDAN bulmaya çalışmıyoruz. BMW modelinde neredeyse her
   malzeme "3erg20_stitch_WHEEL.001_N" diye adlandırılmış (sanatçı tüm atlası
   tekerlek dokusundan türetmiş), yani ada bakan bir kural aracın taban sacını
   da tekerlek sanıyor. Onun yerine saf geometri: aday parçalar dört çeyreğe
   bölünür ve her parça GERÇEKTEN tekerleğe benziyorsa kabul edilir. */
export const WHEEL_SHAPE = {
  lowFraction: 0.45,     // ağırlık merkezi kabuğun alt %45'inde olmalı
  roundness: 0.62,       // yükseklik / boy oranı — teker yuvarlaktır
  thinness: 0.85,        // aks boyunca kalınlık, çapın bu katından az olmalı
  minDiameter: 0.06,     // araç boyunun oranı olarak
  maxDiameter: 0.22,
  noiseTris: 30,         // bu kadar küçük çeyrek parçaları yok say
  noiseFraction: 0.02,
};

/**
 * Düğümleri düzgün adlandırılmış modellerde tekerlek adı kuralı.
 *
 * Ada göre ayıklama (`extractNamedWheels`) geometrik sezgiden daima daha
 * güvenlidir — teker KENDİ sınırından ayrılır, aracın orta hattından değil —
 * ama yalnızca adlandırma güvenilirse. Bu yüzden kural MODEL BAŞINA açılır:
 * BMW'de her malzeme "..._WHEEL..." adını taşıdığı için ada bakan bir kural
 * taban sacını da teker sanardı; o model geometrik yolda kalır.
 *
 * `ilkaraba.glb` düğümleri ölçüldü: `front right wheel`, `front left wheel`,
 * `rear wheels` (İKİ tekeri tek mesh'te taşır). Üçü de `wheel` malzemesini
 * kullanır ve bu adı başka hiçbir düğüm/malzeme taşımaz — yani kural tam
 * dört tekerleği alır, gövdeden hiçbir şey almaz.
 */
const WHEEL_NODE_RE =
  /(^|[\s_.\-])(wheels?|rims?|tyres?|tires?|[LR][FR]W)([\s_.\-]|$)/i;

/** Model anahtarı -> teker düğümü kuralı. `MODELS[].wheelNodes` bunu ezer. */
export const WHEEL_NODES = {
  ilkaraba: WHEEL_NODE_RE,
};

/** Eksen adı -> bileşen indeksi. */
const AXIS = { x: 0, y: 1, z: 2 };
const _v = new THREE.Vector3();

/**
 * Çok malzemeli bir geometriden tek bir `group`u indekssiz olarak keser.
 *
 * (Eskiden `buildPrefab()` içinde kapalıydı; ada göre tekerlek ayıklama da
 * aynı kesiciye ihtiyaç duyduğu için modül düzeyine alındı. Hiçbir kapanış
 * değişkenine dokunmuyordu, davranış birebir aynı.)
 */
function sliceGeometry(geo, start, count) {
  if (geo.index) {
    const cut = geo.clone();
    cut.clearGroups();
    cut.setIndex(new THREE.BufferAttribute(geo.index.array.slice(start, start + count), 1));
    const flat = cut.toNonIndexed();
    cut.dispose();
    return flat;
  }
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = geo.getAttribute(name);
    const n = a.itemSize;
    out.setAttribute(name, new THREE.BufferAttribute(a.array.slice(start * n, (start + count) * n), n));
  }
  return out;
}

/**
 * Bir meshi dünya matrisi pişirilmiş, birleştirilebilir bir geometriye çevirir.
 * Sadece birleştirebildiğimiz öznitelikleri (position/normal/uv) taşır.
 */
export function bakeGeometry(mesh, matrix) {
  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  if (!pos) return null;

  const baked = new THREE.BufferGeometry();
  baked.setAttribute('position', pos.clone());
  baked.setAttribute('normal', g.getAttribute('normal')
    ? g.getAttribute('normal').clone()
    : new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));
  baked.setAttribute('uv', g.getAttribute('uv')
    ? g.getAttribute('uv').clone()
    : new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
  if (g.index) baked.setIndex(g.index.clone());
  baked.applyMatrix4(matrix);
  if (!g.getAttribute('normal')) baked.computeVertexNormals();
  return baked;
}

/**
 * Tekerlekleri gövdeden ayırıp her birini kendi ekseni etrafında dönebilen bir
 * pivot grubuna koyar. Tüketilen parçaları `used` kümesinde geri döndürür ki
 * gövde birleştirmesi onları tekrar eklemesin.
 *
 * Modellerin hiçbiri aynı şekilde kurulmuş değil: npc1'de dört ayrı `wheel_0x`
 * düğümü var, npc2 ve npc3 dört tekerleği tek bir mesh'te birleştirmiş, BMW'de
 * ise 250 parçanın hepsi aynı anlamsız ada sahip. Ortak payda geometridir:
 * her aday parça ÜÇGEN ÜÇGEN dört çeyreğe bölünür, sonra ortaya çıkan
 * parçaların hepsi tekerlek biçiminde mi diye bakılır (yuvarlak, aks boyunca
 * ince, araç boyuna oranla makul çapta). Böyle olmayan bir parça — taban sacı,
 * egzoz, tavandaki yedek lastik — gövdede kalır.
 *
 * `shape` eşikleri model başına gevşetilebilir (MODELS[].wheelShape): karikatür
 * oranlı gövdelerde teker çapı gerçekçi modellerin iki katı olabiliyor.
 */
export function extractWheels(parts, shell, lateralAxis, lengthAxis, shape = WHEEL_SHAPE) {
  const centre = shell.getCenter(new THREE.Vector3());
  const size = shell.getSize(new THREE.Vector3());
  const lat = { x: 0, y: 1, z: 2 }[lateralAxis];
  const lon = { x: 0, y: 1, z: 2 }[lengthAxis];
  const cLat = centre.getComponent(lat);
  const cLon = centre.getComponent(lon);
  const lowY = shell.min.y + size.y * shape.lowFraction;
  const minDia = size[lengthAxis] * shape.minDiameter;
  const maxDia = size[lengthAxis] * shape.maxDiameter;

  // çeyrek -> Map(malzeme -> geometri[])
  const buckets = [new Map(), new Map(), new Map(), new Map()];
  const used = new Set();
  const partBox = new THREE.Box3();

  for (const part of parts) {
    // Ucuz ön eleme: tekerlek asla kaportanın üst yarısında olmaz.
    partBox.setFromObject(part.mesh);
    if (partBox.getCenter(new THREE.Vector3()).y > lowY) continue;

    const baked = bakeGeometry(part.mesh, part.matrix);
    if (!baked) continue;
    const flat = baked.index ? baked.toNonIndexed() : baked;
    if (flat !== baked) baked.dispose();

    const src = {
      position: flat.getAttribute('position'),
      normal: flat.getAttribute('normal'),
      uv: flat.getAttribute('uv'),
    };
    const triCount = src.position.count / 3;

    // Üçgenleri ağırlık merkezine göre sol/sağ × ön/arka çeyreklere ayır.
    const out = [[], [], [], []];
    for (let t = 0; t < triCount; t++) {
      const i = t * 3;                 // üçgenin ilk köşesinin köşe indeksi
      let sLat = 0, sLon = 0;
      for (let v = 0; v < 3; v++) {
        sLat += src.position.getComponent(i + v, lat);
        sLon += src.position.getComponent(i + v, lon);
      }
      const q = (sLat / 3 > cLat ? 2 : 0) + (sLon / 3 > cLon ? 1 : 0);
      out[q].push(i);
    }

    // Her çeyrek parçası tekerleğe benziyor mu? Biri bile benzemiyorsa parça
    // gövdeye geri döner — yarısını kesip almak modelde delik bırakırdı.
    let looksLikeWheel = false;
    let rejected = false;
    for (let q = 0; q < 4 && !rejected; q++) {
      if (!out[q].length) continue;
      if (out[q].length < shape.noiseTris &&
          out[q].length < triCount * shape.noiseFraction) continue;

      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (const i of out[q]) {
        for (let v = 0; v < 3; v++) {
          for (let c = 0; c < 3; c++) {
            const val = src.position.getComponent(i + v, c);
            if (val < lo[c]) lo[c] = val;
            if (val > hi[c]) hi[c] = val;
          }
        }
      }
      const sLatE = hi[lat] - lo[lat];
      const sY = hi[1] - lo[1];
      const sLonE = hi[lon] - lo[lon];
      const dia = Math.max(sY, sLonE);
      const round = Math.min(sY, sLonE) / Math.max(dia, 1e-9);

      if (round > shape.roundness &&
          sLatE < dia * shape.thinness &&
          dia > minDia && dia < maxDia) {
        looksLikeWheel = true;
      } else {
        rejected = true;
      }
    }

    if (rejected || !looksLikeWheel) { flat.dispose(); continue; }
    used.add(part);

    const material = Array.isArray(part.mesh.material) ? part.mesh.material[0] : part.mesh.material;
    for (let q = 0; q < 4; q++) {
      if (!out[q].length) continue;
      const n = out[q].length * 3;
      const geo = new THREE.BufferGeometry();
      for (const name of ['position', 'normal', 'uv']) {
        const a = src[name];
        const itemSize = a.itemSize;
        const arr = new Float32Array(n * itemSize);
        let w = 0;
        for (const i of out[q]) {
          for (let v = 0; v < 3; v++) {
            for (let c = 0; c < itemSize; c++) arr[w++] = a.getComponent(i + v, c);
          }
        }
        geo.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
      }
      if (!buckets[q].has(material)) buckets[q].set(material, []);
      buckets[q].get(material).push({ geo, part });
    }
    flat.dispose();
  }
  // `used` yakınlık elemesinden SONRA kesinleşir (aşağıda `keptParts`).

  const wheels = [];
  const box = new THREE.Box3();
  const keptParts = new Set();

  for (let q = 0; q < 4; q++) {
    if (!buckets[q].size) continue;

    // Pivot, kümenin ORTAK kutusundan değil, EN BÜYÜK çaplı parçasından
    // türetilir. Ortak kutu fren kaliperi gibi eksen dışı parçalar yüzünden
    // gerçek aksın yanına kayar ve teker dönerken göze batacak kadar yalpalar;
    // en dıştaki lastik halkası ise tanımı gereği aksa göre ortalıdır.
    let tyre = null, tyreDia = -1;
    for (const entries of buckets[q].values()) {
      for (const { geo } of entries) {
        geo.computeBoundingBox();
        const s = geo.boundingBox.getSize(new THREE.Vector3());
        const dia = Math.max(s.y, s[lengthAxis]);
        if (dia > tyreDia) { tyreDia = dia; tyre = geo.boundingBox; }
      }
    }
    const pivotAt = tyre.getCenter(new THREE.Vector3());
    const qSize = tyre.getSize(new THREE.Vector3());

    /* Lastiğin zarfının dışında kalan parçalar aslında tekerlek değildir
       (süspansiyon kolu, davlumbaz, çamurluk içi…). Burada bırakılırlarsa
       teker döndükçe etrafında yörüngeye girerler — npc2'de arka sol tekere
       yapışan bir plastik parça gövdeyi 15 cm sallıyordu. Gövdeye iade. */
    const near = (bb) => {
      const c = bb.getCenter(new THREE.Vector3());
      const radial = Math.hypot(c.y - pivotAt.y, c[lengthAxis] - pivotAt[lengthAxis]);
      return radial < tyreDia * 0.55 &&
        Math.abs(c[lateralAxis] - pivotAt[lateralAxis]) < tyreDia * 0.9;
    };

    const pivot = new THREE.Group();
    pivot.position.copy(pivotAt);
    // Y (direksiyon) DIŞTA, aks ekseni (dönüş) İÇTE kalsın.
    pivot.rotation.order = 'YXZ';

    box.makeEmpty();
    for (const [material, entries] of buckets[q]) {
      for (const { geo, part } of entries) {
        if (!near(geo.boundingBox)) { geo.dispose(); continue; }
        box.union(geo.boundingBox);
        keptParts.add(part);
        geo.translate(-pivotAt.x, -pivotAt.y, -pivotAt.z);
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, material);
        mesh.userData.materialName = material ? material.name : '';
        pivot.add(mesh);
      }
    }
    if (!pivot.children.length) continue;

    pivot.userData = {
      isWheel: true,
      spinAxis: lateralAxis,
      // Ada göre ayıklamayla aynı sözleşme: yuvarlanma yarıçapı = aks
      // yüksekliği eksi temas noktası (bkz. `extractNamedWheels`).
      radius: Math.max(pivotAt.y - box.min.y, qSize[lengthAxis] / 2),
      bottom: box.min.y,
      lon: pivotAt[lengthAxis],
      lat: pivotAt[lateralAxis],
    };
    wheels.push(pivot);
  }

  // Hiçbir parçası tekerlek olarak kalmayan mesh gövdeye geri döner.
  return { wheels, used: keptParts };
}

/* --- ada göre tekerlek tespiti + pivot düzeltme (modele özel) ---------- */

/*
 * Yukarıdaki geometrik sezgi ADSIZ modeller için yazıldı ve BMW gibi bütün
 * malzemesi "..._WHEEL..." adını taşıyan dosyalarda tek doğru yol o. Ama
 * düğümleri düzgün adlandırılmış bir modelde (ilkaraba) sezgi gereksiz risk
 * taşıyor: aracı dört çeyreğe bölmek, tekerleği KENDİ sınırından değil
 * ARACIN orta hattından ayırmak demek. `ilkaraba.glb`de bu iki yerde
 * ısırıyordu —
 *
 *   • `rear wheels` düğümü İKİ tekeri tek mesh'te taşıyor. Meshin kendi
 *     kutusunun merkezi aracın orta hattına düşer; oraya konan bir pivot
 *     tekerin tamamen dışındadır, teker kendi aksında değil aracın altında
 *     yörüngede döner. (Şikâyet edilen "dış eksende dönme" tam olarak bu.)
 *   • Gövdedeki `black floats` parçası yuvarlaklık eşiğinin %3 altında
 *     (0.600 / 0.62) duruyor: model bir daha dışa aktarıldığında ön teker
 *     kovasına düşüp pivotu kaydırabilirdi.
 *
 * Bu yol, `MODELS[].wheelNodes` tanımlı olan modellerde devreye girer ve
 * tekerlekleri şöyle kurar:
 *
 *   1. Adı kurala uyan mesh bulunur (kendi adı, ata düğüm adı veya malzeme
 *      adı) — ve KUTUSU da tekerleğe benzemek zorundadır, yani "steering
 *      wheel" / "wheel arch" gibi adaylar burada elenir.
 *   2. Mesh'in dünya matrisi geometriye pişirilir (özgün konum/dönüşü
 *      koruyan tek yol: gövde de aynı şekilde pişiriliyor).
 *   3. Tek mesh'te birden çok teker varsa mesh, İÇİNDE HİÇ ÜÇGEN OLMAYAN
 *      boşluklardan bölünür — hiçbir üçgen ikiye kesilmediği için lastikte
 *      delik açılmaz.
 *   4. Her teker için geometri `center()` ile kendi geometrik merkezine
 *      oturtulur ve merkeze konan temiz bir `THREE.Group` pivotunun ALTINA
 *      alınır. Böylece dönüş ekseni aksın tam üstünden geçer.
 *   5. Özgün mesh düğümü gövde birleştirmesinden düşürülür (`used`), yani
 *      hiyerarşide yerini bu pivot grubu alır.
 */

/**
 * Adı kurala uyuyor mu?
 *
 * GLTF dışa aktarımlarında geometriyi taşıyan düğüm çoğu zaman
 * `<isim>_<malzeme>_0` diye türetilir ve ASIL ad ebeveynde durur
 * (`front right wheel` -> `front right wheel_wheel_0`); bu yüzden ata
 * zincirinin tamamına ve malzeme adlarına bakılır.
 */
function wheelNamed(part, re) {
  for (let o = part.mesh; o; o = o.parent) if (o.name && re.test(o.name)) return true;
  for (const m of part.mats) if (m && m.name && re.test(m.name)) return true;
  return false;
}

/** Parçayı malzeme başına, indekssiz, dünya matrisi pişmiş geometrilere böler. */
function bakePieces(part) {
  const baked = bakeGeometry(part.mesh, part.matrix);
  if (!baked) return [];
  const g = part.mesh.geometry;
  const out = [];

  if (part.mats.length > 1 && g.groups.length) {
    for (const grp of g.groups) {
      const geo = sliceGeometry(baked, grp.start, grp.count);
      if (geo) out.push({ geo, material: part.mats[grp.materialIndex] || part.mats[0] });
    }
    baked.dispose();
  } else {
    const flat = baked.index ? baked.toNonIndexed() : baked;
    if (flat !== baked) baked.dispose();
    out.push({ geo: flat, material: part.mats[0] });
  }
  return out;
}

/** Üçgen başına eksen aralıkları — bölme ve kutu hesabı bunun üstünde döner. */
function triangleSpans(pieces) {
  let n = 0;
  for (const p of pieces) n += p.geo.getAttribute('position').count / 3;

  const lo = new Float32Array(n * 3);
  const hi = new Float32Array(n * 3);
  const piece = new Uint32Array(n);
  const vert = new Uint32Array(n);      // üçgenin ilk köşesinin köşe indeksi

  let k = 0;
  for (let pi = 0; pi < pieces.length; pi++) {
    const pos = pieces[pi].geo.getAttribute('position');
    const tris = pos.count / 3;
    for (let t = 0; t < tris; t++) {
      const i = t * 3;
      for (let c = 0; c < 3; c++) {
        let a = Infinity, b = -Infinity;
        for (let v = 0; v < 3; v++) {
          const val = pos.getComponent(i + v, c);
          if (val < a) a = val;
          if (val > b) b = val;
        }
        lo[k * 3 + c] = a;
        hi[k * 3 + c] = b;
      }
      piece[k] = pi;
      vert[k] = i;
      k++;
    }
  }
  return { n, lo, hi, piece, vert };
}

/**
 * Eksen boyunca İÇİNDE HİÇBİR ÜÇGEN OLMAYAN boşlukları bulur ve ortalarından
 * kesim noktaları döndürür.
 *
 * Süpürme, üçgenleri başlangıçlarına göre sıralayıp o ana kadar ulaşılan en
 * uzak noktayı ("reach") takip eder: bir sonraki üçgen o noktadan `minGap`
 * kadar ötede başlıyorsa arada gerçekten boşluk vardır. Boşluk kanıtlanmış
 * olduğu için kesim hiçbir üçgeni ikiye ayırmaz.
 */
function emptySlabCuts(S, axis, minGap) {
  const order = new Uint32Array(S.n);
  for (let i = 0; i < S.n; i++) order[i] = i;
  order.sort((a, b) => S.lo[a * 3 + axis] - S.lo[b * 3 + axis]);

  const cuts = [];
  let reach = -Infinity;
  for (let j = 0; j < S.n; j++) {
    const i = order[j];
    const l = S.lo[i * 3 + axis];
    if (reach > -Infinity && l - reach > minGap) cuts.push((reach + l) / 2);
    const h = S.hi[i * 3 + axis];
    if (h > reach) reach = h;
  }
  return cuts;
}

/** `v` hangi dilime düşer? (kesimler artan sırada gelir) */
function cellOf(v, cuts) {
  let i = 0;
  while (i < cuts.length && v > cuts[i]) i++;
  return i;
}

/**
 * Tekerleğe benziyor mu? `extractWheels`teki ölçütlerin aynısı, ama burada
 * ada göre seçilmiş bir adayı DOĞRULAMAK için kullanılıyor: yuvarlak, aks
 * boyunca ince, araç boyuna göre makul çapta ve kaportanın alt yarısında.
 */
function wheelShaped(box, lat, lon, shape, minDia, maxDia, lowY) {
  const sLat = box.max.getComponent(lat) - box.min.getComponent(lat);
  const sY = box.max.y - box.min.y;
  const sLon = box.max.getComponent(lon) - box.min.getComponent(lon);
  const dia = Math.max(sY, sLon);
  const round = Math.min(sY, sLon) / Math.max(dia, 1e-9);
  return (box.min.y + box.max.y) / 2 <= lowY &&
    round > shape.roundness &&
    sLat < dia * shape.thinness &&
    dia > minDia && dia < maxDia;
}

/**
 * Adı `nameRe`ye uyan tekerlek düğümlerini gövdeden ayırır ve her birini
 * geometrik merkezine oturtulmuş temiz bir pivot grubuna koyar.
 *
 * `extractWheels` ile BİREBİR aynı sözleşmeyi döndürür — `{ wheels, used }`,
 * pivotlar model uzayında, `userData` alanları aynı — böylece `buildPrefab`,
 * `instantiate`, `driveWheels` hattının geri kalanı iki yolu ayırt etmez.
 *
 * @param {Array}   parts        { mesh, mats, matrix } kayıtları
 * @param {THREE.Box3} shell     aracın kabuğu (model uzayı)
 * @param {'x'|'z'} lateralAxis  aks (dönüş) ekseni
 * @param {'x'|'z'} lengthAxis   aracın uzun ekseni
 * @param {RegExp}  nameRe       MODELS[].wheelNodes
 * @param {object}  shape        WHEEL_SHAPE eşikleri
 */
export function extractNamedWheels(parts, shell, lateralAxis, lengthAxis, nameRe, shape = WHEEL_SHAPE) {
  const size = shell.getSize(new THREE.Vector3());
  const lat = AXIS[lateralAxis];
  const lon = AXIS[lengthAxis];
  const lowY = shell.min.y + size.y * shape.lowFraction;
  const minDia = size[lengthAxis] * shape.minDiameter;
  const maxDia = size[lengthAxis] * shape.maxDiameter;

  const wheels = [];
  const used = new Set();
  const partBox = new THREE.Box3();

  for (const part of parts) {
    if (!wheelNamed(part, nameRe)) continue;

    // Ada tek başına güvenilmez: "steering wheel", "wheel arch", "rim trim"
    // gibi düğümler de kurala uyar. Kaba kutu elemesi, kaportanın üst
    // yarısında duran her adayı daha geometriyi pişirmeden durdurur.
    partBox.setFromObject(part.mesh);
    if (partBox.getCenter(_v).y > lowY) continue;

    const pieces = bakePieces(part);
    if (!pieces.length) continue;

    const S = triangleSpans(pieces);
    if (!S.n) { for (const p of pieces) p.geo.dispose(); continue; }

    /* Tek mesh'te birden çok teker olabilir (`rear wheels`). Bir tekerin
       kendi içinde bu kadar büyük boşluğu olmaz: en büyük iç boşluk ön
       tekerde 0.006 birim, iki teker arası ise 4.16 birim. Eşik çapın
       ~%35'i — arada güvenli bir kat var. */
    const spanLon = partBox.max.getComponent(lon) - partBox.min.getComponent(lon);
    const gap = Math.max(spanLon, partBox.max.y - partBox.min.y) * 0.35;
    const cutsLat = emptySlabCuts(S, lat, gap);
    const cutsLon = emptySlabCuts(S, lon, gap);

    /* Üçgenleri hücrelere dağıt. (Kesim boş aralıktan geçtiği için üçgenin
       hangi ucuna bakıldığı fark etmez.) */
    const stride = cutsLon.length + 1;
    const cells = new Map();
    for (let i = 0; i < S.n; i++) {
      const key = cellOf(S.lo[i * 3 + lat], cutsLat) * stride +
                  cellOf(S.lo[i * 3 + lon], cutsLon);
      let cell = cells.get(key);
      if (!cell) { cell = { tris: [], box: new THREE.Box3() }; cells.set(key, cell); }
      cell.tris.push(i);
      cell.box.expandByPoint(_v.set(S.lo[i * 3], S.lo[i * 3 + 1], S.lo[i * 3 + 2]));
      cell.box.expandByPoint(_v.set(S.hi[i * 3], S.hi[i * 3 + 1], S.hi[i * 3 + 2]));
    }

    /* Kırıntı hücreler (bir vidanın birkaç üçgeni) kendi başına tekerlek
       sayılmaz; en yakın gerçek hücreye katılır. Atılsalardı lastikte delik
       kalırdı. */
    const solid = [];
    const crumbs = [];
    for (const cell of cells.values()) {
      if (cell.tris.length < shape.noiseTris && cell.tris.length < S.n * shape.noiseFraction) {
        crumbs.push(cell);
      } else {
        solid.push(cell);
      }
    }
    for (const crumb of crumbs) {
      let best = null, bestD = Infinity;
      const c = crumb.box.getCenter(new THREE.Vector3());
      for (const cell of solid) {
        const d = c.distanceToSquared(cell.box.getCenter(_v));
        if (d < bestD) { bestD = d; best = cell; }
      }
      if (!best) { solid.length = 0; break; }     // hepsi kırıntı: aday değil
      best.tris.push(...crumb.tris);
      best.box.union(crumb.box);
    }

    // Hepsi geçmek zorunda: bir hücre tekerleğe benzemiyorsa mesh'in TAMAMI
    // gövdeye döner — yarısını alıp yarısını bırakmak modelde delik açardı.
    const ok = solid.length > 0 &&
      solid.every((cell) => wheelShaped(cell.box, lat, lon, shape, minDia, maxDia, lowY));
    if (!ok) { for (const p of pieces) p.geo.dispose(); continue; }

    /* Özgün dünya konumu/dönüşü — pivot bunun üstüne kurulur. Dönüş zaten
       geometriye pişirildiği (adım 2) için gruba TEKRAR uygulanmaz; iki kez
       sayılırsa teker yamulur. Kayıt yalnızca teşhis içindir. */
    const srcPos = new THREE.Vector3();
    const srcQuat = new THREE.Quaternion();
    part.matrix.decompose(srcPos, srcQuat, new THREE.Vector3());

    for (const cell of solid) {
      // Pivot: hücrenin KENDİ geometrik merkezi (aracın orta hattı değil).
      const pivotAt = cell.box.getCenter(new THREE.Vector3());
      const cellSize = cell.box.getSize(new THREE.Vector3());

      const pivot = new THREE.Group();
      pivot.position.copy(pivotAt);
      // Y (direksiyon) DIŞTA, aks ekseni (dönüş) İÇTE kalsın.
      pivot.rotation.order = 'YXZ';

      // Hücrenin üçgenlerini kaynak parça başına topla.
      const byPiece = new Map();
      for (const i of cell.tris) {
        const pi = S.piece[i];
        if (!byPiece.has(pi)) byPiece.set(pi, []);
        byPiece.get(pi).push(S.vert[i]);
      }

      const geos = [];
      for (const [pi, starts] of byPiece) {
        const src = pieces[pi].geo;
        const n = starts.length * 3;
        const geo = new THREE.BufferGeometry();
        for (const name of ['position', 'normal', 'uv']) {
          const a = src.getAttribute(name);
          if (!a) continue;
          const arr = new Float32Array(n * a.itemSize);
          let w = 0;
          for (const i of starts) {
            for (let v = 0; v < 3; v++) {
              for (let c = 0; c < a.itemSize; c++) arr[w++] = a.getComponent(i + v, c);
            }
          }
          geo.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
        }
        geos.push({ geo, material: pieces[pi].material });
      }

      /* İSTENEN DÜZELTMENİN ÖZÜ: köşe verisi kendi geometrik merkezine
         kaydırılır, yani mesh'in merkezi (0,0,0)'a oturur. Tek geometrili
         (olağan) durumda bu doğrudan `geometry.center()`tir; birden çok
         malzeme varsa hepsi ORTAK merkeze göre kaydırılmak zorunda, yoksa
         parçalar birbirinden ayrılırdı. */
      if (geos.length === 1) {
        geos[0].geo.center();
      } else {
        for (const { geo } of geos) geo.translate(-pivotAt.x, -pivotAt.y, -pivotAt.z);
      }

      for (const { geo, material } of geos) {
        geo.computeBoundingSphere();
        const m = new THREE.Mesh(geo, material);
        m.userData.materialName = material ? material.name : '';
        pivot.add(m);
      }

      pivot.userData = {
        isWheel: true,
        spinAxis: lateralAxis,
        /* YUVARLANMA YARIÇAPI = aks yüksekliği eksi temas noktası, kutunun
           yarısı DEĞİL. İkisi yuvarlak bir tekerde birbirine eşittir; lastiğin
           sırtında en ufak bir çıkıntı varsa kutu yarıçapı büyür ve teker
           gerçekte aldığı yoldan yavaş dönerdi (kayma hissi). */
        radius: Math.max(pivotAt.y - cell.box.min.y, cellSize[lengthAxis] / 2),
        bottom: cell.box.min.y,
        lon: pivotAt[lengthAxis],
        lat: pivotAt[lateralAxis],
        /* Özgün dünya konumu/dönüşü — hem teşhis hem de "pivot ne kadar
           kaydı" ölçüsü. Dönüş geometriye zaten pişirildiği için buradaki
           quaternion gruba UYGULANMAZ; iki kez sayılırsa teker yamulur. */
        repivot: {
          from: { x: srcPos.x, y: srcPos.y, z: srcPos.z },
          to: { x: pivotAt.x, y: pivotAt.y, z: pivotAt.z },
          quat: { x: srcQuat.x, y: srcQuat.y, z: srcQuat.z, w: srcQuat.w },
        },
      };
      wheels.push(pivot);
    }

    // Pivotlar kuruldu: özgün mesh artık gövde birleştirmesine girmez.
    used.add(part);
    for (const p of pieces) p.geo.dispose();
  }

  return { wheels, used };
}

/**
 * Kaporta yatıp daldığında asfaltın altına ne kadar ineceğini ÖLÇER.
 *
 * Sınır kutusunun alt köşelerinden hesaplamak çok kötümser: gerçek bir aracın
 * en alçak noktası aynı anda hem en geniş hem en uzun uçta değildir. Kutu
 * hesabı BMW'de 17 cm kaldırma istiyordu — araba zıplıyormuş gibi görünürdü.
 * Bunun yerine gerçek köşe noktaları üzerinden, açı ızgarasının her düğümünde
 * gereken kaldırma bir kez ölçülür; çalışma anında aradaki değerler doğrusal
 * olarak bulunur. Fonksiyon dışbükey olduğu için ara değerler daima güvenli
 * tarafta (biraz fazla) kalır.
 *
 * @returns {{ roll:number[], pitch:number[], lift:number[][] }}
 */
export function measureLift(bodyNorm, rollCentre, rollMax = BODY.rollMax, pitchMax = BODY.pitchMax) {
  const rolls = [0, rollMax * 0.5, rollMax];
  const pitches = [-pitchMax, 0, pitchMax];

  // Köşe noktalarını bodyPivot uzayına taşı; her 11. köşe yeterli çözünürlük.
  bodyNorm.updateMatrixWorld(true);
  const pts = [];
  const v = new THREE.Vector3();
  bodyNorm.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.getAttribute('position');
    if (!pos) return;
    const stride = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      pts.push(v.x, v.y, v.z);
    }
  });

  const lift = rolls.map((roll) => pitches.map((pitch) => {
    let worst = 0;
    // Euler sırası YXZ -> önce yatış (Z), sonra dalış (X).
    for (const sign of [1, -1]) {
      const s = Math.sin(roll * sign), cR = Math.cos(roll * sign);
      const sP = Math.sin(pitch), cP = Math.cos(pitch);
      for (let i = 0; i < pts.length; i += 3) {
        const y = (pts[i] * s + pts[i + 1] * cR) * cP - pts[i + 2] * sP;
        const ground = rollCentre + y;
        if (ground < worst) worst = ground;
      }
    }
    return -worst;             // >= 0: asfaltın altına inen miktar
  }));

  return { roll: rolls, pitch: pitches, lift };
}

/* ------------------------ PBR malzeme cilası --------------------------- */

/* Her .glb kendi sanatçısının ayarlarıyla geliyor: kimi doku sRGB
   işaretlenmemiş, kiminde anizotropik filtre yok (jant yazıları eğik açıdan
   bulanıklaşıyor), kimi kaporta metalness = 0 ile mat plastik gibi duruyor.
   Aşağıdaki geçiş üç garaj aracını da (Süper Coupe, Spor Coupe, Şehir
   Hatchback) ve trafiği AYNI hattan geçirir, böylece hiçbir araç ötekinin
   yanında "başka bir oyundan gelmiş" gibi görünmez. */

/** Aynı malzeme/doku onlarca mesh'te paylaşılır — her birini bir kez işle. */
const tunedMaterials = new WeakSet();
const tunedTextures = new WeakSet();

let _maxAniso = 0;
function maxAnisotropy() {
  if (!_maxAniso) _maxAniso = renderer.capabilities.getMaxAnisotropy() || 1;
  return _maxAniso;
}

/**
 * Bir dokuyu oyunun renk hattına oturtur.
 *
 * RENK dokuları (albedo, emissive) sRGB'dir. Normal / metalness-roughness /
 * AO dokuları VERİdir ve doğrusal kalmak zorundadır — sRGB işaretlenirlerse
 * three onları bir kez daha gamma'lar, yüzey plastikleşir.
 *
 * Anizotropi asfalt gibi eğik bakılan yüzeylerde belirleyici: yol dokusu
 * zaten maksimuma çekiliyordu, araçlarınki 1'de kalmıştı.
 */
export function tuneTexture(tex, srgb) {
  if (!tex || tunedTextures.has(tex)) return;
  tunedTextures.add(tex);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = maxAnisotropy();
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
}

const GLASS_RE = /glass|window|windshield|windscreen|vitre/i;
const LAMP_RE = /head ?light|tail ?light|lamp|stop/i;
const CHROME_RE = /chrome|krom|mirror/i;
const TYRE_RE = /tyre|tire|rubber|lastik/i;

const clamp01 = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Tek bir malzemeyi hizalar: dokular yukarıdaki kurala göre, sayısal
 * değerler ise malzemenin ne olduğuna göre (kaporta / cam / krom / lastik).
 * Uçları budamak amaç: roughness 0 kaportayı ayna, 1 ise tebeşir yapıyor;
 * ikisi de aynı sahnedeki öteki araçların yanında sırıtıyor.
 */
export function tuneMaterial(mat, cfg) {
  if (!mat || tunedMaterials.has(mat)) return;
  tunedMaterials.add(mat);

  const name = mat.name || '';

  tuneTexture(mat.map, true);
  tuneTexture(mat.emissiveMap, true);
  tuneTexture(mat.specularColorMap, true);
  tuneTexture(mat.sheenColorMap, true);
  for (const t of [mat.normalMap, mat.roughnessMap, mat.metalnessMap, mat.aoMap,
    mat.alphaMap, mat.clearcoatNormalMap, mat.clearcoatRoughnessMap]) tuneTexture(t, false);

  if (!('roughness' in mat)) return;      // MeshBasic vb.: PBR alanı yok

  // Sahnenin IBL'i (RoomEnvironment) hem pistte hem garajda aynı; şiddeti de
  // aynı olsun ki araç garajdan piste geçerken renk atlaması olmasın.
  mat.envMapIntensity = 1.15;

  const lamp = LAMP_RE.test(name);
  if (lamp) { mat.needsUpdate = true; return; }   // farlara dokunma

  if (TYRE_RE.test(name)) {
    mat.metalness = 0;
    mat.roughness = clamp01(mat.roughness ?? 0.9, 0.70, 0.95);
  } else if (GLASS_RE.test(name)) {
    mat.metalness = 0.12;
    mat.roughness = clamp01(mat.roughness ?? 0.05, 0.02, 0.12);
  } else if (CHROME_RE.test(name)) {
    mat.metalness = 1;
    mat.roughness = clamp01(mat.roughness ?? 0.10, 0.04, 0.22);
  } else if (cfg.paint && cfg.paint.test(name)) {
    // Kaporta: garajdaki kaplama seçimi (applyLook) bunun ÜSTÜNE yazar; bu
    // değerler boyanmamış/trafik örneklerinin taban görünümü.
    mat.metalness = clamp01(mat.metalness ?? 0.8, 0.55, 1);
    mat.roughness = clamp01(mat.roughness ?? 0.2, 0.08, 0.35);
    if ('clearcoat' in mat) {
      mat.clearcoat = Math.max(mat.clearcoat ?? 0, 1);
      mat.clearcoatRoughness = clamp01(mat.clearcoatRoughness ?? 0.05, 0.02, 0.12);
    }
  } else if (!mat.roughnessMap) {
    mat.roughness = clamp01(mat.roughness ?? 0.6, 0.08, 0.90);
  }

  mat.needsUpdate = true;
}

/** Bir prefabın bütün mesh/malzemelerini PBR hattından geçirir. */
export function tunePrefabMaterials(root, cfg) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    // Gölge haritası pistte kapalı (araç başına bir blob doku kullanıyoruz);
    // bayraklar yine de doğru olsun ki garajda/ileride açıldığında araç
    // gölgesiz kalmasın.
    o.castShadow = true;
    o.receiveShadow = false;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) tuneMaterial(m, cfg);
  });
}

/**
 * Sketchfab tarzı bir GLTF'i (yüzlerce minik mesh) malzeme başına bir mesh'e
 * indirger. Çizim çağrılarını ~250'den ~40'a düşürür ve her trafik örneğinin
 * aynı geometriyi paylaşmasını sağlar.
 *
 * `dropInterior`, sınır kutusu tamamen aracın kabuğunun içinde kalan meshleri
 * atar (koltuklar, gösterge paneli, motor, turbo tesisatı). Tamamen geometrik
 * bir ölçüt olduğu için sanatçının isimlendirmesine bağlı değildir.
 */
export function buildPrefab(gltf, cfg, { dropInterior = true } = {}) {
  const src = gltf.scene;
  src.updateWorldMatrix(true, true);

  /* 1 — parçaları topla, sahne süslerini daha ölçmeden at ------------------ */
  const parts = [];
  src.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (cfg.dropMaterials && mats.every((m) => m && cfg.dropMaterials.test(m.name || ''))) return;
    parts.push({ mesh: o, mats, matrix: o.matrixWorld.clone() });
  });

  /* 2 — geriye kalanın kabuğu; artık sadece araç var ---------------------- */
  const box = new THREE.Box3();
  const shell = new THREE.Box3();
  shell.makeEmpty();
  for (const p of parts) { box.setFromObject(p.mesh); shell.union(box); }

  const size = shell.getSize(new THREE.Vector3());
  const centre = shell.getCenter(new THREE.Vector3());
  // faceYaw ±90° ise model uzun kenarı X boyunca modellenmiş demektir.
  const lengthAxis = Math.abs(Math.sin(cfg.faceYaw)) > 0.5 ? 'x' : 'z';
  const lateralAxis = lengthAxis === 'x' ? 'z' : 'x';

  /* 3 — tekerlekleri ayıkla; geri kalanı gövdedir --------------------------
     Düğümleri düzgün adlandırılmış modeller (`cfg.wheelNodes`) ada göre
     ayıklanır: teker mesh'i kendi geometrik merkezine oturtulup temiz bir
     pivot grubuna alınır. Kural tanımlı DEĞİLSE eski geometrik sezgi
     çalışır — BMW gibi her malzemesi "..._WHEEL..." adını taşıyan
     dosyalarda tek doğru yol o. */
  const wheelShape = cfg.wheelShape ? { ...WHEEL_SHAPE, ...cfg.wheelShape } : WHEEL_SHAPE;
  const wheelNodes = cfg.wheelNodes || WHEEL_NODES[cfg.key] || null;
  let { wheels, used } = wheelNodes
    ? extractNamedWheels(parts, shell, lateralAxis, lengthAxis, wheelNodes, wheelShape)
    : extractWheels(parts, shell, lateralAxis, lengthAxis, wheelShape);
  /* Ada göre yol dört tekeri bulamadıysa (model yeniden dışa aktarılmış,
     düğümler yeniden adlandırılmış) geometrik sezgiye düş: tekersiz bir
     araçtan iyidir. */
  if (wheelNodes && wheels.length < 4) {
    if (DEBUG) console.warn(`[prefab] ${cfg.url}: ada göre ${wheels.length} teker bulundu, geometrik sezgiye düşülüyor`);
    for (const w of wheels) w.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    ({ wheels, used } = extractWheels(parts, shell, lateralAxis, lengthAxis, wheelShape));
  }
  const bodyParts = parts.filter((p) => !used.has(p));

  /* 4 — gövdeyi malzeme başına birleştir ---------------------------------- */
  const skin = cfg.interiorSkin ?? 0.15;
  const inner = shell.clone();
  inner.min.x += size.x * skin; inner.max.x -= size.x * skin;
  inner.min.z += size.z * skin; inner.max.z -= size.z * skin;
  inner.min.y += size.y * skin * 0.7; inner.max.y = shell.min.y + size.y * 0.74;

  /** @type {Map<THREE.Material, THREE.BufferGeometry[]>} */
  const groups = new Map();
  let dropped = 0;

  function push(mat, geo) {
    if (!mat || !geo) return;
    if (!groups.has(mat)) groups.set(mat, []);
    groups.get(mat).push(geo);
  }

  for (const { mesh, mats, matrix } of bodyParts) {
    if (dropInterior && mats.length === 1) {
      box.setFromObject(mesh);
      if (inner.containsBox(box)) { dropped++; continue; }
    }

    const baked = bakeGeometry(mesh, matrix);
    if (!baked) continue;
    const g = mesh.geometry;

    if (mats.length > 1 && g.groups.length) {
      // Çok malzemeli geometriyi böl ki her dilim doğru kovaya girsin.
      for (const grp of g.groups) {
        push(mats[grp.materialIndex] || mats[0], sliceGeometry(baked, grp.start, grp.count));
      }
      baked.dispose();
    } else {
      push(mats[0], baked);
    }
  }

  const body = new THREE.Group();
  let tris = 0;
  for (const [mat, geos] of groups) {
    // mergeGeometries partinin tamamında tutarlı bir index durumu ister.
    const anyIndexed = geos.some((g) => g.index);
    const allIndexed = geos.every((g) => g.index);
    const batch = anyIndexed && !allIndexed ? geos.map((g) => g.toNonIndexed()) : geos;

    let merged = null;
    try { merged = mergeGeometries(batch, false); } catch { merged = null; }
    if (!merged) {
      // Malzemeyi tamamen kaybetmektense birleştirmeden ekle.
      for (const g of batch) body.add(new THREE.Mesh(g, mat));
      continue;
    }
    merged.computeBoundingSphere();
    tris += (merged.index ? merged.index.count : merged.getAttribute('position').count) / 3;
    for (const g of batch) g.dispose();   // veri artık `merged` içinde

    const mesh = new THREE.Mesh(merged, mat);
    mesh.userData.materialName = mat.name;
    mesh.frustumCulled = true;
    body.add(mesh);
  }

  /* 5 — normalleştir: burun +Z, X'te ortalı, LASTİKLER y = 0'da ----------- */
  const rig = new THREE.Group();
  rig.rotation.y = cfg.faceYaw;
  const wheelGroup = new THREE.Group();
  for (const w of wheels) wheelGroup.add(w);
  rig.add(body, wheelGroup);
  rig.updateMatrixWorld(true);

  const bb = new THREE.Box3().setFromObject(rig);
  const bbSize = bb.getSize(new THREE.Vector3());
  const scale = cfg.length / bbSize.z;

  // Zemin referansı: tekerlek varsa lastiğin en alt noktası, yoksa kabuğun
  // dibi. Böylece alçak bir difüzör aracı havada bırakmaz, kaporta da asfalta
  // gömülmez. (Y ekseni faceYaw'dan etkilenmediği için model uzayı = bu uzay.)
  const groundY = wheels.length
    ? Math.min(...wheels.map((w) => w.userData.bottom))   // model uzayında mutlak
    : bb.min.y;

  /* Dört teker aynı yükseklikte MODELLENMEMİŞ olabilir: `ilkaraba.glb`de arka
     tekerlerin dibi ön tekerlerden 0.060 birim yukarıda duruyor. Zemin en
     alçak tekere göre ayarlandığı için arka lastikler asfaltın ~1.9 cm
     üstünde havada kalıyor, araç arkadan kalkıkmış gibi görünüyordu.
     Her pivotu KENDİ temas noktasına indirerek dördü de yola otursun.
     Fark yarıçapın %20'sini aşarsa dokunma: o kadar sapan bir parça büyük
     ihtimalle yanlış tespit edilmiş bir gövde parçasıdır, onu yere çakmak
     mevcut hâlinden daha kötü görünür. */
  for (const w of wheels) {
    const wu = w.userData;
    const drop = wu.bottom - groundY;
    if (drop > 1e-6 && drop < wu.radius * 0.20) {
      w.position.y -= drop;
      wu.bottom = groundY;
      // `radius` aksın KENDİ temas noktasına uzaklığı; öteleme onu değiştirmez.
      if (DEBUG) console.log(`[prefab] ${cfg.url}: teker (lat ${wu.lat?.toFixed(2)}, lon ${wu.lon?.toFixed(2)}) ${drop.toFixed(4)} birim indirildi — asfalta oturdu`);
    }
  }

  const offset = new THREE.Vector3(
    -((bb.min.x + bb.max.x) / 2) * scale,
    -groundY * scale,
    -((bb.min.z + bb.max.z) / 2) * scale
  );

  rig.remove(body, wheelGroup);

  const height = bbSize.y * scale;
  const width = bbSize.x * scale;
  const rollCentre = height * 0.38;     // gövdenin yattığı eksenin yüksekliği

  /* Hiyerarşi:
       holder
        ├── bodyPivot   (yatış Z / dalış X — sadece kaporta)
        │    └── bodyNorm  (faceYaw + ölçek + kaydırma)
        └── wheelRoot   (aynı normalleştirme, ama yatmaz: lastikler yolda kalır)
  */
  const holder = new THREE.Group();

  const bodyNorm = new THREE.Group();
  bodyNorm.rotation.y = cfg.faceYaw;
  bodyNorm.scale.setScalar(scale);
  bodyNorm.position.set(offset.x, offset.y - rollCentre, offset.z);
  bodyNorm.add(body);

  // Kaldırma tablosunu bodyPivot'a EKLEMEDEN önce ölç: bu sayede noktalar
  // pivotun kendi uzayında çıkar, pivotun yüksekliği iki kez sayılmaz.
  const liftTable = measureLift(bodyNorm, rollCentre, BODY.rollMax, BODY.pitchMax);

  const bodyPivot = new THREE.Group();
  bodyPivot.name = 'bodyPivot';
  bodyPivot.position.y = rollCentre;
  bodyPivot.rotation.order = 'YXZ';
  bodyPivot.add(bodyNorm);
  holder.add(bodyPivot);

  const wheelRoot = new THREE.Group();
  wheelRoot.name = 'wheelRoot';
  wheelRoot.rotation.y = cfg.faceYaw;
  wheelRoot.scale.setScalar(scale);
  wheelRoot.position.copy(offset);
  wheelRoot.add(wheelGroup);
  holder.add(wheelRoot);

  /* 6 — dönüş yönü ve ön/arka ayrımı -------------------------------------- */
  // Model uzayındaki yanal eksenin faceYaw'dan sonraki dünya-X bileşeni.
  const spinSign = Math.sign(
    lateralAxis === 'x' ? Math.cos(cfg.faceYaw) : Math.sin(cfg.faceYaw)
  ) || 1;
  // Model uzayında +Z'ye dönüşecek yön boyunca burun tarafı.
  const frontSign = lengthAxis === 'x' ? -Math.sin(cfg.faceYaw) : Math.cos(cfg.faceYaw);
  const centreLon = centre[lengthAxis];
  for (const w of wheels) {
    w.userData.isFront = (w.userData.lon - centreLon) * frontSign > 0;
    // Direksiyonu SADECE bu bayrak taşır: `driveWheels` ön/arka ayrımını
    // değil, "kırılacak mı" sorusunu okur (arkadan direksiyonlu bir araç
    // eklenirse tek satır değişir).
    w.userData.isSteered = w.userData.isFront;
    /* Ad: dünya-X'in işareti yanal eksenin faceYaw sonrası yönüne bağlı;
       aynı hesap `spinSign`de yapıldı. +X = sol (ileri +Z, yukarı +Y). */
    const side = w.userData.lat == null ? '' : ((w.userData.lat * spinSign) > 0 ? 'L' : 'R');
    w.userData.side = side;
    w.userData.corner = `${w.userData.isFront ? 'F' : 'R'}${side}`;
    w.name = `wheelPivot_${w.userData.corner}`;
  }

  /* 7 — ortak PBR cilası: sRGB dokular, tam anizotropi, ölçülü metal/pürüz -- */
  tunePrefabMaterials(holder, cfg);

  holder.userData = {
    width,
    height,
    length: bbSize.z * scale,
    rollCentre,
    liftTable,
    spinSign,
    paintRe: cfg.paint,
    /* Sürüş yarıçapı ÖN tekerden okunur (varsa): kamera onları görür ve
       çoğu modelde arka teker birkaç santim farklıdır — dördün ortalaması
       hiçbirine uymayan bir hızda döndürürdü. */
    wheelRadius: wheels.length
      ? (wheels.find((w) => w.userData.isFront) || wheels[0]).userData.radius * scale
      : 0.33,
  };

  if (DEBUG) {
    console.log(
      `[prefab] ${cfg.url}: ${groups.size} malzeme, ${Math.round(tris / 1000)}k üçgen, ` +
      `${dropped} iç mesh atıldı, ${wheels.length} tekerlek ` +
      `(ön: ${wheels.filter((w) => w.userData.isFront).length}), ` +
      `uzun eksen ${lengthAxis}, dönüş yönü ${spinSign}, ` +
      `teker yolu: ${cfg.wheelNodes ? 'ada göre (pivot düzeltmeli)' : 'geometrik'}`
    );
    console.table(wheels.map((w) => ({
      pivot: w.name,
      x: +w.position.x.toFixed(3),
      y: +w.position.y.toFixed(3),
      z: +w.position.z.toFixed(3),
      r: +w.userData.radius.toFixed(3),
      'dönen': w.userData.isSteered ? 'ön (kırılır)' : 'arka',
    })));
  }

  // Orijinal meshlere artık referans yok (gövde birleştirildi, tekerlekler
  // kopyalandı); tamponlarını serbest bırak.
  src.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });

  return holder;
}

/* --- örnekler ---------------------------------------------------------- */

const shadowTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grd.addColorStop(0, 'rgba(0,0,0,0.75)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

/* Gölge lekesi PAYLAŞILIR. Eskiden her araç örneği için yeni bir
   PlaneGeometry + yeni bir MeshBasicMaterial üretiliyordu; trafik aracı
   yarışın ortasında doğduğunda bu, o karede yeni bir GPU tamponu ve yeni
   bir malzeme kaydı demekti — takılmanın küçük ama ölçülebilir bir parçası.
   Aynı ölçüdeki bütün araçlar artık tek geometriyi ve tek malzemeyi
   paylaşır (leke zaten araç başına farklı görünmüyordu). */
const shadowGeometries = new Map();
const shadowMaterial = new THREE.MeshBasicMaterial({
  name: 'contactShadow',
  map: shadowTexture, transparent: true, depthWrite: false, opacity: 0.85,
});

function addShadow(group, w, l) {
  const key = `${w.toFixed(2)}|${l.toFixed(2)}`;
  let geo = shadowGeometries.get(key);
  if (!geo) {
    geo = new THREE.PlaneGeometry(w * 2.1, l * 1.5);
    shadowGeometries.set(key, geo);
  }
  const m = new THREE.Mesh(geo, shadowMaterial);
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.02;
  // Leke gölgenin KENDİSİdir; gölge haritasına girmesi anlamsız olurdu.
  m.castShadow = false;
  m.receiveShadow = false;
  group.add(m);
  return m;
}

/**
 * Stop lambaları — düz, opak kırmızı yüzeyler. Bilerek additive DEĞİL:
 * eski hâli katmanlandıkça arkadan gelen araçta göz alan bir korona
 * yaratıyordu. Burada lamba sadece "yanıyor" gibi okunan bir doku.
 */
const tailLampMaterial = new THREE.MeshBasicMaterial({ name: 'tailLamp', color: 0xc21f1f });
const tailLampGeometry = new THREE.PlaneGeometry(0.55, 0.16);

function addTailLamps(group, l) {
  for (const side of [-1, 1]) {
    // Geometri ve malzeme bütün araçlarda ortak: lambalar zaten aynı.
    const q = new THREE.Mesh(tailLampGeometry, tailLampMaterial);
    q.position.set(side * 0.62, 0.82, -l / 2 - 0.02);
    q.rotation.y = Math.PI;          // yüzey geriye baksın (tek taraflı)
    q.castShadow = false;
    q.receiveShadow = false;
    group.add(q);
  }
}

/**
 * LOD_SWAP metreden sonra kullanılan ~80 üçgenlik vekil. O mesafede araç
 * birkaç düzine piksel yüksekliğindedir, yani siluet ve renkten başkası
 * hayatta kalmaz — ama arka plandaki araç başına ~200 bin üçgen kazandırır.
 */
const lowPolyCache = new Map();

function makeLowPoly(color, w, h, l) {
  const cacheKey = `${color}|${w.toFixed(2)}|${l.toFixed(2)}`;
  if (lowPolyCache.has(cacheKey)) return lowPolyCache.get(cacheKey).clone(true);

  const body = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0a0d14, roughness: 0.6 });
  const lamp = new THREE.MeshBasicMaterial({ color: 0xff2a2a });

  const g = new THREE.Group();
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  // Kaporta kutusu işaretlenir: havuzdaki araç yeniden boyanınca UZAK
  // vekilin de rengi değişsin. LOD_SWAP 70 m, görüş ufku 340 m — yani
  // trafiğin çoğu zaten bu vekille çiziliyor; rengi kaçırmak göze batardı.
  add(new THREE.BoxGeometry(w * 0.94, h * 0.46, l * 0.98), body, 0, h * 0.30, 0)
    .userData.isLowPolyBody = true;
  add(new THREE.BoxGeometry(w * 0.80, h * 0.40, l * 0.44), dark, 0, h * 0.70, -l * 0.06);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    add(new THREE.BoxGeometry(w * 0.10, h * 0.30, h * 0.30), dark,
      sx * w * 0.46, h * 0.15, sz * l * 0.32);
  }
  for (const sx of [-1, 1]) {
    add(new THREE.PlaneGeometry(w * 0.26, h * 0.08), lamp, sx * w * 0.3, h * 0.40, -l * 0.5 - 0.01);
  }

  lowPolyCache.set(cacheKey, g);
  return g.clone(true);
}

/* --- paylaşılan trafik boyası ------------------------------------------
 *
 * Trafik aracının kaportası tek bir düz renkle boyanır. Eski yol her örnek
 * için `material.clone()` çağırıyordu: 20 araçlık bir trafikte 20 ayrı
 * malzeme nesnesi, 20 ayrı `WebGLProgram` arama/kurulum yolu ve — daha
 * kötüsü — araç YARIŞIN ORTASINDA doğduğunda o karede yapılan bir malzeme
 * kurulumu demekti.
 *
 * Artık (temel malzeme × renk) başına TEK malzeme üretilir ve bütün örnekler
 * onu paylaşır. Renk bir uniform olduğu için shader programı zaten aynıydı;
 * paylaşım, ilk çizimdeki kurulum maliyetini de tamamen ortadan kaldırır ve
 * yarış başlamadan derlenebilmelerini sağlar (bkz. `scene.js` → `prewarm`).
 */
const paintVariants = new Map();          // temel malzeme uuid -> Map(renk -> malzeme)

function sharedPaint(base, color) {
  let byColor = paintVariants.get(base.uuid);
  if (!byColor) { byColor = new Map(); paintVariants.set(base.uuid, byColor); }
  let mat = byColor.get(color);
  if (!mat) {
    mat = base.clone();
    mat.name = `${base.name || 'paint'}#${(color >>> 0).toString(16)}`;
    mat.color = new THREE.Color(color);
    mat.metalness = Math.max(base.metalness ?? 0, 0.55);
    mat.roughness = Math.min(base.roughness ?? 1, 0.28);
    if ('clearcoat' in mat) mat.clearcoat = 1;
    byColor.set(color, mat);
  }
  return mat;
}

/**
 * Havuzdan alınan bir aracı yeniden boyar — YENİ malzeme üretmeden.
 *
 * Havuz model başına tutulur, renk varyantı ise sunucudan gelir; aynı mesh
 * bu yüzden ömrü boyunca birkaç renk arasında gidip gelir. Renk değişimi
 * `sharedPaint` önbelleğinden hazır malzemeyi takmaktan ibarettir, yani
 * tahsis de shader derlemesi de yoktur.
 *
 * @param {THREE.Object3D} car    instantiate() çıktısı
 * @param {number} color          0xRRGGBB
 */
export function setCarPaint(car, color) {
  const meshes = car && car.userData && car.userData.paintMeshes;
  if (!meshes || !meshes.length) return;
  for (const o of meshes) {
    const base = o.userData.basePaint;
    if (!base) continue;
    o.material = sharedPaint(base, color);
  }
}

/**
 * Bir prefabı klonlar ve ona bir görünüm giydirir.
 *
 * İki farklı giydirme yolu var:
 *   • `paint` (sayı)  — trafik/hayalet araçlar için tek renk, hızlı yol.
 *   • `look` (nesne)  — garajdan gelen tam takım (kaplama, cam filmi, jant).
 *     Bu durumda iş `vehicles.js`'teki `applyLook()`a devredilir; orada
 *     malzemeler örneğe özel klonlanır ve `__owned` ile işaretlenir.
 *
 * @param {THREE.Group} prefab
 * @param {object} opts
 * @param {number} [opts.paint]
 * @param {object} [opts.look]
 * @param {boolean} [opts.tailLamps] düz stop lambası yüzeyleri
 * @param {boolean} [opts.lod]
 * @param {boolean} [opts.shadows]    gölge haritası bayrakları (trafikte false)
 * @param {boolean} [opts.sharePaint] boya malzemesini örnekler arasında paylaş
 */
export function instantiate(prefab, {
  paint, look, tailLamps, lod = false, shadows = true, sharePaint = false,
} = {}) {
  const { width, height, length, paintRe, rollCentre, liftTable, spinSign, wheelRadius } = prefab.userData;

  const src = prefab.clone(true);
  const bodyPivot = src.getObjectByName('bodyPivot');
  const wheelRoot = src.getObjectByName('wheelRoot');

  // Boya sadece kaportaya uygulanır — jantlar ve diskler kendi rengini korur.
  const paintMeshes = [];
  if (paint != null && paintRe) {
    bodyPivot.traverse((o) => {
      if (!o.isMesh) return;
      if (!paintRe.test(o.userData.materialName || o.material.name || '')) return;
      paintMeshes.push(o);
      // Temel (boyanmamış) malzeme saklanır: her yeniden boyama ondan türer,
      // yoksa renkler üst üste binerek kayardı.
      o.userData.basePaint = o.material;
      if (sharePaint) {
        // Paylaşılan malzeme: `__owned` İŞARETLENMEZ, çünkü nesne bu
        // malzemenin sahibi değil — `retireCar()` onu bırakmamalı.
        o.material = sharedPaint(o.material, paint);
      } else {
        o.material = o.material.clone();
        o.material.color = new THREE.Color(paint);
        o.material.metalness = Math.max(o.material.metalness ?? 0, 0.55);
        o.material.roughness = Math.min(o.material.roughness ?? 1, 0.28);
        if ('clearcoat' in o.material) o.material.clearcoat = 1;
        o.userData.__owned = true;
      }
    });
  }

  const car = new THREE.Group();
  car.add(bodyPivot);

  if (lod) {
    // Kaporta uzakta kutuya düşer; tekerlekler de o mesafede tamamen kapanır.
    const bodyNorm = bodyPivot.children[0];
    bodyPivot.remove(bodyNorm);

    const levels = new THREE.LOD();
    levels.addLevel(bodyNorm, 0);
    /* Paylaşımlı boyada vekil NÖTR kurulur: `lowPolyCache` böylece renk
       başına değil, gövde ölçüsü başına tek takım tutar (3 model = 3 takım,
       12 yerine). Renk `setCarPaint` ile takılır. */
    const low = makeLowPoly(sharePaint ? 0x9aa3b2 : (paint ?? 0x9aa3b2), width, height, length);
    low.position.y = -rollCentre;   // vekil lastikleri y = 0'a göre çizilir
    if (sharePaint && paint != null) {
      low.traverse((o) => {
        if (!o.isMesh || !o.userData.isLowPolyBody) return;
        o.userData.basePaint = o.material;
        o.material = sharedPaint(o.material, paint);
        paintMeshes.push(o);
      });
    }
    levels.addLevel(low, LOD_SWAP);
    levels.addLevel(new THREE.Object3D(), LOD_CULL);
    bodyPivot.add(levels);

    const wheelLod = new THREE.LOD();
    wheelLod.addLevel(wheelRoot, 0);
    wheelLod.addLevel(new THREE.Object3D(), LOD_SWAP);
    car.add(wheelLod);
  } else {
    car.add(wheelRoot);
  }

  // Sürüş animasyonunun döndüreceği düğümler: yalnızca pivot GRUPLARI.
  const wheels = [];
  wheelRoot.traverse((o) => {
    if (!o.isMesh && o.userData && o.userData.isWheel) wheels.push(o);
  });
  // Ön (kırılır + yuvarlanır) / arka (sadece yuvarlanır) ayrımı BİR KEZ
  // burada çözülür; `driveWheels` her karede bayrak sınamaz.
  const frontWheels = wheels.filter((w) => w.userData.isSteered ?? w.userData.isFront);
  const rearWheels = wheels.filter((w) => !(w.userData.isSteered ?? w.userData.isFront));

  addShadow(car, width, length);
  if (tailLamps) addTailLamps(car, length);

  /* Trafik gölge HARİTASINA hiç girmez: `renderer.shadowMap` zaten kapalı,
     ama bayraklar açık kalırsa ileride açıldığı gün 20 araç bir anda gölge
     geçişine katılır. Temas lekesi (`addShadow`) görsel karşılığını zaten
     bedavaya veriyor. */
  if (!shadows) {
    car.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      o.receiveShadow = false;
    });
  }

  car.userData = {
    width, height, length, rollCentre, liftTable, spinSign, wheelRadius,
    bodyPivot, wheels, frontWheels, rearWheels, spin: 0,
    // Havuzdan alınan aracı yeniden boyamak için (bkz. `setCarPaint`).
    paintMeshes,
  };

  // Garaj görünümü: boya + kaplama + cam filmi + jant tek çağrıda.
  if (look) applyLook(car, look, paintRe);

  /* Far donanımı bilerek yok: koni demetleri, additive "lens" diskleri ve
     alt neon (underglow) sökülmüştür. Farlar artık yalnızca modelin kendi
     malzemesi — ekranı yakan hâle veya nabız gibi atan LED animasyonu yok. */

  if (DEBUG) {
    const hw = Math.min(width * 0.5 * 0.86, 1.0);
    const hl = length * 0.5 * 0.92;
    car.add(new THREE.Box3Helper(new THREE.Box3(
      new THREE.Vector3(-hw, 0, -hl), new THREE.Vector3(hw, height, hl)
    ), 0x00ff88));
  }
  return car;
}

/* ------------------------- tekerlek animasyonu ------------------------- */

/** `o`, `root`un altında mı? (kopan/eskimiş pivot listesini yakalar) */
function isUnder(root, o) {
  for (let p = o; p; p = p.parent) if (p === root) return true;
  return false;
}

/**
 * Bir araç örneğinin TEKERLEK PİVOT GRUPLARINI çözer ve `userData.wheels`e
 * yazar.
 *
 * Döndürülen her düğüm, `buildPrefab`in tekerlek başına kurduğu temiz
 * `THREE.Group` pivotudur — geometrisi `center()` ile kendi merkezine
 * oturtulmuş, dolayısıyla dönüşü aksın tam üstünden geçer. HAM MESH ASLA
 * dönmez: doğrudan mesh döndürmek, pivotu modeldeki (çoğu zaman aracın orta
 * hattındaki) düğüm başlangıcına geri götürüp yalpalamayı geri getirirdi.
 *
 * Liste tembel kurulur ve kendini tazeler: garajda araç değişince
 * (`rebuildCars`) `playerCar` yepyeni bir örnektir, eskisinin pivotları artık
 * sahnede değildir.
 *
 * @param {THREE.Object3D} car  instantiate() çıktısı
 * @returns {THREE.Object3D[]}  pivot grupları
 */
export function bindWheelPivots(car) {
  if (!car) return [];
  const u = car.userData || (car.userData = {});
  if (u.wheels && u.wheels.length && isUnder(car, u.wheels[0])) return u.wheels;

  const found = [];
  (car.getObjectByName('wheelRoot') || car).traverse((o) => {
    if (o.isMesh) return;                            // ham mesh aday değil
    if (o.userData && o.userData.isWheel) found.push(o);
  });
  u.wheels = found;
  // Ön/arka listeleri de tazelenir — yoksa garajda araç değişince eski
  // örneğin pivotlarına yazmaya devam ederdik (yeni araç dönmezdi).
  u.frontWheels = found.filter((w) => w.userData.isSteered ?? w.userData.isFront);
  u.rearWheels = found.filter((w) => !(w.userData.isSteered ?? w.userData.isFront));
  return found;
}

/* Dönüş HER ZAMAN quaternion olarak kurulur, Euler bileşeni yazılarak değil.
   `rotation.x = spin; rotation.y = steer` yazmak, düğümün `rotation.order`
   alanına güvenmek demektir — klonlama, bir tween ya da dışarıdan tek satır
   onu 'XYZ'ye çevirdiği anda direksiyon açısı yuvarlanmanın İÇİNE girer ve
   teker dönerken yalpalar. Eksen açı çiftlerini elle çarpınca sıra sözleşmenin
   parçası olur: önce dikey eksende kırılma, sonra aksta yuvarlanma. */
const _AXES = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};
const _qSteer = new THREE.Quaternion();
const _qRoll = new THREE.Quaternion();

/** Direksiyonun görsel tavanı — hangi modelde olursa olsun aşılamaz. */
const STEER_CEILING = THREE.MathUtils.degToRad(30);

/* Bir karede GÖSTERİLEBİLECEK en büyük dönüş adımı. 60 fps'de 395 km/h'ta
   gerçek açısal hız ~229 rad/s, yani kare başına 3.8 tam tur eder: ekranda
   teker ya durur ya geri döner (araba tekeri / strobe etkisi). Tavan, beş
   kollu bir jantın simetri açısının (72°) yarısının altında tutulur ki
   hangi kare hızında olursak olalım dönüş yönü doğru okunsun. */
const MAX_SPIN_STEP = THREE.MathUtils.degToRad(30);

/**
 * Tekerlek pivotlarını araç hızıyla ileri döndürür; ön pivotlar direksiyon
 * sinyaline göre Y ekseninde hafifçe kırılır.
 *
 * Dönüş HER ZAMAN pivot grubuna yazılır, altındaki mesh'e değil — mesh'in
 * köşe verisi zaten merkeze kaydırıldığı için grup dönünce teker kendi aksı
 * etrafında döner.
 *
 * @param {THREE.Group} car    instantiate() çıktısı
 * @param {number} speed       m/s cinsinden ileri hız
 * @param {number} steer       -1 (sol) .. +1 (sağ)
 * @param {number} dt          saniye
 */
export function driveWheels(car, speed, steer, dt) {
  const u = car && car.userData;
  if (!u || !(dt > 0)) return;
  const wheels = u.wheels && u.wheels.length ? u.wheels : bindWheelPivots(car);
  if (!wheels.length) return;

  /* --- yuvarlanma ------------------------------------------------------
     Fiziğin verdiği tek doğru cevap: kat edilen yay / yarıçap.
         rollDelta = (hız * dt) / yarıçap
     `wheelRadius` metre cinsinden GERÇEK yarıçaptır (aks -> temas noktası,
     prefab ölçeğiyle çarpılmış), yani burada hiçbir sihirli katsayı yok. */
  const radius = Math.max(u.wheelRadius || 0, 0.15);
  const rollDelta = (speed * dt) / radius;

  /* Ekranın gösterebileceğinden hızlı dönemeyiz: kare başına adım yarım
     jant simetrisini geçerse teker durur ya da geriye döner. Sert kesme
     yerine YUMUŞAK DİZ (soft knee):
       • dizin altında (tavanın %60'ı — ~32 km/h'a kadar) formül BİREBİR
         uygulanır, tek derece kayıp yok,
       • üstünde tanh ile doyar, tavanı asla aşmaz — strobe biter,
       • doyum bölgesinde bile MONOTON: hızlandıkça teker hâlâ hızlanıyor
         görünür. (Eski sert tavan 56 km/h üstünde her hızı birebir aynı
         gösteriyordu; "aşırı hızlı ama gaza tepkisiz" hissinin kaynağı
         buydu — göz, dönüşü araç hızından kopuk okuyunca yalpalama
         olarak algılıyor.)
     Tavan, saniyelik (config: WHEEL.maxOmega) ve karelik (MAX_SPIN_STEP)
     sınırların küçüğüdür; ikincisi düşük kare hızında da güvende tutar. */
  const cap = Math.min(WHEEL.maxOmega * dt, MAX_SPIN_STEP);
  const knee = cap * 0.6;
  const mag = Math.abs(rollDelta);
  const shaped = mag <= knee
    ? mag
    : knee + (cap - knee) * Math.tanh((mag - knee) / (cap - knee));
  const step = shaped * Math.sign(rollDelta || 1);

  u.spin = (u.spin + step * u.spinSign) % (Math.PI * 2);

  /* --- direksiyon -------------------------------------------------------
     Sinyal önce [-1,1]'e, sonra açı tavanına kırpılır. İki kademe de gerekli:
     ilki modelin kendi kilidini (`WHEEL.steerMax`) ölçekler, ikincisi hiçbir
     ayarın tekeri çamurluğun içine sokamayacağını garanti eder. */
  const steerAngle = THREE.MathUtils.clamp(
    THREE.MathUtils.clamp(steer, -1, 1) * WHEEL.steerMax,
    -STEER_CEILING, STEER_CEILING
  );

  const axis = _AXES[wheels[0].userData.spinAxis] || _AXES.x;
  _qRoll.setFromAxisAngle(axis, u.spin);
  _qSteer.setFromAxisAngle(_AXES.y, steerAngle);

  const front = u.frontWheels;
  const rear = u.rearWheels;
  if (front && rear && front.length + rear.length === wheels.length) {
    // Ön: dikey eksende kırıl, SONRA aksta yuvarlan.
    for (const w of front) w.quaternion.copy(_qSteer).multiply(_qRoll);
    // Arka: sadece yuvarlanma — tek bir yaw/roll bileşeni bile sızmaz.
    for (const w of rear) w.quaternion.copy(_qRoll);
    return;
  }

  // Listeler henüz kurulmamışsa (elle üretilmiş vekil araç) bayrakla çalış.
  for (const w of wheels) {
    const wu = w.userData;
    if (!wu || !wu.isWheel) continue;
    const a = _AXES[wu.spinAxis] || _AXES.x;
    _qRoll.setFromAxisAngle(a, u.spin);
    if (wu.isSteered ?? wu.isFront) w.quaternion.copy(_qSteer).multiply(_qRoll);
    else w.quaternion.copy(_qRoll);
  }
}

/** measureLift tablosundan ara değer okur (yatış simetrik olduğu için |roll|). */
export function liftAt(table, roll, pitch) {
  if (!table) return 0;
  const { roll: rs, pitch: ps, lift } = table;
  const pick = (arr, v) => {
    let i = 0;
    while (i < arr.length - 2 && v > arr[i + 1]) i++;
    const span = arr[i + 1] - arr[i] || 1;
    return [i, THREE.MathUtils.clamp((v - arr[i]) / span, 0, 1)];
  };
  const [ri, rk] = pick(rs, Math.abs(roll));
  const [pi, pk] = pick(ps, THREE.MathUtils.clamp(pitch, ps[0], ps[ps.length - 1]));
  const a = THREE.MathUtils.lerp(lift[ri][pi], lift[ri][pi + 1], pk);
  const b = THREE.MathUtils.lerp(lift[ri + 1][pi], lift[ri + 1][pi + 1], pk);
  return Math.max(0, THREE.MathUtils.lerp(a, b, rk));
}

/**
 * Kaportayı yatırır / daldırır ve gövdeyi asfaltın üstünde tutar.
 * Tekerlekler bodyPivot'un dışında olduğu için yola yapışık kalır.
 */
export function poseBody(car, roll, pitch) {
  const u = car.userData;
  const pivot = u.bodyPivot;
  if (!pivot) return;
  pivot.rotation.z = roll;
  pivot.rotation.x = pitch;
  // Yatarken alçakta kalan eşik asfaltı kesmesin diye tam gerektiği kadar kaldır.
  pivot.position.y = u.rollCentre + liftAt(u.liftTable, roll, pitch);
}
