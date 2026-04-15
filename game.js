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
const hemi = new THREE.HemisphereLight(0xbfe0ff, 0x4a3a2a, 0.55);
scene.add(hemi);
const ambient = new THREE.AmbientLight(0xffffff, 0.18);
scene.add(ambient);

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
  if (e.code === 'Escape') {
    document.exitPointerLock?.();
    if (typeof closeDialog === 'function') closeDialog();
    if (typeof closeBigPanel === 'function') closeBigPanel();
  }
  if (e.code === 'KeyE' && typeof tryInteract === 'function') tryInteract();
  if (e.code === 'KeyF' && typeof tryGatherNearbyPlant === 'function') tryGatherNearbyPlant();
  if (e.code === 'KeyP' && typeof plantSapling === 'function') plantSapling();
  if (e.code === 'KeyI' && typeof toggleInventoryPanel === 'function') toggleInventoryPanel();
  if (e.code === 'KeyM' && typeof toggleWorldMapPanel === 'function') toggleWorldMapPanel();
  if (e.code === 'KeyA' && typeof toggleAtlasPanel === 'function') toggleAtlasPanel();
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

// Shared terrain material (uses per-vertex biome colors)
const terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

// Per-biome materials, created lazily and cached
const biomeMats = new Map(); // biome.id -> { foliage, trunk, rock, flower }
function rgbToHex(r, g, b) {
  return ((r * 255) & 0xff) * 65536 + ((g * 255) & 0xff) * 256 + ((b * 255) & 0xff);
}
function getBiomeMats(biome) {
  let m = biomeMats.get(biome.id);
  if (!m) {
    m = {
      foliage: new THREE.MeshLambertMaterial({ color: biome.trees }),
      trunk:   new THREE.MeshLambertMaterial({ color: biome.trunks }),
      rock:    new THREE.MeshLambertMaterial({ color: rgbToHex(...biome.rock), flatShading: true }),
      flower:  new THREE.MeshLambertMaterial({ color: biome.flowerColor }),
    };
    biomeMats.set(biome.id, m);
  }
  return m;
}

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

// --- Biomes ---------------------------------------------------------------
// 6 hand-tuned zones inspired by classic open-world MMO regions. Each
// chunk picks a single biome by sampling very low-frequency noise at its
// center, so the world has coherent regions dozens-to-hundreds of units
// wide instead of random per-chunk colors.
const BIOMES = [
  {
    id: 'clairiere',
    name: 'La Clairière des Ormes',
    sky: 0x9fd0ff, fog: 0xbfe0ff,
    grass: [0.32, 0.56, 0.22],
    dryGrass: [0.72, 0.76, 0.40],
    rock: [0.55, 0.55, 0.55],
    sand: [0.82, 0.78, 0.55],
    trees: 0x2e5a2a, trunks: 0x5a3a22,
    treeDensity: 1.1,
    flowerColor: 0xff9ad0,
  },
  {
    id: 'cimes',
    name: 'Les Cimes de Givre',
    sky: 0xd8e8ff, fog: 0xd4e4ff,
    grass: [0.84, 0.88, 0.95],
    dryGrass: [0.90, 0.92, 0.96],
    rock: [0.85, 0.88, 0.92],
    sand: [0.92, 0.94, 0.96],
    trees: 0x3a5a4a, trunks: 0x4a3020,
    treeDensity: 0.45,
    flowerColor: 0xd0e0ff,
  },
  {
    id: 'desert',
    name: 'Le Désert des Coquelicots',
    sky: 0xffd9a0, fog: 0xffcfa0,
    grass: [0.82, 0.68, 0.36],
    dryGrass: [0.90, 0.78, 0.44],
    rock: [0.78, 0.56, 0.32],
    sand: [0.94, 0.82, 0.54],
    trees: 0x6a8040, trunks: 0x5a3a22,
    treeDensity: 0.2,
    flowerColor: 0xff4050,
  },
  {
    id: 'marais',
    name: 'Les Marais Chanteurs',
    sky: 0x8aa098, fog: 0x7a9088,
    grass: [0.22, 0.44, 0.30],
    dryGrass: [0.34, 0.48, 0.30],
    rock: [0.42, 0.48, 0.46],
    sand: [0.5, 0.52, 0.40],
    trees: 0x1f3a22, trunks: 0x3a2814,
    treeDensity: 1.4,
    flowerColor: 0xb8d060,
  },
  {
    id: 'foret',
    name: 'La Forêt Chuchotante',
    sky: 0x7a8ae0, fog: 0x6070c0,
    grass: [0.25, 0.32, 0.48],
    dryGrass: [0.30, 0.36, 0.50],
    rock: [0.32, 0.35, 0.52],
    sand: [0.42, 0.44, 0.58],
    trees: 0x4060a0, trunks: 0x2a2040,
    treeDensity: 1.8,
    flowerColor: 0x9ac8ff,
  },
  {
    id: 'dorees',
    name: 'Les Collines Dorées',
    sky: 0xffe7a8, fog: 0xffd996,
    grass: [0.80, 0.68, 0.22],
    dryGrass: [0.88, 0.78, 0.30],
    rock: [0.68, 0.55, 0.22],
    sand: [0.92, 0.82, 0.48],
    trees: 0x6a7a20, trunks: 0x5a3a20,
    treeDensity: 0.55,
    flowerColor: 0xffdd40,
  },
];

function biomeAt(x, z, seed) {
  // Higher frequency (0.0028 → 0.005) so biome regions are ~150 units wide
  // instead of ~350 — the player encounters new biomes within a short walk.
  const h = fbm(x * 0.0050, z * 0.0050, seed + 7001, 2);
  const t = fbm(x * 0.0042, z * 0.0042, seed + 9103, 2);
  // Loosened thresholds so each biome covers a meaningful share of the map
  if (h > 0.62)             return BIOMES[1]; // cimes (snow)
  if (h > 0.50 && t > 0.55) return BIOMES[5]; // dorées (warm mid-high)
  if (h < 0.42 && t > 0.55) return BIOMES[2]; // désert (low, warm)
  if (h < 0.45 && t < 0.45) return BIOMES[3]; // marais (low, cool)
  if (t < 0.32)             return BIOMES[4]; // forêt (cold-mid)
  return BIOMES[0];                           // clairière (default)
}

function chunkKey(cx, cz) { return cx + ',' + cz; }

function buildChunk(cx, cz) {
  const seed = save.worldSeed;
  const lvl  = worldLevel();
  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;
  const rand = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ (seed * 2654435761));

  // Dominant biome sampled at the chunk center — controls tree / rock
  // materials and density. Per-vertex terrain colors will still blend
  // between biomes for smoother regional transitions.
  const centerBiome = biomeAt(originX + CHUNK_SIZE / 2, originZ + CHUNK_SIZE / 2, seed);
  const mats = getBiomeMats(centerBiome);

  const group = new THREE.Group();

  // --- Terrain patch (per-vertex biome-aware colors) ---
  const geo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, CHUNK_SEG, CHUNK_SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i);
    const lz = pos.getZ(i);
    const wx = originX + lx;
    const wz = originZ + lz;
    const h = terrainHeight(wx, wz, seed, lvl);
    pos.setY(i, h);
    const b = biomeAt(wx, wz, seed);
    let cr, cg, cb;
    if (h < -2) {
      [cr, cg, cb] = b.sand;
    } else if (h < 2) {
      [cr, cg, cb] = b.dryGrass;
    } else if (h < 13) {
      // Blend grass toward "rich" based on height within the range
      const f = Math.min(1, (h + 2) / 15);
      cr = b.grass[0] + f * 0.05;
      cg = b.grass[1] + f * 0.05;
      cb = b.grass[2];
    } else {
      [cr, cg, cb] = b.rock;
    }
    colors[i * 3]     = cr;
    colors[i * 3 + 1] = cg;
    colors[i * 3 + 2] = cb;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const terrain = new THREE.Mesh(geo, terrainMat);
  terrain.position.set(originX, 0, originZ);
  group.add(terrain);

  // --- Trees (biome-colored, biome-density) ---
  const nTreesTarget = Math.max(1, Math.round((6 + rand() * (4 + lvl * 2)) * centerBiome.treeDensity));
  const dummy = new THREE.Object3D();
  const foliage = new THREE.InstancedMesh(foliageGeoSrc, mats.foliage, nTreesTarget);
  const trunks  = new THREE.InstancedMesh(trunkGeoSrc,   mats.trunk,   nTreesTarget);
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

  // Apply persisted chopped state — trees the player has cut down already
  // should come back as zero-scale matrices when the chunk is re-streamed.
  const choppedKey = cx + ',' + cz;
  const choppedSet = save.choppedTrees && save.choppedTrees[choppedKey];
  if (choppedSet && choppedSet.length) {
    const zeroMat = new THREE.Matrix4().makeScale(0.0001, 0.0001, 0.0001);
    for (const idx of choppedSet) {
      if (idx < placed) {
        foliage.setMatrixAt(idx, zeroMat);
        trunks.setMatrixAt(idx, zeroMat);
      }
    }
    foliage.instanceMatrix.needsUpdate = true;
    trunks.instanceMatrix.needsUpdate = true;
  }

  // --- Rocks ---
  const nRocks = 3 + Math.floor(rand() * (3 + lvl));
  const rocks = new THREE.InstancedMesh(rockGeoSrc, mats.rock, nRocks);
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
    const flowers = new THREE.InstancedMesh(flowerGeoSrc, mats.flower, nFlowers);
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
  return { group, cx, cz, foliage, trunks, treeCount: placed };
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
  if (typeof clearAllVillages === 'function') clearAllVillages();
  if (typeof clearAllPlants   === 'function') clearAllPlants();
  // Initial ring around current player position
  ensureVisibleChunks();
  // Force biome banner to re-trigger on next frame
  currentBiomeId = null;
}

// =============================================================================
// Water plane — a large semi-transparent disc at sea level that follows the
// player so the world "has" lakes/oceans wherever the terrain dips below it.
// =============================================================================
const WATER_LEVEL = -1.5;
const WATER_SIZE = 900;
let waterMesh = null;
function buildWaterPlane() {
  const geo = new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshLambertMaterial({
    color: 0x2978b8,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = WATER_LEVEL;
  mesh.renderOrder = 1;
  scene.add(mesh);
  return mesh;
}
function updateWater(dt) {
  if (!waterMesh) return;
  waterMesh.position.x = player.pos.x;
  waterMesh.position.z = player.pos.z;
  // Gentle vertical bob to fake waves
  waterMesh.position.y = WATER_LEVEL + Math.sin(performance.now() * 0.001) * 0.05;
}
waterMesh = buildWaterPlane();

// --- Biome tracking: shows a "zone entered" banner (sky/fog handled by updateDayNight) ---
let currentBiomeId = null;
let biomeBannerTimer = 0;
function updateBiomeTracking(dt) {
  const b = biomeAt(player.pos.x, player.pos.z, save.worldSeed);
  if (b.id !== currentBiomeId) {
    currentBiomeId = b.id;
    const el = document.getElementById('biomeBanner');
    if (el) {
      el.textContent = b.name;
      el.classList.remove('hidden');
      el.classList.add('show');
      biomeBannerTimer = 3.5;
    }
  }
  if (biomeBannerTimer > 0) {
    biomeBannerTimer -= dt;
    if (biomeBannerTimer <= 0) {
      const el = document.getElementById('biomeBanner');
      if (el) el.classList.remove('show');
    }
  }
}

// =============================================================================
// Day / night cycle — sun orbit, ambient intensity, sky/fog tinting
// =============================================================================
const DAY_LENGTH = 180; // seconds for a full day/night cycle
let timeOfDay = 0.28;   // start mid-morning
const _tmpSkyColor   = new THREE.Color();
const _tmpFogColor   = new THREE.Color();
const _nightTint     = new THREE.Color(0x0a1426);
const _duskTint      = new THREE.Color(0xff8a40);
const _dawnTint      = new THREE.Color(0xffb478);

function updateDayNight(dt) {
  timeOfDay = (timeOfDay + dt / DAY_LENGTH) % 1;

  // Sun orbits on a tilted plane around the player. Angle 0 = sunrise east,
  // PI/2 = noon above, PI = sunset west, 3*PI/2 = night below.
  const angle = timeOfDay * Math.PI * 2 - Math.PI * 0.5;
  const sunDist = 220;
  sun.position.set(
    player.pos.x + Math.cos(angle) * sunDist,
    player.pos.y + Math.sin(angle) * sunDist + 40,
    player.pos.z + Math.sin(angle * 0.8) * 40,
  );

  // Day factor: 1 = noon, 0 = night
  const dayFactor = Math.max(0, Math.sin(timeOfDay * Math.PI * 2 - Math.PI * 0.5));
  // Dusk / dawn factor: peaks right at sunrise / sunset
  // At angle 0 (sunrise) or PI (sunset) → near horizon
  const horizon = Math.max(0, 1 - Math.abs(Math.sin(angle)) * 3);
  const dusk = horizon * (1 - dayFactor);

  sun.intensity  = 0.2 + dayFactor * 1.0;
  hemi.intensity = 0.15 + dayFactor * 0.55;
  ambient.intensity = 0.08 + dayFactor * 0.22;

  // Base from current biome, then tint with time-of-day
  const biome = biomeAt(player.pos.x, player.pos.z, save.worldSeed);
  _tmpSkyColor.set(biome.sky);
  _tmpFogColor.set(biome.fog);

  // Blend toward night tint as dayFactor drops
  const nightMix = (1 - dayFactor) * 0.8;
  _tmpSkyColor.lerp(_nightTint, nightMix);
  _tmpFogColor.lerp(_nightTint, nightMix);

  // Dusk / dawn warm tint
  if (dusk > 0.05) {
    const warm = timeOfDay < 0.5 ? _dawnTint : _duskTint;
    _tmpSkyColor.lerp(warm, dusk * 0.45);
    _tmpFogColor.lerp(warm, dusk * 0.45);
  }

  scene.background = _tmpSkyColor.clone();
  scene.fog.color = _tmpFogColor;
}

// =============================================================================
// Villages (procedural, deterministic, streamed like chunks)
// =============================================================================
const VILLAGE_GRID = 280;   // world units per village grid cell (smaller -> denser)
const VILLAGE_VIEW = 2;     // 5x5 cells scanned around player
const villages = new Map(); // "vgx,vgz" -> { group, worldX, worldZ, npcs, key } | null

// Shared materials for village props
const wallMat     = new THREE.MeshLambertMaterial({ color: 0xc9a97a });
const roofMat     = new THREE.MeshLambertMaterial({ color: 0x8a3e2a });
const stoneMat    = new THREE.MeshLambertMaterial({ color: 0x777777, flatShading: true });
const wellWoodMat = new THREE.MeshLambertMaterial({ color: 0x5a3a22 });
const npcShirtMat = new THREE.MeshLambertMaterial({ color: 0x3a7a3a });
const npcSkinMat  = new THREE.MeshLambertMaterial({ color: 0xf2c79a });
const markerMat   = new THREE.MeshBasicMaterial({ color: 0xffd23a });

const NPC_NAMES = [
  'Émile',   'Mathilde', 'Gaspard', 'Rosalie', 'Eulalie',
  'Ferdinand', 'Camille', 'Augustin', 'Léontine', 'Joachim',
];

function hasVillageAt(vgx, vgz, seed) {
  // Guaranteed starter village at the world origin
  if (vgx === 0 && vgz === 0) return true;
  const r = hash2(vgx * 91, vgz * 73, seed + 4242);
  return r > 0.42; // ~58% of cells have a village
}

function villagePosForCell(vgx, vgz, seed) {
  const r1 = hash2(vgx * 101 + 3, vgz * 131 + 7, seed + 101);
  const r2 = hash2(vgx * 107 + 13, vgz * 149 + 17, seed + 202);
  const offX = (r1 - 0.5) * VILLAGE_GRID * 0.4;
  const offZ = (r2 - 0.5) * VILLAGE_GRID * 0.4;
  return {
    x: vgx * VILLAGE_GRID + VILLAGE_GRID * 0.5 + offX,
    z: vgz * VILLAGE_GRID + VILLAGE_GRID * 0.5 + offZ,
  };
}

function buildHouse(x, y, z, rot, rand) {
  const g = new THREE.Group();
  const w = 2.8 + rand() * 1.4;
  const d = 2.4 + rand() * 1.2;
  const height = 2 + rand() * 0.6;
  const walls = new THREE.Mesh(new THREE.BoxGeometry(w, height, d), wallMat);
  walls.position.y = height / 2;
  g.add(walls);
  // Door (small darker box on the front)
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 1.2, 0.08),
    new THREE.MeshLambertMaterial({ color: 0x3a2010 }),
  );
  door.position.set(0, 0.6, d / 2 + 0.01);
  g.add(door);
  // Roof — pyramid (cone with 4 segments)
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(Math.max(w, d) * 0.78, 1.4, 4),
    roofMat,
  );
  roof.position.y = height + 0.7;
  roof.rotation.y = Math.PI / 4;
  g.add(roof);
  g.position.set(x, y, z);
  g.rotation.y = rot;
  return g;
}

function buildWell(x, y, z) {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 0.9, 0.8, 10),
    stoneMat,
  );
  ring.position.y = 0.4;
  g.add(ring);
  // Posts + roof
  const postGeo = new THREE.CylinderGeometry(0.08, 0.08, 1.6, 5);
  for (const dx of [-0.7, 0.7]) {
    const post = new THREE.Mesh(postGeo, wellWoodMat);
    post.position.set(dx, 1.2, 0);
    g.add(post);
  }
  const wroof = new THREE.Mesh(
    new THREE.ConeGeometry(1.1, 0.5, 4),
    roofMat,
  );
  wroof.position.y = 2.3;
  wroof.rotation.y = Math.PI / 4;
  g.add(wroof);
  g.position.set(x, y, z);
  return g;
}

function buildNPC(x, y, z, name, rand) {
  const g = new THREE.Group();
  // Body (slightly shorter than the player)
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.24, 1.1, 8),
    npcShirtMat,
  );
  body.position.y = 0.7;
  g.add(body);
  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), npcSkinMat);
  head.position.y = 1.45;
  g.add(head);
  // Simple hat (triangle cone)
  const hat = new THREE.Mesh(
    new THREE.ConeGeometry(0.24, 0.3, 8),
    new THREE.MeshLambertMaterial({ color: 0x4a2810 }),
  );
  hat.position.y = 1.68;
  g.add(hat);

  g.position.set(x, y, z);
  g.rotation.y = rand() * Math.PI * 2;
  g.userData = { kind: 'npc', name, hasQuest: false, questId: null, offered: false };
  return g;
}

// Gold "!" marker — NPC has a quest to OFFER
function addQuestMarker(npcGroup) {
  const marker = new THREE.Group();
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.42, 0.10), markerMat);
  bar.position.y = 0.0;
  const dot = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 0.10), markerMat);
  dot.position.y = -0.32;
  marker.add(bar, dot);
  marker.position.y = 2.2;
  marker.userData.isQuestMarker = true;
  npcGroup.add(marker);
  npcGroup.userData.questMarker = marker;
}

// Cyan "?" marker — NPC can COMPLETE a ready quest (turn-in)
const turnInMat = new THREE.MeshBasicMaterial({ color: 0x6ae8ff });
function addTurnInMarker(npcGroup) {
  const marker = new THREE.Group();
  // Question mark: curve on top (arc made of a few small cubes) + dot
  // Simpler: a small sphere at the top + a vertical bar tapering to a dot
  const top = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), turnInMat);
  top.position.y = 0.12;
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.08), turnInMat);
  bar.position.y = -0.06;
  const dot = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), turnInMat);
  dot.position.y = -0.28;
  marker.add(top, bar, dot);
  marker.position.y = 2.2;
  marker.userData.isQuestMarker = true;
  marker.userData.turnIn = true;
  npcGroup.add(marker);
  npcGroup.userData.questMarker = marker;
}

function buildVillage(worldX, worldZ, vgKey) {
  const seed = save.worldSeed;
  const lvl  = worldLevel();
  const rand = mulberry32(
    (vgKey.charCodeAt(0) * 1000003) ^ (seed * 2654435761) ^ vgKey.length,
  );

  const centerY = terrainHeight(worldX, worldZ, seed, lvl);
  const group = new THREE.Group();
  group.position.set(0, 0, 0);

  // Central well
  group.add(buildWell(worldX, centerY, worldZ));

  // Houses arranged in a rough circle around the well
  const nHouses = 4 + Math.floor(rand() * 3);
  for (let i = 0; i < nHouses; i++) {
    const angle = (i / nHouses) * Math.PI * 2 + rand() * 0.4;
    const r = 6.5 + rand() * 3;
    const hx = worldX + Math.cos(angle) * r;
    const hz = worldZ + Math.sin(angle) * r;
    const hy = terrainHeight(hx, hz, seed, lvl);
    group.add(buildHouse(hx, hy, hz, angle + Math.PI, rand));
  }

  // NPCs walking (well, standing) around the square
  const nNPCs = 2 + Math.floor(rand() * 2);
  const npcs = [];
  for (let i = 0; i < nNPCs; i++) {
    const r = 1.5 + rand() * 4;
    const a = rand() * Math.PI * 2;
    const nx = worldX + Math.cos(a) * r;
    const nz = worldZ + Math.sin(a) * r;
    const ny = terrainHeight(nx, nz, seed, lvl);
    const name = NPC_NAMES[Math.floor(rand() * NPC_NAMES.length)];
    const npc = buildNPC(nx, ny, nz, name, rand);
    npc.userData.vgKey = vgKey; // remember which village this NPC belongs to
    // First NPC in each village offers a quest
    if (i === 0) {
      npc.userData.hasQuest = true;
      npc.userData.questId = pickQuestIdFor(vgKey);
      addQuestMarker(npc);
    }
    group.add(npc);
    npcs.push(npc);
  }

  worldGroup.add(group);
  return { group, worldX, worldZ, npcs, key: vgKey };
}

function disposeVillage(v) {
  if (!v) return;
  worldGroup.remove(v.group);
  v.group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    // materials are shared — do not dispose
  });
}

function ensureVillages() {
  const pvx = Math.floor(player.pos.x / VILLAGE_GRID);
  const pvz = Math.floor(player.pos.z / VILLAGE_GRID);
  for (let dx = -VILLAGE_VIEW; dx <= VILLAGE_VIEW; dx++) {
    for (let dz = -VILLAGE_VIEW; dz <= VILLAGE_VIEW; dz++) {
      const vgx = pvx + dx;
      const vgz = pvz + dz;
      const key = vgx + ',' + vgz;
      if (villages.has(key)) continue;
      if (hasVillageAt(vgx, vgz, save.worldSeed)) {
        const { x, z } = villagePosForCell(vgx, vgz, save.worldSeed);
        villages.set(key, buildVillage(x, z, key));
      } else {
        villages.set(key, null);
      }
    }
  }
  // Dispose far cells (hysteresis)
  for (const [key, v] of villages) {
    const [vgx, vgz] = key.split(',').map(Number);
    if (Math.abs(vgx - pvx) > VILLAGE_VIEW + 1 || Math.abs(vgz - pvz) > VILLAGE_VIEW + 1) {
      disposeVillage(v);
      villages.delete(key);
    }
  }
}

function clearAllVillages() {
  for (const [, v] of villages) disposeVillage(v);
  villages.clear();
}

// List nearby villages (for the minimap)
function getNearbyVillages() {
  const out = [];
  for (const [, v] of villages) {
    if (v) out.push({ x: v.worldX, z: v.worldZ, type: 'village', hasQuest: v.npcs.some(n => n.userData.hasQuest && !n.userData.offered) });
  }
  return out;
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
  yaw: 0,      // camera yaw — driven by look joystick / mouse drag
  meshYaw: 0,  // character facing — lerps to match the walking direction
  pitch: 0.15,
  onGround: false,
  swimming: false,
  group: new THREE.Group(),
  axeSwing: 0, // seconds remaining on the chop animation, counts down to 0
};

// Virtual input (joystick / touch buttons). Shared with desktop keys.
const touchInput = {
  moveX: 0,     // -1..1 strafe
  moveY: 0,     // -1..1 forward(+)/backward(-)
  jump:  false, // pulse — consumed once
  sprint: false,
  lookX: 0,     // -1..1 yaw delta per second (scaled)
  lookY: 0,     // -1..1 pitch delta per second (scaled)
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

  // Materials — MeshStandardMaterial for softer, nicer shading
  const beltMat = new THREE.MeshStandardMaterial({ color: 0x4a2a12, roughness: 0.75 });
  const buckleMat = new THREE.MeshStandardMaterial({ color: 0xd4a952, metalness: 0.7, roughness: 0.35 });
  const hairMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.9 });

  // The whole character is built with its "front" on -Z (walking direction
  // at yaw=0), so the 3rd-person camera (positioned behind on +Z) sees the
  // back of the character. All face / belt / satchel features live at
  // negative z.
  // Higher subdivisions so every curve is smooth.

  // --- Legs — lathed profiles so the thigh + shin have a real taper ---
  // Thigh: wide at the hip, narrows toward the knee. Shin: narrow at
  // the knee, bulges at the calf, narrow at the ankle.
  const thighProfile = [
    new THREE.Vector2(0.00, 0.00),   // knee top
    new THREE.Vector2(0.14, 0.02),
    new THREE.Vector2(0.16, 0.12),   // thigh belly (fat lumberjack)
    new THREE.Vector2(0.18, 0.22),   // widest
    new THREE.Vector2(0.17, 0.32),
    new THREE.Vector2(0.14, 0.40),   // hip top narrowing
    new THREE.Vector2(0.00, 0.40),
  ];
  const shinProfile = [
    new THREE.Vector2(0.00, 0.00),   // ankle bottom
    new THREE.Vector2(0.09, 0.02),   // ankle
    new THREE.Vector2(0.11, 0.08),
    new THREE.Vector2(0.13, 0.18),   // calf widest
    new THREE.Vector2(0.11, 0.28),
    new THREE.Vector2(0.10, 0.36),
    new THREE.Vector2(0.10, 0.40),   // knee bottom
    new THREE.Vector2(0.00, 0.40),
  ];
  const thighGeo = new THREE.LatheGeometry(thighProfile, 20);
  thighGeo.computeVertexNormals();
  // Shift so y=0 is the TOP of the thigh (hip pivot), and the leg hangs down
  thighGeo.translate(0, -0.40, 0);
  const shinGeo = new THREE.LatheGeometry(shinProfile, 20);
  shinGeo.computeVertexNormals();
  shinGeo.translate(0, -0.40, 0);
  const bootGeo  = new THREE.IcosahedronGeometry(0.23, 3);
  const kneeCapGeo = new THREE.SphereGeometry(0.11, 14, 10);
  const bootSoleGeo = new THREE.BoxGeometry(0.3, 0.05, 0.42);
  const bootLaceGeo = new THREE.BoxGeometry(0.04, 0.015, 0.04);
  const soleMat = new THREE.MeshStandardMaterial({ color: 0x1a110a, roughness: 0.95 });
  const laceMat = new THREE.MeshStandardMaterial({ color: 0xd4b070, roughness: 0.7 });

  function buildLeg(x) {
    // Hip pivot — top of the thigh, attached to the pelvis
    const hip = new THREE.Group();
    hip.position.set(x, 0.85, 0);

    // Thigh lathe — already pre-translated so y=0 is the hip pivot and
    // y=-0.40 is the knee
    const thigh = new THREE.Mesh(thighGeo, pantsMat);
    hip.add(thigh);

    // Knee pivot at the bottom of the thigh
    const knee = new THREE.Group();
    knee.position.y = -0.40;
    hip.add(knee);

    // Kneecap — small pants-colored sphere that fills the seam when bent
    const kneeCap = new THREE.Mesh(kneeCapGeo, pantsMat);
    knee.add(kneeCap);

    // Shin lathe — y=0 is the knee, y=-0.40 is the ankle
    const shin = new THREE.Mesh(shinGeo, pantsMat);
    knee.add(shin);

    // Ankle pivot at the bottom of the shin
    const ankle = new THREE.Group();
    ankle.position.y = -0.40;
    knee.add(ankle);

    // Foot (boot) + a darker flat sole underneath + 3 laces on top
    const foot = new THREE.Mesh(bootGeo, bootsMat);
    foot.scale.set(1.2, 0.7, 1.65);
    foot.position.set(0, 0, -0.06);
    ankle.add(foot);
    const sole = new THREE.Mesh(bootSoleGeo, soleMat);
    sole.position.set(0, -0.13, -0.06);
    ankle.add(sole);
    for (let i = 0; i < 3; i++) {
      const lace = new THREE.Mesh(bootLaceGeo, laceMat);
      lace.position.set(0, 0.07 - i * 0.04, -0.14);
      ankle.add(lace);
    }

    return { hip, knee, ankle, foot };
  }
  const legL = buildLeg(-0.14);
  const legR = buildLeg( 0.14);
  group.add(legL.hip, legR.hip);

  // --- Torso — single LatheGeometry with a true bedonnant profile ---
  // Instead of stitching a capsule + chest/belly bumps together we define
  // a 2D profile curve in (radius, y) and revolve it around the Y axis.
  // This gives a full silhouette with hips, beer belly, chest and a
  // tapered neck base — much less cylindrical than any capsule stack.
  const torsoProfile = [
    new THREE.Vector2(0.00, 0.00),  // bottom pinch (waist base)
    new THREE.Vector2(0.30, 0.00),
    new THREE.Vector2(0.34, 0.08),  // belt line
    new THREE.Vector2(0.40, 0.16),  // belly starts
    new THREE.Vector2(0.44, 0.26),  // belly widest (peak of the pot-belly)
    new THREE.Vector2(0.42, 0.36),
    new THREE.Vector2(0.36, 0.48),  // chest bottom
    new THREE.Vector2(0.38, 0.58),  // pec widest
    new THREE.Vector2(0.36, 0.68),
    new THREE.Vector2(0.30, 0.78),  // upper chest narrowing
    new THREE.Vector2(0.22, 0.86),  // shoulder pinch
    new THREE.Vector2(0.18, 0.92),  // neck base
    new THREE.Vector2(0.15, 0.95),
    new THREE.Vector2(0.00, 0.95),  // close the top
  ];
  const torsoLatheGeo = new THREE.LatheGeometry(torsoProfile, 24);
  torsoLatheGeo.computeVertexNormals();
  const torso = new THREE.Mesh(torsoLatheGeo, shirtMat);
  torso.position.y = 0.85; // so y=0 in the profile aligns with the belt
  group.add(torso);

  // Belt (thin torus) + buckle at front (-z)
  const beltGeo = new THREE.TorusGeometry(0.35, 0.055, 12, 28);
  const belt = new THREE.Mesh(beltGeo, beltMat);
  belt.rotation.x = Math.PI / 2;
  belt.position.y = 0.86;
  group.add(belt);
  const buckle = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.08, 0.04),
    buckleMat,
  );
  buckle.position.set(0, 0.86, -0.35);
  group.add(buckle);

  // Collar to soften the neck
  const collar = new THREE.Mesh(
    new THREE.TorusGeometry(0.24, 0.055, 10, 22),
    shirtMat,
  );
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 1.62;
  group.add(collar);

  // --- Arms — lathed profiles so the biceps / forearm taper properly ---
  // Upper arm: shoulder (wide) → biceps belly → elbow (narrow)
  const upperArmProfile = [
    new THREE.Vector2(0.00, 0.00),
    new THREE.Vector2(0.09, 0.02),
    new THREE.Vector2(0.11, 0.10),  // biceps belly
    new THREE.Vector2(0.12, 0.18),  // widest
    new THREE.Vector2(0.11, 0.26),
    new THREE.Vector2(0.09, 0.33),  // elbow
    new THREE.Vector2(0.00, 0.33),
  ];
  // Forearm: elbow (narrow) → forearm belly → wrist (narrow)
  const forearmProfile = [
    new THREE.Vector2(0.00, 0.00),  // wrist
    new THREE.Vector2(0.08, 0.02),
    new THREE.Vector2(0.10, 0.10),  // forearm belly
    new THREE.Vector2(0.09, 0.20),
    new THREE.Vector2(0.085, 0.30), // elbow
    new THREE.Vector2(0.00, 0.30),
  ];
  const upperArmGeo = new THREE.LatheGeometry(upperArmProfile, 16);
  upperArmGeo.computeVertexNormals();
  upperArmGeo.translate(0, -0.33, 0);
  const forearmGeo = new THREE.LatheGeometry(forearmProfile, 16);
  forearmGeo.computeVertexNormals();
  forearmGeo.translate(0, -0.30, 0);
  const palmGeo     = new THREE.SphereGeometry(0.1, 18, 14);
  const fingerGeo   = new THREE.CapsuleGeometry(0.022, 0.05, 6, 10);
  const thumbGeo    = new THREE.CapsuleGeometry(0.025, 0.04, 6, 10);
  const shoulderPadGeo = new THREE.SphereGeometry(0.18, 18, 14, 0, Math.PI * 2, 0, Math.PI / 2);

  function buildHand(mirrorX) {
    // Palm + 4 fingers curled slightly forward + opposable thumb
    const h = new THREE.Group();
    const palm = new THREE.Mesh(palmGeo, skinMat);
    palm.scale.set(1, 0.65, 1.25);
    h.add(palm);
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Mesh(fingerGeo, skinMat);
      // Fingers extend forward (-Z) and fan out slightly along X
      f.rotation.x = Math.PI / 2 - 0.25;
      f.position.set(-0.055 + i * 0.032, 0, -0.095);
      h.add(f);
    }
    const thumb = new THREE.Mesh(thumbGeo, skinMat);
    thumb.rotation.set(Math.PI / 3, 0, (mirrorX ? -1 : 1) * (Math.PI / 3));
    thumb.position.set((mirrorX ? -1 : 1) * 0.085, 0.02, -0.02);
    h.add(thumb);
    return h;
  }

  function buildArm(x, zTilt, mirrorX) {
    // Shoulder pivot
    const shoulder = new THREE.Group();
    shoulder.position.set(x, 1.55, 0);
    shoulder.rotation.z = zTilt;

    // Shoulder pad (rounded dome) — hides the seam where the arm meets the
    // torso and adds visual weight to the upper body.
    const pad = new THREE.Mesh(shoulderPadGeo, shirtMat);
    pad.position.y = 0.02;
    pad.scale.set(1.05, 0.7, 1.1);
    shoulder.add(pad);

    // Upper arm lathe — y=0 is the shoulder, y=-0.33 is the elbow
    const upperArm = new THREE.Mesh(upperArmGeo, shirtMat);
    shoulder.add(upperArm);

    // Elbow pivot at the bottom of the upper arm
    const elbow = new THREE.Group();
    elbow.position.y = -0.33;
    shoulder.add(elbow);

    // Elbow cap (small sphere) to fill the seam when bent
    const elbowCap = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 14, 10),
      shirtMat,
    );
    elbow.add(elbowCap);

    // Forearm lathe — y=0 is the elbow, y=-0.30 is the wrist
    const forearm = new THREE.Mesh(forearmGeo, shirtMat);
    elbow.add(forearm);

    // Wrist pivot at the bottom of the forearm
    const wrist = new THREE.Group();
    wrist.position.y = -0.30;
    elbow.add(wrist);

    // Hand assembly
    const hand = buildHand(mirrorX);
    hand.position.y = -0.06;
    wrist.add(hand);

    return { shoulder, elbow, wrist, hand };
  }
  const armL = buildArm(-0.40,  0.22, true);
  const armR = buildArm( 0.40, -0.22, false);
  group.add(armL.shoulder, armR.shoulder);

  // --- Neck + head (neck pivot at the collar, head pivot stacked on top) ---
  // The neck lives just above the collar; the headPivot sits on the neck so
  // we can animate them independently (neck for spine motion, head for nods).
  const neck = new THREE.Group();
  neck.position.y = 1.58;
  group.add(neck);
  const headPivot = new THREE.Group();
  headPivot.position.y = 0.14; // world y ≈ 1.72
  neck.add(headPivot);
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 32, 26),
    skinMat,
  );
  head.position.y = 0.18;
  headPivot.add(head);

  // Big bushy LONG beard — wrapped in a pivot group so we can swing it in
  // the wind while surfing. Pivot at the chin so the beard flares from
  // there when rotated.
  const beardPivot = new THREE.Group();
  beardPivot.position.set(0, 0.02, -0.05); // under the chin
  headPivot.add(beardPivot);
  const beardCore = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 26, 20, 0, Math.PI * 2, Math.PI / 3, Math.PI),
    hairMat,
  );
  // Much longer beard: y scale bumped from 1.65 to 2.6 and the whole thing
  // pushed down a bit so it hangs from the chin
  beardCore.scale.set(1.25, 2.6, 1.18);
  beardCore.position.set(0, -0.22, 0);
  beardPivot.add(beardCore);
  // Side fluff — longer too, hanging down the sides of the jaw
  for (const sx of [-0.2, 0.2]) {
    const side = new THREE.Mesh(new THREE.SphereGeometry(0.17, 18, 14), hairMat);
    side.scale.set(0.95, 2.0, 0.95);
    side.position.set(sx, -0.18, 0.02);
    beardPivot.add(side);
  }
  // Pointed beard tip — extends the bottom even further
  const beardTip = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 14, 10),
    hairMat,
  );
  beardTip.scale.set(0.85, 1.4, 0.9);
  beardTip.position.set(0, -0.58, 0.02);
  beardPivot.add(beardTip);
  // Moustache
  const moustache = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), hairMat);
  moustache.scale.set(1.45, 0.5, 0.7);
  moustache.position.set(0, 0.1, -0.22);
  headPivot.add(moustache);

  // Eyes — sclera (white) + iris (dark) for a bit of extra detail
  const scleraGeo = new THREE.SphereGeometry(0.036, 14, 12);
  const irisGeo   = new THREE.SphereGeometry(0.018, 12, 10);
  const scleraMat = new THREE.MeshStandardMaterial({ color: 0xf5efe3, roughness: 0.4 });
  const irisMat   = new THREE.MeshStandardMaterial({ color: 0x224a6a, roughness: 0.35 });
  for (const ex of [-0.09, 0.09]) {
    const sclera = new THREE.Mesh(scleraGeo, scleraMat);
    sclera.position.set(ex, 0.18, -0.235);
    headPivot.add(sclera);
    const iris = new THREE.Mesh(irisGeo, irisMat);
    iris.position.set(ex, 0.18, -0.265);
    headPivot.add(iris);
    // Eyebrow — dark thin box above the eye
    const brow = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.022, 0.03),
      hairMat,
    );
    brow.position.set(ex, 0.235, -0.24);
    brow.rotation.z = ex < 0 ? 0.12 : -0.12;
    headPivot.add(brow);
  }

  // Nose — small skin-colored sphere below the eyes
  const nose = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 14, 12),
    skinMat,
  );
  nose.scale.set(0.9, 0.9, 1.2);
  nose.position.set(0, 0.11, -0.27);
  headPivot.add(nose);

  // Ears — small disc-like spheres on both sides of the head
  for (const ex of [-0.27, 0.27]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), skinMat);
    ear.scale.set(0.6, 1.1, 1.2);
    ear.position.set(ex, 0.12, -0.02);
    headPivot.add(ear);
  }

  // Neck cylinder (skin) between the collar and the head so the seam is
  // properly filled in.
  const neckGeo = new THREE.CylinderGeometry(0.13, 0.14, 0.18, 14);
  const neckMesh = new THREE.Mesh(neckGeo, skinMat);
  neckMesh.position.y = -0.06;
  neck.add(neckMesh);

  // --- Cap — dome + brim at the front ---
  const capCrown = new THREE.Mesh(
    new THREE.SphereGeometry(0.3, 26, 18, 0, Math.PI * 2, 0, Math.PI / 2),
    capMat,
  );
  capCrown.position.y = 0.28;
  headPivot.add(capCrown);
  // Brim: thin flattened box extending forward from the crown
  const brim = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.04, 0.22),
    capMat,
  );
  brim.position.set(0, 0.24, -0.22);
  headPivot.add(brim);
  // Round the brim corners by adding two small cylinders at the ends
  const brimSideGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.22, 8);
  brimSideGeo.rotateX(Math.PI / 2);
  for (const sx of [-0.2, 0.2]) {
    const side = new THREE.Mesh(brimSideGeo, capMat);
    side.position.set(sx, 0.24, -0.22);
    headPivot.add(side);
  }

  // --- Satchel (left hip, front -z) ---
  const strap = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 1.0, 0.04),
    satchelMat,
  );
  strap.position.set(0.04, 1.2, -0.2);
  strap.rotation.z = -0.42;
  group.add(strap);
  const pouch = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.22, 2),
    satchelMat,
  );
  pouch.scale.set(1.7, 1.3, 0.85);
  pouch.position.set(-0.36, 0.9, -0.12);
  pouch.rotation.y = -0.35;
  group.add(pouch);
  const flap = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    satchelMat,
  );
  flap.scale.set(1.6, 0.55, 0.75);
  flap.position.set(-0.36, 1.02, -0.14);
  flap.rotation.y = -0.35;
  group.add(flap);

  // Berries peeking out of the pouch (front side)
  const berryGeo = new THREE.SphereGeometry(0.075, 14, 12);
  const berrySpots = [
    [-0.28, 1.06, -0.19],
    [-0.36, 1.09, -0.24],
    [-0.44, 1.06, -0.19],
    [-0.32, 1.11, -0.14],
    [-0.40, 1.10, -0.14],
  ];
  for (const [x, y, z] of berrySpots) {
    const b = new THREE.Mesh(berryGeo, berryMat);
    b.position.set(x, y, z);
    group.add(b);
  }

  // --- Two axes: one on the back (static), one in the right hand (hidden
  //     until the chop animation plays) ---
  const woodMat  = new THREE.MeshStandardMaterial({ color: 0x7a4a22, roughness: 0.85 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ab, metalness: 0.8, roughness: 0.3 });
  const darkSteelMat = new THREE.MeshStandardMaterial({ color: 0x5a6068, metalness: 0.7, roughness: 0.45 });

  function makeAxe() {
    const g = new THREE.Group();
    const handle = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 1.05, 8, 16), woodMat);
    g.add(handle);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.22, 10), darkSteelMat);
    grip.position.y = -0.55;
    g.add(grip);
    const headBody = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.2, 0.08), steelMat);
    headBody.position.y = 0.58;
    g.add(headBody);
    const bladeGeo = new THREE.CylinderGeometry(0.14, 0.02, 0.02, 12, 1, false, -Math.PI * 0.35, Math.PI * 0.7);
    const blade = new THREE.Mesh(bladeGeo, steelMat);
    blade.rotation.z = Math.PI / 2;
    blade.position.set(0.11, 0.58, 0);
    g.add(blade);
    const poll = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.07), darkSteelMat);
    poll.position.set(-0.1, 0.58, 0);
    g.add(poll);
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.1, 6), darkSteelMat);
    pin.position.y = 0.58;
    pin.rotation.z = Math.PI / 2;
    g.add(pin);
    return g;
  }

  // Back axe — sits diagonally on the lumberjack's back (+Z)
  const backAxe = makeAxe();
  backAxe.position.set(-0.05, 1.22, 0.42);
  backAxe.rotation.set(-0.08, 0, Math.PI * 0.22);
  group.add(backAxe);

  // Hand axe — child of the right wrist, hidden until the chop animation
  const handAxe = makeAxe();
  // The wrist y origin is at the base of the forearm; we want the handle
  // in the fist so the blade is pointing upward + forward while at rest.
  handAxe.position.set(0, -0.25, 0);
  handAxe.rotation.set(-0.4, 0, 0);
  handAxe.visible = false;
  armR.wrist.add(handAxe);

  // --- Surfboard — appears under the feet when the player is swimming ---
  const boardMat = new THREE.MeshStandardMaterial({ color: 0xf2d49a, roughness: 0.55 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0xc44a4a, roughness: 0.6 });
  const surfboard = new THREE.Group();
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.08, 2.0), boardMat);
  board.position.y = 0;
  surfboard.add(board);
  // Round the tip by adding a small tapered cylinder at the front
  const boardTip = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.35, 0.4, 12, 1, false, 0, Math.PI), boardMat);
  boardTip.rotation.x = Math.PI / 2;
  boardTip.rotation.z = Math.PI;
  boardTip.position.set(0, 0, -1.1);
  surfboard.add(boardTip);
  // Red center stripe for flavor
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.09, 1.8), stripeMat);
  stripe.position.y = 0.01;
  surfboard.add(stripe);
  // Surfboard sits just below the feet so its top aligns with y=0 of the
  // group (the feet plane) — half its thickness (0.04) below.
  surfboard.position.y = -0.04;
  surfboard.visible = false;
  group.add(surfboard);

  return { legL, legR, armL, armR, torso, neck, headPivot, beardPivot, backAxe, handAxe, surfboard };
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

  // Apply look joystick (mobile) to yaw / pitch — low sensitivity so the
  // camera feels stable on the thumb.
  if (touchInput.lookX || touchInput.lookY) {
    player.yaw   -= touchInput.lookX * dt * 1.4;
    player.pitch -= touchInput.lookY * dt * 1.1;
    player.pitch = Math.max(-0.6, Math.min(1.0, player.pitch));
  }

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

  // Detect if the player is in water — terrain below water level at their
  // current (x, z). When swimming, gravity is dampened and movement is
  // slower but still possible in all 4 directions plus vertical via Space/Jump.
  const groundH = terrainHeight(player.pos.x, player.pos.z, seed, lvl);
  const waterSurface = WATER_LEVEL - 0.2;
  const playerSwimming = groundH < waterSurface && player.pos.y - PLAYER_HEIGHT * 0.5 < waterSurface + 0.3;
  player.swimming = playerSwimming;

  if (playerSwimming) {
    // Strong water drag — swimming is clearly slower than walking
    player.vel.x *= 0.55;
    player.vel.z *= 0.55;
    // Buoyancy target: the player stands ON TOP of the 0.08-thick
    // surfboard, which is floating ON the water surface. So the feet
    // sit at waterSurface + 0.08 and the pelvis is half a body-height
    // above that.
    const targetY = waterSurface + 0.08 + PLAYER_HEIGHT * 0.5;
    player.vel.y += (targetY - player.pos.y) * 4 * dt * 10;
    player.vel.y *= 0.82;
    // Space / jump = paddle up
    if (keys['Space'] || keys['KeyJ'] || touchInput.jump) {
      player.vel.y += 10 * dt;
    }
    touchInput.jump = false;
  } else {
    // Gravity
    player.vel.y -= GRAVITY * dt;
    // Jump
    if (player.onGround && (keys['Space'] || keys['KeyJ'] || touchInput.jump)) {
      player.vel.y = PLAYER_JUMP;
      player.onGround = false;
    }
    touchInput.jump = false; // consume one-shot
  }

  player.pos.addScaledVector(player.vel, dt);

  // Ground collision via terrain heightfield
  // When swimming, the "floor" is the water floor so the player can dive
  // all the way to the bottom if they want (Space pushes them back up).
  const footY = groundH + PLAYER_HEIGHT * 0.5;
  if (player.pos.y < footY) {
    player.pos.y = footY;
    if (player.vel.y < 0) player.vel.y = 0;
    player.onGround = !playerSwimming;
  } else {
    player.onGround = !playerSwimming && (player.pos.y - footY < 0.05);
  }

  // No world bounds — the world streams in as the player moves

  // Update mesh position
  player.group.position.copy(player.pos);
  player.group.position.y -= PLAYER_HEIGHT * 0.5; // mesh is modelled with feet at 0

  // --- Mesh facing: rotate the character toward the walking direction ---
  // Camera yaw (player.yaw) is independent of the character facing so the
  // look joystick / mouse drag can orbit freely while the body turns
  // smoothly to match whatever direction you're actually moving in.
  const horizSpeed = Math.hypot(player.vel.x, player.vel.z);
  if (horizSpeed > 0.2) {
    const desired = Math.atan2(-player.vel.x, -player.vel.z);
    // Shortest-path delta (wrap to [-π, π])
    let diff = desired - player.meshYaw;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    player.meshYaw += diff * Math.min(1, dt * 12);
  } else if (player.swimming) {
    // While surfing, keep facing the camera yaw so it reads as "looking ahead"
    let diff = player.yaw - player.meshYaw;
    while (diff >  Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    player.meshYaw += diff * Math.min(1, dt * 5);
  }
  player.group.rotation.y = player.meshYaw;

  // --- Walk / swim animation: full skeletal chain ---
  if (player.swimming) {
    player.walkPhase += dt * 2.5; // slow constant paddle
  } else if (horizSpeed > 0.1) {
    player.walkPhase += dt * (5 + horizSpeed * 0.6);
  } else {
    player.walkPhase *= 0.88;
  }
  const moving = (player.swimming || horizSpeed > 0.1) ? 1 : 0;
  const sinP  = Math.sin(player.walkPhase);
  const sinP2 = Math.sin(player.walkPhase * 2);
  // Hip (thigh) swing
  const hipSwing = sinP * 1.15 * moving;
  // Knee bends when the leg is behind (foot lifting up)
  const kneeBendL = Math.max(0,  sinP) * 1.3 * moving;
  const kneeBendR = Math.max(0, -sinP) * 1.3 * moving;
  // Ankle flex keeps the foot level-ish during knee bend
  const ankleFlexL = -kneeBendL * 0.5;
  const ankleFlexR = -kneeBendR * 0.5;

  // Legs
  player.parts.legL.hip.rotation.x   =  hipSwing;
  player.parts.legR.hip.rotation.x   = -hipSwing;
  player.parts.legL.knee.rotation.x  =  kneeBendL;
  player.parts.legR.knee.rotation.x  =  kneeBendR;
  player.parts.legL.ankle.rotation.x =  ankleFlexL;
  player.parts.legR.ankle.rotation.x =  ankleFlexR;

  // Arms counter-swing with extra amplitude
  const shoulderSwing = -sinP * 1.0 * moving;
  // Elbow bends when the arm is forward (natural walking motion)
  const elbowBendL = Math.max(0, -sinP) * 0.6 * moving + 0.2;
  const elbowBendR = Math.max(0,  sinP) * 0.6 * moving + 0.2;

  player.parts.armL.shoulder.rotation.x =  shoulderSwing;
  player.parts.armR.shoulder.rotation.x = -shoulderSwing;
  // Keep the natural resting outward tilt and pulse it slightly
  player.parts.armL.shoulder.rotation.z =  0.22 + Math.abs(sinP) * 0.05 * moving;
  player.parts.armR.shoulder.rotation.z = -0.22 - Math.abs(sinP) * 0.05 * moving;
  // Elbow bends
  // Elbow flexes naturally (positive X rotation brings the forearm
  // forward toward the chest, which is the correct anatomical bend)
  player.parts.armL.elbow.rotation.x = elbowBendL;
  player.parts.armR.elbow.rotation.x = elbowBendR;
  // Wrist follows with a small counter-rotation
  player.parts.armL.wrist.rotation.x = -elbowBendL * 0.25;
  player.parts.armR.wrist.rotation.x = -elbowBendR * 0.25;

  // Torso counter-rotates around Y (hips go left → shoulders go right)
  player.parts.torso.rotation.y = -sinP * 0.25 * moving;
  player.parts.torso.rotation.z = sinP2 * 0.1 * moving;
  player.parts.torso.rotation.x = -horizSpeed * 0.015;
  // Neck follows the torso counter-rotation but less
  player.parts.neck.rotation.y = sinP * 0.18 * moving;
  player.parts.neck.rotation.x =  horizSpeed * 0.01;
  // Head nods gently with the gait
  player.parts.headPivot.rotation.x = -Math.abs(sinP2) * 0.05 * moving;
  // Whole-body bob up/down (2× phase since each step contributes a bob)
  player.group.position.y += Math.abs(sinP2) * 0.06 * moving;

  // --- Idle rest pose: right hand on the hip, left arm forward ---
  // Plus breathing, head scanning, and ambient micro-motion.
  if (!moving && !player.swimming && player.axeSwing <= 0) {
    const a = player.parts;
    const tSec = performance.now() * 0.001;
    // Right arm — hand on the hip (arm tucked inward, elbow bent forward)
    a.armR.shoulder.rotation.x = THREE.MathUtils.lerp(a.armR.shoulder.rotation.x, 0.15,  0.18);
    a.armR.shoulder.rotation.z = THREE.MathUtils.lerp(a.armR.shoulder.rotation.z, -0.55, 0.18);
    a.armR.elbow.rotation.x    = THREE.MathUtils.lerp(a.armR.elbow.rotation.x,    1.55,  0.18);
    a.armR.wrist.rotation.x    = THREE.MathUtils.lerp(a.armR.wrist.rotation.x,    0,     0.18);
    // Left arm — extended forward (like he's pointing at something ahead)
    a.armL.shoulder.rotation.x = THREE.MathUtils.lerp(a.armL.shoulder.rotation.x, 0.55,  0.18);
    a.armL.shoulder.rotation.z = THREE.MathUtils.lerp(a.armL.shoulder.rotation.z, 0.3,   0.18);
    a.armL.elbow.rotation.x    = THREE.MathUtils.lerp(a.armL.elbow.rotation.x,    0.4,   0.18);
    a.armL.wrist.rotation.x    = THREE.MathUtils.lerp(a.armL.wrist.rotation.x,    0,     0.18);
    // Breathing — subtle torso + chest expansion
    const breath = Math.sin(tSec * 2.3) * 0.02;
    a.torso.scale.set(1, 1 + breath, 1);
    // Head scanning — slow look-around
    const scan = Math.sin(tSec * 0.45);
    a.neck.rotation.y = scan * 0.22;
    a.headPivot.rotation.y = scan * 0.12;
    a.headPivot.rotation.x = Math.sin(tSec * 0.9) * 0.04;
    // Small idle bob
    player.group.position.y += Math.sin(tSec * 2.3) * 0.01;
  } else {
    // Reset the torso breathing scale outside the idle state
    player.parts.torso.scale.set(1, 1, 1);
  }

  // --- Swimming → standing on a surfboard + beard in the wind ---
  if (player.swimming) {
    player.parts.surfboard.visible = true;
    player.parts.legL.hip.rotation.x = 0;
    player.parts.legR.hip.rotation.x = 0;
    player.parts.legL.knee.rotation.x = 0.25;
    player.parts.legR.knee.rotation.x = 0.25;
    player.parts.legL.ankle.rotation.x = -0.1;
    player.parts.legR.ankle.rotation.x = -0.1;
    // Arms stretched out WIDE like a surfer balancing, both visible
    // against the silhouette instead of hanging down the sides.
    player.parts.armL.shoulder.rotation.x = 0.15;
    player.parts.armR.shoulder.rotation.x = 0.15;
    player.parts.armL.shoulder.rotation.z =  1.25; // arm up + out to the side
    player.parts.armR.shoulder.rotation.z = -1.25;
    // Slight natural bend at the elbow (forward, not backward)
    player.parts.armL.elbow.rotation.x = 0.3;
    player.parts.armR.elbow.rotation.x = 0.3;
    player.parts.armL.wrist.rotation.x = 0;
    player.parts.armR.wrist.rotation.x = 0;
    player.parts.torso.rotation.x = 0;
    player.parts.torso.rotation.y = 0;
    player.parts.torso.rotation.z = 0;
    // Subtle balance bob on the board
    player.group.position.y += Math.sin(performance.now() * 0.003) * 0.03;
    // --- Beard in the wind: blow it backward + gentle wobble ---
    // +Z is the back of the character (forward is -Z), so we rotate the
    // beardPivot by a POSITIVE X angle to swing its tip toward +Z (behind
    // the chin) as if the wind were coming at the surfer's face.
    const wobble = Math.sin(performance.now() * 0.008) * 0.12;
    player.parts.beardPivot.rotation.x = 0.9 + wobble;
    player.parts.beardPivot.rotation.z = Math.sin(performance.now() * 0.006) * 0.15;
  } else {
    player.parts.surfboard.visible = false;
    // Ease the beard back to rest hanging straight down
    player.parts.beardPivot.rotation.x = THREE.MathUtils.lerp(player.parts.beardPivot.rotation.x, 0, 0.12);
    player.parts.beardPivot.rotation.z = THREE.MathUtils.lerp(player.parts.beardPivot.rotation.z, 0, 0.12);
  }

  // --- Axe swing override for gathering ---
  // 3-phase chop: wind-up (rest → up-back), slam (up-back → forward-down),
  // follow-through (forward-down → rest). Positive shoulder.rotation.x in
  // Three.js swings the arm toward -Z (the character's forward side), so
  // the slam ends with the axe pointed at whatever is in front of the
  // lumberjack, not toward the camera.
  if (player.axeSwing > 0) {
    player.axeSwing = Math.max(0, player.axeSwing - dt);
    player.parts.backAxe.visible = false;
    player.parts.handAxe.visible = true;
    const t = 1 - player.axeSwing / 0.55;
    let shoulderX, elbowX;
    if (t < 0.3) {
      // Wind-up: rest → up-back. Elbow flexes STRONGLY (forearm folds
      // toward the shoulder so the axe is cocked over the head).
      const k = t / 0.3;
      shoulderX = -2.5 * k;
      elbowX    = 0.2 + 1.4 * k;    // 0.2 → 1.6 (flexed)
    } else if (t < 0.65) {
      // Slam: up-back → forward-down. Elbow STRAIGHTENS so the axe
      // extends fully forward/down into the target.
      const k = (t - 0.3) / 0.35;
      shoulderX = -2.5 + 4.5 * k;   // -2.5 → +2.0
      elbowX    = 1.6 - 1.4 * k;    // 1.6 → 0.2
    } else {
      // Follow-through: back to rest
      const k = (t - 0.65) / 0.35;
      shoulderX = 2.0 * (1 - k);
      elbowX    = 0.2;
    }
    player.parts.armR.shoulder.rotation.x = shoulderX;
    player.parts.armR.shoulder.rotation.z = -0.15;
    player.parts.armR.elbow.rotation.x    = elbowX;
    player.parts.armR.wrist.rotation.x    = 0;
    // Torso leans forward slightly during the slam phase only
    if (t >= 0.3 && t < 0.65) {
      player.parts.torso.rotation.x += -0.2;
    }
  } else {
    player.parts.backAxe.visible = true;
    player.parts.handAxe.visible = false;
  }

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
  const foodRec = {
    pos: mesh.position,
    tier,
    life: def.life,
    energy: def.energy,
    mesh,
  };
  foods.push(foodRec);

  // Guaranteed bird visit: if no bird is within 25 units of the food,
  // spawn one right next to it with a velocity pointing straight at it,
  // so the player always sees a bird arrive after dropping food.
  let closestDist = Infinity;
  for (const b of birds) {
    const d = b.pos.distanceTo(foodRec.pos);
    if (d < closestDist) closestDist = d;
  }
  if (closestDist > 25 && birds.length < MAX_BIRDS) {
    const angle = Math.random() * Math.PI * 2;
    const dist  = 12 + Math.random() * 6; // spawn 12-18 units from the food
    const sx = foodRec.pos.x + Math.cos(angle) * dist;
    const sz = foodRec.pos.z + Math.sin(angle) * dist;
    const sy = foodRec.pos.y + 3 + Math.random() * 3;
    const bird = new Bird(new THREE.Vector3(sx, sy, sz));
    // Point velocity straight at the food
    const dir = new THREE.Vector3(
      foodRec.pos.x - sx,
      foodRec.pos.y - sy,
      foodRec.pos.z - sz,
    ).normalize().multiplyScalar(MAX_SPEED);
    bird.vel.copy(dir);
    birds.push(bird);
  }
  // Also occasionally spawn an extra bird for visual density
  if (birds.length < MAX_BIRDS && Math.random() < 0.35 + tier * 0.1) spawnBird();

  // Quest progress (drop_tier objective)
  questEvent('drop_tier', { tier });
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
// Quest system
// =============================================================================
// Quest templates — parameterised pools from which each village draws
const QUEST_TEMPLATES = [
  {
    id: 'feed_basic',
    title: 'Les premiers grains',
    desc: 'Nourris <b>5</b> oiseaux pour gagner leur confiance.',
    objective: { type: 'feed', target: 5 },
    reward: { xp: 30 },
  },
  {
    id: 'drop_berries',
    title: 'Récolte de baies',
    desc: 'Dépose <b>3</b> baies (tier 2) pour les voyageurs ailés.',
    objective: { type: 'drop_tier', tier: 1, target: 3 },
    reward: { xp: 60 },
  },
  {
    id: 'explore_far',
    title: "L'appel du large",
    desc: 'Marche <b>200</b> unités depuis ce village.',
    objective: { type: 'distance', target: 200 },
    reward: { xp: 80 },
  },
  {
    id: 'feed_many',
    title: 'Le grand festin',
    desc: 'Nourris <b>15</b> oiseaux supplémentaires.',
    objective: { type: 'feed', target: 15 },
    reward: { xp: 120 },
  },
];

// =============================================================================
// Species atlas
// =============================================================================
const SPECIES_PREFIXES = ['Cyan', 'Écarlate', 'Indigo', 'Ambre', 'Rubis', 'Jade', 'Pourpre', 'Safran', 'Cobalt', 'Turquoise', 'Magenta', 'Doré'];
const SPECIES_SUFFIXES = [
  'des Clairières', 'des Cimes', 'des Marais', 'chanteur',
  'au long vol', 'crépusculaire', 'de l\'Aube', 'des Dunes',
  'chuchoteur', 'des Prairies', 'givré', 'solitaire',
];
function generateSpeciesName(bin) {
  const p = SPECIES_PREFIXES[bin % SPECIES_PREFIXES.length];
  const s = SPECIES_SUFFIXES[(bin * 7 + 3) % SPECIES_SUFFIXES.length];
  return p + ' ' + s;
}
function recordSpecies(bird) {
  const hsl = { h: 0, s: 0, l: 0 };
  bird.color.getHSL(hsl);
  const bin = Math.floor(hsl.h * 12);
  const id = 'sp_' + bin;
  if (!save.species[id]) {
    save.species[id] = {
      hue: bin / 12,
      count: 0,
      firstSeen: Date.now(),
      name: generateSpeciesName(bin),
    };
    showToast('Nouvelle espèce découverte : <b>' + save.species[id].name + '</b>');
  }
  save.species[id].count++;
}

// =============================================================================
// Village reputation
// =============================================================================
const REP_GRADES = [
  { min: 0,    name: 'Inconnu' },
  { min: 100,  name: 'Ami' },
  { min: 300,  name: 'Honoré' },
  { min: 800,  name: 'Vénéré' },
  { min: 2000, name: 'Exalté' },
];
function getRepGrade(rep) {
  let best = REP_GRADES[0];
  for (const g of REP_GRADES) if (rep >= g.min) best = g;
  return best.name;
}
function addVillageRep(vgKey, amount) {
  if (!vgKey) return;
  if (!save.villageRep[vgKey]) save.villageRep[vgKey] = { rep: 0 };
  const prevGrade = getRepGrade(save.villageRep[vgKey].rep);
  save.villageRep[vgKey].rep += amount;
  const nextGrade = getRepGrade(save.villageRep[vgKey].rep);
  if (prevGrade !== nextGrade) {
    showToast('Réputation village : <b>' + nextGrade + '</b>');
  }
}

function pickQuestIdFor(vgKey) {
  const h = hash2(vgKey.charCodeAt(0) * 7, vgKey.length * 11, 31337);
  return QUEST_TEMPLATES[Math.floor(h * QUEST_TEMPLATES.length)].id;
}
function getQuestTemplate(id) {
  return QUEST_TEMPLATES.find(q => q.id === id);
}

// Active quest state (kept in memory only — persisted on save)
if (!save.activeQuests) save.activeQuests = [];
if (!save.completedQuests) save.completedQuests = [];
// Inventory of gathered resources
if (!save.inventory) save.inventory = { bois: 0, herbe: 0, baie: 0, nectar: 0, essence: 0, plume: 0, graine: 0 };
if (save.inventory.graine === undefined) save.inventory.graine = 0;
// Map of "cx,cz" -> [instanceIdx] of trees the player has chopped down
if (!save.choppedTrees) save.choppedTrees = {};
// POIs visited by the player (map: "vgx,vgz" -> { x, z, visitedAt })
if (!save.discoveredVillages) save.discoveredVillages = {};
// Species atlas (id -> { hue, count, firstSeen, name })
if (!save.species) save.species = {};
// Per-village reputation (vgKey -> { rep })
if (!save.villageRep) save.villageRep = {};

function acceptQuest(tmpl, fromNpc) {
  if (save.activeQuests.some(q => q.id === tmpl.id)) return false;
  save.activeQuests.push({
    id: tmpl.id,
    progress: 0,
    startX: player.pos.x,
    startZ: player.pos.z,
    giverVgKey: fromNpc?.userData?.vgKey || null,
  });
  if (fromNpc) {
    fromNpc.userData.offered = true;
    // Remove the marker from the NPC
    if (fromNpc.userData.questMarker) {
      fromNpc.remove(fromNpc.userData.questMarker);
      fromNpc.userData.questMarker = null;
    }
  }
  persist();
  updateQuestTracker();
  showToast(`Nouvelle quête : <b>${tmpl.title}</b>`);
  return true;
}

// Quest is "ready": objective reached, player must return to an NPC to hand
// it in and collect the reward. Previously we auto-completed on reaching
// the target, which skipped the return-to-village beat.
function markQuestReady(q) {
  if (q.ready) return;
  q.ready = true;
  showToast(`Quête prête — rends-la à un villageois !`);
  persist();
  updateQuestTracker();
  refreshTurnInMarkers();
}

function turnInQuest(q) {
  const tmpl = getQuestTemplate(q.id);
  if (!tmpl) return;
  save.completedQuests.push(q.id);
  save.activeQuests = save.activeQuests.filter(x => x !== q);
  if (tmpl.reward?.xp) gainXp(tmpl.reward.xp);
  // Village reputation award
  addVillageRep(q.giverVgKey, 25);
  showToast(`Quête complétée : <b>${tmpl.title}</b> (+${tmpl.reward?.xp || 0} ◈)`);
  persist();
  updateQuestTracker();
  refreshTurnInMarkers();
}

function questEvent(type, extra = {}) {
  let changed = false;
  for (const q of save.activeQuests) {
    if (q.ready) continue; // don't keep incrementing past the target
    const tmpl = getQuestTemplate(q.id);
    if (!tmpl) continue;
    const o = tmpl.objective;
    if (o.type !== type) continue;
    if (type === 'drop_tier' && extra.tier !== o.tier) continue;
    q.progress = Math.min(o.target, q.progress + (extra.amount || 1));
    changed = true;
    if (q.progress >= o.target) markQuestReady(q);
  }
  if (changed) updateQuestTracker();
}

function updateQuestDistances() {
  let changed = false;
  for (const q of save.activeQuests) {
    if (q.ready) continue;
    const tmpl = getQuestTemplate(q.id);
    if (!tmpl || tmpl.objective.type !== 'distance') continue;
    const d = Math.hypot(player.pos.x - q.startX, player.pos.z - q.startZ);
    if (d > q.progress) {
      q.progress = Math.min(tmpl.objective.target, d);
      changed = true;
      if (q.progress >= tmpl.objective.target) markQuestReady(q);
    }
  }
  if (changed) updateQuestTracker();
}

// Update every NPC's marker. If the player has any ready quest, all NPCs
// that gave quests (or any NPC with questId set) swap from the gold "!"
// to a cyan "?" turn-in marker. Also regenerates fresh "!" markers for
// NPCs whose pre-accepted quest was cleared by a reset.
function refreshTurnInMarkers() {
  for (const [, v] of villages) {
    if (!v) continue;
    for (const n of v.npcs) {
      if (!n.userData.questId) continue;
      const activeReady = save.activeQuests.find(q => q.id === n.userData.questId && q.ready);
      const activeBusy  = save.activeQuests.find(q => q.id === n.userData.questId && !q.ready);
      // Remove old marker
      if (n.userData.questMarker) {
        n.remove(n.userData.questMarker);
        n.userData.questMarker = null;
      }
      if (activeReady) {
        addTurnInMarker(n); // "?" cyan
      } else if (!activeBusy && !save.completedQuests.includes(n.userData.questId)) {
        addQuestMarker(n);  // "!" gold (back to offering)
      }
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
// Bigger base geometry so birds are clearly visible at flight altitudes.
// Was (0.5 radius) * (1.6, 0.3, 1.0) = 1.6 x 0.3 x 1.0 world units.
// Now (0.9 radius) * (1.7, 0.35, 1.1) = ~3.1 x 0.6 x 2.0 — almost 2x bigger.
const birdGeo = new THREE.OctahedronGeometry(0.9, 0);
birdGeo.scale(1.7, 0.35, 1.1);
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
    this.scale = 1.1 + Math.random() * 0.4;
    this.color = new THREE.Color().setHSL(Math.random(), 0.55, 0.55);
    this.phase = Math.random() * Math.PI * 2;
    // --- Pollination state ---
    this.chargeTier = 0;   // tier of the food last eaten (drives plant rarity)
    this.chargeLeft = 0;   // seconds of charge remaining; plant drops when this hits 0 from positive
    this.postMealPause = 0; // after eating, hover in place briefly so the player sees the bird
  }
}

// Spawn birds in a close ring around the player so they're immediately
// visible. Altitude is tuned so the bird sits roughly at the camera's
// look-at height (around player head + 1-4 units), well inside the
// default 70° FOV regardless of terrain height.
function spawnBird() {
  if (birds.length >= MAX_BIRDS) return;
  const angle = Math.random() * Math.PI * 2;
  const r = 8 + Math.random() * 18;
  const x = player.pos.x + Math.cos(angle) * r;
  const z = player.pos.z + Math.sin(angle) * r;
  const ground = terrainHeight(x, z, save.worldSeed, worldLevel());
  // Lower and tighter than before — eye level to just above the head
  const h = Math.max(ground + 2.5, player.pos.y + 0.5 + Math.random() * 4);
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

    // Food attraction: pick best food by tier / distance (wider radius now)
    let best = null, bestScore = -Infinity;
    for (const f of foods) {
      const d = b.pos.distanceTo(f.pos);
      if (d > 160) continue;
      const score = (f.energy + 1) * 12 - d;
      if (score > bestScore) { bestScore = score; best = f; }
    }
    tmpFood.set(0, 0, 0);
    if (best) {
      tmpFood.subVectors(best.pos, b.pos);
      if (tmpFood.lengthSq() > 0) {
        tmpFood.setLength(MAX_SPEED).sub(b.vel).clampLength(0, 18);
      }
    }

    // Ground / ceiling avoidance — birds prefer to fly at a lower, visible
    // altitude rather than high above the player. When diving at food, even
    // lower.
    const groundH = terrainHeight(b.pos.x, b.pos.z, seed, lvl);
    const foodDiveMode = !!best && b.pos.distanceTo(best.pos) < 18;
    // Default min altitude: ~2 above ground. Ceiling: ~8 above the player.
    const minY = foodDiveMode ? groundH + 0.5 : groundH + 2;
    const maxY = foodDiveMode ? groundH + 20 : (player.pos.y + 10);
    tmpGround.set(0, 0, 0);
    if (b.pos.y < minY + (foodDiveMode ? 1 : 2)) {
      tmpGround.y += (minY + (foodDiveMode ? 1 : 2) - b.pos.y) * (foodDiveMode ? 1 : 2);
    }
    if (b.pos.y > maxY) tmpGround.y -= (b.pos.y - maxY) * 2;

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

    // Post-meal hover: after eating, the bird slows to a near stop for a
    // half-second so the player clearly sees it land + take off again.
    if (b.postMealPause > 0) {
      b.postMealPause -= dt;
      b.vel.multiplyScalar(0.82);
    }

    // Eat food if close enough
    if (best && b.pos.distanceTo(best.pos) < 2.2) {
      b.energy += best.energy * 10;
      gainXp(best.energy);
      questEvent('feed');
      recordSpecies(b);
      // (Pollination spawns a plant LATER, far from the food, so that
      //  the food itself clearly "gets eaten" rather than being replaced.)
      b.chargeTier = best.tier;
      b.chargeLeft = 4 + best.tier * 2;
      // Brief hover so the player sees the bird before it zooms off
      b.postMealPause = 0.6;
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

    // Pollination tick — the charge counts down while flying. When it runs
    // out, the bird drops a seed somewhere below it which will grow into
    // a plant over a few seconds.
    if (b.chargeLeft > 0) {
      const prev = b.chargeLeft;
      b.chargeLeft -= dt;
      if (b.chargeLeft <= 0) {
        plantSeedBelowBird(b);
        b.chargeLeft = 0;
      }
    }

    if (b.energy < 0) b.energy = 0;
  }
}

// =============================================================================
// Pollination — charged birds drop seeds, seeds grow into plants
// =============================================================================
const plants = []; // { mesh, grow, target, kind, pos }
const MAX_PLANTS = 400;
const PLANT_CULL_DIST = 260;

// Shared plant materials / geometries (allocated once)
const seedFlowerGeo = new THREE.ConeGeometry(0.22, 0.7, 5);
seedFlowerGeo.translate(0, 0.35, 0);
const seedBushGeo = new THREE.SphereGeometry(0.45, 8, 6);
seedBushGeo.translate(0, 0.45, 0);
const seedTreeLeavesGeo = new THREE.ConeGeometry(1.2, 3.6, 6);
seedTreeLeavesGeo.translate(0, 2.6, 0);
const seedTreeTrunkGeo = new THREE.CylinderGeometry(0.2, 0.3, 1.0, 5);
seedTreeTrunkGeo.translate(0, 0.5, 0);
const seedGlowGeo = new THREE.ConeGeometry(0.4, 1.4, 6);
seedGlowGeo.translate(0, 0.7, 0);
const seedMythicGeo = new THREE.IcosahedronGeometry(0.7, 0);
seedMythicGeo.translate(0, 0.8, 0);

const plantKinds = [
  // tier 0 — Graine → petite fleur jaune
  { name: 'fleur', geos: [seedFlowerGeo], colors: [0xffe45a], emissive: 0x000000, scale: 1 },
  // tier 1 — Baie → buisson rouge
  { name: 'buisson', geos: [seedBushGeo], colors: [0xc4301a], emissive: 0x1a0600, scale: 1.1 },
  // tier 2 — Ver → arbuste vert (cone + trunk)
  { name: 'arbuste', geos: [seedTreeTrunkGeo, seedTreeLeavesGeo], colors: [0x5a3a22, 0x4fa442], emissive: 0x001a00, scale: 0.8 },
  // tier 3 — Nectar → fleur luminescente
  { name: 'nectar', geos: [seedGlowGeo], colors: [0x7affcf], emissive: 0x20704a, scale: 1.2 },
  // tier 4 — Essence → gemme mythique
  { name: 'mythique', geos: [seedMythicGeo], colors: [0xb68cff], emissive: 0x30106a, scale: 1.5 },
];

// Plant a seed at an arbitrary world position (x, z) for the given tier.
// Used by the instant-plant-on-eat flow so growing plants appear at the
// exact spot where a bird ate food, not a few seconds later elsewhere.
function plantAtPosition(x, z, tier) {
  if (plants.length >= MAX_PLANTS) return;
  const kind = plantKinds[Math.min(tier, plantKinds.length - 1)];
  const seed = save.worldSeed;
  const lvl = worldLevel();
  const y = terrainHeight(x, z, seed, lvl);
  if (y < -1) return; // skip underwater seeds

  const group = new THREE.Group();
  for (let i = 0; i < kind.geos.length; i++) {
    const mat = new THREE.MeshLambertMaterial({
      color: kind.colors[i] || kind.colors[0],
      emissive: kind.emissive,
      emissiveIntensity: kind.emissive ? 0.6 : 0,
    });
    const mesh = new THREE.Mesh(kind.geos[i], mat);
    group.add(mesh);
  }
  group.position.set(x, y, z);
  group.scale.setScalar(0.001);
  scene.add(group);
  plants.push({
    mesh: group,
    grow: 0,
    target: kind.scale * 1.3, // slightly bigger for visibility
    tier,
    pos: new THREE.Vector3(x, y, z),
  });
  gainXp(1 + tier);
  spawnFloatingNumber('🌱');
}

// Keep the old name around in case it's referenced elsewhere
function plantSeedBelowBird(b) {
  plantAtPosition(b.pos.x, b.pos.z, b.chargeTier || 0);
}

function updatePlants(dt) {
  // Animate growth & cull plants that are too far
  const px = player.pos.x, pz = player.pos.z;
  for (let i = plants.length - 1; i >= 0; i--) {
    const p = plants[i];
    if (p.grow < 1) {
      p.grow = Math.min(1, p.grow + dt * 1.1); // grows to full size in ~1s
      // Ease-out for a pop effect
      const eased = 1 - Math.pow(1 - p.grow, 2);
      p.mesh.scale.setScalar(Math.max(0.001, eased * p.target));
    }
    // Cull distant plants to keep memory bounded
    const dx = p.pos.x - px, dz = p.pos.z - pz;
    if (dx * dx + dz * dz > PLANT_CULL_DIST * PLANT_CULL_DIST) {
      scene.remove(p.mesh);
      p.mesh.traverse(obj => {
        if (obj.geometry && !plantKinds.some(k => k.geos.includes(obj.geometry))) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
      plants.splice(i, 1);
    }
  }
}

function clearAllPlants() {
  for (const p of plants) {
    scene.remove(p.mesh);
    p.mesh.traverse(obj => {
      if (obj.material) obj.material.dispose();
    });
  }
  plants.length = 0;
}

// --- Gather nearest plant within range ---
// Maps plant tier to the resource added to the inventory.
const GATHER_MAP = [
  { key: 'herbe',   label: 'herbe' },
  { key: 'baie',    label: 'baie' },
  { key: 'bois',    label: 'bois' },
  { key: 'nectar',  label: 'nectar' },
  { key: 'essence', label: 'essence' },
];

function tryGatherNearbyPlant() {
  // Always play the chop animation so the action feels responsive
  player.axeSwing = 0.55;

  // 1) Closest pollinated plant within 3.5 units
  let best = null, bestDist = 3.5;
  let bestIdx = -1;
  for (let i = 0; i < plants.length; i++) {
    const p = plants[i];
    if (p.grow < 0.4) continue;
    const dx = p.pos.x - player.pos.x;
    const dz = p.pos.z - player.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < bestDist) { bestDist = d; best = p; bestIdx = i; }
  }
  if (best) {
    const map = GATHER_MAP[Math.min(best.tier, GATHER_MAP.length - 1)];
    save.inventory[map.key] = (save.inventory[map.key] || 0) + 1;
    persist();
    spawnFloatingNumber('+1 ' + map.label);
    scene.remove(best.mesh);
    best.mesh.traverse(obj => { if (obj.material) obj.material.dispose(); });
    plants.splice(bestIdx, 1);
    updateInventoryPanel();
    return true;
  }

  // 2) Nothing close → try chopping a procedural tree
  return chopNearestTree();
}

// --- Chop a procedural chunk tree ---
// Iterates the loaded chunks, finds the nearest non-chopped foliage instance
// within range, zero-scales its matrices and persists the choice.
const _treeTmpMat = new THREE.Matrix4();
const _treeTmpPos = new THREE.Vector3();
function chopNearestTree(maxDist = 4) {
  let bestDist = maxDist;
  let bestChunkKey = null;
  let bestIdx = -1;
  let bestChunk = null;
  for (const [chunkKey, ch] of chunks) {
    if (!ch || !ch.foliage) continue;
    const choppedSet = save.choppedTrees[chunkKey] || [];
    for (let i = 0; i < ch.treeCount; i++) {
      if (choppedSet.includes(i)) continue;
      ch.foliage.getMatrixAt(i, _treeTmpMat);
      _treeTmpPos.setFromMatrixPosition(_treeTmpMat);
      const d = _treeTmpPos.distanceTo(player.pos);
      if (d < bestDist) {
        bestDist = d;
        bestChunkKey = chunkKey;
        bestIdx = i;
        bestChunk = ch;
      }
    }
  }
  if (bestIdx < 0) return false;

  const zeroMat = new THREE.Matrix4().makeScale(0.0001, 0.0001, 0.0001);
  bestChunk.foliage.setMatrixAt(bestIdx, zeroMat);
  bestChunk.trunks.setMatrixAt(bestIdx, zeroMat);
  bestChunk.foliage.instanceMatrix.needsUpdate = true;
  bestChunk.trunks.instanceMatrix.needsUpdate = true;

  if (!save.choppedTrees[bestChunkKey]) save.choppedTrees[bestChunkKey] = [];
  save.choppedTrees[bestChunkKey].push(bestIdx);

  save.inventory.bois = (save.inventory.bois || 0) + 2;
  if (Math.random() < 0.35) {
    save.inventory.graine = (save.inventory.graine || 0) + 1;
    spawnFloatingNumber('+2 bois +1 graine');
  } else {
    spawnFloatingNumber('+2 bois');
  }
  persist();
  updateInventoryPanel();
  return true;
}

// --- Plant a sapling in front of the player ---
// Consumes 1 graine from the inventory and spawns a growing tree.
function plantSapling() {
  if (!save.inventory.graine || save.inventory.graine < 1) {
    showToast('Il te faut au moins <b>1 graine</b> pour planter.');
    return false;
  }
  const px = player.pos.x - Math.sin(player.yaw) * 2;
  const pz = player.pos.z - Math.cos(player.yaw) * 2;
  // tier 2 = arbuste (tree-like) from plantKinds
  plantAtPosition(px, pz, 2);
  save.inventory.graine--;
  persist();
  updateInventoryPanel();
  player.axeSwing = 0.55; // reuse the chop anim for the planting gesture
  return true;
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
const $questTracker = document.getElementById('questTracker');
const $dialog       = document.getElementById('dialog');
const $dialogName   = document.getElementById('dialogName');
const $dialogText   = document.getElementById('dialogText');
const $dialogAccept = document.getElementById('dialogAccept');
const $dialogTrade  = document.getElementById('dialogTrade');
const $dialogClose  = document.getElementById('dialogClose');
const $interactPrompt = document.getElementById('interactPrompt');
const $miniCanvas   = document.getElementById('minimap');
const $miniCtx      = $miniCanvas ? $miniCanvas.getContext('2d') : null;

// --- Quest tracker panel ------------------------------------------------
function updateQuestTracker() {
  if (!$questTracker) return;
  if (save.activeQuests.length === 0) {
    $questTracker.classList.add('empty');
    $questTracker.innerHTML = '<div class="empty-note">Pas de quête active.<br>Parle aux villageois avec un <span class="mark">!</span></div>';
    return;
  }
  $questTracker.classList.remove('empty');
  $questTracker.innerHTML = save.activeQuests.map(q => {
    const t = getQuestTemplate(q.id);
    if (!t) return '';
    const unit = t.objective.type === 'distance' ? 'm' : '';
    const target = t.objective.target;
    const prog = Math.floor(q.progress);
    const pct = Math.min(100, (prog / target) * 100);
    return `
      <div class="q">
        <div class="q-title">${t.title}</div>
        <div class="q-bar"><div class="q-fill" style="width:${pct}%"></div></div>
        <div class="q-prog">${prog}${unit} / ${target}${unit}</div>
      </div>
    `;
  }).join('');
}

// --- Dialog modal --------------------------------------------------------
let dialogNpc = null;
let dialogQuest = null;
let dialogMode = 'none'; // 'offer' | 'turnIn' | 'inProgress' | 'done' | 'none'
// Trade table — what each villager pays for stuff from your sacoche
const TRADE_TABLE = [
  { key: 'bois',   label: '🪵 Bois',   price: 5  },
  { key: 'baie',   label: '🫐 Baie',   price: 4  },
  { key: 'herbe',  label: '🌿 Herbe',  price: 2  },
  { key: 'plume',  label: '🪶 Plume',  price: 8  },
  { key: 'nectar', label: '🍯 Nectar', price: 12 },
  { key: 'graine', label: '🌰 Graine', price: 3  },
];

function openDialog(npc) {
  if (!$dialog) return;
  dialogNpc = npc;
  dialogMode = 'none';
  // NPC name + current village reputation grade
  const vgKey = npc.userData.vgKey;
  const rep = (vgKey && save.villageRep[vgKey]?.rep) || 0;
  const grade = getRepGrade(rep);
  $dialogName.textContent = (npc.userData.name || 'Villageois') + '   —   ' + grade + ' (' + rep + ')';

  // Always show the Commerce button so the player can sell anywhere
  if ($dialogTrade) $dialogTrade.style.display = '';

  // First: any ready quest the player can turn in to ANY NPC in this village?
  const readyQuest = save.activeQuests.find(q => q.ready);
  if (readyQuest) {
    const tmpl = getQuestTemplate(readyQuest.id);
    dialogQuest = { ...tmpl, _readyInstance: readyQuest };
    dialogMode = 'turnIn';
    $dialogText.innerHTML = `<b>« ${tmpl.title} »</b><br><br>"Tu as accompli ta mission. Reçois ta récompense, bûcheron."<br><br><i>Récompense : +${tmpl.reward.xp} ◈ essence</i>`;
    $dialogAccept.style.display = '';
    $dialogAccept.textContent = 'Rendre la quête';
    $dialog.classList.remove('hidden');
    return;
  }

  const tmpl = getQuestTemplate(npc.userData.questId);
  dialogQuest = tmpl;
  if (tmpl && !save.activeQuests.some(q => q.id === tmpl.id) && !save.completedQuests.includes(tmpl.id)) {
    dialogMode = 'offer';
    $dialogText.innerHTML = `<b>« ${tmpl.title} »</b><br><br>${tmpl.desc}<br><br><i>Récompense : +${tmpl.reward.xp} ◈ essence</i>`;
    $dialogAccept.style.display = '';
    $dialogAccept.textContent = 'Accepter';
  } else if (tmpl && save.completedQuests.includes(tmpl.id)) {
    dialogMode = 'done';
    $dialogText.innerHTML = `"Merci encore, bûcheron. Tu as aidé notre village."`;
    $dialogAccept.style.display = 'none';
  } else if (tmpl) {
    dialogMode = 'inProgress';
    $dialogText.innerHTML = `"N'oublie pas : <b>${tmpl.title}</b>. Reviens quand ce sera fait."`;
    $dialogAccept.style.display = 'none';
  } else {
    $dialogText.innerHTML = `"Bonne route, bûcheron !"`;
    $dialogAccept.style.display = 'none';
  }
  $dialog.classList.remove('hidden');
}

function openTradePanel() {
  if (!$dialog) return;
  dialogMode = 'trade';
  $dialogAccept.style.display = 'none';
  if ($dialogTrade) $dialogTrade.style.display = 'none';
  const rows = TRADE_TABLE.map(t => {
    const have = save.inventory[t.key] || 0;
    return `
      <div class="tradeRow">
        <span>${t.label} — <i>${have} en stock</i></span>
        <button data-trade="${t.key}" ${have < 1 ? 'disabled' : ''}>Vendre 1 → ${t.price} ◈</button>
      </div>
    `;
  }).join('');
  $dialogText.innerHTML = `"Qu'as-tu à vendre aujourd'hui ?"<br><div class="tradeList">${rows}</div>`;
  // Wire the trade buttons
  for (const btn of $dialogText.querySelectorAll('[data-trade]')) {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-trade');
      sellItem(key);
    });
  }
}

function sellItem(key) {
  const trade = TRADE_TABLE.find(t => t.key === key);
  if (!trade) return;
  if (!save.inventory[key] || save.inventory[key] < 1) return;
  save.inventory[key]--;
  gainXp(trade.price);
  // Reputation + 2 for each trade
  if (dialogNpc?.userData?.vgKey) addVillageRep(dialogNpc.userData.vgKey, 2);
  persist();
  updateInventoryPanel();
  openTradePanel(); // refresh the rows
}
function closeDialog() {
  if (!$dialog) return;
  $dialog.classList.add('hidden');
  dialogNpc = null;
  dialogQuest = null;
}

// --- Interaction prompt (proximity-based) --------------------------------
let nearbyNpc = null;
function updateInteraction() {
  // Find closest NPC within 3 units with a dialog to show
  let best = null, bestDist = 3.5;
  for (const [, v] of villages) {
    if (!v) continue;
    for (const n of v.npcs) {
      const d = Math.hypot(n.position.x - player.pos.x, n.position.z - player.pos.z);
      if (d < bestDist) { bestDist = d; best = n; }
    }
  }
  nearbyNpc = best;
  if ($interactPrompt) {
    if (best) {
      $interactPrompt.classList.remove('hidden');
      $interactPrompt.innerHTML = `Parler à <b>${best.userData.name}</b> — <span class="key">E</span>`;
    } else {
      $interactPrompt.classList.add('hidden');
    }
  }
}

// --- Inventory panel -----------------------------------------------------
const INV_LAYOUT = [
  { key: 'bois',    icon: '🪵', name: 'Bois' },
  { key: 'graine',  icon: '🌰', name: 'Graine' },
  { key: 'herbe',   icon: '🌿', name: 'Herbe' },
  { key: 'baie',    icon: '🫐', name: 'Baie' },
  { key: 'nectar',  icon: '🍯', name: 'Nectar' },
  { key: 'plume',   icon: '🪶', name: 'Plume' },
];
function updateInventoryPanel() {
  const grid = document.getElementById('inventoryGrid');
  if (!grid) return;
  grid.innerHTML = INV_LAYOUT.map(slot => `
    <div class="invSlot">
      <div class="invIcon">${slot.icon}</div>
      <div class="invName">${slot.name}</div>
      <div class="invCount">${save.inventory[slot.key] || 0}</div>
    </div>
  `).join('');
}
// --- Side panel with tabs (inventory / map / atlas) ---
// One sliding drawer instead of three full-screen modals, so the game
// keeps running behind it and the player can close it instantly.
let sideOpen = false;
let currentSideTab = 'inventory';

function updateSideTab(tab) {
  currentSideTab = tab;
  const panels = {
    inventory: document.getElementById('sideTabInventory'),
    map:       document.getElementById('sideTabMap'),
    atlas:     document.getElementById('sideTabAtlas'),
  };
  for (const [name, el] of Object.entries(panels)) {
    if (!el) continue;
    el.classList.toggle('hidden', name !== tab);
  }
  for (const btn of document.querySelectorAll('.sideTab')) {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
  }
  // Refresh the content of the newly shown tab
  if (tab === 'inventory') updateInventoryPanel();
  else if (tab === 'map')  drawWorldMap();
  else if (tab === 'atlas') updateAtlasPanel();
}

function openSidePanel(tab) {
  const el = document.getElementById('sidePanel');
  if (!el) return;
  el.classList.remove('hidden');
  sideOpen = true;
  updateSideTab(tab || currentSideTab || 'inventory');
}

function closeSidePanel() {
  const el = document.getElementById('sidePanel');
  if (!el) return;
  el.classList.add('hidden');
  sideOpen = false;
}

// Back-compat names kept so other places (keydown handler) still work
function closeBigPanel() { closeSidePanel(); }
function toggleInventoryPanel() {
  if (sideOpen && currentSideTab === 'inventory') closeSidePanel();
  else openSidePanel('inventory');
}
function toggleWorldMapPanel() {
  if (sideOpen && currentSideTab === 'map') closeSidePanel();
  else openSidePanel('map');
}
function toggleAtlasPanel() {
  if (sideOpen && currentSideTab === 'atlas') closeSidePanel();
  else openSidePanel('atlas');
}

function updateAtlasPanel() {
  const grid = document.getElementById('atlasGrid');
  if (!grid) return;
  const ids = Object.keys(save.species);
  if (ids.length === 0) {
    grid.innerHTML = '<div class="empty-note">Aucune espèce encore enregistrée.</div>';
    return;
  }
  ids.sort((a, b) => save.species[a].firstSeen - save.species[b].firstSeen);
  grid.innerHTML = ids.map(id => {
    const sp = save.species[id];
    const c = new THREE.Color().setHSL(sp.hue, 0.55, 0.55);
    const hex = '#' + c.getHexString();
    return `
      <div class="atlasCard">
        <div class="atlasDot" style="background:${hex}; box-shadow:0 0 12px ${hex}"></div>
        <div class="atlasName">${sp.name}</div>
        <div class="atlasCount">× ${sp.count}</div>
      </div>
    `;
  }).join('');
}

// Side panel tab buttons + close button
document.addEventListener('click', e => {
  const t = e.target;
  if (!t || !t.matches) return;
  if (t.matches('.sideTab')) {
    updateSideTab(t.getAttribute('data-tab'));
  } else if (t.matches('#sidePanelClose')) {
    closeSidePanel();
  } else if (t.matches('.dialog-close-btn')) {
    closeSidePanel();
  }
});

// --- World map drawing ---------------------------------------------------
const WORLD_MAP_RANGE = 900; // world units across the full canvas
function drawWorldMap() {
  const canvas = document.getElementById('worldMapCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  // Background gradient for depth
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#1c2838');
  g.addColorStop(1, '#0c1626');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Low-res terrain height shading sampled around the player
  const step = 10;
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const wx = player.pos.x + ((x - W / 2) / (W / 2)) * WORLD_MAP_RANGE;
      const wz = player.pos.z + ((y - H / 2) / (H / 2)) * WORLD_MAP_RANGE;
      const b = biomeAt(wx, wz, save.worldSeed);
      const h = terrainHeight(wx, wz, save.worldSeed, worldLevel());
      // Base biome fog color, darkened by relief
      const bc = new THREE.Color(b.fog);
      const k = 0.35 + Math.max(-0.25, Math.min(0.25, h / 40)) * 0.8;
      ctx.fillStyle = `rgb(${(bc.r*255*k)|0},${(bc.g*255*k)|0},${(bc.b*255*k)|0})`;
      ctx.fillRect(x, y, step, step);
    }
  }

  // Discovered villages (gold dots)
  ctx.fillStyle = '#ffd23a';
  ctx.strokeStyle = '#ffe99a';
  ctx.lineWidth = 1;
  for (const key in save.discoveredVillages) {
    const v = save.discoveredVillages[key];
    const mx = W / 2 + ((v.x - player.pos.x) / WORLD_MAP_RANGE) * (W / 2);
    const my = H / 2 + ((v.z - player.pos.z) / WORLD_MAP_RANGE) * (H / 2);
    if (mx < 0 || mx > W || my < 0 || my > H) continue;
    ctx.beginPath();
    ctx.arc(mx, my, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Player marker (same rotation convention as the minimap — negate
  // yaw because canvas rotate is clockwise and we use meshYaw so the
  // arrow shows the body facing direction, not the camera)
  const pX = W / 2, pY = H / 2;
  ctx.save();
  ctx.translate(pX, pY);
  ctx.rotate(-player.meshYaw);
  ctx.beginPath();
  ctx.moveTo(0, -10);
  ctx.lineTo(-6, 7);
  ctx.lineTo(6, 7);
  ctx.closePath();
  ctx.fillStyle = '#ff9f40';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Cardinal N label
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', W / 2, 20);
}

// Mark a village as discovered when the player walks within range of it.
function updateVillageDiscovery() {
  for (const [key, v] of villages) {
    if (!v) continue;
    if (save.discoveredVillages[key]) continue;
    const d = Math.hypot(v.worldX - player.pos.x, v.worldZ - player.pos.z);
    if (d < 14) {
      save.discoveredVillages[key] = { x: v.worldX, z: v.worldZ, visitedAt: Date.now() };
      persist();
      showToast('Village découvert ! Ouvre la carte avec <span class="key">M</span>');
    }
  }
}

// --- Minimap drawing -----------------------------------------------------
const MINIMAP_RANGE = 180; // world units shown in the full minimap width
let minimapAcc = 0;
function drawMinimap() {
  if (!$miniCtx) return;
  const ctx = $miniCtx;
  const W = $miniCanvas.width, H = $miniCanvas.height;
  const cx = W / 2, cy = H / 2;
  const R = Math.min(cx, cy) - 2;
  ctx.clearRect(0, 0, W, H);

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();

  // Background tinted by current biome
  const b = biomeAt(player.pos.x, player.pos.z, save.worldSeed);
  ctx.fillStyle = '#' + b.fog.toString(16).padStart(6, '0');
  ctx.fillRect(0, 0, W, H);

  // Terrain relief shading (low-res grid)
  const step = 6;
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const wx = player.pos.x + ((x - cx) / R) * MINIMAP_RANGE;
      const wz = player.pos.z + ((y - cy) / R) * MINIMAP_RANGE;
      const h = terrainHeight(wx, wz, save.worldSeed, worldLevel());
      const tint = Math.max(-0.3, Math.min(0.3, h / 50));
      if (tint > 0) {
        ctx.fillStyle = `rgba(255,255,255,${tint * 0.7})`;
      } else {
        ctx.fillStyle = `rgba(0,0,0,${-tint * 0.7})`;
      }
      ctx.fillRect(x, y, step, step);
    }
  }

  // Villages
  for (const v of getNearbyVillages()) {
    const mx = cx + ((v.x - player.pos.x) / MINIMAP_RANGE) * R;
    const my = cy + ((v.z - player.pos.z) / MINIMAP_RANGE) * R;
    const distSq = (mx - cx) * (mx - cx) + (my - cy) * (my - cy);
    if (distSq > R * R) continue;
    // Village square
    ctx.fillStyle = '#fff1b0';
    ctx.fillRect(mx - 3, my - 3, 6, 6);
    // Quest marker (gold ring)
    if (v.hasQuest) {
      ctx.beginPath();
      ctx.arc(mx, my, 6, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffd23a';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Player dot + direction arrow. Canvas rotate() is clockwise, Three.js
  // yaw is counter-clockwise around +Y, and we want the arrow to show
  // the body facing direction (meshYaw), not the camera yaw. Negate so
  // the arrow always points where the lumberjack is actually looking.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-player.meshYaw);
  ctx.beginPath();
  ctx.moveTo(0, -7);
  ctx.lineTo(-4, 4);
  ctx.lineTo(4, 4);
  ctx.closePath();
  ctx.fillStyle = '#ff9f40';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  ctx.restore();

  // Border ring
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Cardinal N marker (always at top, no rotation)
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', cx, 12);
}

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

// Floating "+X ◈" element that rises + fades away. Spawned next to the
// screen center so it's readable no matter where the player is looking.
function spawnFloatingNumber(text) {
  const el = document.createElement('div');
  el.className = 'floatXp';
  el.textContent = text;
  // Small random horizontal jitter so bursts don't stack perfectly
  el.style.left = (50 + (Math.random() - 0.5) * 6) + '%';
  el.style.top  = '52%';
  document.body.appendChild(el);
  // Remove after the CSS animation finishes
  setTimeout(() => el.remove(), 1400);
}

let lastLevel = worldLevel();
function gainXp(amount) {
  const before = save.xp;
  save.xp += amount;
  // Floating "+X ◈" number on screen near the center
  spawnFloatingNumber('+' + Math.round(amount) + ' ◈');
  // Check food unlocks
  for (let i = 0; i < FOODS.length; i++) {
    if (before < FOODS[i].unlock && save.xp >= FOODS[i].unlock) {
      showToast(`Nouvelle nourriture débloquée : <b>${FOODS[i].name}</b>`);
      buildFoodbar();
    }
  }
  // Check world level up — do NOT rebuild the world, just show a toast.
  // Destroying the chunks/villages/plants on every level-up used to wipe
  // everything the player had discovered / grown, which broke the flow.
  // Chunks that stream in AFTER the level-up will naturally pick up the
  // higher worldLevel() and add their extra detail — the transition is
  // seamless at the edge of the currently loaded world.
  const lv = worldLevel();
  if (lv !== lastLevel) {
    lastLevel = lv;
    showToast(`Le monde évolue — <b>niveau ${lv}</b>`);
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
  save.activeQuests = [];
  save.completedQuests = [];
  save.inventory = { bois: 0, herbe: 0, baie: 0, nectar: 0, essence: 0, plume: 0 };
  save.discoveredVillages = {};
  save.species = {};
  save.villageRep = {};
  persist();
  birds.length = 0;
  for (const f of foods) { scene.remove(f.mesh); f.mesh.material.dispose(); }
  foods.length = 0;
  clearAllVillages();
  lastLevel = worldLevel();
  buildWorld();
  placePlayerOnGround();
  buildFoodbar();
  updateHUD();
  updateQuestTracker();
});

// --- Procedural ambient (pink-noise wind + random bird chirps) ---
// Generated with the Web Audio API so there is no extra asset to ship.
// Starts on the very first user interaction because browsers block autoplay.
let audioCtx = null;
let ambientStarted = false;
let chirpTimer = 0;
function startAmbient() {
  if (ambientStarted) return;
  ambientStarted = true;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Pink noise buffer (Paul Kellet's method)
    const bufSize = 2 * audioCtx.sampleRate;
    const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < bufSize; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    const gain = audioCtx.createGain();
    gain.gain.value = 0.06; // soft ambient wind
    src.connect(filter).connect(gain).connect(audioCtx.destination);
    src.start();
  } catch (e) {
    console.warn('ambient audio failed', e);
    audioCtx = null;
  }
}
window.addEventListener('pointerdown', startAmbient, { once: true });
window.addEventListener('keydown',    startAmbient, { once: true });

function playChirp() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  const f0 = 1800 + Math.random() * 2400;
  const f1 = 1000 + Math.random() * 1200;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(f1, t + 0.12);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.035, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.22);
}

function updateAmbientChirps(dt) {
  if (!audioCtx) return;
  chirpTimer -= dt;
  if (chirpTimer <= 0) {
    chirpTimer = 1.2 + Math.random() * 3.5;
    // More chirps when more birds are nearby
    if (birds.length > 0 && Math.random() < 0.7) playChirp();
  }
}

// --- Open side panel button (visible on desktop AND mobile) ---
document.getElementById('openPanelBtn')?.addEventListener('click', () => {
  if (sideOpen) closeSidePanel();
  else openSidePanel('inventory');
});

// --- Music toggle (Radio Meuh stream) ---
const $music = document.getElementById('bgm');
const $musicBtn = document.getElementById('musicBtn');
let musicPlaying = false;
$musicBtn?.addEventListener('click', () => {
  if (!$music) return;
  if (musicPlaying) {
    $music.pause();
    musicPlaying = false;
    $musicBtn.classList.remove('active');
    $musicBtn.textContent = '♪';
  } else {
    // Play the stream. If it fails (CORS / network / offline), show a toast.
    $music.play().then(() => {
      musicPlaying = true;
      $musicBtn.classList.add('active');
      $musicBtn.textContent = '♫';
      showToast('SomaFM Metal Detector — en direct 🎸');
    }).catch(err => {
      showToast('Musique indisponible — <i>' + (err.message || 'erreur') + '</i>');
    });
  }
});

// --- Dialog modal wiring ---
$dialogAccept?.addEventListener('click', () => {
  if (dialogMode === 'turnIn' && dialogQuest?._readyInstance) {
    turnInQuest(dialogQuest._readyInstance);
    closeDialog();
    return;
  }
  if (dialogMode === 'offer' && dialogQuest && dialogNpc) {
    if (acceptQuest(dialogQuest, dialogNpc)) {
      closeDialog();
    }
  }
});
$dialogTrade?.addEventListener('click', () => openTradePanel());
$dialogClose?.addEventListener('click', () => closeDialog());

function tryInteract() {
  if (nearbyNpc) openDialog(nearbyNpc);
}
// Interact button (mobile) and keyboard
document.getElementById('btnInteract')?.addEventListener('pointerdown', e => {
  e.preventDefault();
  tryInteract();
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

// --- Look joystick (right side, camera yaw / pitch) ---
const lookJoy   = document.getElementById('lookJoystick');
const lookThumb = document.getElementById('lookJoystickThumb');
let lookJoyId = null;
let lookCX = 0, lookCY = 0;
if (lookJoy) {
  lookJoy.addEventListener('pointerdown', e => {
    if (lookJoyId !== null) return;
    lookJoyId = e.pointerId;
    const rect = lookJoy.getBoundingClientRect();
    lookCX = rect.left + rect.width  / 2;
    lookCY = rect.top  + rect.height / 2;
    lookJoy.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  lookJoy.addEventListener('pointermove', e => {
    if (e.pointerId !== lookJoyId) return;
    let dx = e.clientX - lookCX;
    let dy = e.clientY - lookCY;
    const mag = Math.hypot(dx, dy);
    if (mag > JOY_MAX) { dx *= JOY_MAX / mag; dy *= JOY_MAX / mag; }
    lookThumb.style.transform = `translate(${dx}px, ${dy}px)`;
    touchInput.lookX =  dx / JOY_MAX;
    touchInput.lookY =  dy / JOY_MAX;
  });
  const endLook = e => {
    if (e.pointerId !== lookJoyId) return;
    lookJoyId = null;
    lookThumb.style.transform = '';
    touchInput.lookX = 0;
    touchInput.lookY = 0;
  };
  lookJoy.addEventListener('pointerup', endLook);
  lookJoy.addEventListener('pointercancel', endLook);
}

// --- Feed, Jump, Gather, Interact buttons ---
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
document.getElementById('btnGather')?.addEventListener('pointerdown', e => {
  e.preventDefault();
  tryGatherNearbyPlant();
});
document.getElementById('btnPlant')?.addEventListener('pointerdown', e => {
  e.preventDefault();
  plantSapling();
});

// =============================================================================
// Init + game loop
// =============================================================================
buildWorld();
placePlayerOnGround();
buildFoodbar();
updateHUD();

// Seed a few starter birds
for (let i = 0; i < 20; i++) spawnBird();

let lastT = performance.now();
let hudAcc = 0;

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  let dt = (now - lastT) / 1000;
  if (dt > 0.1) dt = 0.1;
  lastT = now;

  // Each subsystem is wrapped so a single failure doesn't kill the whole
  // frame loop. Errors are logged once per subsystem to the console.
  try { updatePlayer(dt); }       catch (e) { logOnce('updatePlayer', e); }
  try { ensureVisibleChunks(); }  catch (e) { logOnce('ensureVisibleChunks', e); }
  try { ensureVillages(); }       catch (e) { logOnce('ensureVillages', e); }
  try { updateBiomeTracking(dt); } catch (e) { logOnce('updateBiomeTracking', e); }
  try { updateDayNight(dt); }      catch (e) { logOnce('updateDayNight', e); }
  try { updateBirds(dt); }        catch (e) { logOnce('updateBirds', e); }
  try { updateFoods(dt); }        catch (e) { logOnce('updateFoods', e); }
  try { updatePlants(dt); }       catch (e) { logOnce('updatePlants', e); }
  try { updateWater(dt); }        catch (e) { logOnce('updateWater', e); }
  try { renderBirds(); }          catch (e) { logOnce('renderBirds', e); }
  try { updateInteraction(); }    catch (e) { logOnce('updateInteraction', e); }
  try { updateQuestDistances(); } catch (e) { logOnce('updateQuestDistances', e); }
  try { updateVillageDiscovery(); } catch (e) { logOnce('updateVillageDiscovery', e); }
  try { updateAmbientChirps(dt); }  catch (e) { logOnce('updateAmbientChirps', e); }

  // Occasional spawn if population is low and xp allows
  if (birds.length < Math.min(12 + worldLevel() * 8, MAX_BIRDS)) {
    if (Math.random() < dt * 0.4) spawnBird();
  }

  // Rotate quest markers for visibility
  try {
    for (const [, v] of villages) {
      if (!v) continue;
      for (const n of v.npcs) {
        if (n.userData.questMarker) {
          n.userData.questMarker.rotation.y += dt * 2;
          n.userData.questMarker.position.y = 2.2 + Math.sin(now * 0.003) * 0.12;
        }
      }
    }
  } catch (e) { logOnce('questMarkerRotate', e); }

  hudAcc += dt;
  if (hudAcc > 0.25) {
    try { updateHUD(); } catch (e) { logOnce('updateHUD', e); }
    hudAcc = 0;
  }

  minimapAcc += dt;
  if (minimapAcc > 0.15) {
    try { drawMinimap(); } catch (e) { logOnce('drawMinimap', e); }
    minimapAcc = 0;
  }

  renderer.render(scene, camera);
}

// Helper: log each subsystem error at most once to keep the console usable
const _loggedErrors = new Set();
function logOnce(tag, err) {
  if (_loggedErrors.has(tag)) return;
  _loggedErrors.add(tag);
  console.error('[birdlife]', tag, err);
}

// Initial quest tracker pass (after all HUD refs are set)
updateQuestTracker();
loop();
