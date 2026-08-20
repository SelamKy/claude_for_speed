/* =====================================================================
   Claude for Speed — araç gövdeleri ve görsel özelleştirme
   ---------------------------------------------------------------------
   İki iş yapar:

   1) `buildProceduralPrefab()` — koddan üretilen yedek gövde. Garajdaki
      araçların HEPSİ artık gerçek .glb modeli kullanıyor; bu yol yalnızca
      bir model indirilemediğinde devreye girer. Çıktı, game.js'teki
      `buildPrefab()` ile BİREBİR aynı arayüzü sunar: `bodyPivot` +
      `wheelRoot` hiyerarşisi ve aynı userData alanları. Böylece
      `instantiate()`, `poseBody()`, `driveWheels()` hiçbir dala ihtiyaç
      duymadan her iki araç türüyle de çalışır.

   2) `applyLook()` — boya / kaplama / cam filmi / jant tercihlerini bir
      araç örneğine uygular. GLB modellerinde malzemeler sanatçının
      isimlendirmesine göre değil, GEOMETRİK ve renk sezgileriyle
      sınıflanır (cam = saydam, jant = tekerlek içindeki açık renkli
      parça), çünkü üç modelin hiçbiri aynı adlandırma düzenini
      kullanmıyor.
   ===================================================================== */

import * as THREE from 'three';
import { FINISHES, TINTS, RIMS } from './garage.js';

/* ====================== 1) prosedürel araç gövdesi ==================== */

/**
 * Yandan görünüm profilleri. Koordinatlar (z, y) ve birimlidir:
 * z ∈ [-0.5, 0.5] (burun +Z), y ∈ [0, 1] (0 = zemin, 1 = tavan yüksekliği).
 * `lower` gövde siluetinin bel hizasına kadarki kısmı, `cabin` ise üstteki
 * cam kafesidir; ikisi ayrı çıkarıldığı için cam gerçekten cam gibi durur.
 */
const PROFILES = {
  hatch: {
    lower: [[0.50, 0.20], [0.50, 0.40], [0.42, 0.50], [0.16, 0.54],
            [-0.34, 0.56], [-0.48, 0.50], [-0.50, 0.36], [-0.50, 0.20]],
    cabin: [[0.16, 0.54], [0.02, 0.92], [-0.24, 0.95], [-0.36, 0.56]],
    roof: { from: -0.24, to: 0.02, y: 0.945 },
    wheel: { front: 0.31, rear: -0.30, radius: 0.325 },
  },
};

/** (z, y) nokta listesinden X boyunca ekstrüde edilmiş bir gövde parçası. */
function extrudeProfile(points, length, height, depth, bevel) {
  const shape = new THREE.Shape();
  points.forEach(([z, y], i) => {
    const px = z * length, py = y * height;
    if (i === 0) shape.moveTo(px, py); else shape.lineTo(px, py);
  });
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    steps: 1,
    curveSegments: 2,
  });
  // Ekstrüzyon +Z'de büyür; aracı X ekseni boyunca genişletmek için çevir.
  geo.rotateY(Math.PI / 2);
  geo.translate(depth / 2, 0, 0);
  geo.computeVertexNormals();
  return geo;
}

/** Tek bir tekerlek: lastik silindiri + jant diski + parmaklar. */
function makeWheel(radius, width, rim, materials) {
  const pivot = new THREE.Group();
  pivot.rotation.order = 'YXZ';

  const tyre = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, width, 16, 1, false),
    materials.tyre,
  );
  tyre.rotation.z = Math.PI / 2;             // silindir ekseni Y -> X
  pivot.add(tyre);

  const rimR = radius * 0.62;
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(rimR, rimR, width * 1.02, 14, 1, false),
    materials.rim,
  );
  disc.rotation.z = Math.PI / 2;
  pivot.add(disc);

  // Parmaklar: jant stilinin göze çarpan tek özelliği.
  const spokes = Math.max(3, rim.spokes | 0);
  const spokeGeo = new THREE.BoxGeometry(width * 1.06, rimR * 1.55, radius * 0.13);
  for (let i = 0; i < spokes; i++) {
    const s = new THREE.Mesh(spokeGeo, materials.rim);
    s.rotation.x = (i / spokes) * Math.PI;   // 180° yeterli: kutu simetrik
    pivot.add(s);
  }

  pivot.userData = { isWheel: true, spinAxis: 'x', radius, bottom: 0 };
  return pivot;
}

/**
 * Bir prosedürel araç prefabı üretir.
 *
 * @param {object} spec       VEHICLES[].proc — { shape, length, width, height, spoiler }
 * @param {object} deps       { measureLift } — game.js'ten enjekte edilir
 * @returns {THREE.Group}     buildPrefab() ile aynı arayüzde `holder`
 */
export function buildProceduralPrefab(spec, deps = {}) {
  const profile = PROFILES[spec.shape] || PROFILES.hatch;
  const L = spec.length, W = spec.width, H = spec.height;
  const rim = RIMS[0];

  /* --- paylaşılan malzemeler ------------------------------------------
     Adlar `applyLook()` ve game.js'teki boya kuralı için anlamlıdır. */
  const mats = {
    paint: new THREE.MeshStandardMaterial({ color: 0xc8ccd4, metalness: 0.85, roughness: 0.18 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x14181f, metalness: 0.35, roughness: 0.55 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x33465c, metalness: 0.1, roughness: 0.08,
      transparent: true, opacity: 0.52, transmission: 0.0, side: THREE.DoubleSide,
    }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x0b0d11, metalness: 0.0, roughness: 0.92 }),
    rim: new THREE.MeshStandardMaterial({ color: rim.color, metalness: rim.metalness, roughness: rim.roughness }),
    head: new THREE.MeshBasicMaterial({ color: 0xfff4d6 }),
    tail: new THREE.MeshBasicMaterial({ color: 0xff2a2a }),
  };
  mats.paint.name = 'paint';
  mats.trim.name = 'trim';
  mats.glass.name = 'glass';
  mats.tyre.name = 'tyre';
  mats.rim.name = 'rim';
  mats.head.name = 'headlight';
  mats.tail.name = 'taillight';

  /* --- gövde ----------------------------------------------------------- */
  const body = new THREE.Group();

  const shell = new THREE.Mesh(
    extrudeProfile(profile.lower, L, H, W * 0.98, Math.min(0.06, W * 0.04)),
    mats.paint,
  );
  shell.position.x = -W * 0.49;
  shell.userData.materialName = 'paint';
  body.add(shell);

  const cabin = new THREE.Mesh(
    extrudeProfile(profile.cabin, L, H, W * 0.86, 0.02),
    mats.glass,
  );
  cabin.position.x = -W * 0.43;
  cabin.userData.materialName = 'glass';
  body.add(cabin);

  // Tavan paneli: camın üstünü kapatır, boyayı sürdürür.
  const roofLen = (profile.roof.to - profile.roof.from) * L;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(W * 0.80, H * 0.035, roofLen), mats.paint);
  roof.position.set(0, profile.roof.y * H, (profile.roof.from + profile.roof.to) / 2 * L);
  roof.userData.materialName = 'paint';
  body.add(roof);

  // Marşpiyel / alt etek — aracı yola oturtan koyu bant.
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(W * 1.0, H * 0.13, L * 0.86), mats.trim);
  skirt.position.set(0, H * 0.19, 0);
  skirt.userData.materialName = 'trim';
  body.add(skirt);

  // Tamponlar.
  for (const [z, len] of [[L * 0.485, L * 0.05], [-L * 0.485, L * 0.05]]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(W * 0.96, H * 0.16, len), mats.trim);
    b.position.set(0, H * 0.30, z);
    b.userData.materialName = 'trim';
    body.add(b);
  }

  // Farlar ve stoplar.
  for (const sx of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(W * 0.22, H * 0.07, 0.06), mats.head);
    hl.position.set(sx * W * 0.32, H * 0.42, L * 0.49);
    hl.userData.materialName = 'headlight';
    body.add(hl);

    const tl = new THREE.Mesh(new THREE.BoxGeometry(W * 0.26, H * 0.06, 0.05), mats.tail);
    tl.position.set(sx * W * 0.31, H * 0.45, -L * 0.49);
    tl.userData.materialName = 'taillight';
    body.add(tl);
  }

  // Aynalar — siluete karakter katan ucuz detay.
  for (const sx of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(W * 0.10, H * 0.05, 0.10), mats.trim);
    m.position.set(sx * W * 0.55, H * 0.55, L * 0.10);
    m.userData.materialName = 'trim';
    body.add(m);
  }

  if (spec.spoiler) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(W * 0.86, H * 0.03, L * 0.09), mats.paint);
    blade.position.set(0, H * 0.62, -L * 0.455);
    blade.userData.materialName = 'paint';
    body.add(blade);
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(W * 0.05, H * 0.10, L * 0.04), mats.trim);
      leg.position.set(sx * W * 0.34, H * 0.56, -L * 0.45);
      leg.userData.materialName = 'trim';
      body.add(leg);
    }
  }

  /* --- tekerlekler ------------------------------------------------------ */
  const wheelGroup = new THREE.Group();
  const r = profile.wheel.radius;
  const tw = W * 0.14;
  for (const sx of [-1, 1]) {
    for (const [zk, front] of [[profile.wheel.front, true], [profile.wheel.rear, false]]) {
      const w = makeWheel(r, tw, rim, mats);
      w.position.set(sx * (W * 0.5 - tw * 0.55), r, zk * L);
      w.userData.isFront = front;
      wheelGroup.add(w);
    }
  }

  /* --- game.js'in beklediği hiyerarşi ----------------------------------- */
  const rollCentre = H * 0.38;

  const bodyNorm = new THREE.Group();
  bodyNorm.position.y = -rollCentre;
  bodyNorm.add(body);

  const liftTable = deps.measureLift
    ? deps.measureLift(bodyNorm, rollCentre)
    : null;

  const holder = new THREE.Group();

  const bodyPivot = new THREE.Group();
  bodyPivot.name = 'bodyPivot';
  bodyPivot.position.y = rollCentre;
  bodyPivot.rotation.order = 'YXZ';
  bodyPivot.add(bodyNorm);
  holder.add(bodyPivot);

  const wheelRoot = new THREE.Group();
  wheelRoot.name = 'wheelRoot';
  wheelRoot.add(wheelGroup);
  holder.add(wheelRoot);

  holder.userData = {
    width: W,
    height: H * 0.95,
    length: L,
    rollCentre,
    liftTable,
    spinSign: 1,               // +X ekseni etrafında pozitif dönüş = ileri yuvarlanma
    paintRe: /^paint$/,
    wheelRadius: r,
    procedural: true,
  };

  return holder;
}

/* ======================= 2) görsel özelleştirme ======================= */

const _c = new THREE.Color();

/** Bir malzemenin adı — GLB'lerde userData'ya kopyalanmış olabilir. */
function matName(mesh, mat) {
  return (mesh.userData && mesh.userData.materialName) || (mat && mat.name) || '';
}

function isGlass(mesh, mat) {
  if (!mat) return false;
  const n = matName(mesh, mat);
  if (/glass|window|windshield|windscreen|screen|vitre|\bcam\b/i.test(n)) return true;
  // İsim işe yaramazsa fiziğe bak: saydam ve neredeyse pürüzsüz.
  return !!mat.transparent && (mat.opacity ?? 1) < 0.98;
}

function isLamp(mesh, mat) {
  return /head ?light|tail ?light|lamp|far|stop/i.test(matName(mesh, mat));
}

/**
 * Bir jant parçası mı?
 *
 * Tekerlek pivotunun içindeyiz, yani soru sadece "lastik mi jant mı". Lastik
 * tanımı gereği neredeyse siyahtır; jant — krom, füme, bronz — her zaman daha
 * açıktır. Ada bakmak güvenilmez (BMW'de her malzeme "..._WHEEL..." adını
 * taşır), o yüzden parlaklık eşiği kullanıyoruz.
 */
function isRim(mesh, mat) {
  if (!mat) return false;
  const n = matName(mesh, mat);
  if (/tyre|tire|rubber|lastik/i.test(n)) return false;
  if (/rim|alloy|jant|spoke|caliper|disc|brake/i.test(n)) return true;
  if (!mat.color) return false;
  const l = mat.color.r * 0.299 + mat.color.g * 0.587 + mat.color.b * 0.114;
  return l > 0.13;
}

/** Malzemeyi bir kez klonlar; aynı örnek üzerinde tekrar tekrar çağrılabilir. */
function ownMaterial(mesh) {
  if (mesh.userData.__owned) return mesh.material;
  const name = matName(mesh, mesh.material);
  mesh.material = mesh.material.clone();
  mesh.material.name = name;
  mesh.userData.materialName = name;
  mesh.userData.__owned = true;
  return mesh.material;
}

/**
 * Garajdaki görünüm tercihlerini bir araç örneğine uygular.
 * `instantiate()` çıktısı üzerinde herhangi bir zamanda çağrılabilir —
 * malzemeler örneğe özel klonlandığı için diğer araçlar etkilenmez.
 *
 * @param {THREE.Object3D} car   instantiate() çıktısı
 * @param {object} look          { finish, paint, tint, rim }
 * @param {RegExp|null} paintRe  gövde boyası malzeme kuralı
 */
export function applyLook(car, look, paintRe) {
  if (!car || !look) return;
  const finish = FINISHES[look.finish] || FINISHES.gloss;
  const tint = TINTS[look.tint] || TINTS[0];
  const rim = RIMS.find((r) => r.id === look.rim) || RIMS[0];

  const bodyPivot = car.userData.bodyPivot || car.getObjectByName('bodyPivot');
  const wheels = car.userData.wheels || [];

  if (bodyPivot) {
    bodyPivot.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
      const name = matName(o, o.material);

      if (isLamp(o, o.material)) return;             // farlar boyanmaz

      if (isGlass(o, o.material)) {
        const m = ownMaterial(o);
        m.color = _c.setHex(tint.color).clone();
        m.transparent = true;
        m.opacity = 1 - (1 - tint.opacity) * 0.85;   // "opacity" = kararma miktarı
        m.roughness = 0.06;
        m.metalness = 0.15;
        if ('transmission' in m) m.transmission = 0;
        m.needsUpdate = true;
        return;
      }

      if (paintRe && !paintRe.test(name)) return;    // sadece kaporta
      const m = ownMaterial(o);
      m.color = _c.setHex(look.paint).clone();
      m.metalness = finish.metalness;
      m.roughness = finish.roughness;
      if ('clearcoat' in m) m.clearcoat = finish.clearcoat;
      if (m.emissive) {
        m.emissive = _c.setHex(look.paint).clone();
        m.emissiveIntensity = finish.emissive;
      }
      m.needsUpdate = true;
    });
  }

  for (const w of wheels) {
    w.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
      if (!isRim(o, o.material)) return;
      const m = ownMaterial(o);
      m.color = _c.setHex(rim.color).clone();
      m.metalness = rim.metalness;
      m.roughness = rim.roughness;
      if (m.emissive && rim.id === 'neon') {
        m.emissive = _c.setHex(rim.color).clone();
        m.emissiveIntensity = 0.5;
      } else if (m.emissive) {
        m.emissiveIntensity = 0;
      }
      m.needsUpdate = true;
    });
  }
}

/* Far demetleri KALDIRILDI.
   `makeHeadlights()` additive bir koni (sahte ışık düzlemi) ve pürüzsüz
   beyaz bir `CircleGeometry` diski (opacity 0.95) kuruyordu. İkisi de
   aracın altında/önünde göz alan beyaz bir leke bırakıyordu; artık
   aydınlatma yalnızca sahnedeki hemisphere + directional ışıklardan ve
   modelin kendi malzemesinden geliyor. */
