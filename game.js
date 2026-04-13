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
const WORLD_SIZE = 220;
const WORLD_SEG  = 140;
let worldGroup = new THREE.Group();
scene.add(worldGroup);
let terrainRef = null;
let perches = []; // THREE.Vector3[] — potential perch points on trees

function terrainHeight(x, z, seed, lvl) {
  const s1 = 1 / 42;
  let h = (fbm(x * s1, z * s1, seed, 4) - 0.5) * 30;
  if (lvl >= 2) h += Math.sin((x + z) * 0.04 + seed) * 2.5;
  if (lvl >= 3) h += (fbm(x * 0.08, z * 0.08, seed + 999, 2) - 0.5) * 14;
  if (lvl >= 5) h += (fbm(x * 0.015, z * 0.015, seed + 321, 2) - 0.5) * 22;
  return h;
}

function disposeGroup(g) {
  while (g.children.length) {
    const c = g.children.pop();
    if (c.geometry) c.geometry.dispose();
    if (c.material) {
      if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
      else c.material.dispose();
    }
  }
}

function buildWorld() {
  disposeGroup(worldGroup);
  perches = [];
  const lvl = worldLevel();
  const seed = save.worldSeed;

  // Terrain
  const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, WORLD_SEG, WORLD_SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const tmpColor = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = terrainHeight(x, z, seed, lvl);
    pos.setY(i, h);
    if (h < -2)       tmpColor.setRGB(0.82, 0.78, 0.55);         // sand
    else if (h < 2)   tmpColor.setRGB(0.72, 0.76, 0.40);         // dry grass
    else if (h < 13)  tmpColor.setRGB(0.25 + (h / 40), 0.52, 0.22); // forest
    else              tmpColor.setRGB(0.55, 0.55, 0.55);         // rock
    colors[i * 3]     = tmpColor.r;
    colors[i * 3 + 1] = tmpColor.g;
    colors[i * 3 + 2] = tmpColor.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  terrainRef = new THREE.Mesh(geo, terrainMat);
  terrainRef.name = 'terrain';
  worldGroup.add(terrainRef);

  // Trees (cone foliage + cylinder trunk), InstancedMesh
  const nTrees = 80 + lvl * 50;
  const foliageGeo = new THREE.ConeGeometry(1.6, 5, 6);
  foliageGeo.translate(0, 3.4, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.3, 0.45, 1.4, 5);
  trunkGeo.translate(0, 0.7, 0);
  const foliageMat = new THREE.MeshLambertMaterial({ color: 0x2e5a2a });
  const trunkMat   = new THREE.MeshLambertMaterial({ color: 0x5a3a22 });
  const foliage = new THREE.InstancedMesh(foliageGeo, foliageMat, nTrees);
  const trunks  = new THREE.InstancedMesh(trunkGeo,   trunkMat,   nTrees);
  const dummy = new THREE.Object3D();
  let placed = 0;
  for (let i = 0; i < nTrees * 3 && placed < nTrees; i++) {
    const x = (Math.random() - 0.5) * WORLD_SIZE * 0.92;
    const z = (Math.random() - 0.5) * WORLD_SIZE * 0.92;
    const h = terrainHeight(x, z, seed, lvl);
    if (h < 1 || h > 15) continue;
    const s = 0.8 + Math.random() * 1.6;
    dummy.position.set(x, h, z);
    dummy.scale.set(s, s, s);
    dummy.rotation.y = Math.random() * Math.PI * 2;
    dummy.updateMatrix();
    foliage.setMatrixAt(placed, dummy.matrix);
    trunks.setMatrixAt(placed,  dummy.matrix);
    perches.push(new THREE.Vector3(x, h + 5 * s, z));
    placed++;
  }
  foliage.count = placed;
  trunks.count  = placed;
  worldGroup.add(trunks);
  worldGroup.add(foliage);

  // Rocks
  const nRocks = 30 + lvl * 14;
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x888888, flatShading: true });
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, nRocks);
  for (let i = 0; i < nRocks; i++) {
    const x = (Math.random() - 0.5) * WORLD_SIZE * 0.95;
    const z = (Math.random() - 0.5) * WORLD_SIZE * 0.95;
    const h = terrainHeight(x, z, seed, lvl);
    const s = 0.6 + Math.random() * 2.8;
    dummy.position.set(x, h + s * 0.35, z);
    dummy.scale.set(s, s * 0.75, s);
    dummy.rotation.set(Math.random(), Math.random() * Math.PI, Math.random());
    dummy.updateMatrix();
    rocks.setMatrixAt(i, dummy.matrix);
  }
  worldGroup.add(rocks);

  // Optional flowers / tall grass at higher levels
  if (lvl >= 4) {
    const n = 120 + lvl * 30;
    const g = new THREE.ConeGeometry(0.2, 0.8, 4);
    g.translate(0, 0.4, 0);
    const m = new THREE.MeshLambertMaterial({ color: 0xff9ad0 });
    const im = new THREE.InstancedMesh(g, m, n);
    for (let i = 0; i < n; i++) {
      const x = (Math.random() - 0.5) * WORLD_SIZE * 0.9;
      const z = (Math.random() - 0.5) * WORLD_SIZE * 0.9;
      const h = terrainHeight(x, z, seed, lvl);
      dummy.position.set(x, h, z);
      dummy.scale.set(1, 1 + Math.random(), 1);
      dummy.rotation.y = Math.random() * Math.PI * 2;
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    }
    worldGroup.add(im);
  }

  // Sky tint shifts with level
  const skyHues = [0x9fd0ff, 0xb8dcff, 0xffd6a8, 0xffc0cb, 0xc7b6ff, 0x8a7ae8];
  const col = new THREE.Color(skyHues[Math.min(lvl - 1, skyHues.length - 1)]);
  scene.background = col;
  scene.fog.color.copy(col);
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

// Simple low-poly character: body capsule + head + arm hint
{
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x4a7fff });
  const headMat = new THREE.MeshLambertMaterial({ color: 0xffd9a8 });
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(PLAYER_RADIUS, 1.0, 4, 8),
    bodyMat,
  );
  body.position.y = 0.9;
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 12, 8),
    headMat,
  );
  head.position.y = 1.7;
  const arm = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 0.7, 6),
    bodyMat,
  );
  arm.position.set(0.35, 1.1, 0.1);
  arm.rotation.z = -0.5;
  player.group.add(body, head, arm);
  scene.add(player.group);
}

// Camera follow parameters
const CAM_DIST   = 6;
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

  moveDir.set(0, 0, 0);
  if (keys['KeyW'] || keys['ArrowUp'])    moveDir.add(forward);
  if (keys['KeyS'] || keys['ArrowDown'])  moveDir.sub(forward);
  if (keys['KeyD'] || keys['ArrowRight']) moveDir.add(right);
  if (keys['KeyA'] || keys['ArrowLeft'])  moveDir.sub(right);
  if (moveDir.lengthSq() > 0) moveDir.normalize();

  const speed = (keys['ShiftLeft'] || keys['ShiftRight']) ? PLAYER_SPRINT : PLAYER_WALK;
  player.vel.x = moveDir.x * speed;
  player.vel.z = moveDir.z * speed;

  // Gravity
  player.vel.y -= GRAVITY * dt;

  // Jump
  if (player.onGround && (keys['Space'] || keys['KeyJ'])) {
    player.vel.y = PLAYER_JUMP;
    player.onGround = false;
  }

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

  // Keep inside world bounds
  const bound = WORLD_SIZE * 0.48;
  player.pos.x = Math.max(-bound, Math.min(bound, player.pos.x));
  player.pos.z = Math.max(-bound, Math.min(bound, player.pos.z));

  // Update mesh
  player.group.position.copy(player.pos);
  player.group.position.y -= PLAYER_HEIGHT * 0.5; // mesh is modelled with feet at 0
  player.group.rotation.y = player.yaw;

  // Follow camera — orbital around player using yaw/pitch
  const cp = Math.cos(player.pitch), sp = Math.sin(player.pitch);
  const cy = Math.cos(player.yaw),   sy = Math.sin(player.yaw);
  tmpCamPos.set(
    player.pos.x + CAM_DIST * cp * sy,
    player.pos.y + CAM_HEIGHT + CAM_DIST * sp,
    player.pos.z + CAM_DIST * cp * cy,
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

function spawnBird() {
  if (birds.length >= MAX_BIRDS) return;
  // Spawn near edges at a safe altitude
  const angle = Math.random() * Math.PI * 2;
  const r = WORLD_SIZE * 0.35;
  const x = Math.cos(angle) * r;
  const z = Math.sin(angle) * r;
  const h = terrainHeight(x, z, save.worldSeed, worldLevel()) + 20 + Math.random() * 15;
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

    // Soft world bounds
    const bound = WORLD_SIZE * 0.48;
    if (b.pos.x >  bound) tmpGround.x -= (b.pos.x -  bound) * 2;
    if (b.pos.x < -bound) tmpGround.x += (-bound - b.pos.x) * 2;
    if (b.pos.z >  bound) tmpGround.z -= (b.pos.z -  bound) * 2;
    if (b.pos.z < -bound) tmpGround.z += (-bound - b.pos.z) * 2;

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
// Input: click to feed, right-drag to orbit, wheel to zoom
// =============================================================================
// Pointer lock for mouse look, click to feed at player position
canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('click', () => {
  if (document.pointerLockElement !== canvas) {
    canvas.requestPointerLock?.();
  } else {
    // Already locked — clicking feeds
    dropFoodAtPlayer();
  }
});

document.addEventListener('pointerlockchange', () => {
  // Nothing special; mousemove handler checks the state
});

window.addEventListener('mousemove', e => {
  if (document.pointerLockElement !== canvas) return;
  player.yaw   -= e.movementX * 0.0025;
  player.pitch -= e.movementY * 0.0025;
  player.pitch = Math.max(-0.6, Math.min(1.0, player.pitch));
});

// =============================================================================
// Init + game loop
// =============================================================================
buildWorld();
placePlayerOnGround();
buildFoodbar();
updateHUD();

// Seed a few starter birds
for (let i = 0; i < 8; i++) spawnBird();

let lastT = performance.now();
let hudAcc = 0;

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  let dt = (now - lastT) / 1000;
  if (dt > 0.1) dt = 0.1;
  lastT = now;

  updatePlayer(dt);
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
