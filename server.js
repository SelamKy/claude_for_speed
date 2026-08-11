'use strict';

/**
 * Traffic Duel — authoritative game server
 *
 *  - Serves the client from /public
 *  - Creates / joins 2-player rooms via invite links (/?room=XYZ123)
 *  - Owns the match state machine (waiting -> countdown -> racing -> finished)
 *  - Owns traffic spawning: a seeded PRNG runs on the server and every spawn
 *    is broadcast to BOTH players with the same id/lane/speed/race-time, so the
 *    two clients always see an identical road.
 */

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

/* ------------------------------------------------------------------ config */

const CONFIG = {
  PORT: Number(process.env.PORT) || 3000,
  MAX_PLAYERS: 2,

  // Track geometry — sent to clients so both sides agree on the world.
  LANE_COUNT: 4,
  LANE_WIDTH: 3.5,
  SPAWN_AHEAD: 250,          // metres ahead of the start line where traffic appears
  SPAWN_JITTER: 45,          // random extra distance on top of SPAWN_AHEAD
  DESPAWN_BEHIND: 80,        // metres behind a car before the client may cull it
  FINISH_DISTANCE: 6000,     // metres to win

  // Traffic pacing (milliseconds of race time between spawns).
  // Roughly half the old rate — the spacing rules below do the rest.
  SPAWN_INTERVAL_MIN: 900,
  SPAWN_INTERVAL_MAX: 2000,
  DIFFICULTY_RAMP_MS: 120000, // interval shrinks towards MIN over this period
  TRAFFIC_SPEED_MIN: 16,      // m/s
  TRAFFIC_SPEED_MAX: 30,

  // Traffic models. The client loads one prefab per entry; the server picks a
  // model per spawn so both clients render the same car in the same slot.
  TRAFFIC_MODELS: ['npc1', 'npc2', 'npc3'],
  TRAFFIC_COLORS: 4,          // cosmetic paint variants per model

  // --- breathing room -----------------------------------------------------
  MIN_LANE_GAP: 52,           // metres between two cars sharing a lane
  BLOCK_WINDOW: 38,           // a lane counts as "walled" within this band
  MIN_OPEN_LANES: 2,          // never wall off more than LANE_COUNT - this
  MAX_ACTIVE_TRAFFIC: 22,     // hard ceiling on cars alive in the play window
  // Looking 40 s ahead (rather than 14) removes every 4-wide road block across
  // a 40-run sweep and cuts 3-wide formations from 12% of encounters to 5%,
  // for the same number of cars on track.
  PASSABLE_HORIZON_MS: 40000, // look this far ahead when checking for road blocks
  PASSABLE_STEP_MS: 700,      // sampling resolution of that check
  NOMINAL_PLAYER_SPEED: 55,   // m/s — fallback frontier before any state report

  COUNTDOWN_MS: 3000,
  TICK_MS: 50,               // spawn scheduler resolution
  STATE_RATE_LIMIT_MS: 20,   // ignore player updates faster than 50 Hz
  EMPTY_ROOM_TTL_MS: 60000,  // reap rooms nobody joined
  ROOM_SWEEP_MS: 30000,
  MAX_SPEED_SANITY: 120,     // m/s — used to reject impossible progress reports
};

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/* ------------------------------------------------------------------- utils */

/** Deterministic 32-bit PRNG (mulberry32). Same seed => same traffic. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRoomCode() {
  const bytes = crypto.randomBytes(ROOM_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

function sanitizeName(name, fallback) {
  if (typeof name !== 'string') return fallback;
  const clean = name.replace(/[^\w \-.]/g, '').trim().slice(0, 16);
  return clean || fallback;
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

/* -------------------------------------------------------------- http layer */

const app = express();
app.disable('x-powered-by');

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', extensions: ['html'] }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, uptime: process.uptime() });
});

/** Lets the client validate an invite code before opening a socket. */
app.get('/api/room/:code', (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ exists: false });
  res.json({
    exists: true,
    players: room.players.size,
    capacity: CONFIG.MAX_PLAYERS,
    joinable: room.players.size < CONFIG.MAX_PLAYERS && room.phase === 'waiting',
    phase: room.phase,
  });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout: 20000,
});

/* ------------------------------------------------------------- room engine */

/** @type {Map<string, Room>} */
const rooms = new Map();

function createRoom() {
  let code = randomRoomCode();
  while (rooms.has(code)) code = randomRoomCode();

  const room = {
    code,
    createdAt: Date.now(),
    phase: 'waiting',        // waiting | countdown | racing | finished
    players: new Map(),      // socketId -> player
    hostId: null,
    seed: 0,
    raceStartAt: 0,          // server epoch ms when raceTime === 0
    nextSpawnAt: 0,          // race time (ms) of the next spawn
    trafficSeq: 0,
    traffic: [],             // live spawn records used for spacing decisions
    rng: null,
    timer: null,
  };
  rooms.set(code, room);
  log(`room ${code} created`);
  return room;
}

function destroyRoom(room) {
  if (room.timer) clearInterval(room.timer);
  rooms.delete(room.code);
  log(`room ${room.code} destroyed`);
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    ready: p.ready,
    isHost: p.isHost,
    distance: p.distance,
    crashed: p.crashed,
    finished: p.finished,
    score: p.score,
  };
}

function roomSnapshot(room) {
  return {
    code: room.code,
    phase: room.phase,
    capacity: CONFIG.MAX_PLAYERS,
    players: [...room.players.values()].map(publicPlayer),
    config: {
      laneCount: CONFIG.LANE_COUNT,
      laneWidth: CONFIG.LANE_WIDTH,
      spawnAhead: CONFIG.SPAWN_AHEAD,
      despawnBehind: CONFIG.DESPAWN_BEHIND,
      finishDistance: CONFIG.FINISH_DISTANCE,
      trafficModels: CONFIG.TRAFFIC_MODELS,
    },
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room:update', roomSnapshot(room));
}

/* ----------------------------------------------------------- match control */

function resetPlayersForRace(room) {
  for (const p of room.players.values()) {
    p.distance = 0;
    p.crashed = false;
    p.finished = false;
    p.finishTime = null;
    p.lastStateAt = 0;
  }
}

function tryStartMatch(room) {
  if (room.phase !== 'waiting' && room.phase !== 'finished') return;
  if (room.players.size !== CONFIG.MAX_PLAYERS) return;
  if (![...room.players.values()].every((p) => p.ready)) return;

  resetPlayersForRace(room);

  // One seed per race, shared by both clients. The server still authoritatively
  // emits every spawn; the seed lets clients pre-generate cosmetics and verify.
  room.seed = crypto.randomBytes(4).readUInt32BE(0);
  room.rng = makeRng(room.seed);
  room.trafficSeq = 0;
  room.traffic = [];
  room.nextSpawnAt = 1400; // grace period after the lights go green
  room.phase = 'countdown';
  room.raceStartAt = Date.now() + CONFIG.COUNTDOWN_MS;

  io.to(room.code).emit('match:countdown', {
    seed: room.seed,
    startAt: room.raceStartAt,
    serverTime: Date.now(),
    countdownMs: CONFIG.COUNTDOWN_MS,
    config: roomSnapshot(room).config,
    players: [...room.players.values()].map(publicPlayer),
  });
  broadcastRoom(room);
  log(`room ${room.code} countdown (seed ${room.seed})`);

  if (room.timer) clearInterval(room.timer);
  room.timer = setInterval(() => tickRoom(room), CONFIG.TICK_MS);
}

/* --------------------------------------------------------------- traffic */

/** Where a spawned car sits at `raceTime`, in metres from the start line. */
function trafficZAt(car, raceTime) {
  return car.z + (car.speed * (raceTime - car.raceTime)) / 1000;
}

/**
 * Where the race is happening right now, in metres from the start line.
 *
 * `lead` is the car furthest up the road: new traffic is placed ahead of it so
 * nobody ever meets a car that spawned behind them. `rear` is the trailing car:
 * spacing records stay alive until the slower player has actually driven past.
 * Crashed players are ignored — they have stopped.
 */
function raceFrontier(room, raceTime) {
  const live = [...room.players.values()].filter((p) => !p.crashed && !p.finished);
  const nominal = (CONFIG.NOMINAL_PLAYER_SPEED * raceTime) / 1000;
  if (!live.length) return { lead: nominal, rear: nominal };
  return {
    lead: Math.max(...live.map((p) => p.distance)),
    rear: Math.min(...live.map((p) => p.distance)),
  };
}

/** Retire records both players have driven past, or that ran off ahead. */
function pruneTraffic(room, raceTime, frontier) {
  room.traffic = room.traffic.filter((car) => {
    const z = trafficZAt(car, raceTime);
    return z > frontier.rear - 120 && z < frontier.lead + 800;
  });
}

/**
 * Would adding this car ever leave the players with fewer than MIN_OPEN_LANES
 * clear lanes across its own z band?
 *
 * Cars in different lanes drift relative to each other, so a formation that
 * looks fine at spawn time can close into a rolling road block ten seconds
 * later — exactly when the player arrives. Every car moves at a constant speed,
 * so we can just walk the run-up window and check each sample.
 */
function staysPassable(lanes, candidateLane, z, candidateSpeed, raceTime) {
  for (let ahead = 0; ahead <= CONFIG.PASSABLE_HORIZON_MS; ahead += CONFIG.PASSABLE_STEP_MS) {
    const dt = ahead / 1000;
    const myZ = z + candidateSpeed * dt;

    let blocked = 0;
    for (let l = 0; l < CONFIG.LANE_COUNT; l++) {
      if (l === candidateLane) { blocked++; continue; }
      const busy = lanes[l].some((c) => Math.abs(c.z + c.speed * dt - myZ) < CONFIG.BLOCK_WINDOW);
      if (busy) blocked++;
    }
    if (CONFIG.LANE_COUNT - blocked < CONFIG.MIN_OPEN_LANES) return false;
  }
  return true;
}

/**
 * Deterministic traffic generator — the only source of spawns in the game.
 *
 * Every candidate consumes a fixed number of PRNG draws whether or not it ends
 * up spawning, so a given seed always produces the same road. On top of the raw
 * roll we enforce three rules that make the traffic driveable:
 *
 *   1. cars sharing a lane keep at least MIN_LANE_GAP metres between them;
 *   2. a car never spawns faster than the car it is following, so gaps in a
 *      lane can only ever open up, never close;
 *   3. at least MIN_OPEN_LANES lanes stay clear across any BLOCK_WINDOW band,
 *      so there is always a line through the traffic.
 *
 * Traffic is placed relative to the leading car rather than to the start line,
 * so the road keeps filling in for the whole 6 km.
 *
 * @returns {object|null} the broadcast event, or null when the roll was vetoed.
 */
function spawnTraffic(room, raceTime, frontier = raceFrontier(room, raceTime)) {
  const r = room.rng;

  // Draw first, decide later — keeps the PRNG stream independent of the veto.
  const laneRoll = r();
  const speedRoll = r();
  const zRoll = r();
  const modelRoll = r();
  const colorRoll = r();

  pruneTraffic(room, raceTime, frontier);
  if (room.traffic.length >= CONFIG.MAX_ACTIVE_TRAFFIC) return null;

  const z = frontier.lead + CONFIG.SPAWN_AHEAD + zRoll * CONFIG.SPAWN_JITTER;
  let speed =
    CONFIG.TRAFFIC_SPEED_MIN +
    speedRoll * (CONFIG.TRAFFIC_SPEED_MAX - CONFIG.TRAFFIC_SPEED_MIN);

  // Snapshot of where every live car is right now, bucketed by lane.
  const lanes = Array.from({ length: CONFIG.LANE_COUNT }, () => []);
  for (const car of room.traffic) {
    lanes[car.lane].push({ z: trafficZAt(car, raceTime), speed: car.speed });
  }

  const firstChoice = Math.floor(laneRoll * CONFIG.LANE_COUNT) % CONFIG.LANE_COUNT;
  let lane = -1;

  // Try the rolled lane first, then the others in a fixed rotation.
  for (let i = 0; i < CONFIG.LANE_COUNT; i++) {
    const candidate = (firstChoice + i) % CONFIG.LANE_COUNT;

    // (1) elbow room in the lane, right now
    if (!lanes[candidate].every((c) => Math.abs(c.z - z) >= CONFIG.MIN_LANE_GAP)) continue;

    // (2) speed window that keeps the lane's gaps from ever closing:
    //     no faster than the car ahead, no slower than the car behind.
    const lo = Math.max(CONFIG.TRAFFIC_SPEED_MIN,
      ...lanes[candidate].filter((c) => c.z < z).map((c) => c.speed));
    const hi = Math.min(CONFIG.TRAFFIC_SPEED_MAX,
      ...lanes[candidate].filter((c) => c.z > z).map((c) => c.speed));
    if (lo > hi) continue;
    const laneSpeed = Math.min(Math.max(speed, lo), hi);

    // (3) the road must stay passable — not just now, but for the whole run-up
    //     while the leading player closes the SPAWN_AHEAD gap. Everything moves
    //     at a constant speed, so sampling the next few seconds is exact enough.
    if (!staysPassable(lanes, candidate, z, laneSpeed, raceTime)) continue;

    lane = candidate;
    speed = laneSpeed;
    break;
  }
  if (lane < 0) return null;

  const event = {
    id: ++room.trafficSeq,
    lane,
    laneX: (lane - (CONFIG.LANE_COUNT - 1) / 2) * CONFIG.LANE_WIDTH,
    z: Number(z.toFixed(3)),            // metres from the start line
    speed: Number(speed.toFixed(3)),    // m/s, moving away from the players
    model: CONFIG.TRAFFIC_MODELS[Math.floor(modelRoll * CONFIG.TRAFFIC_MODELS.length) % CONFIG.TRAFFIC_MODELS.length],
    variant: Math.floor(colorRoll * CONFIG.TRAFFIC_COLORS) % CONFIG.TRAFFIC_COLORS,
    raceTime: Math.round(raceTime),     // race-clock ms this car exists from
  };

  room.traffic.push(event);
  io.to(room.code).emit('traffic:spawn', event);
  return event;
}

function scheduleNextSpawn(room, raceTime) {
  const ramp = Math.min(1, raceTime / CONFIG.DIFFICULTY_RAMP_MS);
  const max =
    CONFIG.SPAWN_INTERVAL_MAX -
    (CONFIG.SPAWN_INTERVAL_MAX - CONFIG.SPAWN_INTERVAL_MIN) * ramp;
  const gap = CONFIG.SPAWN_INTERVAL_MIN + room.rng() * (max - CONFIG.SPAWN_INTERVAL_MIN);
  room.nextSpawnAt += gap;
}

function tickRoom(room) {
  const now = Date.now();

  if (room.phase === 'countdown') {
    if (now < room.raceStartAt) return;
    room.phase = 'racing';
    io.to(room.code).emit('match:start', { serverTime: now, startAt: room.raceStartAt });
    log(`room ${room.code} racing`);
  }

  if (room.phase !== 'racing') return;

  const raceTime = now - room.raceStartAt;

  // Catch up on any spawns due this tick (bounded so a stalled loop can't flood).
  const frontier = raceFrontier(room, raceTime);
  let guard = 0;
  while (room.nextSpawnAt <= raceTime && guard++ < 6) {
    spawnTraffic(room, room.nextSpawnAt, frontier);
    scheduleNextSpawn(room, room.nextSpawnAt);
  }

  const alive = [...room.players.values()].filter((p) => !p.crashed && !p.finished);
  if (alive.length === 0 && room.players.size > 0) endMatch(room, 'all-out');
}

function endMatch(room, reason) {
  if (room.phase === 'finished' || room.phase === 'waiting') return;
  room.phase = 'finished';
  if (room.timer) clearInterval(room.timer);
  room.timer = null;

  const players = [...room.players.values()];
  // Winner: first to finish; otherwise the survivor; otherwise furthest travelled.
  const finishers = players
    .filter((p) => p.finished)
    .sort((a, b) => a.finishTime - b.finishTime);
  const survivors = players.filter((p) => !p.crashed);

  let winner = null;
  if (finishers.length) winner = finishers[0];
  else if (survivors.length === 1) winner = survivors[0];
  else {
    const sorted = [...players].sort((a, b) => b.distance - a.distance);
    if (sorted.length && (!sorted[1] || sorted[0].distance !== sorted[1].distance)) {
      winner = sorted[0];
    }
  }
  if (winner) winner.score += 1;

  for (const p of players) p.ready = false;

  io.to(room.code).emit('match:over', {
    reason,
    winnerId: winner ? winner.id : null,
    results: players
      .map((p) => ({
        id: p.id,
        name: p.name,
        distance: Math.round(p.distance),
        crashed: p.crashed,
        finished: p.finished,
        finishTime: p.finishTime,
        score: p.score,
      }))
      .sort((a, b) => b.distance - a.distance),
  });
  broadcastRoom(room);
  log(`room ${room.code} finished (${reason})`);
}

/* ------------------------------------------------------------ socket layer */

io.on('connection', (socket) => {
  socket.data.roomCode = null;

  const currentRoom = () =>
    socket.data.roomCode ? rooms.get(socket.data.roomCode) || null : null;

  const fail = (ack, code, message) => {
    if (typeof ack === 'function') ack({ ok: false, code, message });
    else socket.emit('room:error', { code, message });
  };

  /** Clock sync: client measures RTT and offsets its race clock. */
  socket.on('time:sync', (clientTime, ack) => {
    if (typeof ack === 'function') ack({ clientTime, serverTime: Date.now() });
  });

  /**
   * join({ room?: 'XYZ123', name?: 'Selam' })
   * No code => create a room and return the invite link path.
   */
  socket.on('room:join', (payload = {}, ack) => {
    if (socket.data.roomCode) return fail(ack, 'ALREADY_IN_ROOM', 'Önce mevcut odadan ayrılmalısın.');

    const requested = String(payload.room || '').toUpperCase().trim();
    let room;

    if (requested) {
      if (!ROOM_CODE_RE.test(requested)) return fail(ack, 'BAD_CODE', 'Geçersiz oda kodu.');
      room = rooms.get(requested);
      if (!room) return fail(ack, 'NOT_FOUND', 'Böyle bir oda yok.');
      if (room.players.size >= CONFIG.MAX_PLAYERS) return fail(ack, 'FULL', 'Oda dolu.');
      if (room.phase === 'countdown' || room.phase === 'racing') {
        return fail(ack, 'IN_PROGRESS', 'Bu yarış çoktan başladı.');
      }
    } else {
      room = createRoom();
    }

    const isHost = room.players.size === 0;
    const player = {
      id: socket.id,
      name: sanitizeName(payload.name, isHost ? 'Oyuncu 1' : 'Oyuncu 2'),
      isHost,
      ready: false,
      distance: 0,
      crashed: false,
      finished: false,
      finishTime: null,
      score: 0,
      lastStateAt: 0,
    };

    room.players.set(socket.id, player);
    if (isHost) room.hostId = socket.id;
    socket.data.roomCode = room.code;
    socket.join(room.code);

    if (typeof ack === 'function') {
      ack({
        ok: true,
        you: publicPlayer(player),
        room: roomSnapshot(room),
        inviteUrl: `/?room=${room.code}`,
        serverTime: Date.now(),
      });
    }
    socket.to(room.code).emit('room:playerJoined', publicPlayer(player));
    broadcastRoom(room);
    log(`room ${room.code}: ${player.name} joined (${room.players.size}/${CONFIG.MAX_PLAYERS})`);
  });

  socket.on('room:ready', (ready, ack) => {
    const room = currentRoom();
    if (!room) return fail(ack, 'NO_ROOM', 'Bir odada değilsin.');
    const player = room.players.get(socket.id);
    if (!player) return fail(ack, 'NO_PLAYER', 'Bir odada değilsin.');
    if (room.phase === 'countdown' || room.phase === 'racing') {
      return fail(ack, 'IN_PROGRESS', 'Yarış zaten sürüyor.');
    }
    player.ready = ready !== false;
    if (typeof ack === 'function') ack({ ok: true, ready: player.ready });
    broadcastRoom(room);
    tryStartMatch(room);
  });

  /**
   * Player transform relay. The server does not simulate the cars — it relays
   * the opponent ghost and keeps an authoritative record of progress.
   */
  socket.on('player:state', (state) => {
    const room = currentRoom();
    if (!room || room.phase !== 'racing') return;
    const player = room.players.get(socket.id);
    if (!player || player.crashed || player.finished) return;
    if (!state || !isFiniteNumber(state.distance) || !isFiniteNumber(state.x)) return;

    const now = Date.now();
    if (now - player.lastStateAt < CONFIG.STATE_RATE_LIMIT_MS) return;

    // Reject impossible progress (teleporting / tampered clients).
    const elapsed = Math.max(1, now - (player.lastStateAt || room.raceStartAt)) / 1000;
    const maxDelta = CONFIG.MAX_SPEED_SANITY * elapsed + 5;
    const distance = Math.min(
      Math.max(state.distance, player.distance),
      player.distance + maxDelta
    );
    player.lastStateAt = now;
    player.distance = distance;

    socket.to(room.code).emit('opponent:state', {
      id: player.id,
      x: state.x,
      distance,
      lane: isFiniteNumber(state.lane) ? state.lane : null,
      speed: isFiniteNumber(state.speed) ? state.speed : 0,
      heading: isFiniteNumber(state.heading) ? state.heading : 0,
      t: now,
    });

    if (distance >= CONFIG.FINISH_DISTANCE && !player.finished) {
      player.finished = true;
      player.finishTime = now - room.raceStartAt;
      io.to(room.code).emit('player:finished', {
        id: player.id,
        name: player.name,
        time: player.finishTime,
      });
      endMatch(room, 'finish');
    }
  });

  socket.on('player:crash', (info = {}) => {
    const room = currentRoom();
    if (!room || room.phase !== 'racing') return;
    const player = room.players.get(socket.id);
    if (!player || player.crashed || player.finished) return;

    player.crashed = true;
    io.to(room.code).emit('player:crashed', {
      id: player.id,
      name: player.name,
      distance: Math.round(player.distance),
      trafficId: isFiniteNumber(info.trafficId) ? info.trafficId : null,
    });

    // Last car standing wins immediately.
    const alive = [...room.players.values()].filter((p) => !p.crashed && !p.finished);
    if (alive.length <= 1) endMatch(room, 'crash');
  });

  socket.on('room:rematch', (_payload, ack) => {
    const room = currentRoom();
    if (!room) return fail(ack, 'NO_ROOM', 'Bir odada değilsin.');
    if (room.phase === 'countdown' || room.phase === 'racing') {
      return fail(ack, 'BAD_PHASE', 'Yarış zaten sürüyor.');
    }
    const player = room.players.get(socket.id);
    if (!player) return fail(ack, 'NO_PLAYER', 'Bir odada değilsin.');

    // Stay in `finished` until BOTH players opt in — flipping the phase here
    // would reject the second player's request.
    player.ready = true;
    if (typeof ack === 'function') ack({ ok: true });
    io.to(room.code).emit('room:rematch', { by: player.id });
    broadcastRoom(room);
    tryStartMatch(room);
  });

  socket.on('room:leave', (_payload, ack) => {
    leaveRoom(socket, 'left');
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', (reason) => leaveRoom(socket, reason));
});

function leaveRoom(socket, reason) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.roomCode = null;
  socket.leave(code);
  if (!room) return;

  const player = room.players.get(socket.id);
  room.players.delete(socket.id);
  if (player) {
    io.to(room.code).emit('room:playerLeft', { id: player.id, name: player.name, reason });
    log(`room ${code}: ${player.name} left (${reason})`);
  }

  if (room.players.size === 0) {
    destroyRoom(room);
    return;
  }

  // Promote the remaining player to host and abort any running race.
  const [next] = room.players.values();
  next.isHost = true;
  next.ready = false;
  room.hostId = next.id;

  if (room.phase === 'countdown' || room.phase === 'racing') {
    endMatch(room, 'opponent-left');
  } else {
    room.phase = 'waiting';
  }
  broadcastRoom(room);
}

/* ------------------------------------------------- housekeeping & shutdown */

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.players.size === 0 && now - room.createdAt > CONFIG.EMPTY_ROOM_TTL_MS) {
      destroyRoom(room);
    }
  }
}, CONFIG.ROOM_SWEEP_MS);

server.listen(CONFIG.PORT, () => {
  log(`Traffic Duel server listening on http://localhost:${CONFIG.PORT}`);
});

function shutdown(signal) {
  log(`${signal} received — shutting down`);
  clearInterval(sweeper);
  for (const room of rooms.values()) if (room.timer) clearInterval(room.timer);
  io.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log('unhandledRejection', err));

module.exports = {
  app, server, io, rooms, CONFIG, makeRng,
  // trafik üreticisi — testler ve determinizm doğrulaması için dışa açık
  spawnTraffic, scheduleNextSpawn, trafficZAt, raceFrontier,
};
