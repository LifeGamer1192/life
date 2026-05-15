const N = 60, M = 65;     // Board size (60 rows x 65 cols, canvas 780x720)
const cell = 12;          // Cell display size
let stepCount = 0;        // Step counter
// Alive history. Each entry: { step, plantCounts: [...], animalCounts: [...] }.
// Used by both the mini graph in the status panel and the full graph that
// appears on game over.
let aliveHistory = [];

// POST display timers (success / failure)
let postOkTimestamp = 0;
let postFailTimestamp = 0;
const POST_DISPLAY_MS = 5000;
const POST_FAIL_DISPLAY_MS = 5000;

// Version number (increment manually when editing this script)
const VERSION = 9; // Per-species graphs + observation UI (hover, step, seed)

// ---------- Seeded PRNG (mulberry32) ----------
// Use rand() instead of the platform PRNG everywhere. When _seedActive is
// null we forward to the native generator (non-deterministic). When set
// to an integer, rand() is fully deterministic so a run can be reproduced.
let _seedActive = null;     // null = unseeded; integer = active seed
let _seedState = 0;
let _seedAtRunStart = null; // the seed value used at the start of this run
function rand() {
  // Bracket access avoids matching a global Math.random -> rand rewrite.
  if (_seedActive === null) return Math["random"]();
  _seedState = (_seedState + 0x6D2B79F5) | 0;
  let t = _seedState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function applySeed(seed) {
  if (seed === null || seed === undefined || !Number.isFinite(seed)) {
    _seedActive = null;
    _seedAtRunStart = null;
  } else {
    _seedActive = seed | 0;
    _seedState = _seedActive;
    _seedAtRunStart = _seedActive;
  }
}

// Run log buffer (TSV-style). Filled every step and exported via the
// "Download log" button or automatically on game over.
let runLog = [];
let runLogStartedAt = '';
let LOG_INTERVAL = 20; // record every Nth step (smaller = more detail, larger file)

// Global plant rule thresholds (previously hardcoded in stepPlants).
// Editable from the in-page parameter editor.
let PLANT_GROW_FIT_THRESHOLD = 0.5;  // fit > this -> biomass grows
let PLANT_DECAY_FIT_THRESHOLD = 0.3; // fit < this -> biomass decays
let PLANT_SPREAD_PROB = 0.18;        // chance per step to attempt seed dispersal
let PLANT_INVADE_FIT_DELTA = 0.15;   // fitness advantage required to invade another species' cell

// Environment initialization parameters (used by initEnvironment).
let ENV_HUMIDITY_POINTS = 6;  // number of random "wetland" points
let ENV_HUMIDITY_RANGE  = 22; // distance over which humidity decays toward 0

// Simulation speed control. The loop is scheduled by setTimeout instead of
// requestAnimationFrame so the user can pick a deliberate pace.
let speedLevel = 1; // 0 = slow, 1 = medium, 2 = fast
const SPEED_DELAYS_MS = [120, 30, 5]; // ms between steps for each level

// Pause/resume state. Spacebar or the Pause button toggles this.
let paused = false;
let loopTimeoutHandle = null;

// ---------- GAS submission URL and send function ----------
// Set GAS_URL to your own Google Apps Script endpoint to enable result submission.
// When empty, submission is skipped silently.
const GAS_URL = '';

async function sendResult(alive, step) {
  if (!GAS_URL) {
    console.log('[sendResult] GAS_URL not configured; skipping submission.', { alive, step });
    return;
  }
  console.log('[sendResult] start', { alive, step });

  // Fetch public IP (proceed even if it fails)
  let clientIp = '';
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    if (r.ok) {
      const j = await r.json();
      clientIp = j.ip || '';
    }
  } catch (e) {
    console.warn('[sendResult] ip fetch failed', e);
    clientIp = '';
  }

  const payload = {
    timestamp: new Date().toISOString(),
    ip: clientIp,
    reverse_dns: '',
    alive_final: Number(alive) || 0,
    step_final: Number(step) || 0
  };

  const body = JSON.stringify(payload);
  console.log('[sendResult] payload', payload);

  try {
    if (navigator && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'text/plain' });
      const queued = navigator.sendBeacon(GAS_URL, blob);
      console.log('[sendResult] sendBeacon queued=', queued);
      if (queued) {
        postOkTimestamp = Date.now();
        postFailTimestamp = 0;
      } else {
        postFailTimestamp = Date.now();
      }
      return;
    }
  } catch (e) {
    console.warn('[sendResult] sendBeacon error', e);
  }

  try {
    const resp = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: body,
      keepalive: true
    });
    console.log('[sendResult] fetch resp', resp && resp.status);
    let text = '';
    try { text = await resp.text(); } catch (e) { text = ''; }
    console.log('[sendResult] fetch resp body', text);
    if (resp && resp.ok) {
      postOkTimestamp = Date.now();
      postFailTimestamp = 0;
    } else {
      postFailTimestamp = Date.now();
    }
  } catch (e) {
    console.error('[sendResult] fetch error', e);
    postFailTimestamp = Date.now();
  }
}

// Helper: format numbers as 'K' notation
function formatStep(n) {
  if (n < 1000) return String(n);
  const k = n / 1000;
  const s = k >= 100 ? Math.round(k).toString() : (Math.round(k * 10) / 10).toString();
  return s.replace(/\.0$/, '') + 'K';
}

// Steady-state detection (legacy from Life Game, unused in ecosystem)
let prevGrid = null;
let prev2Grid = null;
let gameOver = false;

function arraysEqual(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function idx(y, x) { return y * M + x; }

// ========================================================================
// Stage 1: environment layer (temperature / humidity, immutable after init)
// ========================================================================
const temperature = new Float32Array(N * M); // 0 (cold) - 1 (hot)
const humidity    = new Float32Array(N * M); // 0 (dry)  - 1 (wet)

function initEnvironment() {
  // Temperature: vertical gradient (top = cold 0, bottom = hot 1)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < M; x++) {
      temperature[idx(y, x)] = y / (N - 1);
    }
  }
  // Humidity: random wetland points, decayed by toroidal distance
  const pointCount = Math.max(1, Math.floor(ENV_HUMIDITY_POINTS));
  const range = Math.max(1, ENV_HUMIDITY_RANGE);
  const points = [];
  for (let k = 0; k < pointCount; k++) {
    points.push({ x: rand() * M, y: rand() * N });
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < M; x++) {
      let minD = Infinity;
      for (const p of points) {
        let dx = Math.abs(x - p.x); if (dx > M / 2) dx = M - dx;
        let dy = Math.abs(y - p.y); if (dy > N / 2) dy = N - dy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < minD) minD = d;
      }
      humidity[idx(y, x)] = Math.max(0, Math.min(1, 1 - minD / range));
    }
  }
}

// ========================================================================
// Stage 1: plant layer
// ========================================================================
// Built-in plant species (used when plants.txt cannot be loaded, e.g. file:// fetch blocked).
// Tunable parameters live in plants.txt; this array is a fallback.
const DEFAULT_PLANT_PARAMS = [
  { name: 'Grass', spriteFile: 'plant_grass.png', color: [200, 230, 80],  optTemp: 0.55, optHum: 0.50, growth: 1.1, decay: 2.0, maxBio: 60,  spreadThresh: 25 },
  { name: 'Tree',  spriteFile: 'plant_tree.png',  color: [40, 130, 50],   optTemp: 0.72, optHum: 0.80, growth: 0.4, decay: 1.5, maxBio: 100, spreadThresh: 50 },
  { name: 'Moss',  spriteFile: 'plant_moss.png',  color: [130, 200, 210], optTemp: 0.15, optHum: 0.85, growth: 0.5, decay: 1.5, maxBio: 50,  spreadThresh: 20 },
];
let PLANT_SPECIES = DEFAULT_PLANT_PARAMS;
let NUM_PLANT_SPECIES = PLANT_SPECIES.length;
let PLANT_PARAMS_SOURCE = 'defaults'; // 'plants.txt' once successfully loaded

let plantSpecies = new Int8Array(N * M); // -1 = none, 0..NUM_PLANT_SPECIES-1
let plantBiomass = new Float32Array(N * M);

// Per-species sprite images (placeholders; intended to be swapped for nicer art later)
let plantSprites = [];
let plantSpritesLoaded = [];

function loadPlantSprites() {
  plantSprites = [];
  plantSpritesLoaded = [];
  PLANT_SPECIES.forEach((def, i) => {
    const img = new Image();
    plantSpritesLoaded[i] = false;
    img.onload = () => { plantSpritesLoaded[i] = true; };
    img.onerror = () => { console.warn(`[sprite] Failed to load ${def.spriteFile}.`); };
    img.src = def.spriteFile;
    plantSprites[i] = img;
  });
}

// Generic INI-style parser shared by plants.txt and animals.txt.
// Sections look like [Name]; lines inside are key = value pairs.
// Returns an array of species objects with the given defaults filled in for missing fields.
function parseSpeciesParams(text, defaults) {
  const sections = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    // Strip inline comment after '#'
    let line = rawLine;
    const hashAt = line.indexOf('#');
    if (hashAt >= 0) line = line.slice(0, hashAt);
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      current = { name: line.slice(1, -1).trim() };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const valRaw = line.slice(eq + 1).trim();
    if (key === 'color') {
      current[key] = valRaw.split(',').map(s => parseInt(s.trim(), 10));
    } else if (key === 'spriteFile' || key === 'name') {
      current[key] = valRaw;
    } else {
      const num = parseFloat(valRaw);
      current[key] = isNaN(num) ? valRaw : num;
    }
  }
  return sections.map(s => Object.assign({}, defaults, s));
}

const PLANT_PARAM_DEFAULTS = {
  color: [128, 128, 128],
  spriteFile: null,
  optTemp: 0.5,
  optHum: 0.5,
  growth: 0.5,
  decay: 1.0,
  maxBio: 50,
  spreadThresh: 25,
};

function parsePlantParams(text) {
  return parseSpeciesParams(text, PLANT_PARAM_DEFAULTS);
}

// Read the text inside an inline <script type="text/plain" id="..."> block.
function readInlineDataBlock(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return null;
  const text = (el.textContent || '').trim();
  return text || null;
}

async function loadPlantParams() {
  // 1. Try fetching the canonical plants.txt (works on HTTP).
  try {
    const resp = await fetch('plants.txt');
    if (resp.ok) {
      const text = await resp.text();
      const parsed = parsePlantParams(text);
      if (parsed.length) {
        PLANT_PARAMS_SOURCE = 'plants.txt (HTTP)';
        return parsed;
      }
    }
  } catch (e) {
    // fetch blocked (typical for file://) -- fall through to inline copy.
  }
  // 2. Try the inline copy embedded in index.html (works on file://).
  const inline = readInlineDataBlock('plants-data');
  if (inline) {
    const parsed = parsePlantParams(inline);
    if (parsed.length) {
      PLANT_PARAMS_SOURCE = 'plants.txt (embedded)';
      return parsed;
    }
  }
  // 3. Last-resort hardcoded defaults.
  console.warn('[plants] plants.txt and inline plants-data both unavailable; using emergency defaults.');
  PLANT_PARAMS_SOURCE = 'defaults';
  return DEFAULT_PLANT_PARAMS;
}

// ========================================================================
// Stage 2: animal layer (Herbivore in v5; Carnivore arrives in v7)
// ========================================================================
// Built-in animal species (used when animals.txt cannot be loaded).
const DEFAULT_ANIMAL_PARAMS = [
  {
    name: 'Herbivore',
    spriteFile: 'animal_herbivore.png',
    color: [240, 240, 240],
    initialCount: 5,
    visionRange: 3,
    maxEnergy: 100,
    energyPerStep: 0.6,
    biteAmount: 6,
    energyFromBiomass: 1.2,
    lifespan: 600,
    reproThreshold: 70,
    maxPopulation: 180,
    prey: 'plants',
    spawnStep: 700,
    moveSpeed: 1,
    reproChancePerStep: 0.07,
  },
  {
    name: 'Carnivore',
    spriteFile: 'animal_carnivore.png',
    color: [230, 80, 80],
    initialCount: 3,
    visionRange: 4,
    maxEnergy: 150,
    energyPerStep: 1.0,
    biteAmount: 25,
    energyFromBiomass: 1.0,
    lifespan: 700,
    reproThreshold: 115,
    maxPopulation: 20,
    prey: 'Herbivore',
    spawnStep: 1200,
    moveSpeed: 2,
    reproChancePerStep: 0.08,
  },
];
let ANIMAL_SPECIES = DEFAULT_ANIMAL_PARAMS;
let NUM_ANIMAL_SPECIES = ANIMAL_SPECIES.length;
let ANIMAL_PARAMS_SOURCE = 'defaults';

let animalSprites = [];
let animalSpritesLoaded = [];

function loadAnimalSprites() {
  animalSprites = [];
  animalSpritesLoaded = [];
  ANIMAL_SPECIES.forEach((def, i) => {
    const img = new Image();
    animalSpritesLoaded[i] = false;
    img.onload = () => { animalSpritesLoaded[i] = true; };
    img.onerror = () => { console.warn(`[sprite] Failed to load ${def.spriteFile}.`); };
    img.src = def.spriteFile;
    animalSprites[i] = img;
  });
}

const ANIMAL_PARAM_DEFAULTS = {
  color: [200, 200, 200],
  spriteFile: null,
  initialCount: 10,
  visionRange: 3,
  maxEnergy: 100,
  energyPerStep: 0.5,
  biteAmount: 10,
  energyFromBiomass: 1.2,
  lifespan: 500,
  reproThreshold: 80,
  maxPopulation: 200,
  prey: 'plants',
  spawnStep: 0,
  moveSpeed: 1,
  reproChancePerStep: 1.0,
};

function parseAnimalParams(text) {
  return parseSpeciesParams(text, ANIMAL_PARAM_DEFAULTS);
}

async function loadAnimalParams() {
  // 1. Try fetching the canonical animals.txt (works on HTTP).
  try {
    const resp = await fetch('animals.txt');
    if (resp.ok) {
      const text = await resp.text();
      const parsed = parseAnimalParams(text);
      if (parsed.length) {
        ANIMAL_PARAMS_SOURCE = 'animals.txt (HTTP)';
        return parsed;
      }
    }
  } catch (e) {
    // fetch blocked (typical for file://) -- fall through to inline copy.
  }
  // 2. Try the inline copy embedded in index.html (works on file://).
  const inline = readInlineDataBlock('animals-data');
  if (inline) {
    const parsed = parseAnimalParams(inline);
    if (parsed.length) {
      ANIMAL_PARAMS_SOURCE = 'animals.txt (embedded)';
      return parsed;
    }
  }
  // 3. Last-resort hardcoded defaults.
  console.warn('[animals] animals.txt and inline animals-data both unavailable; using emergency defaults.');
  ANIMAL_PARAMS_SOURCE = 'defaults';
  return DEFAULT_ANIMAL_PARAMS;
}

// Live animal individuals: { species, x, y, energy, age }
let animals = [];
// Tracks which animal species have already been introduced into the world.
let spawnedSpecies = new Set();

function initAnimals() {
  animals = [];
  spawnedSpecies = new Set();
}

function spawnSpecies(sp) {
  const def = ANIMAL_SPECIES[sp];
  const count = Math.max(0, Math.floor(def.initialCount || 0));
  for (let k = 0; k < count; k++) {
    animals.push({
      species: sp,
      x: Math.floor(rand() * M),
      y: Math.floor(rand() * N),
      energy: def.maxEnergy * (0.5 + rand() * 0.5),
      age: 0,
    });
  }
  spawnedSpecies.add(sp);
  flashAnimalRow(sp);
}

// Manually drop N individuals of a species at random cells.
// Bypasses maxPopulation (user-initiated injection).
function dropAnimals(sp, count) {
  const def = ANIMAL_SPECIES[sp];
  const n = Math.max(0, Math.floor(count || 0));
  for (let k = 0; k < n; k++) {
    animals.push({
      species: sp,
      x: Math.floor(rand() * M),
      y: Math.floor(rand() * N),
      energy: def.maxEnergy * (0.5 + rand() * 0.5),
      age: 0,
    });
  }
  spawnedSpecies.add(sp);
  flashAnimalRow(sp);
}

// Check every step whether any species has reached its spawnStep.
function checkSpawnEvents() {
  for (let sp = 0; sp < NUM_ANIMAL_SPECIES; sp++) {
    if (spawnedSpecies.has(sp)) continue;
    const def = ANIMAL_SPECIES[sp];
    const spawnAt = def.spawnStep | 0;
    if (stepCount >= spawnAt) spawnSpecies(sp);
  }
}

function countsByAnimalSpecies() {
  const counts = new Array(NUM_ANIMAL_SPECIES).fill(0);
  for (const a of animals) {
    if (a.energy <= 0) continue; // skip kills not yet swept up
    counts[a.species]++;
  }
  return counts;
}

// Shortest signed delta along a torus axis (returns a value in (-len/2, len/2])
function torDelta(from, to, len) {
  let d = to - from;
  if (d > len / 2) d -= len;
  else if (d < -len / 2) d += len;
  return d;
}

// Resolve prey species names to indices and pre-compute predator lists.
// Called once after ANIMAL_SPECIES is loaded in main().
function computePredatorPreyMap() {
  for (let sp = 0; sp < NUM_ANIMAL_SPECIES; sp++) {
    const def = ANIMAL_SPECIES[sp];
    def._preySpeciesIdx = -1; // -1 means "no animal prey" (eats plants or nothing)
    def._predatorSpeciesIdxs = [];
  }
  for (let sp = 0; sp < NUM_ANIMAL_SPECIES; sp++) {
    const def = ANIMAL_SPECIES[sp];
    if (def.prey && def.prey !== 'plants') {
      const preyName = def.prey;
      const preyIdx = ANIMAL_SPECIES.findIndex(s => s.name === preyName);
      if (preyIdx >= 0) {
        def._preySpeciesIdx = preyIdx;
        ANIMAL_SPECIES[preyIdx]._predatorSpeciesIdxs.push(sp);
      } else {
        console.warn(`[animals] Species "${def.name}" has prey="${preyName}" but no matching species was found.`);
      }
    }
  }
}

function stepAnimals() {
  if (!animals.length) return;
  // Iterate apex predators first so prey reacts to the predator's new position
  // rather than the other way around. Ties are broken by array order.
  const order = animals.slice().sort((x, y) => {
    const ax = ANIMAL_SPECIES[x.species]._predatorSpeciesIdxs.length;
    const ay = ANIMAL_SPECIES[y.species]._predatorSpeciesIdxs.length;
    return ax - ay;
  });
  for (const a of order) {
    if (a.energy <= 0) continue; // killed earlier this tick (e.g. eaten)
    a.age++;
    const def = ANIMAL_SPECIES[a.species];
    const R = def.visionRange;

    // 1. Look for the nearest predator in vision (flee priority).
    let predDx = 0, predDy = 0, minPredDist = Infinity;
    if (def._predatorSpeciesIdxs.length > 0) {
      for (const other of animals) {
        if (other.energy <= 0) continue;
        if (!def._predatorSpeciesIdxs.includes(other.species)) continue;
        const dx = torDelta(a.x, other.x, M);
        const dy = torDelta(a.y, other.y, N);
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > R) continue;
        if (dist < minPredDist) {
          minPredDist = dist;
          predDx = dx;
          predDy = dy;
        }
      }
    }

    // 2. If no predator, look for food (plants or animal prey).
    let foodDx = 0, foodDy = 0, foundFood = false;
    if (minPredDist === Infinity) {
      if (def.prey === 'plants') {
        let bestBio = 0, bestX = a.x, bestY = a.y;
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            if (dx * dx + dy * dy > R * R) continue;
            const yy = ((a.y + dy) % N + N) % N;
            const xx = ((a.x + dx) % M + M) % M;
            const ni = idx(yy, xx);
            if (plantSpecies[ni] < 0) continue;
            if (plantBiomass[ni] > bestBio) {
              bestBio = plantBiomass[ni];
              bestX = xx;
              bestY = yy;
            }
          }
        }
        if (bestBio > 0) {
          foodDx = torDelta(a.x, bestX, M);
          foodDy = torDelta(a.y, bestY, N);
          foundFood = true;
        }
      } else if (def._preySpeciesIdx >= 0) {
        let minDist = Infinity;
        for (const other of animals) {
          if (other.energy <= 0) continue;
          if (other.species !== def._preySpeciesIdx) continue;
          const dx = torDelta(a.x, other.x, M);
          const dy = torDelta(a.y, other.y, N);
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > R) continue;
          if (dist < minDist) {
            minDist = dist;
            foodDx = dx;
            foodDy = dy;
          }
        }
        if (minDist < Infinity) foundFood = true;
      }
    }

    // 3. Decide a one-cell move: flee > pursue > random walk.
    let mx, my;
    if (minPredDist < Infinity) {
      mx = -Math.sign(predDx);
      my = -Math.sign(predDy);
      if (mx === 0 && my === 0) {
        mx = Math.floor(rand() * 3) - 1;
        my = Math.floor(rand() * 3) - 1;
      }
    } else if (foundFood) {
      mx = Math.sign(foodDx);
      my = Math.sign(foodDy);
    } else {
      mx = Math.floor(rand() * 3) - 1;
      my = Math.floor(rand() * 3) - 1;
    }
    const speed = def.moveSpeed || 1;
    a.x = ((a.x + mx * speed) % M + M) % M;
    a.y = ((a.y + my * speed) % N + N) % N;

    // 4. Eat at new location.
    if (def.prey === 'plants') {
      const i = idx(a.y, a.x);
      if (plantSpecies[i] >= 0) {
        const bite = Math.min(def.biteAmount, plantBiomass[i]);
        plantBiomass[i] -= bite;
        a.energy = Math.min(def.maxEnergy, a.energy + bite * def.energyFromBiomass);
        if (plantBiomass[i] <= 0) {
          plantBiomass[i] = 0;
          plantSpecies[i] = -1;
        }
      }
    } else if (def._preySpeciesIdx >= 0) {
      // Eat one prey animal sharing this cell, if any (they will be filtered out
      // by the end-of-step dead-animal pass).
      for (const other of animals) {
        if (other === a || other.energy <= 0) continue;
        if (other.species !== def._preySpeciesIdx) continue;
        if (other.x === a.x && other.y === a.y) {
          a.energy = Math.min(def.maxEnergy, a.energy + def.biteAmount * def.energyFromBiomass);
          other.energy = 0;
          break;
        }
      }
    }

    // 5. Drain baseline energy.
    a.energy -= def.energyPerStep;
  }

  // Reproduction: any individual above reproThreshold spawns one newborn in a
  // random neighbour cell, and the parent's energy is halved (so it must eat
  // again before reproducing again). maxPopulation caps the species count.
  // reproChancePerStep gates each eligible step probabilistically to spread
  // out birth events and smooth the population curve.
  const speciesPop = countsByAnimalSpecies();
  const newborns = [];
  for (const a of animals) {
    const def = ANIMAL_SPECIES[a.species];
    if (a.energy < def.reproThreshold) continue;
    if (speciesPop[a.species] >= def.maxPopulation) continue;
    const chance = def.reproChancePerStep != null ? def.reproChancePerStep : 1.0;
    if (chance < 1.0 && rand() >= chance) continue;
    let dx, dy;
    do {
      dx = Math.floor(rand() * 3) - 1;
      dy = Math.floor(rand() * 3) - 1;
    } while (dx === 0 && dy === 0);
    const cy = ((a.y + dy) % N + N) % N;
    const cx = ((a.x + dx) % M + M) % M;
    const childEnergy = a.energy / 2;
    a.energy = a.energy / 2;
    newborns.push({
      species: a.species,
      x: cx,
      y: cy,
      energy: childEnergy,
      age: 0,
    });
    speciesPop[a.species]++;
  }
  if (newborns.length) animals.push(...newborns);

  // Remove dead (starvation or old age).
  animals = animals.filter(a => {
    const def = ANIMAL_SPECIES[a.species];
    return a.energy > 0 && a.age < def.lifespan;
  });
}

function fitness(sp, i) {
  const dt = Math.abs(temperature[i] - PLANT_SPECIES[sp].optTemp);
  const dh = Math.abs(humidity[i]    - PLANT_SPECIES[sp].optHum);
  return Math.max(0, 1 - (dt + dh));
}

function initPlants() {
  plantSpecies.fill(-1);
  plantBiomass.fill(0);
  const spotsPerSpecies = 20;
  for (let sp = 0; sp < NUM_PLANT_SPECIES; sp++) {
    let placed = 0, tries = 0;
    while (placed < spotsPerSpecies && tries < spotsPerSpecies * 10) {
      const x = Math.floor(rand() * M);
      const y = Math.floor(rand() * N);
      const i = idx(y, x);
      if (plantSpecies[i] < 0) {
        plantSpecies[i] = sp;
        plantBiomass[i] = PLANT_SPECIES[sp].spreadThresh + rand() * 10;
        placed++;
      }
      tries++;
    }
  }
}

function stepPlants() {
  const ns = new Int8Array(plantSpecies);
  const nb = new Float32Array(plantBiomass);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < M; x++) {
      const i = idx(y, x);
      const sp = plantSpecies[i];
      if (sp < 0) continue;
      const fit = fitness(sp, i);
      const def = PLANT_SPECIES[sp];
      // Growth or decay
      if (fit > PLANT_GROW_FIT_THRESHOLD) {
        nb[i] = Math.min(def.maxBio, nb[i] + def.growth * fit);
      } else if (fit < PLANT_DECAY_FIT_THRESHOLD) {
        nb[i] = nb[i] - def.decay;
        if (nb[i] <= 0) {
          nb[i] = 0;
          ns[i] = -1;
        }
      }
      // Seed dispersal: if biomass exceeds threshold, randomly spread to a neighbor
      if (plantBiomass[i] > def.spreadThresh && rand() < PLANT_SPREAD_PROB) {
        const dy = Math.floor(rand() * 3) - 1;
        const dx = Math.floor(rand() * 3) - 1;
        if (dy === 0 && dx === 0) continue;
        const yy = (y + dy + N) % N;
        const xx = (x + dx + M) % M;
        const ni = idx(yy, xx);
        const targetSp = ns[ni];
        if (targetSp < 0) {
          // Empty cell -> colonize with a small biomass
          ns[ni] = sp;
          nb[ni] = 5;
        } else if (targetSp !== sp) {
          // Different species -> invade only if fitness is clearly higher
          const myFit = fitness(sp, ni);
          const otherFit = fitness(targetSp, ni);
          if (myFit > otherFit + PLANT_INVADE_FIT_DELTA) {
            nb[ni] = Math.max(0, nb[ni] - 4);
            if (nb[ni] <= 0) {
              ns[ni] = sp;
              nb[ni] = 5;
            }
          }
        }
      }
    }
  }
  plantSpecies = ns;
  plantBiomass = nb;
}

function countAlive() {
  let n = 0;
  for (let i = 0; i < plantSpecies.length; i++) if (plantSpecies[i] >= 0) n++;
  return n;
}

function countsByPlantSpecies() {
  const counts = new Array(NUM_PLANT_SPECIES).fill(0);
  for (let i = 0; i < plantSpecies.length; i++) {
    const sp = plantSpecies[i];
    if (sp >= 0) counts[sp]++;
  }
  return counts;
}

// ========================================================================
// Status panel (DOM)
// ========================================================================
const elVersion = document.getElementById('status-version');
const elStep    = document.getElementById('status-step');
const elAlive   = document.getElementById('status-alive');
const elPlants  = document.getElementById('status-plants');
const elAnimals = document.getElementById('status-animals');
const elDrop    = document.getElementById('status-drop');
const elPlantCounts  = []; // Per-plant-species count display elements
const elAnimalCounts = []; // Per-animal-species count display elements
let dropCounts = [];        // Per-animal-species "Drop" amount (user-adjustable)

// Build a "Source: file / defaults" indicator row.
// The source string may be "<filename> (HTTP)", "<filename> (embedded)",
// or "defaults". Green for any successful load, red for emergency defaults.
function makeSourceRow(filename, source) {
  const row = document.createElement('div');
  row.className = 'small';
  row.style.marginBottom = '6px';
  if (source && source.indexOf(filename) === 0) {
    row.textContent = `Source: ${source}`;
    row.style.color = '#9c9';
  } else {
    row.textContent = `Source: emergency defaults (${filename} not loaded)`;
    row.style.color = '#d99';
  }
  return row;
}

// Build an inline pill { dot, name, count } and return the count element.
function appendCompactPill(parent, def, dotExtraClass) {
  const colorCss = `rgb(${def.color[0]}, ${def.color[1]}, ${def.color[2]})`;
  const pill = document.createElement('span');
  pill.className = 'compact-pill';
  pill.innerHTML = `
    <span class="dot ${dotExtraClass || ''}" style="background:${colorCss}"></span>
    <span class="pill-name">${def.name}</span>
    <span class="pill-count">0</span>
  `;
  parent.appendChild(pill);
  return pill.querySelector('.pill-count');
}

function initStatusPanel() {
  elVersion.textContent = `v${VERSION}`;

  // Plants section (compact inline pills)
  elPlants.innerHTML = '';
  elPlantCounts.length = 0;
  elPlants.appendChild(makeSourceRow('plants.txt', PLANT_PARAMS_SOURCE));
  const plantList = document.createElement('div');
  plantList.className = 'compact-list';
  elPlants.appendChild(plantList);
  for (let sp = 0; sp < NUM_PLANT_SPECIES; sp++) {
    elPlantCounts.push(appendCompactPill(plantList, PLANT_SPECIES[sp]));
  }

  // Animals section
  if (elAnimals) {
    elAnimals.innerHTML = '';
    elAnimalCounts.length = 0;
    elAnimals.appendChild(makeSourceRow('animals.txt', ANIMAL_PARAMS_SOURCE));
    const animalList = document.createElement('div');
    animalList.className = 'compact-list';
    elAnimals.appendChild(animalList);
    for (let sp = 0; sp < NUM_ANIMAL_SPECIES; sp++) {
      elAnimalCounts.push(appendCompactPill(animalList, ANIMAL_SPECIES[sp], 'circle'));
    }
  }
}

function updateStatusPanel() {
  elStep.textContent = formatStep(stepCount);
  const plantCounts = countsByPlantSpecies();
  const animalCounts = countsByAnimalSpecies();
  const plantTotal = plantCounts.reduce((a, b) => a + b, 0);
  const animalTotal = animalCounts.reduce((a, b) => a + b, 0);
  elAlive.textContent = plantTotal + animalTotal;
  for (let sp = 0; sp < NUM_PLANT_SPECIES; sp++) {
    elPlantCounts[sp].textContent = plantCounts[sp];
  }
  for (let sp = 0; sp < NUM_ANIMAL_SPECIES; sp++) {
    elAnimalCounts[sp].textContent = animalCounts[sp];
  }
}

// Build the Manual Drop section: one row per animal species with -/+ to
// adjust the drop count and a Drop button to inject that many individuals
// at random cells.
function initDropPanel() {
  if (!elDrop) return;
  elDrop.innerHTML = '';
  // Preserve previously-set drop counts where possible (e.g. after applying
  // the parameter editor); fall back to 10 for any new slots.
  const prev = dropCounts.slice();
  dropCounts = [];
  for (let sp = 0; sp < NUM_ANIMAL_SPECIES; sp++) {
    dropCounts.push(prev[sp] != null ? prev[sp] : 10);
  }
  for (let sp = 0; sp < NUM_ANIMAL_SPECIES; sp++) {
    const def = ANIMAL_SPECIES[sp];
    const row = document.createElement('div');
    row.className = 'drop-row';
    row.innerHTML = `
      <span class="drop-label">${def.name}</span>
      <button class="drop-step-btn" type="button" aria-label="Decrease">&minus;</button>
      <span class="drop-count">${dropCounts[sp]}</span>
      <button class="drop-step-btn" type="button" aria-label="Increase">+</button>
      <button class="drop-action-btn" type="button">Drop</button>
    `;
    elDrop.appendChild(row);
    const stepBtns = row.querySelectorAll('.drop-step-btn');
    const decBtn = stepBtns[0];
    const incBtn = stepBtns[1];
    const countEl = row.querySelector('.drop-count');
    const actionBtn = row.querySelector('.drop-action-btn');
    decBtn.addEventListener('click', () => {
      dropCounts[sp] = Math.max(1, dropCounts[sp] - 1);
      countEl.textContent = dropCounts[sp];
    });
    incBtn.addEventListener('click', () => {
      dropCounts[sp]++;
      countEl.textContent = dropCounts[sp];
    });
    actionBtn.addEventListener('click', () => {
      dropAnimals(sp, dropCounts[sp]);
      updateStatusPanel();
      draw();
    });
  }
}

// ========================================================================
// Parameter editor (screen 2 overlay)
// ========================================================================
// Saved simulator state so we can restore on exit from the editor.
let editorSavedSpeedLevel = 1;

// Number of plant-rule fields (used to clean up between renders).
const PLANT_RULE_FIELDS = [
  { key: 'PLANT_GROW_FIT_THRESHOLD',  label: 'growFitThresh',  step: 0.05, min: 0, max: 1 },
  { key: 'PLANT_DECAY_FIT_THRESHOLD', label: 'decayFitThresh', step: 0.05, min: 0, max: 1 },
  { key: 'PLANT_SPREAD_PROB',         label: 'spreadProb',     step: 0.01, min: 0, max: 1 },
  { key: 'PLANT_INVADE_FIT_DELTA',    label: 'invadeFitDelta', step: 0.01, min: 0, max: 1 },
];

const PLANT_SPECIES_FIELDS = [
  { key: 'name',         label: 'name',         type: 'string' },
  { key: 'color',        label: 'color',        type: 'rgb' },
  { key: 'optTemp',      label: 'optTemp',      type: 'float', step: 0.01, min: 0, max: 1 },
  { key: 'optHum',       label: 'optHum',       type: 'float', step: 0.01, min: 0, max: 1 },
  { key: 'growth',       label: 'growth',       type: 'float', step: 0.05, min: 0 },
  { key: 'decay',        label: 'decay',        type: 'float', step: 0.1,  min: 0 },
  { key: 'maxBio',       label: 'maxBio',       type: 'int',   step: 1,    min: 1 },
  { key: 'spreadThresh', label: 'spreadThresh', type: 'int',   step: 1,    min: 1 },
];

const ANIMAL_SPECIES_FIELDS = [
  { key: 'name',              label: 'name',              type: 'string' },
  { key: 'color',             label: 'color',             type: 'rgb' },
  { key: 'initialCount',      label: 'initialCount',      type: 'int',   step: 1, min: 0 },
  { key: 'spawnStep',         label: 'spawnStep',         type: 'int',   step: 50, min: 0 },
  { key: 'visionRange',       label: 'visionRange',       type: 'int',   step: 1, min: 0 },
  { key: 'moveSpeed',         label: 'moveSpeed',         type: 'int',   step: 1, min: 1 },
  { key: 'maxEnergy',         label: 'maxEnergy',         type: 'float', step: 1, min: 1 },
  { key: 'energyPerStep',     label: 'energyPerStep',     type: 'float', step: 0.05, min: 0 },
  { key: 'biteAmount',        label: 'biteAmount',        type: 'float', step: 1, min: 0 },
  { key: 'energyFromBiomass', label: 'energyFromBiomass', type: 'float', step: 0.05, min: 0 },
  { key: 'lifespan',          label: 'lifespan',          type: 'int',   step: 10, min: 1 },
  { key: 'reproThreshold',     label: 'reproThreshold',     type: 'float', step: 1, min: 0 },
  { key: 'maxPopulation',      label: 'maxPopulation',      type: 'int',   step: 1, min: 1 },
  { key: 'reproChancePerStep', label: 'reproChancePerStep', type: 'float', step: 0.05, min: 0, max: 1 },
  { key: 'prey',               label: 'prey',               type: 'string' },
];

function rgbToHex(rgb) {
  const r = Math.max(0, Math.min(255, (rgb && rgb[0]) || 0)).toString(16).padStart(2, '0');
  const g = Math.max(0, Math.min(255, (rgb && rgb[1]) || 0)).toString(16).padStart(2, '0');
  const b = Math.max(0, Math.min(255, (rgb && rgb[2]) || 0)).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}
function hexToRgb(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  if (!m) return [128, 128, 128];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
function inputForField(value, field) {
  if (field.type === 'rgb') {
    return `<input type="color" data-key="${field.key}" data-type="rgb" value="${rgbToHex(value)}">`;
  }
  if (field.type === 'string') {
    return `<input type="text" data-key="${field.key}" data-type="string" value="${value != null ? value : ''}">`;
  }
  // number
  const step = field.step != null ? ` step="${field.step}"` : '';
  const min  = field.min  != null ? ` min="${field.min}"` : '';
  const max  = field.max  != null ? ` max="${field.max}"` : '';
  return `<input type="number" data-key="${field.key}" data-type="${field.type}"${step}${min}${max} value="${value}">`;
}
function parseInputValue(inp) {
  const t = inp.dataset.type;
  if (t === 'int')   return parseInt(inp.value, 10);
  if (t === 'float') return parseFloat(inp.value);
  if (t === 'rgb')   return hexToRgb(inp.value);
  return inp.value;
}

function buildSpeciesCard(def, fields, indexAttr, indexValue) {
  const card = document.createElement('div');
  card.className = 'editor-card';
  card.setAttribute(indexAttr, indexValue);
  let html = `<h4>${def.name}</h4>`;
  for (const f of fields) {
    html += `<label><span class="field-name">${f.label}</span>${inputForField(def[f.key], f)}</label>`;
  }
  card.innerHTML = html;
  return card;
}

function buildGlobalCard(title, entries) {
  // entries: [{ key, label, valueGetter, type, step, min, max }]
  const card = document.createElement('div');
  card.className = 'editor-card';
  let html = `<h4>${title}</h4>`;
  for (const e of entries) {
    html += `<label><span class="field-name">${e.label}</span>${inputForField(e.value, e)}</label>`;
  }
  card.innerHTML = html;
  return card;
}

function renderEditor() {
  // Plants
  const elP = document.getElementById('editor-plants');
  elP.innerHTML = '';
  PLANT_SPECIES.forEach((def, i) => {
    elP.appendChild(buildSpeciesCard(def, PLANT_SPECIES_FIELDS, 'data-plant-idx', String(i)));
  });
  // Animals
  const elA = document.getElementById('editor-animals');
  elA.innerHTML = '';
  ANIMAL_SPECIES.forEach((def, i) => {
    elA.appendChild(buildSpeciesCard(def, ANIMAL_SPECIES_FIELDS, 'data-animal-idx', String(i)));
  });
  // Plant rules (global)
  const elR = document.getElementById('editor-plant-rules');
  elR.innerHTML = '';
  const ruleValues = {
    PLANT_GROW_FIT_THRESHOLD,
    PLANT_DECAY_FIT_THRESHOLD,
    PLANT_SPREAD_PROB,
    PLANT_INVADE_FIT_DELTA,
  };
  const ruleEntries = PLANT_RULE_FIELDS.map(f => ({ ...f, type: 'float', value: ruleValues[f.key] }));
  elR.appendChild(buildGlobalCard('Plant rules', ruleEntries));
  // Environment
  const elE = document.getElementById('editor-env');
  if (elE) {
    elE.innerHTML = '';
    const envEntries = [
      { key: 'ENV_HUMIDITY_POINTS', label: 'humidityPoints', type: 'int',   step: 1, min: 1, value: ENV_HUMIDITY_POINTS },
      { key: 'ENV_HUMIDITY_RANGE',  label: 'humidityRange',  type: 'float', step: 1, min: 1, value: ENV_HUMIDITY_RANGE },
    ];
    elE.appendChild(buildGlobalCard('Environment', envEntries));
  }
  // Simulation
  const elS = document.getElementById('editor-sim');
  elS.innerHTML = '';
  const simEntries = [
    { key: 'LOG_INTERVAL', label: 'LOG_INTERVAL', type: 'int', step: 1, min: 1, value: LOG_INTERVAL },
  ];
  elS.appendChild(buildGlobalCard('Simulation', simEntries));
}

function applyEditor() {
  // Plants per-species
  document.querySelectorAll('#editor-plants .editor-card').forEach(card => {
    const i = parseInt(card.dataset.plantIdx, 10);
    const def = PLANT_SPECIES[i];
    if (!def) return;
    card.querySelectorAll('input[data-key]').forEach(inp => {
      def[inp.dataset.key] = parseInputValue(inp);
    });
  });
  // Animals per-species
  document.querySelectorAll('#editor-animals .editor-card').forEach(card => {
    const i = parseInt(card.dataset.animalIdx, 10);
    const def = ANIMAL_SPECIES[i];
    if (!def) return;
    card.querySelectorAll('input[data-key]').forEach(inp => {
      def[inp.dataset.key] = parseInputValue(inp);
    });
  });
  // Plant rules (global) — write to specific named globals
  document.querySelectorAll('#editor-plant-rules input[data-key]').forEach(inp => {
    const v = parseInputValue(inp);
    switch (inp.dataset.key) {
      case 'PLANT_GROW_FIT_THRESHOLD':  PLANT_GROW_FIT_THRESHOLD = v; break;
      case 'PLANT_DECAY_FIT_THRESHOLD': PLANT_DECAY_FIT_THRESHOLD = v; break;
      case 'PLANT_SPREAD_PROB':         PLANT_SPREAD_PROB = v; break;
      case 'PLANT_INVADE_FIT_DELTA':    PLANT_INVADE_FIT_DELTA = v; break;
    }
  });
  // Environment (regenerate the env map only if a value actually changed)
  let envChanged = false;
  document.querySelectorAll('#editor-env input[data-key]').forEach(inp => {
    const v = parseInputValue(inp);
    switch (inp.dataset.key) {
      case 'ENV_HUMIDITY_POINTS':
        if (v !== ENV_HUMIDITY_POINTS) { ENV_HUMIDITY_POINTS = v; envChanged = true; }
        break;
      case 'ENV_HUMIDITY_RANGE':
        if (v !== ENV_HUMIDITY_RANGE) { ENV_HUMIDITY_RANGE = v; envChanged = true; }
        break;
    }
  });
  if (envChanged) initEnvironment();
  // Simulation
  document.querySelectorAll('#editor-sim input[data-key]').forEach(inp => {
    const v = parseInputValue(inp);
    switch (inp.dataset.key) {
      case 'LOG_INTERVAL': LOG_INTERVAL = Math.max(1, v); break;
    }
  });
  // Refresh derived state
  computePredatorPreyMap(); // prey field may have changed
  loadPlantSprites();       // spriteFile / order may have changed (color picker keeps spriteFile)
  loadAnimalSprites();
  // Re-render the status panel legend so colors update.
  initStatusPanel();
  initDropPanel();
}

function enterEditMode() {
  editorSavedSpeedLevel = speedLevel;
  // Force pause while editing (do not surface this as "user paused").
  if (!paused) setPaused(true);
  renderEditor();
  // Refresh the seed display + clear the seed input each time the editor opens.
  updateSeedDisplay();
  const seedInput = document.getElementById('editor-seed-input');
  if (seedInput) seedInput.value = '';
  const ov = document.getElementById('editor-overlay');
  if (ov) {
    ov.classList.add('visible');
    ov.setAttribute('aria-hidden', 'false');
  }
}

function exitEditMode(submit) {
  if (submit) applyEditor();
  const ov = document.getElementById('editor-overlay');
  if (ov) {
    ov.classList.remove('visible');
    ov.setAttribute('aria-hidden', 'true');
  }
  // Restore previous speed and resume.
  speedLevel = editorSavedSpeedLevel;
  document.querySelectorAll('.speed-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.speed, 10) === speedLevel);
  });
  if (!gameOver) setPaused(false);
}

// Flash the legend pill of an animal species when it is first introduced.
function flashAnimalRow(speciesIdx) {
  const countEl = elAnimalCounts[speciesIdx];
  if (!countEl) return;
  const pill = countEl.closest('.compact-pill') || countEl.closest('.legend-row');
  if (!pill) return;
  pill.classList.remove('flash');
  // Force reflow so the animation restarts even if re-flashed quickly.
  void pill.offsetWidth;
  pill.classList.add('flash');
}

// Step the world: plants first (growth/spread), then animals (move/eat/age).
function step() {
  stepPlants();
  stepAnimals();
}

function randInit() {
  initEnvironment();
  initPlants();
  initAnimals();
  stepCount = 0;
  prevGrid = null;
  prev2Grid = null;
  gameOver = false;
  // Spawn any species whose spawnStep <= 0 immediately at step 0.
  checkSpawnEvents();
  aliveHistory = [];
  recordHistoryPoint();
  initRunLog();
  appendRunLog(); // record initial state at step 0
}

// Append the current step's per-species counts to aliveHistory.
function recordHistoryPoint() {
  aliveHistory.push({
    step: stepCount,
    plantCounts: countsByPlantSpecies(),
    animalCounts: countsByAnimalSpecies(),
  });
}

// ========================================================================
// Rendering
// ========================================================================
const ctx = document.getElementById("cv").getContext("2d");

// Draw a multi-series time-series graph (plants + animals) into a rectangle
// on the given context. Used by both the GAME OVER overlay and the
// status-panel mini graph. The `history` argument is an array of records
// produced by recordHistoryPoint().
//
// options: { background?, showLegend?, showLabels? }
function drawMultiSeriesGraph(ctx, x, y, w, h, history, options) {
  options = options || {};
  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(x, y, w, h);
  }
  const n = history.length;
  if (n === 0) return;

  const padL = options.showLabels ? 36 : 4;
  const padR = options.showLegend ? 120 : 4;
  const padT = 6;
  const padB = options.showLabels ? 18 : 4;
  const gx = x + padL;
  const gy = y + padT;
  const gw = w - padL - padR;
  const gh = h - padT - padB;
  if (gw < 10 || gh < 10) return;

  // Y range: max across every species
  let maxV = 1;
  for (const e of history) {
    for (const c of e.plantCounts)  if (c > maxV) maxV = c;
    for (const c of e.animalCounts) if (c > maxV) maxV = c;
  }

  const xScale = (i) => gx + (n <= 1 ? 0 : (i / (n - 1)) * gw);
  const yScale = (v) => gy + (1 - v / maxV) * gh;

  // Grid and Y labels
  if (options.showLabels) {
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const yy = gy + (i / 4) * gh;
      ctx.beginPath();
      ctx.moveTo(gx, yy);
      ctx.lineTo(gx + gw, yy);
      ctx.stroke();
      ctx.fillText(String(Math.round(maxV * (1 - i / 4))), gx - 4, yy);
    }
  }

  // Build series in (plants first, animals after) order
  const series = [];
  for (let sp = 0; sp < NUM_PLANT_SPECIES; sp++) {
    series.push({
      name: PLANT_SPECIES[sp].name,
      color: PLANT_SPECIES[sp].color,
      data: history.map(e => e.plantCounts[sp] || 0),
    });
  }
  for (let sp = 0; sp < NUM_ANIMAL_SPECIES; sp++) {
    series.push({
      name: ANIMAL_SPECIES[sp].name,
      color: ANIMAL_SPECIES[sp].color,
      data: history.map(e => e.animalCounts[sp] || 0),
    });
  }

  ctx.lineWidth = 1.5;
  for (const s of series) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const px = xScale(i);
      const py = yScale(s.data[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = `rgb(${s.color[0]},${s.color[1]},${s.color[2]})`;
    ctx.stroke();
  }

  // Legend
  if (options.showLegend && series.length > 0) {
    const lx = gx + gw + 8;
    const ly = gy;
    ctx.font = "11px sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (let i = 0; i < series.length; i++) {
      const s = series[i];
      const py = ly + i * 18 + 8;
      ctx.fillStyle = `rgb(${s.color[0]},${s.color[1]},${s.color[2]})`;
      ctx.fillRect(lx, py - 6, 12, 12);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillText(`${s.name}: ${s.data[n - 1]}`, lx + 16, py);
    }
  }

  // X-axis labels
  if (options.showLabels) {
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(`step ${history[0].step}`, gx, gy + gh + 4);
    ctx.textAlign = "right";
    ctx.fillText(`step ${history[n - 1].step}`, gx + gw, gy + gh + 4);
  }

  // Restore canvas defaults
  ctx.textAlign = "start";
  ctx.textBaseline = "top";
}

function envColor(t, h) {
  // Cold (t=0): blue-gray to dark blue; warm (t=1): ochre to deep green (humid side)
  const r = Math.round((1 - t) * (60 - 15 * h) + t * (190 - 140 * h));
  const g = Math.round((1 - t) * (75 - 10 * h) + t * (155 - 35 * h));
  const b = Math.round((1 - t) * (115 - 25 * h) + t * (90  - 30 * h));
  return `rgb(${r}, ${g}, ${b})`;
}

function draw() {
  ctx.clearRect(0, 0, M * cell, N * cell);

  // 1. Environment (background)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < M; x++) {
      const i = idx(y, x);
      ctx.fillStyle = envColor(temperature[i], humidity[i]);
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  // 2. Plants: draw per-species sprite if loaded, otherwise fall back to translucent colored rect
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < M; x++) {
      const i = idx(y, x);
      const sp = plantSpecies[i];
      if (sp < 0) continue;
      const def = PLANT_SPECIES[sp];
      const alpha = Math.min(1, 0.35 + 0.65 * (plantBiomass[i] / def.maxBio));
      if (plantSpritesLoaded[sp]) {
        ctx.globalAlpha = alpha;
        ctx.drawImage(plantSprites[sp], x * cell, y * cell, cell, cell);
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = `rgba(${def.color[0]}, ${def.color[1]}, ${def.color[2]}, ${alpha})`;
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
  }

  // 3. Animals: draw per-species sprite (or fallback circle) at each individual's cell
  for (const a of animals) {
    const def = ANIMAL_SPECIES[a.species];
    const px = a.x * cell;
    const py = a.y * cell;
    if (animalSpritesLoaded[a.species]) {
      ctx.drawImage(animalSprites[a.species], px, py, cell, cell);
    } else {
      ctx.beginPath();
      ctx.arc(px + cell / 2, py + cell / 2, cell / 2.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${def.color[0]}, ${def.color[1]}, ${def.color[2]})`;
      ctx.fill();
    }
  }

  // 4. POST success / failure badge (top-right of canvas)
  if (Date.now() - postOkTimestamp < POST_DISPLAY_MS ||
      Date.now() - postFailTimestamp < POST_FAIL_DISPLAY_MS) {
    const isOk = (Date.now() - postOkTimestamp < POST_DISPLAY_MS);
    const badgeText = isOk ? 'POST' : 'POST FAILED';
    ctx.font = '12px sans-serif';
    const bw = ctx.measureText(badgeText).width + 10;
    const bh = 16;
    const bx = M * cell - bw - 8;
    const by = 8;
    ctx.fillStyle = isOk ? 'rgba(0,128,0,0.9)' : 'rgba(200,0,0,0.9)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = 'white';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(badgeText, bx + bw / 2, by + bh / 2);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'top';
  }

  // 5. Game over overlay (when both plants and animals are gone)
  if (gameOver) {
    const cw = M * cell;
    const ch = N * cell;
    const title = "SIMULATION ENDED";
    const last = aliveHistory.length ? aliveHistory[aliveHistory.length - 1] : null;
    const totalAlive = last
      ? last.plantCounts.reduce((a, b) => a + b, 0) + last.animalCounts.reduce((a, b) => a + b, 0)
      : countAlive() + animals.length;
    const stepLine = `Step: ${formatStep(stepCount)}`;
    const aliveLine = `Alive: ${totalAlive}`;

    const titleSize = Math.max(24, Math.floor(Math.min(cw, ch) / 12));
    const subSize = Math.max(14, Math.floor(titleSize / 2.2));

    const pad = 20;
    ctx.font = `${titleSize}px sans-serif`;
    const tw = ctx.measureText(title).width;
    ctx.font = `${subSize}px sans-serif`;
    const swStep = ctx.measureText(stepLine).width;
    const swAlive = ctx.measureText(aliveLine).width;
    const sw = Math.max(swStep, swAlive);
    const boxW2 = Math.max(tw, sw) + pad * 2;
    const boxH2 = titleSize + subSize * 2 + pad * 2 + 6;

    const boxX2 = (cw - boxW2) / 2;
    const boxY2 = (ch - boxH2) / 4; // shift up so it doesn't cover the graph

    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(boxX2, boxY2, boxW2, boxH2);

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "white";
    ctx.font = `${titleSize}px sans-serif`;
    ctx.fillText(title, cw / 2, boxY2 + pad / 2);
    ctx.font = `${subSize}px sans-serif`;
    ctx.fillText(stepLine, cw / 2, boxY2 + pad / 2 + titleSize);
    ctx.fillText(aliveLine, cw / 2, boxY2 + pad / 2 + titleSize + subSize + 4);

    ctx.textAlign = "start";
    ctx.textBaseline = "top";

    // 5-series time-series graph in the bottom half (plants + animals)
    drawMultiSeriesGraph(ctx, 0, Math.floor(ch * 0.45), cw, Math.ceil(ch * 0.55), aliveHistory, {
      background: 'rgba(0,0,0,0.8)',
      showLegend: true,
      showLabels: true,
      labelStep: stepCount,
    });
  }

  // 6. Paused overlay (skipped when game over already shows its own overlay)
  if (paused && !gameOver) {
    const cw = M * cell;
    const ch = N * cell;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, cw, ch);
    const titleSize = Math.max(36, Math.floor(Math.min(cw, ch) / 14));
    ctx.font = `bold ${titleSize}px sans-serif`;
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("PAUSED", cw / 2, ch / 2 - titleSize * 0.4);
    ctx.font = "14px sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.fillText("Press Space or click Resume to continue", cw / 2, ch / 2 + titleSize * 0.6);
    ctx.textAlign = "start";
    ctx.textBaseline = "top";
  }
}

// Advance the world by exactly one step and update all derived state.
// Returns true if the simulation should continue (alive total > 0), or
// false if it just transitioned to game over.
function doOneStep() {
  if (gameOver) return false;
  step();
  stepCount++;
  checkSpawnEvents();
  const plantAlive = countAlive();
  const aliveTotal = plantAlive + animals.length;
  recordHistoryPoint();
  appendRunLog();
  if (aliveTotal === 0) {
    gameOver = true;
    sendResult(aliveTotal, stepCount);
    updateStatusPanel();
    draw();
    return false;
  }
  updateStatusPanel();
  draw();
  return true;
}

// Main loop
function loop() {
  if (gameOver) return;
  if (paused) { loopTimeoutHandle = null; return; }
  if (!doOneStep()) return;
  loopTimeoutHandle = setTimeout(loop, SPEED_DELAYS_MS[speedLevel]);
}

// Advance exactly one step. Used by the "Step ›" button while paused.
function stepOnce() {
  if (gameOver) return;
  if (!paused) return; // only step while paused; otherwise the loop is running
  doOneStep();
}

// Reset the world: re-init env / plants / animals, optionally with a seed
// parsed from the editor's seed input field. Empty input = random.
// If called from inside the editor overlay, also applies any other parameter
// edits the user made and then closes the overlay.
function resetWorld() {
  // If we're in the editor, apply the rest of the form first so the user's
  // parameter edits land in PLANT_SPECIES / ANIMAL_SPECIES before re-init.
  const editorOpen = document.getElementById('editor-overlay')?.classList.contains('visible');
  if (editorOpen) applyEditor();

  // Cancel any pending step so we don't race the re-init.
  if (loopTimeoutHandle !== null) {
    clearTimeout(loopTimeoutHandle);
    loopTimeoutHandle = null;
  }
  // Apply seed from input (in editor)
  const inp = document.getElementById('editor-seed-input');
  const raw = inp ? inp.value.trim() : '';
  if (raw === '') {
    applySeed(null);
  } else {
    const n = parseInt(raw, 10);
    applySeed(Number.isFinite(n) ? n : null);
  }
  randInit();
  initStatusPanel();
  initDropPanel();
  updateStatusPanel();
  draw();
  updateSeedDisplay();
  // Close the editor if it was open, and restore speed/run state.
  if (editorOpen) {
    const ov = document.getElementById('editor-overlay');
    if (ov) {
      ov.classList.remove('visible');
      ov.setAttribute('aria-hidden', 'true');
    }
    speedLevel = editorSavedSpeedLevel;
    document.querySelectorAll('.speed-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.speed, 10) === speedLevel);
    });
    if (!gameOver) setPaused(false);
  } else if (!paused && !gameOver) {
    loop();
  }
}

function updateSeedDisplay() {
  const el = document.getElementById('editor-seed-current');
  if (el) el.textContent = _seedAtRunStart === null ? 'random' : String(_seedAtRunStart);
}

function setPaused(p) {
  paused = !!p;
  const btn = document.getElementById('btn-pause');
  if (btn) {
    btn.textContent = paused ? 'Resume (Space)' : 'Pause (Space)';
    btn.classList.toggle('active', paused);
  }
  // The Step button is only useful while paused.
  const stepBtn = document.getElementById('btn-step');
  if (stepBtn) stepBtn.disabled = !paused || gameOver;
  if (paused) {
    if (loopTimeoutHandle !== null) {
      clearTimeout(loopTimeoutHandle);
      loopTimeoutHandle = null;
    }
    draw(); // repaint so the PAUSED overlay shows immediately
  } else if (!gameOver && loopTimeoutHandle === null) {
    // Resume immediately at the chosen speed.
    loop();
  }
}

function togglePause() {
  if (gameOver) return;
  setPaused(!paused);
}

// Build a floating tooltip that reports temperature, humidity, plant and any
// animals at the cell currently under the mouse cursor.
function setupCanvasTooltip() {
  const cvEl = document.getElementById('cv');
  if (!cvEl) return;
  const tip = document.createElement('div');
  tip.className = 'canvas-tooltip';
  document.body.appendChild(tip);

  function render(cx, cy, clientX, clientY) {
    const i = idx(cy, cx);
    const lines = [];
    lines.push(`Cell (${cx}, ${cy})  step ${stepCount}`);
    lines.push(`Temp ${temperature[i].toFixed(2)}   Hum ${humidity[i].toFixed(2)}`);
    const sp = plantSpecies[i];
    if (sp >= 0) {
      const def = PLANT_SPECIES[sp];
      lines.push(`Plant: ${def.name} (${plantBiomass[i].toFixed(0)} / ${def.maxBio})`);
    } else {
      lines.push(`Plant: -`);
    }
    const here = [];
    for (const a of animals) {
      if (a.energy <= 0) continue;
      if (a.x === cx && a.y === cy) here.push(a);
    }
    if (here.length > 0) {
      lines.push(`Animals on this cell:`);
      for (const a of here) {
        const def = ANIMAL_SPECIES[a.species];
        lines.push(`  ${def.name}  e=${a.energy.toFixed(1)} age=${a.age}`);
      }
    }
    tip.innerHTML = lines.join('<br>');
    // Position offset from cursor; flip to the left if near right edge
    const offset = 14;
    let x = clientX + offset;
    let y = clientY + offset;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    if (x + tw + 8 > window.innerWidth)  x = clientX - offset - tw;
    if (y + th + 8 > window.innerHeight) y = clientY - offset - th;
    tip.style.left = x + 'px';
    tip.style.top  = y + 'px';
    tip.classList.add('visible');
  }

  cvEl.addEventListener('mousemove', (e) => {
    const rect = cvEl.getBoundingClientRect();
    const scaleX = cvEl.width  / rect.width;
    const scaleY = cvEl.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top)  * scaleY;
    const cx = Math.floor(px / cell);
    const cy = Math.floor(py / cell);
    if (cx < 0 || cx >= M || cy < 0 || cy >= N) {
      tip.classList.remove('visible');
      return;
    }
    render(cx, cy, e.clientX, e.clientY);
  });
  cvEl.addEventListener('mouseleave', () => {
    tip.classList.remove('visible');
  });
}

// Detect whether this page is being served from a vN/ snapshot folder
// and adjust the top navigation link + window title accordingly.
function setupVersionNav() {
  const inVersionFolder = /\/v\d+\//.test(window.location.pathname);
  const navEl = document.getElementById('version-nav');
  if (navEl) {
    if (inVersionFolder) {
      navEl.innerHTML =
        '<a href="../index_old_version_menu.html">&larr; Other versions</a>' +
        ` <span class="muted">| frozen v${VERSION}</span>`;
    } else {
      navEl.innerHTML =
        '<a href="index_old_version_menu.html">Other versions &rarr;</a>' +
        ` <span class="muted">| latest v${VERSION}</span>`;
    }
  }
  document.title = inVersionFolder
    ? `Ecosystem Simulator - v${VERSION} (frozen)`
    : `Ecosystem Simulator - v${VERSION} (latest)`;
}

// ========================================================================
// Run log (TSV) - records simulation state each step for later analysis.
// ========================================================================

function initRunLog() {
  runLog = [];
  runLogStartedAt = new Date().toISOString();

  // Metadata header
  runLog.push(`# Ecosystem Simulator run log`);
  runLog.push(`# Version: v${VERSION}`);
  runLog.push(`# Started: ${runLogStartedAt}`);
  runLog.push(`# Seed: ${_seedAtRunStart === null ? 'random' : _seedAtRunStart}`);
  runLog.push(`# Grid: N=${N}, M=${M}, cell=${cell}`);
  runLog.push(`# Plant params source: ${PLANT_PARAMS_SOURCE}`);
  runLog.push(`# Animal params source: ${ANIMAL_PARAMS_SOURCE}`);
  runLog.push(`# Log interval: every ${LOG_INTERVAL} step(s)`);
  runLog.push(`#`);
  runLog.push(`# Plant species:`);
  for (const s of PLANT_SPECIES) {
    runLog.push(`#   ${s.name}: optTemp=${s.optTemp} optHum=${s.optHum} growth=${s.growth} decay=${s.decay} maxBio=${s.maxBio} spreadThresh=${s.spreadThresh}`);
  }
  runLog.push(`# Animal species:`);
  for (const s of ANIMAL_SPECIES) {
    runLog.push(`#   ${s.name}: initialCount=${s.initialCount} spawnStep=${s.spawnStep} visionRange=${s.visionRange} moveSpeed=${s.moveSpeed} maxEnergy=${s.maxEnergy} energyPerStep=${s.energyPerStep} biteAmount=${s.biteAmount} energyFromBiomass=${s.energyFromBiomass} lifespan=${s.lifespan} reproThreshold=${s.reproThreshold} maxPopulation=${s.maxPopulation} reproChancePerStep=${s.reproChancePerStep} prey=${s.prey}`);
  }
  runLog.push(`# ---`);

  // TSV column header
  const cols = ['step'];
  for (const s of PLANT_SPECIES) cols.push(`plant_${s.name}_cells`);
  cols.push('plant_biomass_total');
  for (const s of ANIMAL_SPECIES) {
    cols.push(`animal_${s.name}_count`);
    cols.push(`animal_${s.name}_avg_energy`);
    cols.push(`animal_${s.name}_avg_age`);
  }
  runLog.push(cols.join('\t'));
}

function appendRunLog() {
  if (LOG_INTERVAL > 1 && stepCount % LOG_INTERVAL !== 0) return;

  const row = [stepCount];

  const plantCounts = countsByPlantSpecies();
  for (const c of plantCounts) row.push(c);

  let totalBio = 0;
  for (let i = 0; i < plantBiomass.length; i++) totalBio += plantBiomass[i];
  row.push(totalBio.toFixed(0));

  const animalCounts = countsByAnimalSpecies();
  for (let sp = 0; sp < NUM_ANIMAL_SPECIES; sp++) {
    let totalE = 0, totalA = 0, cnt = 0;
    for (const a of animals) {
      if (a.species === sp) { totalE += a.energy; totalA += a.age; cnt++; }
    }
    row.push(animalCounts[sp]);
    row.push(cnt > 0 ? (totalE / cnt).toFixed(2) : '0');
    row.push(cnt > 0 ? (totalA / cnt).toFixed(1) : '0');
  }
  runLog.push(row.join('\t'));
}

function downloadRunLog() {
  // Append a final marker so partial logs are clearly partial vs. game-over
  const finalLog = runLog.slice();
  finalLog.push(`# Exported at step ${stepCount}, status: ${gameOver ? 'simulation ended' : 'in progress'}`);

  const blob = new Blob([finalLog.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = (new Date()).toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  a.download = `ecosystem_log_v${VERSION}_${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function main() {
  setupVersionNav();
  const [plants, animalDefs] = await Promise.all([
    loadPlantParams(),
    loadAnimalParams(),
  ]);
  PLANT_SPECIES = plants;
  NUM_PLANT_SPECIES = PLANT_SPECIES.length;
  ANIMAL_SPECIES = animalDefs;
  NUM_ANIMAL_SPECIES = ANIMAL_SPECIES.length;
  computePredatorPreyMap();
  loadPlantSprites();
  loadAnimalSprites();
  randInit();
  initStatusPanel();
  initDropPanel();
  updateStatusPanel();

  // Wire the download button (no-op if the element is missing on this page)
  const dlBtn = document.getElementById('status-download');
  if (dlBtn) dlBtn.addEventListener('click', downloadRunLog);

  // Wire the speed selector buttons (Slow / Medium / Fast).
  const speedButtons = document.querySelectorAll('.speed-btn');
  speedButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const lvl = parseInt(btn.dataset.speed, 10);
      if (!Number.isFinite(lvl)) return;
      speedLevel = lvl;
      speedButtons.forEach(b => b.classList.toggle('active', b === btn));
    });
  });

  // Wire the pause/resume button.
  const pauseBtn = document.getElementById('btn-pause');
  if (pauseBtn) pauseBtn.addEventListener('click', togglePause);

  // Spacebar toggles pause/resume globally (ignored while typing in inputs
  // and while the parameter editor is open).
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    const t = e.target;
    if (t && t.matches && t.matches('input, textarea, [contenteditable="true"]')) return;
    const ov = document.getElementById('editor-overlay');
    if (ov && ov.classList.contains('visible')) return;
    e.preventDefault();
    togglePause();
  });

  // Wire the parameter editor (Edit / Submit / Cancel).
  const editBtn = document.getElementById('btn-edit');
  if (editBtn) editBtn.addEventListener('click', enterEditMode);
  const submitBtn = document.getElementById('editor-submit');
  if (submitBtn) submitBtn.addEventListener('click', () => exitEditMode(true));
  const cancelBtn = document.getElementById('editor-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => exitEditMode(false));

  // Canvas hover tooltip: show what's at the cell under the mouse.
  setupCanvasTooltip();

  // Step button (1-step-while-paused). setPaused() keeps it in sync.
  const stepBtn = document.getElementById('btn-step');
  if (stepBtn) {
    stepBtn.disabled = !paused;
    stepBtn.addEventListener('click', stepOnce);
  }

  // Seed reset button.
  const seedBtn = document.getElementById('btn-seed-reset');
  if (seedBtn) seedBtn.addEventListener('click', resetWorld);
  updateSeedDisplay();

  draw();
  loop();
}
main();
