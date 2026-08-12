# Claude for Speed

A real-time, 2-player highway racing duel built with Node.js, Express, Socket.IO, and Three.js. Two players race head-to-head down a 4-lane highway, dodging deterministic AI traffic that's synced between both clients by a seeded server-side PRNG — last one standing (or first to the finish) wins.

## Features

- **2-player rooms** via shareable invite links (`/?room=XYZ123`)
- **Authoritative server** — match state machine (waiting → countdown → racing → finished) and traffic spawning are owned by the server so both clients see an identical road
- **3D rendering** with Three.js, including car models (BMW M3 Competition, Nissan Skyline GT-R R35) and NPC traffic
- **Live HUD** — speed, distance, nitro, run earnings, ping, FPS, and traffic count
- **Garage & shop** — persistent coin economy, four vehicles with distinct stats, 4-tier Engine/Brake/Nitro upgrades, and visual customisation (gloss/matte/neon paint, underglow, window tint, rims)
- **New York skyline** — the real `new_york_buildings.glb` recycled endlessly down both sides of the road
- **Weather & time of day** — Day, Sunset, Night and Rain, selectable or seeded per race
- **Speed juice** — nitro boost, screen shake, warp lines, dynamic FOV, exhaust flames, tyre smoke and skid marks

### Garage & shop

Coins are earned during a run (distance, road pickups, near misses) plus end-of-race
bonuses, and persist in `localStorage` under `cfs.garage.v1`.

| Vehicle | Body | Price | Top speed (stock → maxed) |
| --- | --- | --- | --- |
| Şehir Hatchback | procedural | free | 259 → 299 km/h |
| Kas Araba | procedural | 4 800 | 302 → 348 km/h |
| Spor Coupe | `nissan_skyline_gtr_r35.glb` | 13 500 | 324 → 373 km/h |
| Süper Coupe | `bmw_m3_competition.glb` | 29 000 | 342 → 394 km/h |

The two starter cars are built in code (`public/js/vehicles.js`) so adding them costs
no download. Vehicle stats and upgrades apply in multiplayer; the chosen car and paint
are relayed to the opponent so both players see the same thing.

### Client architecture

```
public/game.js        # loop, networking, driving model, road
public/js/garage.js   # economy + loadout state (no THREE, no DOM)
public/js/garage-ui.js# garage screen + 3D preview (renders into the main canvas)
public/js/vehicles.js # procedural car bodies + paint/tint/rim application
public/js/scenery.js  # instanced, chunk-recycled roadside buildings
public/js/atmosphere.js # weather / time-of-day preset blending
public/js/fx.js       # shake, speed lines, particle pools, skid marks
```

Every system is pooled and allocation-free per frame: buildings are drawn as one
`InstancedMesh` per material (~22 draw calls for ~80 buildings), particles share a
single ring-buffered `Points`, and skid marks share a single `InstancedMesh`.

If `new_york_buildings.glb` fails to load, `buildFallbackPrefabs()` substitutes
canvas-textured box buildings with the same interface and the race still starts.

## Setup

### Prerequisites

- Node.js (with npm)

### Install

```bash
npm install
```

### Run

```bash
npm start
```

The server starts on `http://localhost:3000` by default. Set the `PORT` environment variable to use a different port, and `CORS_ORIGIN` to restrict allowed origins.

### Test

```bash
npm test
```

Runs the traffic-spawning simulation tests in `test/traffic.test.js`.

## Project Structure

```
server.js          # Authoritative game server (Express + Socket.IO)
public/
  index.html      # Client shell / UI screens
  game.js         # Client-side rendering and game loop (Three.js)
  style.css       # UI styling
  js/             # Garage, scenery, atmosphere, FX and vehicle modules
  models/         # 3D car, NPC and building models (.glb)
test/
  traffic.test.js # Traffic-spawning simulation tests
```

### Controls

| Key | Action |
| --- | --- |
| `A` / `D`, `←` / `→` | change lane (hold to keep moving across) |
| `W` / `↑` | throttle |
| `S` / `↓` | brake |
| `Shift` | nitro |
| `Esc` | leave the garage |

### Debug hook

Loading with `?debug` exposes `window.__cfs` — collision boxes, a solo race
(`startSolo()`), a frame-rate-independent simulation step (`drive({ seconds })`),
environment switching (`setEnv()`) and a render/scene report (`snapshot()`, `cars()`).
This is what the headless smoke test drives.
