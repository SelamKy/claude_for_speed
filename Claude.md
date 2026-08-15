# Claude for Speed - System Context & Operational Rules

## 1. Project Overview & Tech Stack
- **Type:** High-speed arcade racing game with Single Player & Multiplayer (Traffic Rider style).
- **Core Stack:** Three.js (r161+), Vanilla JS (ES6 modules), Node.js/Express, Socket.io, DRACO Loader.
- **Root Directory:** `claude_for_speed/`
- **Key Directories:**
  - `public/`: Client entry (`index.html`, `style.css`).
  - `public/js/`: ES6 modules (`main.js`, `loader.js`, `player.js`, `traffic.js`, `scene.js`, `config.js`, `network.js`, `garage.js`).
  - `public/models/originale/`: GLTF/GLB vehicle and environment assets.
  - `server.js`: Matchmaking, room management, and multiplayer state relay.

## 2. Core Game Rules & Constants
- **Top Speed:** 395 km/h limit. Progressive throttle decay/air drag kicks in above 300 km/h.
- **Traffic:** Procedural lane-based generation extending continuously from 100m to 6000m.
- **Lighting & Post-Processing:** Clean arcade style. NO heavy scene fog (`scene.fog = null`), NO blinding headlight flare sprites, NO particle smoke on normal turning/acceleration.
- **Starter Vehicle:** `ilkaraba` (`/models/originale/ilkaraba.glb`). Requires centered wheel pivot groups to avoid wobbly wheel rotation.

## 3. Asset Loading Pipeline
- Parallel Draco decoding with Worker offloading (`setWorkerLimit(4)`).
- Critical assets (`ilkaraba`, immediate road mesh) preload first; secondary/scenery assets are deferred to prevent blocking the game loop.
- All car materials must use PBR workflow with `THREE.SRGBColorSpace` textures and anisotropic filtering.

## 4. Operational Rules for Claude (Strict)
- **Direct Execution:** Never output conversational filler, introductory remarks, or unsolicited explanations. Apply changes directly to disk using file tools.
- **Token Efficiency:** Only read and edit the exact target files required for the task.
- **No Regressions:** Never overwrite multiplayer room logic, change top speed curves, or re-introduce fog/smoke unless explicitly commanded.