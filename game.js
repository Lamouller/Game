// Birdlife — Bird simulation game
// ES modules, Three.js from importmap. No build step.
import * as THREE from 'three';

// =============================================================================
// Save / progression
// =============================================================================
const SAVE_KEY = 'birdlife.save.v1';

function defaultSave() {
  return {
    xp: 0,
    worldSeed: (Math.random() * 1e9) | 0,
    selectedFood: 0,
  };
}
function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return defaultSave();
    return { ...defaultSave(), ...JSON.parse(raw) };
  } catch (e) {
    return defaultSave();
  }
}
function persist() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) {}
}
let save = loadSave();

// =============================================================================
// Food tiers — unlock thresholds, energy, persistence
// =============================================================================
const FOODS = [
  { name: 'Graine',  color: 0xeccd8a, energy: 1,  life: 10,  unlock: 0   },
  { name: 'Baie',    color: 0xff5577, energy: 3,  life: 25,  unlock: 20  },
  { name: 'Ver',     color: 0xc48262, energy: 7,  life: 55,  unlock: 80  },
  { name: 'Nectar',  color: 0x7aff9f, energy: 15, life: 140, unlock: 220 },
  { name: 'Essence', color: 0xb68cff, energy: 40, life: 999, unlock: 500 },
];
function worldLevel() {
  // World complexity grows with xp
  return Math.min(1 + Math.floor(save.xp / 60), 6);
}
function foodUnlocked(i) { return save.xp >= FOODS[i].unlock; }

// =============================================================================
// Three.js setup
// =============================================================================
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd0ff);
scene.fog = new THREE.Fog(0x9fd0ff, 90, 280);

const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 600);
// Camera is a 3rd-person follow camera controlled by the player (see Player section)
camera.position.set(0, 20, 30);
camera.lookAt(0, 0, 0);

// Lights
const sun = new THREE.DirectionalLight(0xfff0d0, 1.0);
sun.position.set(80, 140, 40);
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xbfe0ff, 0x4a3a2a, 0.55));
scene.add(new THREE.AmbientLight(0xffffff, 0.18));

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);
onResize();

// =============================================================================
// Keyboard / pointer state (used by Player)
// =============================================================================
const keys = Object.create(null);
window.addEventListener('keydown', e => {
  keys[e.code] = true;
  // 1..5 select food tier
  if (e.code.startsWith('Digit')) {
    const i = parseInt(e.code.slice(5), 10) - 1;
    if (i >= 0 && i < FOODS.length && foodUnlocked(i)) {
      save.selectedFood = i;
      persist();
      buildFoodbar();
    }
  }
  if (e.code === 'Escape') document.exitPointerLock?.();
});
window.addEventListener('keyup', e => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

// =============================================================================
// Value noise (seeded, allocation-free)
// =============================================================================
function hash2(x, y, s) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + s * 362437;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function smooth(t) { return t * t * (3 - 2 * t); }
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const a = hash2(xi,     yi,     seed);
  const b = hash2(xi + 1, yi,     seed);
  const c = hash2(xi,     yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  const u = smooth(xf), v = smooth(yf);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x, y, seed, octaves = 4) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, seed + i * 17) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// =============================================================================
// World generation (procedural terrain + instanced trees / rocks)
// =============================================================================
// Chunk-based endless world. Terrain, trees, rocks and flowers are generated
// per chunk, deterministically from (chunkX, chunkZ, worldSeed), so the world
// is the same whenever you revisit a location. Only a small ring of chunks
// around the player is kept in memory at a time.
const CHUNK_SIZE = 64;   // world units per chunk side
const CHUNK_SEG  = 32;   // subdivisions per chunk side
const VIEW_RADIUS = 3;   // (2*VIEW_RADIUS+1)^2 chunks visible => 7x7 = 49

let worldGroup = new THREE.Group();
scene.add(worldGroup);
// Map key "cx,cz" -> { group, cx, cz }
const chunks = new Map();

// Shared materials — created once, re-used by every chunk
const terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
const foliageMat = new THREE.MeshLambertMaterial({ color: 0x2e5a2a });
const trunkMat   = new THREE.MeshLambertMaterial({ color: 0x5a3a22 });
const rockMat    = new THREE.MeshLambertMaterial({ color: 0x888888, flatShading: true });
const flowerMat  = new THREE.MeshLambertMaterial({ color: 0xff9ad0 });

// Shared instanced-mesh source geometries
const foliageGeoSrc = new THREE.ConeGeometry(1.6, 5, 6);
foliageGeoSrc.translate(0, 3.4, 0);
const trunkGeoSrc = new THREE.CylinderGeometry(0.3, 0.45, 1.4, 5);
trunkGeoSrc.translate(0, 0.7, 0);
const rockGeoSrc   = new THREE.DodecahedronGeometry(1, 0);
const flowerGeoSrc = new THREE.ConeGeometry(0.2, 0.8, 4);
flowerGeoSrc.translate(0, 0.4, 0);

function terrainHeight(x, z, seed, lvl) {
  const s1 = 1 / 42;
  let h = (fbm(x * s1, z * s1, seed, 4) - 0.5) * 30;
  if (lvl >= 2) h += Math.sin((x + z) * 0.04 + seed) * 2.5;
  if (lvl >= 3) h += (fbm(x * 0.08, z * 0.08, seed + 999, 2) - 0.5) * 14;
  if (lvl >= 5) h += (fbm(x * 0.015, z * 0.015, seed + 321, 2) - 0.5) * 22;
  return h;
}

// Seeded deterministic PRNG (mulberry32) so every chunk yields the same
// content across regenerations / sessions.
function mulberry32(a) {
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chunkKey(cx, cz) { return cx + ',' + cz; }

function buildChunk(cx, cz) {
  const seed = save.worldSeed;
  const lvl  = worldLevel();
  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;
  const rand = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ (seed * 2654435761));

  const group = new THREE.Group();

  // --- Terrain patch ---
  const geo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, CHUNK_SEG, CHUNK_SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const tmpColor = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i);
    const lz = pos.getZ(i);
    const wx = originX + lx;
    const wz = originZ + lz;
    const h = terrainHeight(wx, wz, seed, lvl);
    pos.setY(i, h);
    if (h < -2)      tmpColor.setRGB(0.82, 0.78, 0.55);
    else if (h < 2)  tmpColor.setRGB(0.72, 0.76, 0.40);
    else if (h < 13) tmpColor.setRGB(0.25 + (h / 40), 0.52, 0.22);
    else             tmpColor.setRGB(0.55, 0.55, 0.55);
    colors[i * 3]     = tmpColor.r;
    colors[i * 3 + 1] = tmpColor.g;
    colors[i * 3 + 2] = tmpColor.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const terrain = new THREE.Mesh(geo, terrainMat);
  terrain.position.set(originX, 0, originZ);
  group.add(terrain);

  // --- Trees ---
  const nTreesTarget = 6 + Math.floor(rand() * (4 + lvl * 2));
  const dummy = new THREE.Object3D();
  const foliage = new THREE.InstancedMesh(foliageGeoSrc, foliageMat, nTreesTarget);
  const trunks  = new THREE.InstancedMesh(trunkGeoSrc,   trunkMat,   nTreesTarget);
  let placed = 0;
  for (let i = 0; i < nTreesTarget * 4 && placed < nTreesTarget; i++) {
    const x = originX + rand() * CHUNK_SIZE;
    const z = originZ + rand() * CHUNK_SIZE;
    const h = terrainHeight(x, z, seed, lvl);
    if (h < 1 || h > 15) continue;
    const s = 0.8 + rand() * 1.6;
    dummy.position.set(x, h, z);
    dummy.scale.set(s, s, s);
    dummy.rotation.y = rand() * Math.PI * 2;
    dummy.updateMatrix();
    foliage.setMatrixAt(placed, dummy.matrix);
    trunks.setMatrixAt(placed,  dummy.matrix);
    placed++;
  }
  foliage.count = placed;
  trunks.count  = placed;
  group.add(trunks);
  group.add(foliage);

  // --- Rocks ---
  const nRocks = 3 + Math.floor(rand() * (3 + lvl));
  const rocks = new THREE.InstancedMesh(rockGeoSrc, rockMat, nRocks);
  for (let i = 0; i < nRocks; i++) {
    const x = originX + rand() * CHUNK_SIZE;
    const z = originZ + rand() * CHUNK_SIZE;
    const h = terrainHeight(x, z, seed, lvl);
    const s = 0.6 + rand() * 2.4;
    dummy.position.set(x, h + s * 0.35, z);
    dummy.scale.set(s, s * 0.75, s);
    dummy.rotation.set(rand() * 6.28, rand() * 6.28, rand() * 6.28);
    dummy.updateMatrix();
    rocks.setMatrixAt(i, dummy.matrix);
  }
  rocks.count = nRocks;
  group.add(rocks);

  // --- Flowers (higher world level) ---
  if (lvl >= 4) {
    const nFlowers = 12 + Math.floor(rand() * (lvl * 4));
    const flowers = new THREE.InstancedMesh(flowerGeoSrc, flowerMat, nFlowers);
    for (let i = 0; i < nFlowers; i++) {
      const x = originX + rand() * CHUNK_SIZE;
      const z = originZ + rand() * CHUNK_SIZE;
      const h = terrainHeight(x, z, seed, lvl);
      dummy.position.set(x, h, z);
      dummy.scale.set(1, 1 + rand(), 1);
      dummy.rotation.y = rand() * Math.PI * 2;
      dummy.updateMatrix();
      flowers.setMatrixAt(i, dummy.matrix);
    }
    flowers.count = nFlowers;
    group.add(flowers);
  }

  worldGroup.add(group);
  return { group, cx, cz };
}

function disposeChunk(ch) {
  worldGroup.remove(ch.group);
  ch.group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    // materials are shared — don't dispose
  });
}

function ensureVisibleChunks() {
  const pcx = Math.floor(player.pos.x / CHUNK_SIZE);
  const pcz = Math.floor(player.pos.z / CHUNK_SIZE);
  for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
    for (let dz = -VIEW_RADIUS; dz <= VIEW_RADIUS; dz++) {
      const k = chunkKey(pcx + dx, pcz + dz);
      if (!chunks.has(k)) chunks.set(k, buildChunk(pcx + dx, pcz + dz));
    }
  }
  // Free anything too far
  for (const [k, ch] of chunks) {
    if (Math.abs(ch.cx - pcx) > VIEW_RADIUS + 1 || Math.abs(ch.cz - pcz) > VIEW_RADIUS + 1) {
      disposeChunk(ch);
      chunks.delete(k);
    }
  }
}

function clearAllChunks() {
  for (const [, ch] of chunks) disposeChunk(ch);
  chunks.clear();
}

function buildWorld() {
  clearAllChunks();
  // Sky tint shifts with level
  const lvl = worldLevel();
  const skyHues = [0x9fd0ff, 0xb8dcff, 0xffd6a8, 0xffc0cb, 0xc7b6ff, 0x8a7ae8];
  const col = new THREE.Color(skyHues[Math.min(lvl - 1, skyHues.length - 1)]);
  scene.background = col;
  scene.fog.color.copy(col);
  // Initial ring around current player position
  ensureVisibleChunks();
}

// =============================================================================
// Player (3rd-person ground character)
// =============================================================================
const PLAYER_HEIGHT = 1.8;
const PLAYER_RADIUS = 0.4;
const PLAYER_WALK   = 8;
const PLAYER_SPRINT = 14;
const PLAYER_JUMP   = 8.5;
const GRAVITY       = 22;

const player = {
  pos: new THREE.Vector3(0, 30, 0),
  vel: new THREE.Vector3(),
  yaw: 0,
  pitch: 0.15,
  onGround: false,
  group: new THREE.Group(),
};

// Virtual input (joystick / touch buttons). Shared with desktop keys.
const touchInput = {
  moveX: 0,     // -1..1 strafe
  moveY: 0,     // -1..1 forward(+)/backward(-)
  jump:  false, // pulse — consumed once
  sprint: false,
};

// Low-poly lumberjack: checkered shirt, cap, satchel full of berries.
// No external assets — the shirt pattern is a procedural CanvasTexture.
function buildLumberjack(group) {
  // Procedural red-checkered shirt texture
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const TS = 16;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      ctx.fillStyle = ((x + y) & 1) ? '#c4261a' : '#7a0e08';
      ctx.fillRect(x * TS, y * TS, TS, TS);
    }
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath(); ctx.moveTo(i * TS, 0);  ctx.lineTo(i * TS, 64); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * TS);  ctx.lineTo(64, i * TS); ctx.stroke();
  }
  const shirtTex = new THREE.CanvasTexture(canvas);
  shirtTex.wrapS = shirtTex.wrapT = THREE.RepeatWrapping;
  shirtTex.repeat.set(2, 1);
  shirtTex.magFilter = THREE.NearestFilter;
  shirtTex.minFilter = THREE.NearestFilter;

  const skinMat    = new THREE.MeshLambertMaterial({ color: 0xf2c79a });
  const pantsMat   = new THREE.MeshLambertMaterial({ color: 0x1e2a3a });
  const shirtMat   = new THREE.MeshLambertMaterial({ map: shirtTex, color: 0xffffff });
  const bootsMat   = new THREE.MeshLambertMaterial({ color: 0x3a2010 });
  const satchelMat = new THREE.MeshLambertMaterial({ color: 0x6a4020 });
  const berryMat   = new THREE.MeshLambertMaterial({ color: 0xe03a58, emissive: 0x3a0612, emissiveIntensity: 0.4 });
  const capMat     = new THREE.MeshLambertMaterial({ color: 0xa31414 });

  // --- Legs as hip pivots so rotation.x swings the whole leg from the hip ---
  const legGeo  = new THREE.CylinderGeometry(0.12, 0.12, 0.75, 6);
  const bootGeo = new THREE.BoxGeometry(0.28, 0.18, 0.34);

  function buildLeg(x) {
    const hip = new THREE.Group();
    hip.position.set(x, 0.755, 0); // hip height (top of leg)
    const leg = new THREE.Mesh(legGeo, pantsMat);
    leg.position.y = -0.375;       // cylinder center hangs below the hip
    hip.add(leg);
    const boot = new THREE.Mesh(bootGeo, bootsMat);
    boot.position.set(0, -0.755 + 0.09, 0.03); // sole at y=0 relative to group
    hip.add(boot);
    return hip;
  }
  const hipL = buildLeg(-0.13);
  const hipR = buildLeg( 0.13);
  group.add(hipL, hipR);

  // Torso (shirt)
  const torso = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.27, 0.8, 10),
    shirtMat,
  );
  torso.position.y = 1.15;
  group.add(torso);

  // --- Arms as shoulder pivots ---
  const armGeo  = new THREE.CylinderGeometry(0.09, 0.09, 0.75, 6);
  const handGeo = new THREE.SphereGeometry(0.1, 8, 6);

  function buildArm(x, zTilt) {
    const shoulder = new THREE.Group();
    shoulder.position.set(x, 1.48, 0); // shoulder position
    shoulder.rotation.z = zTilt;       // slight outward tilt at rest
    const arm = new THREE.Mesh(armGeo, shirtMat);
    arm.position.y = -0.375;
    shoulder.add(arm);
    const hand = new THREE.Mesh(handGeo, skinMat);
    hand.position.y = -0.78;
    shoulder.add(hand);
    return shoulder;
  }
  const shoulderL = buildArm(-0.35,  0.2);
  const shoulderR = buildArm( 0.35, -0.2);
  group.add(shoulderL, shoulderR);

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 10), skinMat);
  head.position.y = 1.78;
  group.add(head);

  // Beard (small dark cone under the head, optional lumberjack vibe)
  const beard = new THREE.Mesh(
    new THREE.ConeGeometry(0.18, 0.22, 8),
    new THREE.MeshLambertMaterial({ color: 0x3a2a1a }),
  );
  beard.position.set(0, 1.62, 0.12);
  beard.rotation.x = 0.3;
  group.add(beard);

  // Cap (cylinder crown + flat brim)
  const capCrown = new THREE.Mesh(
    new THREE.CylinderGeometry(0.25, 0.25, 0.14, 14),
    capMat,
  );
  capCrown.position.y = 1.97;
  group.add(capCrown);
  const capBrim = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.04, 0.2),
    capMat,
  );
  capBrim.position.set(0, 1.92, 0.22);
  group.add(capBrim);

  // Satchel on the left hip (strap across torso + pouch)
  const strap = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.9, 0.04),
    satchelMat,
  );
  strap.position.set(0.08, 1.18, 0.18);
  strap.rotation.z = -0.45;
  group.add(strap);
  const pouch = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.26, 0.16),
    satchelMat,
  );
  pouch.position.set(-0.32, 0.88, 0.08);
  pouch.rotation.y = 0.35;
  group.add(pouch);
  // Flap
  const flap = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.12, 0.02),
    satchelMat,
  );
  flap.position.set(-0.32, 1.02, 0.17);
  flap.rotation.y = 0.35;
  group.add(flap);

  // Berries peeking out of the pouch
  const berryGeo = new THREE.SphereGeometry(0.065, 8, 6);
  const berrySpots = [
    [-0.26, 1.02,  0.17],
    [-0.34, 1.05,  0.22],
    [-0.41, 1.02,  0.17],
    [-0.30, 1.07,  0.12],
    [-0.38, 1.06,  0.12],
  ];
  for (const [x, y, z] of berrySpots) {
    const b = new THREE.Mesh(berryGeo, berryMat);
    b.position.set(x, y, z);
    group.add(b);
  }

  return { hipL, hipR, shoulderL, shoulderR, torso };
}
player.parts = buildLumberjack(player.group);
player.walkPhase = 0;
scene.add(player.group);

// Camera follow parameters
let camDist = 7;
const CAM_DIST_MIN = 3;
const CAM_DIST_MAX = 45;
const CAM_HEIGHT = 2.2;
const tmpCamPos = new THREE.Vector3();
const tmpLookAt = new THREE.Vector3();
const moveDir = new THREE.Vector3();
const forward = new THREE.Vector3();
const right   = new THREE.Vector3();

function placePlayerOnGround() {
  const seed = save.worldSeed;
  const lvl = worldLevel();
  const h = terrainHeight(player.pos.x, player.pos.z, seed, lvl);
  player.pos.y = h + PLAYER_HEIGHT * 0.5;
  player.vel.set(0, 0, 0);
  player.onGround = true;
}

function updatePlayer(dt) {
  const seed = save.worldSeed;
  const lvl = worldLevel();

  // Build horizontal forward / right from yaw
  forward.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  right.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));

  // Keyboard input
  let mFwd = 0, mStr = 0;
  if (keys['KeyW'] || keys['ArrowUp'])    mFwd += 1;
  if (keys['KeyS'] || keys['ArrowDown'])  mFwd -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) mStr += 1;
  if (keys['KeyA'] || keys['ArrowLeft'])  mStr -= 1;
  // Virtual joystick input (touch)
  mFwd += touchInput.moveY;
  mStr += touchInput.moveX;
  mFwd = Math.max(-1, Math.min(1, mFwd));
  mStr = Math.max(-1, Math.min(1, mStr));

  moveDir.set(0, 0, 0);
  moveDir.addScaledVector(forward, mFwd);
  moveDir.addScaledVector(right,   mStr);
  if (moveDir.lengthSq() > 1) moveDir.normalize();

  const sprinting = keys['ShiftLeft'] || keys['ShiftRight'] || touchInput.sprint;
  const speed = sprinting ? PLAYER_SPRINT : PLAYER_WALK;
  player.vel.x = moveDir.x * speed;
  player.vel.z = moveDir.z * speed;

  // Gravity
  player.vel.y -= GRAVITY * dt;

  // Jump
  if (player.onGround && (keys['Space'] || keys['KeyJ'] || touchInput.jump)) {
    player.vel.y = PLAYER_JUMP;
    player.onGround = false;
  }
  touchInput.jump = false; // consume one-shot

  player.pos.addScaledVector(player.vel, dt);

  // Ground collision via terrain heightfield
  const groundH = terrainHeight(player.pos.x, player.pos.z, seed, lvl);
  const footY = groundH + PLAYER_HEIGHT * 0.5;
  if (player.pos.y < footY) {
    player.pos.y = footY;
    player.vel.y = 0;
    player.onGround = true;
  } else {
    player.onGround = player.pos.y - footY < 0.05;
  }

  // No world bounds — the world streams in as the player moves

  // Update mesh
  player.group.position.copy(player.pos);
  player.group.position.y -= PLAYER_HEIGHT * 0.5; // mesh is modelled with feet at 0
  player.group.rotation.y = player.yaw;

  // --- Walk animation (hip + shoulder swings) ---
  const horizSpeed = Math.hypot(player.vel.x, player.vel.z);
  if (horizSpeed > 0.1) {
    // Step frequency scales gently with speed so sprint looks faster
    player.walkPhase += dt * (4 + horizSpeed * 0.5);
  } else {
    // Ease back to neutral when idle
    player.walkPhase *= 0.9;
  }
  const moving = horizSpeed > 0.1 ? 1 : 0;
  const swing  = Math.sin(player.walkPhase) * 0.7 * moving;
  const swing2 = Math.sin(player.walkPhase * 2) * 0.06 * moving;
  // Legs swing opposite each other
  player.parts.hipL.rotation.x =  swing;
  player.parts.hipR.rotation.x = -swing;
  // Arms swing opposite to the matching leg
  player.parts.shoulderL.rotation.x = -swing * 0.9;
  player.parts.shoulderR.rotation.x =  swing * 0.9;
  // Slight body bob + torso roll for liveliness
  player.group.position.y += Math.abs(Math.sin(player.walkPhase)) * 0.04 * moving;
  player.parts.torso.rotation.z = swing2;

  // Follow camera — orbital around player using yaw/pitch
  const cp = Math.cos(player.pitch), sp = Math.sin(player.pitch);
  const cy = Math.cos(player.yaw),   sy = Math.sin(player.yaw);
  tmpCamPos.set(
    player.pos.x + camDist * cp * sy,
    player.pos.y + CAM_HEIGHT + camDist * sp,
    player.pos.z + camDist * cp * cy,
  );
  // Prevent camera from going below terrain
  const camGround = terrainHeight(tmpCamPos.x, tmpCamPos.z, seed, lvl) + 1.2;
  if (tmpCamPos.y < camGround) tmpCamPos.y = camGround;
  camera.position.copy(tmpCamPos);
  tmpLookAt.set(player.pos.x, player.pos.y + 0.6, player.pos.z);
  camera.lookAt(tmpLookAt);
}

// =============================================================================
// Food system
// =============================================================================
const foods = []; // { pos, tier, life, energy, mesh }
const foodGeo = new THREE.IcosahedronGeometry(0.45, 0);

function dropFood(point) {
  const tier = save.selectedFood;
  if (!foodUnlocked(tier)) return;
  const def = FOODS[tier];
  const mat = new THREE.MeshStandardMaterial({
    color: def.color,
    emissive: def.color,
    emissiveIntensity: 0.4,
    roughness: 0.4,
  });
  const mesh = new THREE.Mesh(foodGeo, mat);
  mesh.position.copy(point);
  mesh.position.y += 0.5;
  scene.add(mesh);
  foods.push({
    pos: mesh.position,
    tier,
    life: def.life,
    energy: def.energy,
    mesh,
  });
  // Spawn a new bird if we don't have many, proportional to tier
  if (birds.length < MAX_BIRDS && Math.random() < 0.35 + tier * 0.1) spawnBird();
}

// Drop food at the player's feet (or slightly in front)
function dropFoodAtPlayer() {
  const p = new THREE.Vector3().copy(player.pos);
  // Offset slightly forward, in facing direction
  p.x += -Math.sin(player.yaw) * 1.2;
  p.z += -Math.cos(player.yaw) * 1.2;
  const seed = save.worldSeed;
  const lvl = worldLevel();
  p.y = terrainHeight(p.x, p.z, seed, lvl) + 0.4;
  dropFood(p);
}

function updateFoods(dt) {
  for (let i = foods.length - 1; i >= 0; i--) {
    const f = foods[i];
    f.life -= dt;
    // Bob / spin
    f.mesh.rotation.y += dt * 2;
    f.mesh.position.y += Math.sin(performance.now() * 0.003 + i) * 0.01;
    if (f.life <= 0) {
      scene.remove(f.mesh);
      f.mesh.material.dispose();
      foods.splice(i, 1);
    }
  }
}

// =============================================================================
// Birds — Boids
// =============================================================================
const MAX_BIRDS = 160;
const NEIGHBOR_DIST = 7;
const SEPARATION_DIST = 2.2;
const MAX_SPEED = 13;
const MIN_SPEED = 3.5;
const CELL = 8;

const birds = [];
// InstancedMesh for birds — flattened octahedron looks vaguely bird-ish
const birdGeo = new THREE.OctahedronGeometry(0.5, 0);
birdGeo.scale(1.6, 0.3, 1.0);
const birdMat = new THREE.MeshLambertMaterial({ vertexColors: false });
const birdMesh = new THREE.InstancedMesh(birdGeo, birdMat, MAX_BIRDS);
birdMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
birdMesh.count = 0;
// per-instance color
const birdColors = new Float32Array(MAX_BIRDS * 3);
birdMesh.instanceColor = new THREE.InstancedBufferAttribute(birdColors, 3);
birdMat.vertexColors = true;
scene.add(birdMesh);

class Bird {
  constructor(pos) {
    this.pos = pos.clone();
    this.vel = new THREE.Vector3(
      (Math.random() - 0.5) * 6,
      (Math.random() - 0.3) * 2,
      (Math.random() - 0.5) * 6,
    );
    this.accel = new THREE.Vector3();
    this.energy = 50;
    this.age = 0;
    this.evo = 0; // evolution stage 0..4
    this.scale = 0.8 + Math.random() * 0.3;
    this.color = new THREE.Color().setHSL(Math.random(), 0.55, 0.55);
    this.phase = Math.random() * Math.PI * 2;
  }
}

// Spawn birds in a close ring around the player so they're immediately visible
function spawnBird() {
  if (birds.length >= MAX_BIRDS) return;
  const angle = Math.random() * Math.PI * 2;
  const r = 12 + Math.random() * 28; // much closer than before (was 40..130)
  const x = player.pos.x + Math.cos(angle) * r;
  const z = player.pos.z + Math.sin(angle) * r;
  const h = terrainHeight(x, z, save.worldSeed, worldLevel()) + 7 + Math.random() * 8;
  birds.push(new Bird(new THREE.Vector3(x, h, z)));
}

// Spatial hash grid
const grid = new Map();
function cellKey(cx, cy, cz) { return cx * 73856093 ^ cy * 19349663 ^ cz * 83492791; }

// Reusable vectors to avoid per-frame allocations
const tmpV = new THREE.Vector3();
const tmpSep = new THREE.Vector3();
const tmpAli = new THREE.Vector3();
const tmpCoh = new THREE.Vector3();
const tmpFood = new THREE.Vector3();
const tmpGround = new THREE.Vector3();
const tmpWander = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const tmpScale = new THREE.Vector3();
const xAxis = new THREE.Vector3(1, 0, 0);

function updateBirds(dt) {
  // Build spatial grid
  grid.clear();
  for (const b of birds) {
    const cx = Math.floor(b.pos.x / CELL);
    const cy = Math.floor(b.pos.y / CELL);
    const cz = Math.floor(b.pos.z / CELL);
    const k = cellKey(cx, cy, cz);
    let arr = grid.get(k);
    if (!arr) { arr = []; grid.set(k, arr); }
    arr.push(b);
  }

  const seed = save.worldSeed;
  const lvl = worldLevel();

  for (let i = 0; i < birds.length; i++) {
    const b = birds[i];
    tmpSep.set(0, 0, 0);
    tmpAli.set(0, 0, 0);
    tmpCoh.set(0, 0, 0);
    let n = 0;

    const cx = Math.floor(b.pos.x / CELL);
    const cy = Math.floor(b.pos.y / CELL);
    const cz = Math.floor(b.pos.z / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const cell = grid.get(cellKey(cx + dx, cy + dy, cz + dz));
          if (!cell) continue;
          for (const o of cell) {
            if (o === b) continue;
            const d = b.pos.distanceTo(o.pos);
            if (d > NEIGHBOR_DIST) continue;
            if (d < SEPARATION_DIST) {
              tmpV.subVectors(b.pos, o.pos).divideScalar(d * d + 0.01);
              tmpSep.add(tmpV);
            }
            tmpAli.add(o.vel);
            tmpCoh.add(o.pos);
            n++;
          }
        }
      }
    }

    if (n > 0) {
      tmpAli.divideScalar(n);
      if (tmpAli.lengthSq() > 0) tmpAli.setLength(MAX_SPEED).sub(b.vel).clampLength(0, 6);
      tmpCoh.divideScalar(n).sub(b.pos);
      if (tmpCoh.lengthSq() > 0) tmpCoh.setLength(MAX_SPEED).sub(b.vel).clampLength(0, 4);
    }

    // Food attraction: pick best food by tier / distance
    let best = null, bestScore = -Infinity;
    for (const f of foods) {
      const d = b.pos.distanceTo(f.pos);
      if (d > 80) continue;
      const score = (f.energy + 1) * 10 - d;
      if (score > bestScore) { bestScore = score; best = f; }
    }
    tmpFood.set(0, 0, 0);
    if (best) {
      tmpFood.subVectors(best.pos, b.pos);
      if (tmpFood.lengthSq() > 0) {
        tmpFood.setLength(MAX_SPEED).sub(b.vel).clampLength(0, 12);
      }
    }

    // Ground / ceiling avoidance
    const groundH = terrainHeight(b.pos.x, b.pos.z, seed, lvl);
    const minY = groundH + 4;
    const maxY = 70;
    tmpGround.set(0, 0, 0);
    if (b.pos.y < minY + 5) tmpGround.y += (minY + 5 - b.pos.y) * 3;
    if (b.pos.y > maxY)     tmpGround.y -= (b.pos.y - maxY) * 3;

    // Soft bounds relative to the player (keep birds in a bubble around them
    // — the world is infinite but we don't want flocks straying off forever)
    const bubbleR = 180;
    const bx = b.pos.x - player.pos.x;
    const bz = b.pos.z - player.pos.z;
    if (bx >  bubbleR) tmpGround.x -= (bx -  bubbleR) * 2;
    if (bx < -bubbleR) tmpGround.x += (-bubbleR - bx) * 2;
    if (bz >  bubbleR) tmpGround.z -= (bz -  bubbleR) * 2;
    if (bz < -bubbleR) tmpGround.z += (-bubbleR - bz) * 2;

    // Wander (smooth pseudo-random drift)
    tmpWander.set(
      (valueNoise(b.age * 0.3 + i, 0, 1) - 0.5) * 4,
      (valueNoise(b.age * 0.2, i, 2) - 0.5) * 1,
      (valueNoise(0, b.age * 0.3 + i, 3) - 0.5) * 4,
    );

    b.accel.set(0, 0, 0)
      .addScaledVector(tmpSep, 2.2)
      .addScaledVector(tmpAli, 1.0)
      .addScaledVector(tmpCoh, 0.8)
      .addScaledVector(tmpFood, 3.0 + b.evo * 0.3)
      .add(tmpGround)
      .add(tmpWander);

    b.vel.addScaledVector(b.accel, dt);
    // Clamp speed
    const speed = b.vel.length();
    const maxS = MAX_SPEED + b.evo * 0.8;
    if (speed > maxS) b.vel.multiplyScalar(maxS / speed);
    else if (speed < MIN_SPEED) b.vel.multiplyScalar(MIN_SPEED / (speed + 0.0001));

    b.pos.addScaledVector(b.vel, dt);
    b.age += dt;
    b.energy -= dt * 0.6;

    // Eat food if close enough
    if (best && b.pos.distanceTo(best.pos) < 1.6) {
      b.energy += best.energy * 10;
      gainXp(best.energy);
      // remove food
      const idx = foods.indexOf(best);
      if (idx !== -1) {
        scene.remove(best.mesh);
        best.mesh.material.dispose();
        foods.splice(idx, 1);
      }
      // Evolve
      if (b.evo < 4 && b.energy > 120 + b.evo * 40) {
        b.evo++;
        b.scale += 0.15;
        b.color.offsetHSL(0.1, 0.05, 0.03);
        showToast(`Un oiseau a évolué ! <b>Stade ${b.evo + 1}</b>`);
      }
    }

    if (b.energy < 0) b.energy = 0;
  }
}

function renderBirds() {
  birdMesh.count = birds.length;
  for (let i = 0; i < birds.length; i++) {
    const b = birds[i];
    // Orient the bird so its +X axis (elongated geom) aligns with velocity
    if (b.vel.lengthSq() > 0.0001) {
      tmpV.copy(b.vel).normalize();
      tmpQuat.setFromUnitVectors(xAxis, tmpV);
    }
    // Wing flap via scale.y oscillation
    const flap = 0.7 + Math.sin(b.age * 14 + b.phase) * 0.35;
    const s = b.scale;
    tmpScale.set(s, s * flap * 0.6, s);
    tmpM.compose(b.pos, tmpQuat, tmpScale);
    birdMesh.setMatrixAt(i, tmpM);
    birdColors[i * 3]     = b.color.r;
    birdColors[i * 3 + 1] = b.color.g;
    birdColors[i * 3 + 2] = b.color.b;
  }
  birdMesh.instanceMatrix.needsUpdate = true;
  if (birdMesh.instanceColor) birdMesh.instanceColor.needsUpdate = true;
}

// =============================================================================
// HUD / UI
// =============================================================================
const $xp       = document.getElementById('xp');
const $birdCnt  = document.getElementById('birdCount');
const $worldLvl = document.getElementById('worldLvl');
const $foodbar  = document.getElementById('foodbar');
const $toast    = document.getElementById('unlock');
const $regen    = document.getElementById('regenBtn');
const $reset    = document.getElementById('resetBtn');

function buildFoodbar() {
  $foodbar.innerHTML = '';
  FOODS.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = 'food';
    const unlocked = foodUnlocked(i);
    if (!unlocked) el.classList.add('locked');
    if (i === save.selectedFood && unlocked) el.classList.add('active');
    el.innerHTML = `
      <div class="dot" style="background:#${f.color.toString(16).padStart(6, '0')};color:#${f.color.toString(16).padStart(6, '0')}"></div>
      <div class="name">${f.name}</div>
      ${unlocked ? '' : `<div class="lock">${f.unlock}◈</div>`}
    `;
    el.addEventListener('click', () => {
      if (!foodUnlocked(i)) return;
      save.selectedFood = i;
      persist();
      buildFoodbar();
    });
    $foodbar.appendChild(el);
  });
}

function updateHUD() {
  $xp.textContent = Math.floor(save.xp);
  $birdCnt.textContent = birds.length;
  $worldLvl.textContent = worldLevel();
}

let toastTimer = 0;
function showToast(html) {
  $toast.innerHTML = html;
  $toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.add('hidden'), 3200);
}

let lastLevel = worldLevel();
function gainXp(amount) {
  const before = save.xp;
  save.xp += amount;
  // Check food unlocks
  for (let i = 0; i < FOODS.length; i++) {
    if (before < FOODS[i].unlock && save.xp >= FOODS[i].unlock) {
      showToast(`Nouvelle nourriture débloquée : <b>${FOODS[i].name}</b>`);
      buildFoodbar();
    }
  }
  // Check world level up
  const lv = worldLevel();
  if (lv !== lastLevel) {
    lastLevel = lv;
    showToast(`Le monde évolue — <b>niveau ${lv}</b>`);
    buildWorld();
    placePlayerOnGround();
  }
  persist();
  updateHUD();
}

$regen.addEventListener('click', () => {
  save.worldSeed = (Math.random() * 1e9) | 0;
  persist();
  buildWorld();
  placePlayerOnGround();
});
$reset.addEventListener('click', () => {
  if (!confirm('Tout réinitialiser ?')) return;
  save = defaultSave();
  persist();
  birds.length = 0;
  for (const f of foods) { scene.remove(f.mesh); f.mesh.material.dispose(); }
  foods.length = 0;
  lastLevel = worldLevel();
  buildWorld();
  placePlayerOnGround();
  buildFoodbar();
  updateHUD();
});

// =============================================================================
// Input: drag canvas to look, virtual joystick & buttons for mobile
// =============================================================================
canvas.addEventListener('contextmenu', e => e.preventDefault());

// Detect touch capability to show the on-screen controls
const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
if (isTouch) document.body.classList.add('touch');

// --- Multi-pointer input: 1 finger / mouse = drag-to-look, 2 fingers = pinch-zoom ---
const activePointers = new Map(); // pointerId -> { x, y, type }
let pinchActive = false;
let pinchStartDist = 0;
let pinchStartCam = 0;
let singleTouchMoved = false;

canvas.addEventListener('pointerdown', e => {
  if (e.target !== canvas) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
  canvas.setPointerCapture?.(e.pointerId);
  if (activePointers.size === 1) {
    singleTouchMoved = false;
  } else if (activePointers.size === 2) {
    const pts = Array.from(activePointers.values());
    pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    pinchStartCam = camDist;
    pinchActive = true;
  }
});

canvas.addEventListener('pointermove', e => {
  const p = activePointers.get(e.pointerId);
  if (!p) return;
  const prevX = p.x, prevY = p.y;
  p.x = e.clientX;
  p.y = e.clientY;

  if (pinchActive && activePointers.size >= 2) {
    const pts = Array.from(activePointers.values());
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (pinchStartDist > 1) {
      // Spread fingers => zoom in (smaller distance), pinch => zoom out
      camDist = Math.max(CAM_DIST_MIN, Math.min(CAM_DIST_MAX, pinchStartCam * (pinchStartDist / d)));
    }
    return;
  }

  if (activePointers.size === 1) {
    const dx = e.clientX - prevX;
    const dy = e.clientY - prevY;
    if (Math.abs(dx) + Math.abs(dy) > 3) singleTouchMoved = true;
    player.yaw   -= dx * 0.005;
    player.pitch -= dy * 0.005;
    player.pitch = Math.max(-0.6, Math.min(1.0, player.pitch));
  }
});

function endCanvasPointer(e) {
  if (!activePointers.has(e.pointerId)) return;
  const p = activePointers.get(e.pointerId);
  activePointers.delete(e.pointerId);
  canvas.releasePointerCapture?.(e.pointerId);
  if (activePointers.size < 2) pinchActive = false;
  // Quick tap (no drag) drops food — mouse only (touch users use the Feed button)
  if (activePointers.size === 0 && !singleTouchMoved && p.type !== 'touch') {
    dropFoodAtPlayer();
  }
}
canvas.addEventListener('pointerup',     endCanvasPointer);
canvas.addEventListener('pointercancel', endCanvasPointer);

// Mouse wheel = zoom on desktop
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  camDist = Math.max(CAM_DIST_MIN, Math.min(CAM_DIST_MAX, camDist * (1 + Math.sign(e.deltaY) * 0.12)));
}, { passive: false });

// --- Virtual joystick ---
const joy    = document.getElementById('joystick');
const thumb  = document.getElementById('joystickThumb');
const JOY_MAX = 48;
let joyPointerId = null;
let joyCX = 0, joyCY = 0;

if (joy) {
  joy.addEventListener('pointerdown', e => {
    if (joyPointerId !== null) return;
    joyPointerId = e.pointerId;
    const rect = joy.getBoundingClientRect();
    joyCX = rect.left + rect.width  / 2;
    joyCY = rect.top  + rect.height / 2;
    joy.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  joy.addEventListener('pointermove', e => {
    if (e.pointerId !== joyPointerId) return;
    let dx = e.clientX - joyCX;
    let dy = e.clientY - joyCY;
    const mag = Math.hypot(dx, dy);
    if (mag > JOY_MAX) { dx *= JOY_MAX / mag; dy *= JOY_MAX / mag; }
    thumb.style.transform = `translate(${dx}px, ${dy}px)`;
    touchInput.moveX =  dx / JOY_MAX;
    touchInput.moveY = -dy / JOY_MAX; // screen up = move forward
    touchInput.sprint = mag > JOY_MAX * 0.85;
  });
  const endJoy = e => {
    if (e.pointerId !== joyPointerId) return;
    joyPointerId = null;
    thumb.style.transform = '';
    touchInput.moveX = 0;
    touchInput.moveY = 0;
    touchInput.sprint = false;
  };
  joy.addEventListener('pointerup', endJoy);
  joy.addEventListener('pointercancel', endJoy);
}

// --- Feed & Jump buttons ---
const btnFeed = document.getElementById('btnFeed');
const btnJump = document.getElementById('btnJump');
btnFeed?.addEventListener('pointerdown', e => {
  e.preventDefault();
  dropFoodAtPlayer();
});
btnJump?.addEventListener('pointerdown', e => {
  e.preventDefault();
  touchInput.jump = true;
});

// =============================================================================
// Init + game loop
// =============================================================================
buildWorld();
placePlayerOnGround();
buildFoodbar();
updateHUD();

// Seed a few starter birds
for (let i = 0; i < 14; i++) spawnBird();

let lastT = performance.now();
let hudAcc = 0;

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  let dt = (now - lastT) / 1000;
  if (dt > 0.1) dt = 0.1;
  lastT = now;

  updatePlayer(dt);
  ensureVisibleChunks();
  updateBirds(dt);
  updateFoods(dt);
  renderBirds();

  // Occasional spawn if population is low and xp allows
  if (birds.length < Math.min(12 + worldLevel() * 8, MAX_BIRDS)) {
    if (Math.random() < dt * 0.4) spawnBird();
  }

  hudAcc += dt;
  if (hudAcc > 0.25) { updateHUD(); hudAcc = 0; }

  renderer.render(scene, camera);
}
loop();
