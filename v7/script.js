const N = 60, M = 65;     // Board size (60 rows x 65 cols, canvas 780x720)
const cell = 12;          // Cell display size
let stepCount = 0;        // Step counter
let aliveHistory = [];    // Alive history (cells with plants)

// POST display timers (success / failure)
let postOkTimestamp = 0;
let postFailTimestamp = 0;
const POST_DISPLAY_MS = 5000;
const POST_FAIL_DISPLAY_MS = 5000;

// Version number (increment manually when editing this script)
const VERSION = 7; // Stage 3: carnivores + prey-driven hunting + flee behavior

// Run log buffer (TSV-style). Filled every step and exported via the
// "Download log" button or automatically on game over.
let runLog = [];
let runLogStartedAt = '';
const LOG_INTERVAL = 20; // record every Nth step (smaller = more detail, larger file)

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
  // Humidity: 6 random wetland points, decayed by toroidal distance
  const points = [];
  for (let k = 0; k < 6; k++) {
    points.push({ x: Math.random() * M, y: Math.random() * N });
  }
  const range = 22;
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
  { name: 'Grass', spriteFile: 'plant_grass.png', color: [200, 230, 80],  optTemp: 0.55, optHum: 0.50, growth: 0.9, decay: 2.0, maxBio: 60,  spreadThresh: 25 },
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

async function loadPlantParams() {
  try {
    const resp = await fetch('plants.txt');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const parsed = parsePlantParams(text);
    if (!parsed.length) throw new Error('No species found in plants.txt');
    PLANT_PARAMS_SOURCE = 'plants.txt';
    return parsed;
  } catch (e) {
    console.warn('[plants] Failed to load plants.txt; using embedded defaults. Reason:', e.message);
    console.warn('[plants] Hint: open index.html via a local HTTP server (e.g. `python -m http.server 8000`) to enable plants.txt loading.');
    PLANT_PARAMS_SOURCE = 'defaults';
    return DEFAULT_PLANT_PARAMS;
  }
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
    initialCount: 20,
    visionRange: 3,
    maxEnergy: 100,
    energyPerStep: 0.6,
    biteAmount: 12,
    energyFromBiomass: 1.4,
    lifespan: 600,
    reproThreshold: 80,
    maxPopulation: 200,
    prey: 'plants',
  },
  {
    name: 'Carnivore',
    spriteFile: 'animal_carnivore.png',
    color: [230, 80, 80],
    initialCount: 8,
    visionRange: 5,
    maxEnergy: 150,
    energyPerStep: 1.0,
    biteAmount: 50,
    energyFromBiomass: 1.0,
    lifespan: 700,
    reproThreshold: 130,
    maxPopulation: 50,
    prey: 'Herbivore',
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
};

function parseAnimalParams(text) {
  return parseSpeciesParams(text, ANIMAL_PARAM_DEFAULTS);
}

async function loadAnimalParams() {
  try {
    const resp = await fetch('animals.txt');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const parsed = parseAnimalParams(text);
    if (!parsed.length) throw new Error('No species found in animals.txt');
    ANIMAL_PARAMS_SOURCE = 'animals.txt';
    return parsed;
  } catch (e) {
    console.warn('[animals] Failed to load animals.txt; using embedded defaults. Reason:', e.message);
    console.warn('[animals] Hint: open index.html via a local HTTP server (e.g. `python -m http.server 8000`) to enable animals.txt loading.');
    ANIMAL_PARAMS_SOURCE = 'defaults';
    return DEFAULT_ANIMAL_PARAMS;
  }
}

// Live animal individuals: { species, x, y, energy, age }
let animals = [];

function initAnimals() {
  animals = [];
  for (let sp = 0; sp < NUM_ANIMAL_SPECIES; sp++) {
    const def = ANIMAL_SPECIES[sp];
    const count = Math.max(0, Math.floor(def.initialCount || 0));
    for (let k = 0; k < count; k++) {
      animals.push({
        species: sp,
        x: Math.floor(Math.random() * M),
        y: Math.floor(Math.random() * N),
        energy: def.maxEnergy * (0.5 + Math.random() * 0.5),
        age: 0,
      });
    }
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
  for (const a of animals) {
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
        mx = Math.floor(Math.random() * 3) - 1;
        my = Math.floor(Math.random() * 3) - 1;
      }
    } else if (foundFood) {
      mx = Math.sign(foodDx);
      my = Math.sign(foodDy);
    } else {
      mx = Math.floor(Math.random() * 3) - 1;
      my = Math.floor(Math.random() * 3) - 1;
    }
    a.x = ((a.x + mx) % M + M) % M;
    a.y = ((a.y + my) % N + N) % N;

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
  const speciesPop = countsByAnimalSpecies();
  const newborns = [];
  for (const a of animals) {
    const def = ANIMAL_SPECIES[a.species];
    if (a.energy < def.reproThreshold) continue;
    if (speciesPop[a.species] >= def.maxPopulation) continue;
    let dx, dy;
    do {
      dx = Math.floor(Math.random() * 3) - 1;
      dy = Math.floor(Math.random() * 3) - 1;
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
      const x = Math.floor(Math.random() * M);
      const y = Math.floor(Math.random() * N);
      const i = idx(y, x);
      if (plantSpecies[i] < 0) {
        plantSpecies[i] = sp;
        plantBiomass[i] = PLANT_SPECIES[sp].spreadThresh + Math.random() * 10;
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
      if (fit > 0.5) {
        nb[i] = Math.min(def.maxBio, nb[i] + def.growth * fit);
      } else if (fit < 0.3) {
        nb[i] = nb[i] - def.decay;
        if (nb[i] <= 0) {
          nb[i] = 0;
          ns[i] = -1;
        }
      }
      // Seed dispersal: if biomass exceeds threshold, randomly spread to a neighbor
      if (plantBiomass[i] > def.spreadThresh && Math.random() < 0.18) {
        const dy = Math.floor(Math.random() * 3) - 1;
        const dx = Math.floor(Math.random() * 3) - 1;
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
          if (myFit > otherFit + 0.15) {
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
const elPlantCounts  = []; // Per-plant-species count display elements
const elAnimalCounts = []; // Per-animal-species count display elements

// Build a "Source: file / defaults" indicator row.
function makeSourceRow(filename, source) {
  const row = document.createElement('div');
  row.className = 'small';
  row.style.marginBottom = '6px';
  if (source === filename) {
    row.textContent = `Source: ${filename}`;
    row.style.color = '#9c9';
  } else {
    row.textContent = `Source: built-in defaults (${filename} not loaded)`;
    row.style.color = '#d99';
  }
  return row;
}

// Build one legend row { swatch, name, count } and return the count element.
function appendLegendRow(parent, def, swatchExtraClass) {
  const colorCss = `rgb(${def.color[0]}, ${def.color[1]}, ${def.color[2]})`;
  const row = document.createElement('div');
  row.className = 'legend-row';
  row.innerHTML = `
    <span class="swatch ${swatchExtraClass || ''}" style="background:${colorCss}"></span>
    <span class="label">${def.name}</span>
    <span class="count">0</span>
  `;
  parent.appendChild(row);
  return row.querySelector('.count');
}

function initStatusPanel() {
  elVersion.textContent = `v${VERSION}`;

  // Plants section
  elPlants.innerHTML = '';
  elPlantCounts.length = 0;
  elPlants.appendChild(makeSourceRow('plants.txt', PLANT_PARAMS_SOURCE));
  for (let sp = 0; sp < NUM_PLANT_SPECIES; sp++) {
    elPlantCounts.push(appendLegendRow(elPlants, PLANT_SPECIES[sp]));
  }

  // Animals section
  if (elAnimals) {
    elAnimals.innerHTML = '';
    elAnimalCounts.length = 0;
    elAnimals.appendChild(makeSourceRow('animals.txt', ANIMAL_PARAMS_SOURCE));
    for (let sp = 0; sp < NUM_ANIMAL_SPECIES; sp++) {
      elAnimalCounts.push(appendLegendRow(elAnimals, ANIMAL_SPECIES[sp], 'circle'));
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
  aliveHistory = [countAlive() + animals.length];
  initRunLog();
  appendRunLog(); // record initial state at step 0
}

// ========================================================================
// Rendering
// ========================================================================
const ctx = document.getElementById("cv").getContext("2d");

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
    const title = "GAME OVER";
    const stepLine = `Step: ${formatStep(stepCount)}`;
    const aliveFinal = aliveHistory.length ? aliveHistory[aliveHistory.length - 1] : countAlive();
    const aliveLine = `Alive: ${aliveFinal}`;

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
    const boxY2 = (ch - boxH2) / 2;

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

    // Graph in the bottom 1/3 (alive count over time)
    const graphTop = Math.floor(ch * (2 / 3));
    const graphHeight = ch - graphTop;
    const graphLeft = 0;
    const graphWidth = cw;

    ctx.fillStyle = "rgba(0,0,0,0.8)";
    ctx.fillRect(graphLeft, graphTop, graphWidth, graphHeight);

    const gp = 40;
    const gx = graphLeft + gp;
    const gy = graphTop + gp;
    const gw = graphWidth - gp * 2;
    const gh = graphHeight - gp * 2;

    const data = aliveHistory.slice();
    const n = data.length;
    const maxV = Math.max(1, ...data);
    const xScale = (i) => gx + (n <= 1 ? 0 : (i / (n - 1)) * gw);
    const yScale = (v) => gy + (1 - v / maxV) * gh;

    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      let labelY = gy + (i / 4) * gh;
      const padY = 6;
      if (labelY < gy + padY) labelY = gy + padY;
      if (labelY > gy + gh - padY) labelY = gy + gh - padY;

      const y = gy + (i / 4) * gh;
      ctx.beginPath();
      ctx.moveTo(gx, y);
      ctx.lineTo(gx + gw, y);
      ctx.stroke();
      const v = Math.round(maxV * (1 - i / 4));
      ctx.fillText(String(v), gx - 8, labelY);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    if (n > 0) {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = xScale(i);
        const y = yScale(data[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "lime";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.lineTo(xScale(n - 1), gy + gh);
      ctx.lineTo(xScale(0), gy + gh);
      ctx.closePath();
      ctx.fillStyle = "rgba(0,255,0,0.12)";
      ctx.fill();

      const lastX = xScale(n - 1);
      const lastY = yScale(data[n - 1]);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath();
      ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = "12px sans-serif";
      const aliveLabel = `Alive: ${data[n - 1]}`;
      const stepLabel = `Step: ${formatStep(stepCount)}`;
      const aliveW = ctx.measureText(aliveLabel).width;
      const stepW = ctx.measureText(stepLabel).width;
      const labelW = Math.max(aliveW, stepW);
      const labelH = 14;

      const labelPadding = 6;
      let lx = lastX + labelPadding;
      const maxLabelX = gx + gw - labelW - 6;
      if (lx > maxLabelX) lx = lastX - labelPadding - labelW;
      if (lx < gx) lx = gx;

      let ly = lastY - labelH - 2;
      if (ly < gy) ly = gy;
      if (ly + labelH * 2 + 4 > gy + gh) ly = gy + gh - (labelH * 2 + 4);

      const panelX = Math.max(gx, lx - 4);
      const panelY = ly - 2;
      const panelW = Math.min(labelW + 8, gx + gw - panelX);
      const panelH = labelH * 2 + 6;
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(panelX, panelY, panelW, panelH);

      ctx.fillStyle = "white";
      ctx.textBaseline = "top";
      ctx.fillText(aliveLabel, lx, ly);
      ctx.fillText(stepLabel, lx, ly + labelH + 2);

      ctx.textAlign = "start";
      ctx.textBaseline = "top";
    }
  }
}

// Main loop
function loop() {
  if (gameOver) return;

  step();
  stepCount++;

  const plantAlive = countAlive();
  const animalAlive = animals.length;
  const aliveTotal = plantAlive + animalAlive;
  aliveHistory.push(aliveTotal);
  appendRunLog();

  // Game over: both plants and animals are gone.
  if (aliveTotal === 0) {
    gameOver = true;
    sendResult(aliveTotal, stepCount);
    updateStatusPanel();
    draw();
    return;
  }

  updateStatusPanel();
  draw();
  requestAnimationFrame(loop);
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
    runLog.push(`#   ${s.name}: initialCount=${s.initialCount} visionRange=${s.visionRange} maxEnergy=${s.maxEnergy} energyPerStep=${s.energyPerStep} biteAmount=${s.biteAmount} energyFromBiomass=${s.energyFromBiomass} lifespan=${s.lifespan} reproThreshold=${s.reproThreshold} maxPopulation=${s.maxPopulation}`);
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
  finalLog.push(`# Exported at step ${stepCount}, status: ${gameOver ? 'game over' : 'in progress'}`);

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
  updateStatusPanel();

  // Wire the download button (no-op if the element is missing on this page)
  const dlBtn = document.getElementById('status-download');
  if (dlBtn) dlBtn.addEventListener('click', downloadRunLog);

  draw();
  loop();
}
main();
