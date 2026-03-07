const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ── HTTP server (serves index.html) ──────────────────────
const httpServer = http.createServer((req, res) => {
  const file = path.join(__dirname, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

// ── Game state ────────────────────────────────────────────
const ROOMS = {};          // roomId → room
const PLAYER_ROOM = {};    // socketId → roomId

function mkRoom(id) {
  return {
    id,
    players: {},           // id → playerState
    zombies: {},           // id → zombieState
    round: 0,
    rndActive: false,
    betweenRnd: false,
    coins: {},             // id → coins
    spawned: 0,
    rndZ: 0,
    killedRnd: 0,
    hostId: null,
    spawnTimer: 3,
    roundStartTime: 0,
  };
}

function broadcast(room, msg, excludeId = null) {
  const data = JSON.stringify(msg);
  Object.values(room.players).forEach(p => {
    if (p.ws && p.ws.readyState === 1 && p.id !== excludeId) {
      try { p.ws.send(data); } catch(e) {}
    }
  });
}

function broadcastAll(room, msg) {
  broadcast(room, msg, null);
}

function sendTo(ws, msg) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch(e) {}
}

// ── Zombie AI (server-authoritative) ─────────────────────
let ZID = 0;
function spawnZombie(room) {
  const big = room.round >= 5 && Math.random() < 0.06 + (room.round - 5) * 0.04;
  const spawnPoints = [
    { x: -5,  z: 20 }, { x: 5,   z: 20 },
    { x: -20, z: -2 }, { x: 20,  z: 2  },
  ];
  const sp = spawnPoints[Math.floor(Math.random() * spawnPoints.length)];
  const id = 'z' + (++ZID);
  const hp = (big ? 700 : 500) + room.round * (big ? 130 : 88);
  room.zombies[id] = {
    id, big,
    x: sp.x + (Math.random() - 0.5) * 2,
    z: sp.z + (Math.random() - 0.5) * 2,
    hp, maxHp: hp,
    speed: big ? 1.0 + room.round * 0.09 : 1.55 + room.round * 0.23,
    dmg: big ? 18 + room.round * 4 : 9 + room.round * 2.5,
    animT: Math.random() * 6.28,
    atkCD: 1.0,
    targetId: null,
    alive: true,
  };
  return id;
}

function startRound(room) {
  room.round++;
  room.rndZ = 6 + room.round * 4 + Math.floor(room.round / 3) * 2;
  room.spawned = 0;
  room.killedRnd = 0;
  room.rndActive = true;
  room.betweenRnd = false;
  room.spawnTimer = 2.5;
  room.zombies = {};
  // Heal all players a bit at round start
  Object.values(room.players).forEach(p => {
    p.hp = Math.min(100, p.hp + 20);
  });
  broadcastAll(room, {
    type: 'round_start',
    round: room.round,
    rndZ: room.rndZ,
    players: sanitizePlayers(room),
  });
}

function endRound(room) {
  room.rndActive = false;
  room.betweenRnd = true;
  room.zombies = {};
  broadcastAll(room, {
    type: 'round_end',
    round: room.round,
    players: sanitizePlayers(room),
  });
  // Auto-start next round after 15 seconds
  setTimeout(() => {
    if (room.betweenRnd && Object.keys(room.players).length > 0) {
      startRound(room);
    }
  }, 15000);
}

function sanitizePlayers(room) {
  const out = {};
  Object.values(room.players).forEach(p => {
    out[p.id] = { id: p.id, name: p.name, hp: p.hp, x: p.x, z: p.z, yaw: p.yaw, score: p.score, coins: p.coins, kills: p.kills, wep: p.wep, alive: p.hp > 0 };
  });
  return out;
}

// ── Server tick (zombie AI) ───────────────────────────────
const TICK = 100; // ms
setInterval(() => {
  Object.values(ROOMS).forEach(room => {
    if (!room.rndActive) return;
    const pList = Object.values(room.players).filter(p => p.hp > 0);
    if (pList.length === 0) return;

    // Spawn timer
    room.spawnTimer -= TICK / 1000;
    if (room.spawnTimer <= 0 && room.spawned < room.rndZ) {
      const batch = room.round > 5 ? 2 : 1;
      for (let i = 0; i < batch && room.spawned < room.rndZ; i++) {
        const zid = spawnZombie(room);
        room.spawned++;
        broadcastAll(room, { type: 'zombie_spawn', zombie: room.zombies[zid] });
      }
      room.spawnTimer = Math.max(0.3, 2.6 - room.round * 0.18);
    }

    // Zombie movement & attacks
    const dt = TICK / 1000;
    const updates = [];
    Object.values(room.zombies).forEach(z => {
      if (!z.alive) return;
      // Find closest player
      let closest = null, minDist = Infinity;
      pList.forEach(p => {
        const dx = p.x - z.x, dz = p.z - z.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < minDist) { minDist = d; closest = p; }
      });
      if (!closest) return;
      const dx = closest.x - z.x, dz = closest.z - z.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const ar = z.big ? 1.5 : 1.15;
      if (dist > ar) {
        z.x += (dx / dist) * z.speed * dt;
        z.z += (dz / dist) * z.speed * dt;
      } else {
        z.atkCD -= dt;
        if (z.atkCD <= 0) {
          z.atkCD = z.big ? 0.75 : 1.05;
          closest.hp = Math.max(0, closest.hp - z.dmg);
          sendTo(closest.ws, { type: 'player_hit', hp: closest.hp, dmg: z.dmg });
          broadcastAll(room, { type: 'player_hp', id: closest.id, hp: closest.hp });
          if (closest.hp <= 0) {
            broadcastAll(room, { type: 'player_dead', id: closest.id });
            // Check if all players dead
            const alive = Object.values(room.players).filter(p => p.hp > 0);
            if (alive.length === 0) {
              broadcastAll(room, { type: 'game_over', round: room.round });
              room.rndActive = false;
            }
          }
        }
      }
      z.animT += dt;
      updates.push({ id: z.id, x: z.x, z: z.z, animT: z.animT });
    });
    if (updates.length > 0) {
      broadcastAll(room, { type: 'zombies_update', updates });
    }
  });
}, TICK);

// ── WebSocket server ──────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });
let SID = 0;

wss.on('connection', (ws) => {
  const sid = 's' + (++SID);
  ws.sid = sid;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    switch (msg.type) {

      case 'join': {
        // Create or join a room
        let roomId = msg.room || 'default';
        if (!ROOMS[roomId]) ROOMS[roomId] = mkRoom(roomId);
        const room = ROOMS[roomId];
        PLAYER_ROOM[sid] = roomId;
        const isHost = Object.keys(room.players).length === 0;
        if (isHost) room.hostId = sid;
        room.players[sid] = {
          id: sid, ws, name: msg.name || ('Player' + Object.keys(room.players).length + 1),
          hp: 100, x: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 4,
          yaw: 0, score: 0, coins: 500, kills: 0, wep: 'm1carbine', alive: true,
        };
        // Send init state to new player
        sendTo(ws, {
          type: 'init',
          id: sid,
          roomId,
          isHost,
          round: room.round,
          rndActive: room.rndActive,
          betweenRnd: room.betweenRnd,
          players: sanitizePlayers(room),
          zombies: room.zombies,
        });
        // Tell others
        broadcast(room, { type: 'player_joined', player: sanitizePlayers(room)[sid] }, sid);
        // If host and first player, start in 3s
        if (isHost) {
          setTimeout(() => {
            if (room.round === 0 && Object.keys(room.players).length > 0) startRound(room);
          }, 3000);
        }
        break;
      }

      case 'move': {
        const room = ROOMS[PLAYER_ROOM[sid]];
        if (!room || !room.players[sid]) break;
        const p = room.players[sid];
        p.x = msg.x; p.z = msg.z; p.yaw = msg.yaw;
        broadcast(room, { type: 'player_move', id: sid, x: msg.x, z: msg.z, yaw: msg.yaw }, sid);
        break;
      }

      case 'shoot': {
        const room = ROOMS[PLAYER_ROOM[sid]];
        if (!room) break;
        // Check hit on zombies
        if (msg.hits && Array.isArray(msg.hits)) {
          msg.hits.forEach(({ zid, dmg }) => {
            const z = room.zombies[zid];
            if (!z || !z.alive) return;
            z.hp -= dmg;
            if (z.hp <= 0) {
              z.alive = false;
              const killer = room.players[sid];
              const bonus = z.big ? 150 : 50;
              if (killer) {
                killer.score += bonus * Math.max(1, Math.floor(room.round / 2));
                killer.coins += bonus;
                killer.kills++;
              }
              room.killedRnd++;
              broadcastAll(room, {
                type: 'zombie_dead', zid, killerId: sid,
                bonus, score: killer ? killer.score : 0, coins: killer ? killer.coins : 0, kills: killer ? killer.kills : 0,
              });
              if (room.killedRnd >= room.rndZ) endRound(room);
            } else {
              broadcastAll(room, { type: 'zombie_hit', zid, hp: z.hp, maxHp: z.maxHp });
            }
          });
        }
        // Broadcast bullet visual to others
        broadcast(room, { type: 'bullet', x: msg.x, z: msg.z, dx: msg.dx, dz: msg.dz, glow: msg.glow }, sid);
        break;
      }

      case 'knife': {
        const room = ROOMS[PLAYER_ROOM[sid]];
        if (!room) break;
        if (msg.hits && Array.isArray(msg.hits)) {
          msg.hits.forEach(({ zid, dmg }) => {
            const z = room.zombies[zid];
            if (!z || !z.alive) return;
            z.hp -= dmg;
            if (z.hp <= 0) {
              z.alive = false;
              const killer = room.players[sid];
              const bonus = z.big ? 150 : 50;
              if (killer) { killer.score += bonus; killer.coins += bonus; killer.kills++; }
              room.killedRnd++;
              broadcastAll(room, { type: 'zombie_dead', zid, killerId: sid, bonus, score: killer?.score||0, coins: killer?.coins||0, kills: killer?.kills||0 });
              if (room.killedRnd >= room.rndZ) endRound(room);
            } else {
              broadcastAll(room, { type: 'zombie_hit', zid, hp: z.hp, maxHp: z.maxHp });
            }
          });
        }
        broadcast(room, { type: 'knife_anim', id: sid }, sid);
        break;
      }

      case 'buy': {
        const room = ROOMS[PLAYER_ROOM[sid]];
        if (!room || !room.players[sid]) break;
        const p = room.players[sid];
        const COSTS = { thompson:1200, shotgun:1600, bar:2200, stg44:3000, raygun:5000 };
        const cost = COSTS[msg.wep] || 0;
        if (p.coins >= cost) {
          p.coins -= cost;
          p.wep = msg.wep;
          sendTo(ws, { type: 'buy_ok', wep: msg.wep, coins: p.coins });
          broadcast(room, { type: 'player_wep', id: sid, wep: msg.wep }, sid);
        } else {
          sendTo(ws, { type: 'buy_fail' });
        }
        break;
      }

      case 'respawn': {
        const room = ROOMS[PLAYER_ROOM[sid]];
        if (!room || !room.players[sid]) break;
        const p = room.players[sid];
        p.hp = 100;
        p.x = (Math.random() - 0.5) * 4;
        p.z = (Math.random() - 0.5) * 4;
        sendTo(ws, { type: 'respawned', hp: p.hp, x: p.x, z: p.z });
        broadcastAll(room, { type: 'player_hp', id: sid, hp: p.hp });
        break;
      }

      case 'chat': {
        const room = ROOMS[PLAYER_ROOM[sid]];
        if (!room) break;
        broadcastAll(room, { type: 'chat', id: sid, name: room.players[sid]?.name || 'Player', text: String(msg.text).slice(0, 80) });
        break;
      }
    }
  });

  ws.on('close', () => {
    const roomId = PLAYER_ROOM[sid];
    if (!roomId) return;
    const room = ROOMS[roomId];
    if (!room) return;
    const name = room.players[sid]?.name || 'Player';
    delete room.players[sid];
    delete PLAYER_ROOM[sid];
    broadcast(room, { type: 'player_left', id: sid, name });
    // Clean empty rooms
    if (Object.keys(room.players).length === 0) {
      delete ROOMS[roomId];
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n🎮 CALL OF DIDY SERVER RUNNING`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`📡 WebSocket ready\n`);
});
