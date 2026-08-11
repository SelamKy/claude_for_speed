# Traffic Duel - Project Guide & Architecture

## Overview
Traffic Duel is a real-time, 2-player browser-based highway racing and survival game inspired by *Traffic Rider*. Players navigate endless highway traffic dodging AI vehicles; the first to crash loses.

---

## Tech Stack
- **Frontend / Graphics:** HTML5, CSS3, Vanilla JavaScript, Three.js (r128+ via unpkg)
- **Backend / Networking:** Node.js, Express, Socket.io
- **3D Assets:** Optimized GLTF/GLB models (`public/models/`)
- **Hosting / Deployment:** Render (Web Service)

---

## Project Structure
```text
traffic-duel/
├── public/
│   ├── models/
│   │   ├── bmw_m3_competition.glb       # Player 1 & 2 model
│   │   ├── nissan_skyline_gtr_r35.glb   # Alternative / reference model
│   │   ├── npc1.glb                     # AI Traffic vehicle variant 1
│   │   ├── npc2.glb                     # AI Traffic vehicle variant 2
│   │   └── npc3.glb                     # AI Traffic vehicle variant 3
│   ├── index.html                       # Lobby, HUD, and Game Over overlays
│   ├── style.css                        # Modern dark arcade HUD styling
│   └── game.js                          # Three.js engine, physics, network interpolation
├── server.js                            # Express static server & Socket.io traffic engine
├── package.json                         # Dependencies (express, socket.io)
├── .gitignore                           # Excludes node_modules/
└── CLAUDE.md                            # Development guide & context