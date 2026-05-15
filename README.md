# Life Ecosystem

A small browser-based ecosystem simulator written in pure HTML + JavaScript
(Canvas API). No build step, no dependencies — just open `index.html`.

This started life as a Conway's Game of Life implementation and is gradually
evolving toward a multi-species ecosystem simulator with plants, herbivores,
and carnivores.

## Live demo

<https://lifegamer1192.github.io/life/>

Older versions are reachable from the in-page **Other versions** link,
or directly at <https://lifegamer1192.github.io/life/v4/index.html>.

## Current state — v7

- 60 x 65 toroidal grid (780 x 720 canvas)
- Per-cell temperature (vertical gradient, cold at top) and humidity
  (random wetland points), generated once at startup
- 3 plant species — Grass, Tree, Moss — with climate-fit-based growth,
  decay, and seed dispersal
- 2 animal species — Herbivore (eats plants), Carnivore (eats Herbivore) —
  with vision-based pursuit, **flee-from-predator priority**, energy
  metabolism, ageing, and reproduction (energy-split with
  `maxPopulation` cap)
- Predator/prey relationships configured via the `prey` field in
  [`animals.txt`](animals.txt)
- Per-species sprite images (placeholders), with translucent-fill fallback
  when sprites have not yet loaded
- Hand-editable parameters in [`plants.txt`](plants.txt) and
  [`animals.txt`](animals.txt)
- Side status panel: version, step count, alive total, per-species counts
  for plants and animals, environment legend
- Downloadable run log (TSV `.txt`, recorded every 20 steps) for
  balance-tuning iteration
- Per-version frozen snapshots under [`v4/`](v4/) ... [`v7/`](v7/),
  accessed via [`index_old_version_menu.html`](index_old_version_menu.html)

## How to run

### Quickest: double-click `index.html`

Works on any modern browser. The simulation runs immediately. Most browsers
block `fetch()` for files on the `file://` protocol, so the simulator falls
back to **built-in default plant parameters**. The status panel will show
`Source: built-in defaults (plants.txt not loaded)`.

### Recommended: serve over HTTP to load `plants.txt`

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>. The status panel should show
`Source: plants.txt`.

## Editing plant parameters

Open [`plants.txt`](plants.txt) in any text editor, change a value, save,
then reload the browser (Ctrl+F5). Field meanings are documented inline
in the file. You can add or remove `[Species]` sections freely; any
missing field falls back to a safe default.

## Project layout

```
.
├── index.html                       Latest version (current development)
├── script.js                        Latest simulation logic
├── plants.txt                       Hand-editable plant parameters
├── sprite.png                       Animal placeholder (reserved for v5+)
├── plant_grass.png / plant_tree.png / plant_moss.png   Plant sprites
├── gen_sprite.ps1                   Regenerates placeholder sprite PNGs
├── snapshot.ps1                     Freezes current root to v<N>/
├── index_old_version_menu.html      Card-style menu of frozen versions
└── v4/                              Frozen snapshot of v4
    └── (the same set of files as above)
```

## Versioning convention

The constant `VERSION` in [`script.js`](script.js) tracks the current
iteration. Before bumping `VERSION` to the next number, the current root
is snapshot into `v<VERSION>/` via [`snapshot.ps1`](snapshot.ps1).

Frozen snapshots are not normally modified — they preserve the simulator
state at that moment so old behavior can be revisited later.

## Roadmap (toward v10)

| ver | Theme |
| --- | --- |
| v3  | Environment + plants + status panel (completed) |
| v4  | Canvas expansion + plant sprites + plants.txt (completed) |
| v5  | Herbivores + animal sprite + animals.txt (completed) |
| v6  | Herbivore reproduction + run log (completed) |
| **v7** | **Carnivores + flee behavior (current)** |
| v8  | Three-way balance tuning |
| v9  | Per-species graphs + observation UI |
| v10 | Seasons + final visual polish |

## License

This repository has **no license attached** and is shared for viewing only.
You may read the source, but copying, redistribution, modification, or
inclusion in derivative works is not granted.

## Privacy note

Earlier private versions of this project (pre-v4) submitted simulation
results to a private Google Apps Script endpoint, which included the
viewer's public IP address obtained via api.ipify.org. As of the public
v4 release, the endpoint URL has been blanked (`GAS_URL = ''`) and no
network submission occurs. The IP-fetch and submission code remain in the
source as inert scaffolding; they only activate if you set `GAS_URL`
to your own endpoint in your local fork.
