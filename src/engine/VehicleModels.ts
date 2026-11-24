import * as THREE from 'three';

export interface VehicleRig {
  root: THREE.Group;
  chassis: THREE.Group;
  frontSteerPivots: THREE.Object3D[];
  spinWheels: THREE.Object3D[];
  wheelRadius: number;
  brakeLightMat: THREE.MeshStandardMaterial;
  reverseLightMat: THREE.MeshStandardMaterial;
  headlightGlowMat: THREE.MeshBasicMaterial;
  shadowMesh: THREE.Mesh;
  dispose: () => void;
}

function createContactShadowTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(
      size * 0.5,
      size * 0.5,
      size * 0.08,
      size * 0.5,
      size * 0.5,
      size * 0.48,
    );
    grad.addColorStop(0, 'rgba(4, 7, 12, 0.82)');
    grad.addColorStop(0.55, 'rgba(4, 7, 12, 0.45)');
    grad.addColorStop(0.82, 'rgba(4, 7, 12, 0.14)');
    grad.addColorStop(1, 'rgba(4, 7, 12, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createHeadlightPoolTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(
      size * 0.5,
      size * 0.85,
      size * 0.04,
      size * 0.5,
      size * 0.48,
      size * 0.5,
    );
    grad.addColorStop(0, 'rgba(255, 244, 214, 0.34)');
    grad.addColorStop(0.45, 'rgba(255, 236, 185, 0.12)');
    grad.addColorStop(1, 'rgba(255, 236, 185, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function disposeObjectTree(root: THREE.Object3D, extraTextures: THREE.Texture[] = []): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
      if (obj.geometry) geometries.add(obj.geometry);
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m) materials.add(m);
      }
    }
  });

  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
  for (const t of extraTextures) t.dispose();
}

function buildCarWheel(
  radius: number,
  width: number,
  rubberMat: THREE.Material,
  rimMat: THREE.Material,
  caliperMat: THREE.Material,
  isSoftwareGl: boolean,
): THREE.Group {
  const wheel = new THREE.Group();
  const radialSegs = isSoftwareGl ? 18 : 28;

  // Main tire tread
  const treadGeo = new THREE.CylinderGeometry(radius, radius, width, radialSegs);
  treadGeo.rotateZ(Math.PI / 2);
  const tread = new THREE.Mesh(treadGeo, rubberMat);
  wheel.add(tread);

  // Outer beveled tire sidewall ring
  const sidewallGeo = new THREE.TorusGeometry(radius * 0.82, radius * 0.19, 10, radialSegs);
  sidewallGeo.rotateY(Math.PI / 2);
  const outerSidewall = new THREE.Mesh(sidewallGeo, rubberMat);
  outerSidewall.position.x = width * 0.34;
  wheel.add(outerSidewall);

  // Metallic alloy rim dish
  const rimGeo = new THREE.CylinderGeometry(radius * 0.66, radius * 0.66, width * 0.88, radialSegs);
  rimGeo.rotateZ(Math.PI / 2);
  const rim = new THREE.Mesh(rimGeo, rimMat);
  wheel.add(rim);

  // 5 sporty spokes so wheel rotation is visibly readable while driving
  const spokeGeo = new THREE.BoxGeometry(width * 0.94, radius * 0.14, radius * 1.18);
  for (let i = 0; i < 5; i += 1) {
    const spoke = new THREE.Mesh(spokeGeo, rimMat);
    spoke.rotation.x = (i * Math.PI) / 5;
    wheel.add(spoke);
  }

  // Center hub cap + subtle performance caliper accent
  const hubGeo = new THREE.CylinderGeometry(radius * 0.18, radius * 0.18, width * 0.98, 12);
  hubGeo.rotateZ(Math.PI / 2);
  const hub = new THREE.Mesh(hubGeo, caliperMat);
  wheel.add(hub);

  return wheel;
}

/**
 * Procedural 3D GT Sports Coupe (rear-chase perspective, facing -Z, grounded at y = 0).
 * Sculpted with beveled extruded silhouette, flared fenders, glass cabin, rear spoiler,
 * quad chrome exhausts, glowing LED lightbar + dynamic brake/reverse lights, and 4 articulated wheels.
 */
export function buildSportsCarModel(isSoftwareGl: boolean): VehicleRig {
  const root = new THREE.Group();
  const chassis = new THREE.Group();
  root.add(chassis);

  const extraTextures: THREE.Texture[] = [];

  // PBR Materials (deep metallic ruby-crimson paint & crisp contrast under outdoor sky IBL)
  const paintMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#9e111a'),
    metalness: 0.68,
    roughness: 0.28,
    clearcoat: 0.55,
    clearcoatRoughness: 0.14,
    envMapIntensity: 0.42,
  });

  const roofAccentMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#0c1018'),
    metalness: 0.5,
    roughness: 0.14,
    clearcoat: 1.0,
    clearcoatRoughness: 0.06,
  });

  const carbonMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#131720'),
    metalness: 0.32,
    roughness: 0.64,
  });

  const glassMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#070d18'),
    metalness: 0.22,
    roughness: 0.04,
    clearcoat: 1.0,
    clearcoatRoughness: 0.04,
  });

  const chromeMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#d8e2ee'),
    metalness: 0.96,
    roughness: 0.12,
  });

  const rimMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#cbd5e1'),
    metalness: 0.9,
    roughness: 0.2,
  });

  const rubberMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#14171c'),
    metalness: 0.04,
    roughness: 0.88,
  });

  const caliperMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#f59e0b'),
    metalness: 0.65,
    roughness: 0.28,
  });

  const brakeLightMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#990a10'),
    emissive: new THREE.Color('#e11d25'),
    emissiveIntensity: 1.25,
    roughness: 0.12,
    metalness: 0.12,
  });

  const reverseLightMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#94a3b8'),
    emissive: new THREE.Color('#ffffff'),
    emissiveIntensity: 0.04,
    roughness: 0.2,
    metalness: 0.1,
  });

  const headlightMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#fef3c7'),
    emissive: new THREE.Color('#fde68a'),
    emissiveIntensity: 1.8,
    roughness: 0.1,
  });

  // 1. Sculpted Main Body Silhouette (ExtrudeGeometry along X, spanning full length Z)
  const bodyShape = new THREE.Shape();
  // Coordinates in 2D shape: x = car Z (-2.05 front to +2.05 rear), y = height above ground
  bodyShape.moveTo(-2.05, 0.24);
  bodyShape.lineTo(-1.95, 0.56);
  bodyShape.quadraticCurveTo(-1.35, 0.72, -0.82, 0.76);
  bodyShape.lineTo(-0.22, 1.18);
  bodyShape.quadraticCurveTo(0.32, 1.24, 0.92, 1.08);
  bodyShape.lineTo(1.52, 0.86);
  bodyShape.lineTo(1.98, 0.82);
  bodyShape.lineTo(2.04, 0.44);
  bodyShape.lineTo(1.88, 0.22);
  bodyShape.lineTo(-1.88, 0.20);
  bodyShape.closePath();

  const bodyGeo = new THREE.ExtrudeGeometry(bodyShape, {
    depth: 1.56,
    bevelEnabled: true,
    bevelThickness: 0.12,
    bevelSize: 0.08,
    bevelSegments: isSoftwareGl ? 2 : 4,
    curveSegments: isSoftwareGl ? 10 : 18,
  });
  // Center extrusion along Z then rotate so shape X -> world Z and extrusion depth -> world X
  bodyGeo.translate(0, 0, -0.78);
  bodyGeo.rotateY(-Math.PI / 2);
  const mainBody = new THREE.Mesh(bodyGeo, paintMat);
  chassis.add(mainBody);

  // 2. Muscular Wide Rear Haunches & Front Fenders (left & right sculpted pods)
  const haunchGeo = new THREE.BoxGeometry(0.24, 0.44, 1.48);
  for (const side of [-1, 1]) {
    const rearHaunch = new THREE.Mesh(haunchGeo, paintMat);
    rearHaunch.position.set(side * 0.86, 0.54, 1.06);
    rearHaunch.rotation.z = side * -0.14;
    chassis.add(rearHaunch);

    const frontFender = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.36, 1.22), paintMat);
    frontFender.position.set(side * 0.84, 0.49, -1.16);
    frontFender.rotation.z = side * -0.12;
    chassis.add(frontFender);

    // Carbon side skirts
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.11, 2.25), carbonMat);
    skirt.position.set(side * 0.89, 0.22, -0.02);
    chassis.add(skirt);
  }

  // 3. Gloss Black Cabin Roof & Sloped Rear Windshield Greenhouse
  const cabinShape = new THREE.Shape();
  cabinShape.moveTo(-0.76, 0.74);
  cabinShape.lineTo(-0.18, 1.21);
  cabinShape.quadraticCurveTo(0.32, 1.25, 0.88, 1.10);
  cabinShape.lineTo(1.42, 0.86);
  cabinShape.lineTo(1.36, 0.75);
  cabinShape.lineTo(-0.72, 0.71);
  cabinShape.closePath();

  const cabinGeo = new THREE.ExtrudeGeometry(cabinShape, {
    depth: 1.26,
    bevelEnabled: true,
    bevelThickness: 0.08,
    bevelSize: 0.05,
    bevelSegments: 2,
    curveSegments: 12,
  });
  cabinGeo.translate(0, 0, -0.63);
  cabinGeo.rotateY(-Math.PI / 2);
  const cabinMesh = new THREE.Mesh(cabinGeo, glassMat);
  chassis.add(cabinMesh);

  // Dark metallic roof panel crown
  const roofCap = new THREE.Mesh(new THREE.BoxGeometry(1.14, 0.05, 0.96), roofAccentMat);
  roofCap.position.set(0, 1.24, 0.26);
  roofCap.rotation.x = 0.06;
  chassis.add(roofCap);

  // 4. Carbon-Fiber Rear Diffuser + Vertical Aero Fins
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.74, 0.26, 0.28), carbonMat);
  diffuser.position.set(0, 0.31, 1.98);
  chassis.add(diffuser);

  const finGeo = new THREE.BoxGeometry(0.03, 0.18, 0.22);
  for (const fx of [-0.36, -0.12, 0.12, 0.36]) {
    const fin = new THREE.Mesh(finGeo, carbonMat);
    fin.position.set(fx, 0.28, 2.08);
    chassis.add(fin);
  }

  // 5. Quad Polished Chrome Exhaust Tips
  const exhaustGeo = new THREE.CylinderGeometry(0.055, 0.06, 0.18, 14);
  exhaustGeo.rotateX(Math.PI / 2);
  for (const ex of [-0.66, -0.51, 0.51, 0.66]) {
    const tip = new THREE.Mesh(exhaustGeo, chromeMat);
    tip.position.set(ex, 0.28, 2.09);
    chassis.add(tip);
  }

  // 6. Sculpted Rear GT Wing Spoiler + Twin Stanchions
  const wingBlade = new THREE.Mesh(new THREE.BoxGeometry(1.76, 0.045, 0.26), carbonMat);
  wingBlade.position.set(0, 1.07, 1.92);
  wingBlade.rotation.x = 0.14;
  chassis.add(wingBlade);

  const endplateGeo = new THREE.BoxGeometry(0.035, 0.15, 0.30);
  const stanchionGeo = new THREE.BoxGeometry(0.04, 0.24, 0.14);
  for (const side of [-1, 1]) {
    const endplate = new THREE.Mesh(endplateGeo, paintMat);
    endplate.position.set(side * 0.89, 1.07, 1.92);
    chassis.add(endplate);

    const stanchion = new THREE.Mesh(stanchionGeo, carbonMat);
    stanchion.position.set(side * 0.44, 0.94, 1.88);
    stanchion.rotation.x = -0.18;
    chassis.add(stanchion);
  }

  // 7. Full-Width Glowing LED Taillight Bar + Brake Clusters + Reverse LEDs
  const rearFascia = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.16, 0.10), roofAccentMat);
  rearFascia.position.set(0, 0.72, 2.04);
  chassis.add(rearFascia);

  const lightbar = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.045, 0.06), brakeLightMat);
  lightbar.position.set(0, 0.73, 2.08);
  chassis.add(lightbar);

  for (const side of [-1, 1]) {
    const cluster = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.09, 0.07), brakeLightMat);
    cluster.position.set(side * 0.64, 0.71, 2.08);
    chassis.add(cluster);

    const revLight = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.035, 0.06), reverseLightMat);
    revLight.position.set(side * 0.34, 0.66, 2.08);
    chassis.add(revLight);
  }

  // Subtle recessed license plate
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.12, 0.03),
    new THREE.MeshStandardMaterial({ color: '#e2e8f0', roughness: 0.4, metalness: 0.2 }),
  );
  plate.position.set(0, 0.50, 2.07);
  chassis.add(plate);

  // 8. Twin Aerodynamic Side Mirrors
  for (const side of [-1, 1]) {
    const mirrorStem = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.045, 0.06), carbonMat);
    mirrorStem.position.set(side * 0.86, 0.82, -0.45);
    chassis.add(mirrorStem);

    const mirrorCap = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.09, 0.12), paintMat);
    mirrorCap.position.set(side * 0.96, 0.85, -0.43);
    chassis.add(mirrorCap);
  }

  // 9. Front LED Headlights & subtle forward asphalt glow
  for (const side of [-1, 1]) {
    const headlight = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.07, 0.10), headlightMat);
    headlight.position.set(side * 0.62, 0.54, -2.02);
    chassis.add(headlight);
  }

  const headlightPoolTex = createHeadlightPoolTexture();
  extraTextures.push(headlightPoolTex);
  const headlightGlowMat = new THREE.MeshBasicMaterial({
    map: headlightPoolTex,
    transparent: true,
    depthWrite: false,
    opacity: 0.42,
    blending: THREE.AdditiveBlending,
  });
  const headlightPool = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 4.6), headlightGlowMat);
  headlightPool.rotation.x = -Math.PI / 2;
  headlightPool.position.set(0, 0.015, -4.15);
  root.add(headlightPool);

  // 10. Four Articulated Wheels (Front 2 steer on Y, all 4 spin on X)
  const wheelRadius = 0.34;
  const wheelWidth = 0.28;
  const frontSteerPivots: THREE.Object3D[] = [];
  const spinWheels: THREE.Object3D[] = [];

  const wheelPositions: Array<{ x: number; z: number; isFront: boolean }> = [
    { x: -0.87, z: -1.26, isFront: true },
    { x: 0.87, z: -1.26, isFront: true },
    { x: -0.89, z: 1.24, isFront: false },
    { x: 0.89, z: 1.24, isFront: false },
  ];

  for (const pos of wheelPositions) {
    const pivot = new THREE.Group();
    pivot.position.set(pos.x, wheelRadius, pos.z);
    const wheelMesh = buildCarWheel(
      wheelRadius,
      wheelWidth,
      rubberMat,
      rimMat,
      caliperMat,
      isSoftwareGl,
    );
    if (pos.x < 0) {
      // Mirror left wheels so sidewall bevel faces outward
      wheelMesh.scale.x = -1;
    }
    pivot.add(wheelMesh);
    root.add(pivot);

    if (pos.isFront) {
      frontSteerPivots.push(pivot);
    }
    spinWheels.push(wheelMesh);
  }

  // 11. Grounded Soft Radial Contact Shadow directly beneath tires
  const shadowTex = createContactShadowTexture();
  extraTextures.push(shadowTex);
  const shadowMat = new THREE.MeshBasicMaterial({
    map: shadowTex,
    transparent: true,
    depthWrite: false,
    opacity: 0.68,
  });
  const shadowMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.65, 5.15), shadowMat);
  shadowMesh.rotation.x = -Math.PI / 2;
  shadowMesh.position.set(0, 0.01, 0);
  root.add(shadowMesh);

  return {
    root,
    chassis,
    frontSteerPivots,
    spinWheels,
    wheelRadius,
    brakeLightMat,
    reverseLightMat,
    headlightGlowMat,
    shadowMesh,
    dispose: () => disposeObjectTree(root, extraTextures),
  };
}

function buildBikeWheel(
  radius: number,
  tireTube: number,
  rubberMat: THREE.Material,
  rimMat: THREE.Material,
  rotorMat: THREE.Material,
  isSoftwareGl: boolean,
): THREE.Group {
  const wheel = new THREE.Group();
  const radialSegs = isSoftwareGl ? 18 : 28;

  const tireGeo = new THREE.TorusGeometry(radius - tireTube, tireTube, 12, radialSegs);
  tireGeo.rotateY(Math.PI / 2);
  wheel.add(new THREE.Mesh(tireGeo, rubberMat));

  const rimRingGeo = new THREE.TorusGeometry(radius - tireTube * 1.9, tireTube * 0.32, 8, radialSegs);
  rimRingGeo.rotateY(Math.PI / 2);
  wheel.add(new THREE.Mesh(rimRingGeo, rimMat));

  const spokeGeo = new THREE.BoxGeometry(tireTube * 0.7, 0.032, (radius - tireTube * 1.6) * 1.9);
  for (let i = 0; i < 5; i += 1) {
    const spoke = new THREE.Mesh(spokeGeo, rimMat);
    spoke.rotation.x = (i * Math.PI) / 5;
    wheel.add(spoke);
  }

  const rotorGeo = new THREE.CylinderGeometry(radius * 0.45, radius * 0.45, 0.025, 16);
  rotorGeo.rotateZ(Math.PI / 2);
  const rotor = new THREE.Mesh(rotorGeo, rotorMat);
  rotor.position.x = tireTube * 0.65;
  wheel.add(rotor);

  return wheel;
}

/**
 * Procedural 3D Supersport Street Motorcycle (rear-chase perspective, facing -Z, grounded at y = 0).
 * Features dynamic lean-into-turn physics, articulated steering forks & handlebars, sculpted fairing,
 * stepped seat, titanium exhaust, glowing LED taillight/brake light, and grounded shadow.
 */
export function buildSportBikeModel(isSoftwareGl: boolean): VehicleRig {
  const root = new THREE.Group();
  const chassis = new THREE.Group();
  root.add(chassis);

  const extraTextures: THREE.Texture[] = [];

  const paintMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#c23b08'),
    metalness: 0.66,
    roughness: 0.28,
    clearcoat: 0.55,
    clearcoatRoughness: 0.14,
    envMapIntensity: 0.42,
  });

  const frameMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#181d29'),
    metalness: 0.68,
    roughness: 0.34,
  });

  const seatMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#14171e'),
    metalness: 0.05,
    roughness: 0.84,
  });

  const chromeMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#d8e2ee'),
    metalness: 0.94,
    roughness: 0.14,
  });

  const rubberMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#12151a'),
    metalness: 0.04,
    roughness: 0.88,
  });

  const visorMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#070d18'),
    metalness: 0.2,
    roughness: 0.04,
    clearcoat: 1.0,
  });

  const brakeLightMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#990a10'),
    emissive: new THREE.Color('#e11d25'),
    emissiveIntensity: 1.3,
    roughness: 0.12,
  });

  const reverseLightMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#cbd5e1'),
    emissive: new THREE.Color('#ffffff'),
    emissiveIntensity: 0.05,
    roughness: 0.2,
  });

  // 1. Sculpted Fairing & Fuel Tank Spine
  const fairingShape = new THREE.Shape();
  fairingShape.moveTo(-0.92, 0.52);
  fairingShape.lineTo(-0.48, 0.96);
  fairingShape.quadraticCurveTo(0.0, 1.05, 0.32, 0.84);
  fairingShape.lineTo(0.98, 1.02);
  fairingShape.lineTo(1.16, 0.94);
  fairingShape.lineTo(0.75, 0.72);
  fairingShape.lineTo(0.28, 0.42);
  fairingShape.lineTo(-0.62, 0.34);
  fairingShape.closePath();

  const fairingGeo = new THREE.ExtrudeGeometry(fairingShape, {
    depth: 0.38,
    bevelEnabled: true,
    bevelThickness: 0.06,
    bevelSize: 0.05,
    bevelSegments: 2,
    curveSegments: 12,
  });
  fairingGeo.translate(0, 0, -0.19);
  fairingGeo.rotateY(-Math.PI / 2);
  chassis.add(new THREE.Mesh(fairingGeo, paintMat));

  // 2. Engine Block & Swingarm Frame
  const engineBlock = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.38, 0.62), frameMat);
  engineBlock.position.set(0, 0.50, -0.05);
  chassis.add(engineBlock);

  for (const side of [-1, 1]) {
    const swingarm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.76), frameMat);
    swingarm.position.set(side * 0.16, 0.36, 0.44);
    swingarm.rotation.x = 0.08;
    chassis.add(swingarm);
  }

  // 3. Stepped Rider Seat & Tail Cowl
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.10, 0.58), seatMat);
  seat.position.set(0, 0.84, 0.38);
  seat.rotation.x = -0.12;
  chassis.add(seat);

  const tailCowl = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.14, 0.46), paintMat);
  tailCowl.position.set(0, 0.96, 0.88);
  tailCowl.rotation.x = 0.18;
  chassis.add(tailCowl);

  // 4. Rear Glowing LED Taillight + Fender Eliminator Plate
  const taillight = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.065, 0.06), brakeLightMat);
  taillight.position.set(0, 0.99, 1.12);
  chassis.add(taillight);

  const plateHolder = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.025), seatMat);
  plateHolder.position.set(0, 0.82, 1.08);
  plateHolder.rotation.x = 0.35;
  chassis.add(plateHolder);

  // 5. Angled Titanium Muffler Exhaust (right side)
  const mufflerGeo = new THREE.CylinderGeometry(0.065, 0.055, 0.56, 14);
  mufflerGeo.rotateX(Math.PI / 2 - 0.32);
  const muffler = new THREE.Mesh(mufflerGeo, chromeMat);
  muffler.position.set(0.27, 0.54, 0.68);
  chassis.add(muffler);

  // 6. Articulated Front Steering Assembly (Forks, Handlebars, Windscreen, Mirrors, Front Wheel)
  const frontSteeringGroup = new THREE.Group();
  frontSteeringGroup.position.set(0, 0.78, -0.58);
  chassis.add(frontSteeringGroup);

  const forkGeo = new THREE.CylinderGeometry(0.028, 0.024, 0.82, 10);
  for (const side of [-1, 1]) {
    const fork = new THREE.Mesh(forkGeo, chromeMat);
    fork.position.set(side * 0.11, -0.14, -0.12);
    fork.rotation.x = 0.36;
    frontSteeringGroup.add(fork);

    // Clip-on handlebars + grips
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.34, 10), seatMat);
    bar.rotation.z = Math.PI / 2;
    bar.rotation.y = side * -0.22;
    bar.position.set(side * 0.24, 0.22, -0.02);
    frontSteeringGroup.add(bar);

    // Mirrors
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.06, 0.05), frameMat);
    mirror.position.set(side * 0.36, 0.34, -0.14);
    frontSteeringGroup.add(mirror);
  }

  // Front nose cowl & tinted windscreen visor
  const noseCowl = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.24, 0.34), paintMat);
  noseCowl.position.set(0, 0.16, -0.24);
  noseCowl.rotation.x = 0.25;
  frontSteeringGroup.add(noseCowl);

  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.26, 0.05), visorMat);
  visor.position.set(0, 0.34, -0.24);
  visor.rotation.x = -0.68;
  frontSteeringGroup.add(visor);

  // 7. Front & Rear Sport Tires
  const wheelRadius = 0.33;
  const frontWheel = buildBikeWheel(wheelRadius, 0.08, rubberMat, frameMat, chromeMat, isSoftwareGl);
  frontWheel.position.set(0, -0.78 + wheelRadius, -0.26);
  frontSteeringGroup.add(frontWheel);

  const rearWheel = buildBikeWheel(wheelRadius, 0.11, rubberMat, frameMat, chromeMat, isSoftwareGl);
  rearWheel.position.set(0, wheelRadius, 0.78);
  chassis.add(rearWheel);

  // Subtle forward headlight road pool
  const headlightPoolTex = createHeadlightPoolTexture();
  extraTextures.push(headlightPoolTex);
  const headlightGlowMat = new THREE.MeshBasicMaterial({
    map: headlightPoolTex,
    transparent: true,
    depthWrite: false,
    opacity: 0.36,
    blending: THREE.AdditiveBlending,
  });
  const headlightPool = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 4.2), headlightGlowMat);
  headlightPool.rotation.x = -Math.PI / 2;
  headlightPool.position.set(0, 0.015, -3.2);
  root.add(headlightPool);

  // 8. Grounded Elliptical Contact Shadow
  const shadowTex = createContactShadowTexture();
  extraTextures.push(shadowTex);
  const shadowMat = new THREE.MeshBasicMaterial({
    map: shadowTex,
    transparent: true,
    depthWrite: false,
    opacity: 0.62,
  });
  const shadowMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 3.0), shadowMat);
  shadowMesh.rotation.x = -Math.PI / 2;
  shadowMesh.position.set(0, 0.01, 0);
  root.add(shadowMesh);

  // Slightly scale bike up so it has strong visual presence in chase view
  root.scale.setScalar(1.16);

  return {
    root,
    chassis,
    frontSteerPivots: [frontSteeringGroup],
    spinWheels: [frontWheel, rearWheel],
    wheelRadius,
    brakeLightMat,
    reverseLightMat,
    headlightGlowMat,
    shadowMesh,
    dispose: () => disposeObjectTree(root, extraTextures),
  };
}
