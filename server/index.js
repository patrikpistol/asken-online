/**
 * Asken Online - Server
 * 
 * Det klassiska svenska kortspelet Asken, online!
 * 
 * Skapat av Patrik Pistol för Pistol Reklambyrå AB
 * https://pistol.se
 * https://patrikpistol.com
 * 
 * © 2024 Pistol Reklambyrå AB
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// Redis för persistent lagring
const { Redis } = require('@upstash/redis');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 120000,    // 2 minuter timeout
  pingInterval: 30000,    // Ping var 30:e sekund
  connectTimeout: 45000,  // 45 sek för initial anslutning
  allowEIO3: true         // Bakåtkompatibilitet
});

// ============================================
// ROBOTNAMN
// ============================================

const BOT_NAMES = [
  'Dave',
  'Deckard',
  'Roy',
  'Pris',
  'Leon',
  'Rachael',
  'Kirsh',
  'Anna',
  'R2-D2',
  'HAL-9000',
  'Mathilda',
  'C-3PO',
  'Ash 120-A/2',
  'Bishop',
  'Chappie',
  'M3GAN',
  'Gort',
  'Dalek',
  'Bender',
  'Ava',
  'Data',
  'T-800',
  'T-1000',
  'Wall-E',
  'Mother',
  'Marvin',
  'Astro Boy',
  'K-2SO',
  'Daneel',
  'Hadaly',
  'Järnjätten',
  'Dot Matrix',
  'KITT',
  'TARS',
  'ED-209',
  'Baymax',
  'Mazinger Z',
  'Sonny',
  'GLaDOS',
  'Megatron',
  'Optimus Prime',
  'Maria',
  'SAL-9000',
  'Twiki',
  'Mimus',
  'Maskinen',
  'Plåtniklas',
  'Atari ST',
  'Amiga',
  'ZX Spectrum',
  'Commodore 64',
  'PC',
  'Macintosh',
  'VIC-20'
];

function getRandomBotName(existingNames) {
  const availableNames = BOT_NAMES.filter(name => 
    !existingNames.some(n => n.toLowerCase() === name.toLowerCase())
  );
  if (availableNames.length === 0) {
    return `Bot-${Math.floor(Math.random() * 1000)}`;
  }
  return availableNames[Math.floor(Math.random() * availableNames.length)];
}

// ============================================
// REDIS SETUP
// ============================================

let redis = null;
const ROOM_EXPIRY = 172800; // Rum försvinner efter 48 timmar utan aktivitet

// Initiera Redis om miljövariabler finns
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  console.log('Redis aktiverat - rum sparas persistent');
} else {
  console.log('Redis ej konfigurerat - rum sparas endast i minnet');
}

// Lokal cache för snabbare åtkomst
const roomsCache = new Map();

// ============================================
// MATCHMAKING-KÖ
// ============================================

// Kö med spelare som söker match
// Format: { socketId, name, joinedAt }
const matchmakingQueue = [];

// Matchmaking-rum (kod börjar alltid med "MM")
const MATCHMAKING_ROOM_CODE = 'MATCHMAKING';

function addToMatchmaking(socketId, name) {
  // Ta bort om redan finns
  removeFromMatchmaking(socketId);
  
  matchmakingQueue.push({
    socketId,
    name,
    joinedAt: Date.now()
  });
  
  console.log(`[Matchmaking] ${name} gick med i kön. Totalt: ${matchmakingQueue.length}`);
  broadcastMatchmakingState();
}

function removeFromMatchmaking(socketId) {
  const index = matchmakingQueue.findIndex(p => p.socketId === socketId);
  if (index !== -1) {
    const removed = matchmakingQueue.splice(index, 1)[0];
    console.log(`[Matchmaking] ${removed.name} lämnade kön. Totalt: ${matchmakingQueue.length}`);
    broadcastMatchmakingState();
    return removed;
  }
  return null;
}

function getMatchmakingState() {
  // Den som väntat längst är värd (index 0)
  const players = matchmakingQueue.map((p, index) => ({
    id: p.socketId,
    name: p.name,
    isHost: index === 0,
    position: index + 1,
    joinedAt: p.joinedAt
  }));
  
  return {
    queueCount: matchmakingQueue.length,
    players,
    hostId: matchmakingQueue.length > 0 ? matchmakingQueue[0].socketId : null
  };
}

function broadcastMatchmakingState() {
  const state = getMatchmakingState();
  
  matchmakingQueue.forEach((player, index) => {
    const socket = io.sockets.sockets.get(player.socketId);
    if (socket) {
      socket.emit('matchmakingUpdate', {
        ...state,
        position: index + 1,
        isHost: index === 0
      });
    }
  });
}

// Spara rum till Redis
async function saveRoom(room) {
  room.lastActivity = Date.now();
  
  // Spara alltid i lokal cache först
  roomsCache.set(room.code, JSON.parse(JSON.stringify(room))); // Deep copy
  
  if (redis) {
    // Spara till Redis i bakgrunden
    redis.set(`room:${room.code}`, JSON.stringify(room), { ex: ROOM_EXPIRY })
      .catch(err => console.error('Redis save error:', err.message));
  }
  return true;
}

// Hämta rum - prioriterar alltid lokal cache
async function getRoom(code) {
  if (!code) return null;
  code = code.toUpperCase();
  
  // Kolla cache först - lita på cachen!
  if (roomsCache.has(code)) {
    return roomsCache.get(code);
  }
  
  // Om inte i cache, försök Redis
  if (redis) {
    try {
      const data = await redis.get(`room:${code}`);
      if (data) {
        const room = typeof data === 'string' ? JSON.parse(data) : data;
        roomsCache.set(code, room);
        console.log(`Rum ${code} hämtat från Redis`);
        return room;
      }
    } catch (err) {
      console.error('Redis get error:', err.message);
    }
  }
  
  return null;
}

// Ta bort rum
async function deleteRoom(code) {
  roomsCache.delete(code);
  
  if (redis) {
    try {
      await redis.del(`room:${code}`);
    } catch (err) {
      console.error('Redis delete error:', err.message);
    }
  }
}

// Räkna antal rum
async function countRooms() {
  if (redis) {
    try {
      const keys = await redis.keys('room:*');
      return keys.length;
    } catch (err) {
      return roomsCache.size;
    }
  }
  return roomsCache.size;
}

async function getAllRooms() {
  const rooms = [];
  if (redis) {
    try {
      const keys = await redis.keys('room:*');
      for (const key of keys) {
        const data = await redis.get(key);
        if (data) {
          rooms.push(JSON.parse(data));
        }
      }
    } catch (err) {
      // Fallback till cache
      for (const room of roomsCache.values()) {
        rooms.push(room);
      }
    }
  } else {
    for (const room of roomsCache.values()) {
      rooms.push(room);
    }
  }
  return rooms;
}

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// Hemlig admin-nyckel (sätt som miljövariabel i Render)
const ADMIN_KEY = process.env.ADMIN_KEY || 'asken-secret-2024';

// Hemlig admin-endpoint
app.get('/admin/:key', async (req, res) => {
  if (req.params.key !== ADMIN_KEY) {
    return res.status(404).send('Not found');
  }
  
  const rooms = await getAllRooms();
  const now = Date.now();
  
  // Formatera data för visning
  const roomData = rooms.map(room => ({
    code: room.code,
    state: room.state,
    mode: room.mode || 'standard',
    roundNumber: room.roundNumber || 0,
    created: room.createdAt ? new Date(room.createdAt).toLocaleString('sv-SE') : 'Okänt',
    lastActivity: room.lastActivity ? Math.floor((now - room.lastActivity) / 60000) + ' min sedan' : 'Okänt',
    players: room.players.map(p => ({
      name: p.name,
      isBot: p.isBot || false,
      connected: p.connected,
      score: p.score || 0,
      cards: p.hand ? p.hand.length : 0
    }))
  }));
  
  // Matchmaking-kö
  const queueData = matchmakingQueue.map(p => ({
    name: p.name,
    waiting: Math.floor((now - p.joinedAt) / 1000) + 's'
  }));
  
  // Beräkna extra statistik
  const totalHumans = roomData.reduce((sum, r) => sum + r.players.filter(p => !p.isBot).length, 0);
  const totalBots = roomData.reduce((sum, r) => sum + r.players.filter(p => p.isBot).length, 0);
  const playingRooms = roomData.filter(r => r.state === 'playing').length;
  const lobbyRooms = roomData.filter(r => r.state === 'lobby').length;
  const connectedSockets = io.sockets.sockets.size;
  const avgPlayersPerRoom = roomData.length > 0 ? (totalHumans / roomData.length).toFixed(1) : 0;
  const longestWait = queueData.length > 0 ? queueData[0].waiting : '-';
  
  // Server-info
  const uptimeSeconds = process.uptime();
  const uptimeStr = uptimeSeconds > 86400 
    ? Math.floor(uptimeSeconds / 86400) + 'd ' + Math.floor((uptimeSeconds % 86400) / 3600) + 'h'
    : uptimeSeconds > 3600 
      ? Math.floor(uptimeSeconds / 3600) + 'h ' + Math.floor((uptimeSeconds % 3600) / 60) + 'm'
      : Math.floor(uptimeSeconds / 60) + 'm';
  const memUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  
  // Generera HTML
  const html = `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Asken Admin</title>
  <meta name="robots" content="noindex, nofollow">
  <meta http-equiv="refresh" content="30">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: system-ui, sans-serif; 
      background: #1a1a1a; 
      color: #f0f0f0; 
      padding: 20px;
      line-height: 1.6;
    }
    h1 { color: #c69e60; margin-bottom: 20px; }
    h2 { color: #c69e60; margin: 30px 0 15px; font-size: 1.2rem; }
    .stats { 
      display: flex; 
      gap: 15px; 
      margin-bottom: 20px; 
      flex-wrap: wrap;
    }
    .stat { 
      background: #2a2a2a; 
      padding: 16px 20px; 
      border-radius: 10px; 
      min-width: 120px;
    }
    .stat-value { font-size: 1.8rem; color: #c69e60; font-weight: bold; }
    .stat-label { color: #888; font-size: 0.85rem; }
    .stat-small { 
      background: #252525; 
      padding: 12px 16px; 
      border-radius: 8px; 
      min-width: 100px;
    }
    .stat-small .stat-value { font-size: 1.3rem; }
    .stat-small .stat-label { font-size: 0.75rem; }
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin: 30px 0 15px;
    }
    .section-header h2 { margin: 0; }
    .section-count {
      background: #3a3a3a;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 0.9rem;
      color: #c69e60;
    }
    .room { 
      background: #2a2a2a; 
      border-radius: 10px; 
      padding: 20px; 
      margin-bottom: 15px;
    }
    .room-header { 
      display: flex; 
      justify-content: space-between; 
      align-items: center;
      margin-bottom: 10px;
      flex-wrap: wrap;
      gap: 10px;
    }
    .room-code { 
      font-size: 1.5rem; 
      font-weight: bold; 
      color: #c69e60;
      font-family: monospace;
    }
    .room-state { 
      padding: 4px 12px; 
      border-radius: 20px; 
      font-size: 0.8rem;
      font-weight: 600;
    }
    .state-lobby { background: #3d5a80; }
    .state-playing { background: #4caf50; }
    .state-roundEnd { background: #ff9800; }
    .room-meta { color: #888; font-size: 0.85rem; margin-bottom: 10px; }
    .players { display: flex; flex-wrap: wrap; gap: 10px; }
    .player { 
      background: #1a1a1a; 
      padding: 8px 12px; 
      border-radius: 6px;
      font-size: 0.9rem;
    }
    .player.bot { opacity: 0.6; }
    .player.disconnected { opacity: 0.4; text-decoration: line-through; }
    .player.current { border: 2px solid #c69e60; }
    .player-name { font-weight: 600; }
    .player-info { color: #888; font-size: 0.8rem; }
    .queue { 
      background: #2a2a2a; 
      border-radius: 10px; 
      padding: 20px;
    }
    .queue-player { 
      display: inline-block;
      background: #1a1a1a; 
      padding: 8px 12px; 
      border-radius: 6px;
      margin: 5px;
    }
    .empty { color: #666; font-style: italic; }
    .server-info {
      background: #252525;
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 20px;
      display: flex;
      gap: 30px;
      flex-wrap: wrap;
      font-size: 0.85rem;
    }
    .server-info-item {
      display: flex;
      gap: 8px;
    }
    .server-info-label { color: #888; }
    .server-info-value { color: #c69e60; font-weight: 500; }
    .refresh { 
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #c69e60;
      color: #1a1a1a;
      border: none;
      padding: 12px 24px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
    }
    .refresh:hover { background: #b08a50; }
    .auto-refresh-note {
      position: fixed;
      bottom: 25px;
      right: 140px;
      color: #666;
      font-size: 0.75rem;
    }
  </style>
</head>
<body>
  <h1>🎴 Asken Admin</h1>
  
  <div class="server-info">
    <div class="server-info-item">
      <span class="server-info-label">Uptime:</span>
      <span class="server-info-value">${uptimeStr}</span>
    </div>
    <div class="server-info-item">
      <span class="server-info-label">Minne:</span>
      <span class="server-info-value">${memUsage} MB</span>
    </div>
    <div class="server-info-item">
      <span class="server-info-label">Sockets:</span>
      <span class="server-info-value">${connectedSockets}</span>
    </div>
    <div class="server-info-item">
      <span class="server-info-label">Redis:</span>
      <span class="server-info-value">${redis ? '✅ Ansluten' : '❌ Ej ansluten'}</span>
    </div>
    <div class="server-info-item">
      <span class="server-info-label">Tid:</span>
      <span class="server-info-value">${new Date().toLocaleString('sv-SE')}</span>
    </div>
  </div>
  
  <div class="nav" style="margin-bottom: 20px;">
    <a href="/admin/${ADMIN_KEY}/history" style="color: #c69e60;">📊 Visa historik →</a>
  </div>
  
  <div class="stats">
    <div class="stat">
      <div class="stat-value">${roomData.length}</div>
      <div class="stat-label">Aktiva rum</div>
    </div>
    <div class="stat">
      <div class="stat-value">${totalHumans}</div>
      <div class="stat-label">Människor i spel</div>
    </div>
    <div class="stat">
      <div class="stat-value">${queueData.length}</div>
      <div class="stat-label">I matchmaking-kö</div>
    </div>
    <div class="stat">
      <div class="stat-value">${totalHumans + queueData.length}</div>
      <div class="stat-label">Totalt online</div>
    </div>
  </div>
  
  <div class="stats">
    <div class="stat-small">
      <div class="stat-value">${playingRooms}</div>
      <div class="stat-label">Spelar</div>
    </div>
    <div class="stat-small">
      <div class="stat-value">${lobbyRooms}</div>
      <div class="stat-label">I lobby</div>
    </div>
    <div class="stat-small">
      <div class="stat-value">${totalBots}</div>
      <div class="stat-label">Robotar</div>
    </div>
    <div class="stat-small">
      <div class="stat-value">${avgPlayersPerRoom}</div>
      <div class="stat-label">Snitt/rum</div>
    </div>
    <div class="stat-small">
      <div class="stat-value">${longestWait}</div>
      <div class="stat-label">Längst väntan</div>
    </div>
  </div>
  
  <div class="section-header">
    <h2>📋 Matchmaking-kö</h2>
    <span class="section-count">${queueData.length} spelare</span>
  </div>
  <div class="queue">
    ${queueData.length === 0 ? '<span class="empty">Ingen i kön</span>' : 
      queueData.map(p => `<span class="queue-player">${p.name} <small>(${p.waiting})</small></span>`).join('')}
  </div>
  
  <div class="section-header">
    <h2>🚪 Aktiva rum</h2>
    <span class="section-count">${roomData.length} rum</span>
  </div>
  ${roomData.length === 0 ? '<p class="empty">Inga aktiva rum</p>' : 
    roomData.map(room => `
      <div class="room">
        <div class="room-header">
          <span class="room-code">${room.code}</span>
          <span class="room-state state-${room.state}">${room.state === 'playing' ? '🎮 Spelar' : room.state === 'roundEnd' ? '🏁 Rundslut' : '⏳ Lobby'}</span>
        </div>
        <div class="room-meta">
          ${room.mode === 'quick' ? '⚡ Snabbspel' : '📊 Standard'} • 
          Runda ${room.roundNumber} • 
          Skapad: ${room.created} •
          Aktiv: ${room.lastActivity}
        </div>
        <div class="players">
          ${room.players.map((p, i) => `
            <div class="player ${p.isBot ? 'bot' : ''} ${!p.connected ? 'disconnected' : ''}">
              <span class="player-name">${p.isBot ? '🤖 ' : '👤 '}${p.name}</span>
              <span class="player-info">${p.score}p • ${p.cards} kort${!p.connected ? ' • ❌' : ''}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('')}
  
  <span class="auto-refresh-note">Auto-uppdatering: 30s</span>
  <button class="refresh" onclick="location.reload()">🔄 Uppdatera</button>
</body>
</html>
  `;
  
  res.send(html);
});

// Statistik-loggning
const statsLog = []; // In-memory för snabb åtkomst
const MAX_STATS_LOG = 1000; // Behåll senaste 1000 entries

async function logStats(event, data = {}) {
  const entry = {
    timestamp: Date.now(),
    event,
    ...data
  };
  
  statsLog.push(entry);
  
  // Begränsa storlek
  if (statsLog.length > MAX_STATS_LOG) {
    statsLog.shift();
  }
  
  // Spara även till Redis för persistens
  if (redis) {
    try {
      await redis.lpush('stats:log', JSON.stringify(entry));
      await redis.ltrim('stats:log', 0, MAX_STATS_LOG - 1);
    } catch (err) {
      // Ignorera Redis-fel
    }
  }
}

async function getStatsLog() {
  // Försök hämta från Redis först
  if (redis) {
    try {
      const logs = await redis.lrange('stats:log', 0, MAX_STATS_LOG - 1);
      if (logs && logs.length > 0) {
        return logs.map(l => JSON.parse(l));
      }
    } catch (err) {
      // Fallback till in-memory
    }
  }
  return statsLog;
}

// Historik-endpoint
app.get('/admin/:key/history', async (req, res) => {
  if (req.params.key !== ADMIN_KEY) {
    return res.status(404).send('Not found');
  }
  
  const logs = await getStatsLog();
  const now = Date.now();
  
  // Gruppera per timme för graf
  const hourlyStats = {};
  const last24h = now - (24 * 60 * 60 * 1000);
  
  logs.filter(l => l.timestamp > last24h).forEach(log => {
    const hour = new Date(log.timestamp).toISOString().slice(0, 13);
    if (!hourlyStats[hour]) {
      hourlyStats[hour] = { games: 0, players: new Set(), rounds: 0 };
    }
    if (log.event === 'game_started') hourlyStats[hour].games++;
    if (log.event === 'round_ended') hourlyStats[hour].rounds++;
    if (log.playerName) hourlyStats[hour].players.add(log.playerName);
  });
  
  // Formatera för visning
  const recentEvents = logs.slice(-100).reverse().map(log => ({
    time: new Date(log.timestamp).toLocaleString('sv-SE'),
    event: log.event,
    details: formatEventDetails(log)
  }));
  
  // Sammanfattning
  const last24hLogs = logs.filter(l => l.timestamp > last24h);
  
  // Samla alla unika spelare (från playerName OCH humans-arrayen)
  const allPlayers = new Set();
  last24hLogs.forEach(l => {
    if (l.playerName) allPlayers.add(l.playerName);
    if (l.humans && Array.isArray(l.humans)) {
      l.humans.forEach(name => allPlayers.add(name));
    }
  });
  
  const summary = {
    gamesStarted: last24hLogs.filter(l => l.event === 'game_started').length,
    roundsPlayed: last24hLogs.filter(l => l.event === 'round_ended').length,
    uniquePlayers: allPlayers.size,
    roomsCreated: last24hLogs.filter(l => l.event === 'room_created').length
  };
  
  const html = `
<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Asken Historik</title>
  <meta name="robots" content="noindex, nofollow">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: system-ui, sans-serif; 
      background: #1a1a1a; 
      color: #f0f0f0; 
      padding: 20px;
      line-height: 1.6;
    }
    h1 { color: #c69e60; margin-bottom: 10px; }
    h2 { color: #c69e60; margin: 30px 0 15px; font-size: 1.2rem; }
    .nav { margin-bottom: 20px; }
    .nav a { color: #c69e60; margin-right: 20px; }
    .stats { 
      display: flex; 
      gap: 20px; 
      margin-bottom: 30px; 
      flex-wrap: wrap;
    }
    .stat { 
      background: #2a2a2a; 
      padding: 20px; 
      border-radius: 10px; 
      min-width: 150px;
    }
    .stat-value { font-size: 2rem; color: #c69e60; font-weight: bold; }
    .stat-label { color: #888; font-size: 0.9rem; }
    .events {
      background: #2a2a2a;
      border-radius: 10px;
      overflow: hidden;
    }
    .event {
      padding: 12px 16px;
      border-bottom: 1px solid #333;
      display: flex;
      gap: 20px;
      align-items: center;
    }
    .event:last-child { border-bottom: none; }
    .event-time { color: #888; font-size: 0.85rem; min-width: 140px; }
    .event-type { 
      padding: 2px 8px; 
      border-radius: 4px; 
      font-size: 0.75rem;
      font-weight: 600;
      min-width: 100px;
      text-align: center;
    }
    .event-game_started { background: #4caf50; }
    .event-game_ended { background: #f44336; }
    .event-round_ended { background: #2196f3; }
    .event-room_created { background: #9c27b0; }
    .event-player_joined { background: #ff9800; }
    .event-player_left { background: #795548; }
    .event-details { color: #ccc; flex: 1; }
    .refresh { 
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #c69e60;
      color: #1a1a1a;
      border: none;
      padding: 12px 24px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 600;
    }
    .empty { color: #666; font-style: italic; padding: 20px; }
  </style>
</head>
<body>
  <h1>📊 Asken Historik</h1>
  <div class="nav">
    <a href="/admin/${ADMIN_KEY}">← Tillbaka till översikt</a>
  </div>
  
  <h2>Senaste 24 timmarna</h2>
  <div class="stats">
    <div class="stat">
      <div class="stat-value">${summary.gamesStarted}</div>
      <div class="stat-label">Spel startade</div>
    </div>
    <div class="stat">
      <div class="stat-value">${summary.roundsPlayed}</div>
      <div class="stat-label">Rundor spelade</div>
    </div>
    <div class="stat">
      <div class="stat-value">${summary.uniquePlayers}</div>
      <div class="stat-label">Unika spelare</div>
    </div>
    <div class="stat">
      <div class="stat-value">${summary.roomsCreated}</div>
      <div class="stat-label">Rum skapade</div>
    </div>
  </div>
  
  <h2>Senaste händelserna</h2>
  <div class="events">
    ${recentEvents.length === 0 ? '<p class="empty">Inga händelser loggade än</p>' :
      recentEvents.map(e => `
        <div class="event">
          <span class="event-time">${e.time}</span>
          <span class="event-type event-${e.event}">${formatEventType(e.event)}</span>
          <span class="event-details">${e.details}</span>
        </div>
      `).join('')}
  </div>
  
  <button class="refresh" onclick="location.reload()">🔄 Uppdatera</button>
</body>
</html>
  `;
  
  res.send(html);
});

function formatEventType(event) {
  const types = {
    'game_started': 'Spel startat',
    'game_ended': 'Spel avslutat',
    'round_ended': 'Runda klar',
    'room_created': 'Rum skapat',
    'player_joined': 'Spelare gick med',
    'player_left': 'Spelare lämnade'
  };
  return types[event] || event;
}

function formatEventDetails(log) {
  switch (log.event) {
    case 'game_started':
      var players = '';
      if (log.humans && log.humans.length > 0) {
        players += '👤 ' + log.humans.join(', ');
      }
      if (log.bots && log.bots.length > 0) {
        if (players) players += ' • ';
        players += '🤖 ' + log.bots.join(', ');
      }
      return 'Rum ' + log.roomCode + ' • ' + (log.mode === 'quick' ? 'Snabbspel' : 'Standard') + (players ? ' • ' + players : '');
    case 'game_ended':
      return 'Rum ' + log.roomCode + ' • Vinnare: ' + (log.winner || 'Okänd');
    case 'round_ended':
      return 'Rum ' + log.roomCode + ' • Runda ' + log.round + ' • Vinnare: ' + (log.winner || 'Okänd');
    case 'room_created':
      return 'Rum ' + log.roomCode + ' • Skapad av ' + log.playerName;
    case 'player_joined':
      return log.playerName + ' gick med i ' + log.roomCode;
    case 'player_left':
      return log.playerName + ' lämnade ' + log.roomCode;
    default:
      return JSON.stringify(log);
  }
}

// Keepalive endpoint
app.get('/health', async (req, res) => {
  const roomCount = await countRooms();
  res.status(200).json({ 
    status: 'ok', 
    rooms: roomCount,
    redis: redis ? 'connected' : 'disabled',
    uptime: process.uptime()
  });
});

// Stats endpoint för klienten
app.get('/stats', async (req, res) => {
  const roomCount = await countRooms();
  const queueCount = matchmakingQueue.length;
  res.status(200).json({ 
    rooms: roomCount,
    queue: queueCount
  });
});

// ============================================
// SPELLOGIK
// ============================================

const SUITS = ['spades', 'hearts', 'clubs', 'diamonds'];
const RANK_NAMES = { 
  1: 'A', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 
  8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K' 
};

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank++) {
      deck.push({ id: `${suit}-${rank}`, suit, rank });
    }
  }
  return deck;
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sortHand(hand) {
  const suitOrder = { spades: 0, hearts: 1, clubs: 2, diamonds: 3 };
  return hand.sort((a, b) => {
    if (suitOrder[a.suit] !== suitOrder[b.suit]) {
      return suitOrder[a.suit] - suitOrder[b.suit];
    }
    return a.rank - b.rank;
  });
}

function getCardPoints(card) {
  if (card.rank === 1) return 25;  // Ess
  if (card.rank >= 10) return 10;  // Klädda kort (10, J, Q, K)
  return 5;  // Oklädda kort (2-9)
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ============================================
// RUM-HANTERING
// ============================================

async function createRoom(hostId, hostName) {
  let code = generateRoomCode();
  
  // Se till att koden är unik
  let attempts = 0;
  while (await getRoom(code) && attempts < 10) {
    code = generateRoomCode();
    attempts++;
  }
  
  const room = {
    code,
    hostId,
    players: [{
      id: hostId,
      name: hostName,
      hand: [],
      score: 0,
      connected: true
    }],
    state: 'lobby',
    mode: 'quick',
    currentPlayerIndex: 0,
    dealerIndex: 0,
    tableau: { spades: null, hearts: null, diamonds: null, clubs: null },
    askenHolderId: null,
    roundNumber: 1,
    roundEnded: false,
    roundWinners: [],
    lastActivity: Date.now()
  };
  
  await saveRoom(room);
  return room;
}

function canPlayCard(card, tableau) {
  const anyCardPlayed = Object.values(tableau).some(s => s !== null);
  if (!anyCardPlayed) {
    return card.suit === 'spades' && card.rank === 7;
  }
  
  const suitState = tableau[card.suit];
  
  if (!suitState) {
    return card.rank === 7;
  }
  
  return card.rank === suitState.low - 1 || card.rank === suitState.high + 1;
}

function canBePartOfSequence(card, hand, tableau) {
  const anyCardPlayed = Object.values(tableau).some(s => s !== null);
  
  if (!anyCardPlayed) {
    // Första draget - BARA spader 7, inget annat
    return card.suit === 'spades' && card.rank === 7;
  }
  
  const suitState = tableau[card.suit];
  
  if (!suitState) {
    if (card.rank === 7) return true;
    
    const has7 = hand.some(c => c.suit === card.suit && c.rank === 7);
    if (!has7) return false;
    
    if (card.rank > 7) {
      for (let r = 8; r < card.rank; r++) {
        if (!hand.some(c => c.suit === card.suit && c.rank === r)) return false;
      }
      return true;
    } else {
      for (let r = 6; r > card.rank; r--) {
        if (!hand.some(c => c.suit === card.suit && c.rank === r)) return false;
      }
      return true;
    }
  }
  
  if (card.rank > suitState.high) {
    for (let r = suitState.high + 1; r < card.rank; r++) {
      if (!hand.some(c => c.suit === card.suit && c.rank === r)) return false;
    }
    return true;
  }
  
  if (card.rank < suitState.low) {
    for (let r = suitState.low - 1; r > card.rank; r--) {
      if (!hand.some(c => c.suit === card.suit && c.rank === r)) return false;
    }
    return true;
  }
  
  return false;
}

// Bygg ett detaljerat meddelande om varför draget är ogiltigt
function buildInvalidMoveMessage(selectedCards, tableau) {
  const SUIT_NAMES_SV = { 
    spades: 'spader', 
    hearts: 'hjärter', 
    diamonds: 'ruter', 
    clubs: 'klöver' 
  };
  const RANK_NAMES_SV = { 
    1: 'ess', 2: 'tvåa', 3: 'trea', 4: 'fyra', 5: 'femma', 
    6: 'sexa', 7: 'sjua', 8: 'åtta', 9: 'nia', 10: 'tia', 
    11: 'knekt', 12: 'dam', 13: 'kung' 
  };
  
  // Gör första bokstaven stor
  const capitalize = (str) => str.charAt(0).toUpperCase() + str.slice(1);
  
  if (selectedCards.length === 0) {
    return 'Inga kort valda.';
  }
  
  const reasons = [];
  
  for (const card of selectedCards) {
    const suitName = SUIT_NAMES_SV[card.suit];
    const rankName = RANK_NAMES_SV[card.rank];
    const suitState = tableau[card.suit];
    
    if (!suitState) {
      // Färgen är inte startad
      if (card.rank !== 7) {
        reasons.push(`<strong>${capitalize(suitName)} ${rankName}</strong> kan inte spelas. ${capitalize(suitName)} måste startas med en sjua.`);
      }
    } else {
      // Färgen är startad - kolla om kortet passar
      const canPlayLow = card.rank === suitState.low - 1;
      const canPlayHigh = card.rank === suitState.high + 1;
      
      if (!canPlayLow && !canPlayHigh) {
        if (card.rank < suitState.low) {
          const needed = suitState.low - 1;
          reasons.push(`<strong>${capitalize(suitName)} ${rankName}</strong> kan inte spelas. Först måste ${suitName} ${RANK_NAMES_SV[needed]} spelas.`);
        } else if (card.rank > suitState.high) {
          const needed = suitState.high + 1;
          reasons.push(`<strong>${capitalize(suitName)} ${rankName}</strong> kan inte spelas. Först måste ${suitName} ${RANK_NAMES_SV[needed]} spelas.`);
        } else {
          reasons.push(`<strong>${capitalize(suitName)} ${rankName}</strong> ligger redan på bordet.`);
        }
      }
    }
  }
  
  if (reasons.length === 0) {
    return 'Korten kan inte spelas tillsammans i denna ordning.';
  }
  
  return reasons.join('<br><br>');
}

function getPlayableOrder(selectedCards, tableau) {
  if (selectedCards.length === 0) return null;
  
  // Kolla om detta är första draget (tableau är helt tomt)
  const isFirstMove = !Object.values(tableau).some(s => s !== null);
  
  // Första draget: BARA spader 7, inget annat
  if (isFirstMove) {
    if (selectedCards.length !== 1) return null;
    const card = selectedCards[0];
    if (card.suit !== 'spades' || card.rank !== 7) return null;
    return [card];
  }
  
  const simTableau = {
    spades: tableau.spades ? { ...tableau.spades } : null,
    hearts: tableau.hearts ? { ...tableau.hearts } : null,
    clubs: tableau.clubs ? { ...tableau.clubs } : null,
    diamonds: tableau.diamonds ? { ...tableau.diamonds } : null
  };
  
  const remaining = [...selectedCards];
  const ordered = [];
  
  while (remaining.length > 0) {
    let foundPlayable = false;
    
    for (let i = 0; i < remaining.length; i++) {
      const card = remaining[i];
      if (canPlayCard(card, simTableau)) {
        ordered.push(card);
        remaining.splice(i, 1);
        
        if (!simTableau[card.suit]) {
          simTableau[card.suit] = { low: card.rank, high: card.rank };
        } else {
          if (card.rank < simTableau[card.suit].low) {
            simTableau[card.suit].low = card.rank;
          }
          if (card.rank > simTableau[card.suit].high) {
            simTableau[card.suit].high = card.rank;
          }
        }
        
        foundPlayable = true;
        break;
      }
    }
    
    if (!foundPlayable) return null;
  }
  
  return ordered;
}

// ============================================
// ROBOT AI
// ============================================

function getBotMove(player, tableau, difficulty = 'dumb', allPlayers = []) {
  // Hitta alla spelbara kort
  const playableCards = player.hand.filter(c => canBePartOfSequence(c, player.hand, tableau));
  
  if (playableCards.length === 0) {
    return { action: 'pass' };
  }
  
  // DUM: Spelar slumpmässigt ett spelbart kort
  if (difficulty === 'dumb') {
    // Välj ett slumpmässigt spelbart kort
    const randomCard = playableCards[Math.floor(Math.random() * playableCards.length)];
    const ordered = getPlayableOrder([randomCard], tableau);
    if (ordered) {
      return { action: 'play', cards: ordered };
    }
    return { action: 'pass' };
  }
  
  // MEDEL & SMART: Gruppera spelbara kort per färg
  const bySuit = {};
  for (const card of playableCards) {
    if (!bySuit[card.suit]) bySuit[card.suit] = [];
    bySuit[card.suit].push(card);
  }
  
  // Hitta alla möjliga sekvenser
  let allSequences = [];
  
  for (const suit of Object.keys(bySuit)) {
    const suitCards = bySuit[suit].sort((a, b) => a.rank - b.rank);
    
    for (let i = 0; i < suitCards.length; i++) {
      for (let j = i; j < suitCards.length; j++) {
        const testCards = suitCards.slice(i, j + 1);
        const ordered = getPlayableOrder(testCards, tableau);
        
        if (ordered && ordered.length > 0) {
          allSequences.push(ordered);
        }
      }
    }
  }
  
  // Lägg till möjligheten att spela flera färger samtidigt
  if (playableCards.length > 1) {
    const ordered = getPlayableOrder(playableCards, tableau);
    if (ordered && ordered.length > 1) {
      allSequences.push(ordered);
    }
  }
  
  if (allSequences.length === 0) {
    const singleCard = getPlayableOrder([playableCards[0]], tableau);
    if (singleCard) {
      return { action: 'play', cards: singleCard };
    }
    return { action: 'pass' };
  }
  
  // MEDEL: Prioritera att bli av med många kort och höga poäng
  if (difficulty === 'medium') {
    let bestSequence = [];
    let bestScore = -1;
    
    for (const seq of allSequences) {
      const points = seq.reduce((sum, c) => sum + getCardPoints(c), 0);
      // Prioritera: antal kort * 100 + poängvärde
      const score = seq.length * 100 + points;
      
      if (score > bestScore) {
        bestScore = score;
        bestSequence = seq;
      }
    }
    
    return { action: 'play', cards: bestSequence };
  }
  
  // SMART: Avancerad strategi
  if (difficulty === 'smart') {
    let bestSequence = [];
    let bestScore = -Infinity;
    
    for (const seq of allSequences) {
      let score = 0;
      
      // Poäng för att bli av med kort
      const points = seq.reduce((sum, c) => sum + getCardPoints(c), 0);
      score += points * 2;
      
      // Bonus för att spela många kort
      score += seq.length * 50;
      
      // Simulera hur spelplanen ser ut efter draget
      const newTableau = JSON.parse(JSON.stringify(tableau));
      for (const card of seq) {
        if (!newTableau[card.suit]) {
          newTableau[card.suit] = { low: card.rank, high: card.rank };
        } else {
          if (card.rank < newTableau[card.suit].low) {
            newTableau[card.suit].low = card.rank;
          }
          if (card.rank > newTableau[card.suit].high) {
            newTableau[card.suit].high = card.rank;
          }
        }
      }
      
      // Beräkna hur många kort jag kan spela efter detta drag
      const remainingHand = player.hand.filter(c => !seq.some(s => s.id === c.id));
      const futurePlayable = remainingHand.filter(c => canBePartOfSequence(c, remainingHand, newTableau));
      score += futurePlayable.length * 30;
      
      // Straffa om vi öppnar upp för motståndare (ändpunkter nära deras möjliga kort)
      // Bonus om vi spelar kort som ligger "i mitten" av vår hand
      for (const card of seq) {
        // Bonus för att spela ess eller kungar (slutar kedjan)
        if (card.rank === 1 || card.rank === 13) {
          score += 40;
        }
        
        // Bonus för att behålla kort som blockerar (6:or och 8:or)
        const isBlockingCard = card.rank === 6 || card.rank === 8;
        if (isBlockingCard) {
          // Kolla om vi har kort på andra sidan
          const hasLower = remainingHand.some(c => c.suit === card.suit && c.rank < card.rank);
          const hasHigher = remainingHand.some(c => c.suit === card.suit && c.rank > card.rank);
          if (hasLower && hasHigher) {
            score -= 20; // Straffa att spela blockerande kort om vi har kort på båda sidor
          }
        }
      }
      
      // Bonus för att tömma en hel färg
      const suitCounts = {};
      for (const c of remainingHand) {
        suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1;
      }
      for (const card of seq) {
        if (!suitCounts[card.suit] || suitCounts[card.suit] === 0) {
          score += 25; // Bonus för att bli av med en hel färg
        }
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestSequence = seq;
      }
    }
    
    return { action: 'play', cards: bestSequence };
  }
  
  // Fallback
  return { action: 'play', cards: allSequences[0] };
}

async function executeBotTurn(room) {
  if (room.state !== 'playing' || room.roundEnded) return;
  
  const currentPlayer = room.players[room.currentPlayerIndex];
  if (!currentPlayer || !currentPlayer.isBot) return;
  
  // Vänta lite så det känns mer naturligt
  await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
  
  // Hämta senaste rumstatus (kan ha ändrats)
  const freshRoom = await getRoom(room.code);
  if (!freshRoom || freshRoom.state !== 'playing' || freshRoom.roundEnded) return;
  if (freshRoom.currentPlayerIndex !== room.currentPlayerIndex) return;
  
  const player = freshRoom.players[freshRoom.currentPlayerIndex];
  if (!player || !player.isBot) return;
  
  const difficulty = freshRoom.botDifficulty || 'dumb';
  const move = getBotMove(player, freshRoom.tableau, difficulty, freshRoom.players);
  
  if (move.action === 'play' && move.cards.length > 0) {
    // Spara vilka kort som spelades (för att markera på spelplanen)
    freshRoom.lastPlayedCards = move.cards.map(c => c.id);
    
    // Ta bort kort från hand
    for (const card of move.cards) {
      const index = player.hand.findIndex(c => c.id === card.id);
      if (index >= 0) player.hand.splice(index, 1);
    }
    
    // Uppdatera tableau
    for (const card of move.cards) {
      if (!freshRoom.tableau[card.suit]) {
        freshRoom.tableau[card.suit] = { low: card.rank, high: card.rank };
      } else {
        if (card.rank < freshRoom.tableau[card.suit].low) {
          freshRoom.tableau[card.suit].low = card.rank;
        }
        if (card.rank > freshRoom.tableau[card.suit].high) {
          freshRoom.tableau[card.suit].high = card.rank;
        }
      }
    }
    
    console.log(`Bot ${player.name} spelade: ${move.cards.map(c => c.id).join(', ')}`);
    
    // Kolla om rundan är slut
    if (player.hand.length === 0) {
      endRoundForRoom(freshRoom);
    } else {
      freshRoom.currentPlayerIndex = (freshRoom.currentPlayerIndex + 1) % freshRoom.players.length;
    }
  } else {
    // Passa
    freshRoom.askenHolderId = player.id;
    freshRoom.currentPlayerIndex = (freshRoom.currentPlayerIndex + 1) % freshRoom.players.length;
    console.log(`Bot ${player.name} passade`);
  }
  
  freshRoom.lastActivity = Date.now();
  await saveRoom(freshRoom);
  
  emitRoomStateToAll(freshRoom);
  
  // Kör nästa robots tur om det är en robot
  if (freshRoom.state === 'playing' && !freshRoom.roundEnded) {
    const nextPlayer = freshRoom.players[freshRoom.currentPlayerIndex];
    if (nextPlayer && nextPlayer.isBot) {
      executeBotTurn(freshRoom);
    }
  }
}

function endRoundForRoom(room) {
  room.roundEnded = true;
  
  room.roundScores = room.players.map(player => {
    const cardPoints = player.hand.reduce((sum, c) => sum + getCardPoints(c), 0);
    const askenPoints = player.id === room.askenHolderId ? 50 : 0;
    const roundTotal = cardPoints + askenPoints;
    player.score += roundTotal;
    
    return {
      playerId: player.id,
      name: player.name,
      cardPoints,
      askenPoints,
      roundTotal
    };
  });
  
  const lowestRoundScore = Math.min(...room.roundScores.map(rs => rs.roundTotal));
  const roundWinnerIds = room.roundScores
    .filter(rs => rs.roundTotal === lowestRoundScore)
    .map(rs => rs.playerId);
  room.roundWinners = room.players.filter(p => roundWinnerIds.includes(p.id));
  
  // Logga händelse
  const winnerNames = room.roundWinners.map(w => w.name).join(', ');
  logStats('round_ended', { 
    roomCode: room.code, 
    round: room.roundNumber,
    winner: winnerNames
  });
  
  // Kolla om spelet är slut
  const isGameOver = room.mode === 'quick' || room.players.some(p => p.score >= 500);
  if (isGameOver) {
    const gameWinner = room.players.reduce((a, b) => a.score < b.score ? a : b);
    logStats('game_ended', {
      roomCode: room.code,
      winner: gameWinner.name,
      rounds: room.roundNumber
    });
  }
  
  room.state = 'roundEnd';
}

function emitRoomStateToAll(room) {
  for (const player of room.players) {
    if (player.isBot) continue; // Robotar behöver inte state
    
    const socketId = player.id;
    const playerSocket = io.sockets.sockets.get(socketId);
    if (!playerSocket) continue;
    
    const isGameOver = room.mode === 'quick' || room.players.some(p => p.score >= 500);
    const hasBots = room.players.some(p => p.isBot);
    
    const state = {
      code: room.code,
      hostId: room.hostId,
      state: room.state,
      mode: room.mode,
      roundNumber: room.roundNumber,
      currentPlayerIndex: room.currentPlayerIndex,
      dealerIndex: room.dealerIndex,
      starterIndex: room.starterIndex,
      tableau: room.tableau,
      askenHolderId: room.askenHolderId,
      roundEnded: room.roundEnded,
      roundWinners: room.roundWinners.map(w => ({ id: w.id, name: w.name })),
      roundScores: room.roundScores || null,
      lastPlayedCards: room.lastPlayedCards || [],
      botDifficulty: room.botDifficulty || 'dumb',
      helpMode: room.helpMode || false,
      hasBots,
      isGameOver,
      myId: player.id,
      players: room.players.map((p, index) => ({
        id: p.id,
        name: p.name,
        cardCount: p.hand.length,
        score: p.score,
        // Visa alla händer när rundan är slut, annars bara egna kort
        hand: (p.id === player.id || room.roundEnded) ? p.hand : null,
        isMe: p.id === player.id,
        isCurrent: index === room.currentPlayerIndex,
        isHost: p.id === room.hostId,
        isDealer: index === room.dealerIndex,
        isStarter: index === room.starterIndex,
        hasAsken: p.id === room.askenHolderId,
        isWinner: room.roundWinners.some(w => w.id === p.id),
        connected: p.connected,
        isBot: p.isBot || false
      }))
    };
    
    // Om det är spelarens tur
    if (player.id === room.players[room.currentPlayerIndex]?.id && room.state === 'playing' && !room.roundEnded) {
      if (room.helpMode) {
        // Hjälpläge på: visa bara spelbara kort
        state.playableCardIds = player.hand
          .filter(c => canBePartOfSequence(c, player.hand, room.tableau))
          .map(c => c.id);
      } else {
        // Hjälpläge av: alla kort är "valbara" (men inte nödvändigtvis spelbara)
        state.playableCardIds = player.hand.map(c => c.id);
      }
    }
    
    playerSocket.emit('gameState', state);
  }
}

function dealCards(room) {
  room.players.forEach(p => p.hand = []);
  
  const deck = shuffle(createDeck());
  const numPlayers = room.players.length;
  let playerIndex = (room.dealerIndex + 1) % numPlayers;
  
  for (const card of deck) {
    room.players[playerIndex].hand.push(card);
    playerIndex = (playerIndex + 1) % numPlayers;
  }
  
  for (const player of room.players) {
    player.hand = sortHand(player.hand);
  }
  
  room.currentPlayerIndex = room.players.findIndex(p =>
    p.hand.some(c => c.suit === 'spades' && c.rank === 7)
  );
  
  room.starterIndex = room.currentPlayerIndex; // Spara vem som börjar
  room.lastPlayedCards = []; // Rensa senast spelade kort
  room.tableau = { spades: null, hearts: null, diamonds: null, clubs: null };
  room.askenHolderId = null;
  room.roundEnded = false;
  room.roundWinners = [];
  room.state = 'playing';
}

function calculateScores(room) {
  return room.players.map(player => {
    const cardPoints = player.hand.reduce((sum, c) => sum + getCardPoints(c), 0);
    const askenPoints = player.id === room.askenHolderId ? 50 : 0;
    const roundTotal = cardPoints + askenPoints;
    player.score += roundTotal;
    
    return {
      playerId: player.id,
      name: player.name,
      cardPoints,
      askenPoints,
      roundTotal,
      cardsLeft: player.hand.length,
      totalScore: player.score
    };
  });
}

// ============================================
// SOCKET HANTERING
// ============================================

io.on('connection', (socket) => {
  console.log('Spelare ansluten:', socket.id);
  
  let currentRoom = null;
  let playerName = null;
  let inMatchmaking = false;
  
  // ============================================
  // MATCHMAKING EVENTS
  // ============================================
  
  // Gå med i matchmaking-kön
  socket.on('joinMatchmaking', (name) => {
    playerName = name;
    inMatchmaking = true;
    addToMatchmaking(socket.id, name);
  });
  
  // Lämna matchmaking-kön
  socket.on('leaveMatchmaking', () => {
    inMatchmaking = false;
    removeFromMatchmaking(socket.id);
  });
  
  // Starta matchmaking-spel (alla i kön kan starta)
  socket.on('startMatchmakingGame', async () => {
    // Kontrollera att denna spelare är i kön
    const playerInQueue = matchmakingQueue.find(p => p.socketId === socket.id);
    if (!playerInQueue) {
      socket.emit('error', { message: 'Du är inte i matchmaking-kön' });
      return;
    }
    
    // Minst 2 spelare krävs
    if (matchmakingQueue.length < 2) {
      socket.emit('error', { message: 'Minst 2 spelare krävs för att starta' });
      return;
    }
    
    // Skapa ett vanligt rum - den som startar blir värd
    const playersToAdd = [...matchmakingQueue];
    
    // Flytta den som startade till första plats (blir värd)
    const starterIndex = playersToAdd.findIndex(p => p.socketId === socket.id);
    if (starterIndex > 0) {
      const starter = playersToAdd.splice(starterIndex, 1)[0];
      playersToAdd.unshift(starter);
    }
    
    // Begränsa till 7 spelare
    const limitedPlayers = playersToAdd.slice(0, 7);
    
    const hostPlayer = limitedPlayers[0];
    
    // Skapa rum med värden
    const room = await createRoom(hostPlayer.socketId, hostPlayer.name);
    
    // Lägg till övriga spelare
    for (let i = 1; i < limitedPlayers.length; i++) {
      const player = limitedPlayers[i];
      room.players.push({
        id: player.socketId,
        name: player.name,
        hand: [],
        score: 0,
        connected: true
      });
    }
    
    await saveRoom(room);
    
    // Flytta valda spelare till rummet, ta bort dem från kön
    for (const player of limitedPlayers) {
      const playerSocket = io.sockets.sockets.get(player.socketId);
      if (playerSocket) {
        playerSocket.join(room.code);
        playerSocket.emit('matchmakingGameStarted', { 
          code: room.code,
          playerName: player.name 
        });
      }
      removeFromMatchmaking(player.socketId);
    }
    
    // Skicka rumstillstånd till alla
    emitRoomState(room);
    
    console.log(`[Matchmaking] Spel startat med ${room.players.length} spelare i rum ${room.code}`);
  });
  
  // Starta matchmaking-spel med valda spelare
  socket.on('startMatchmakingGameWithSelected', async (selectedIds) => {
    // Kontrollera att denna spelare är i kön
    const playerInQueue = matchmakingQueue.find(p => p.socketId === socket.id);
    if (!playerInQueue) {
      socket.emit('error', { message: 'Du är inte i matchmaking-kön' });
      return;
    }
    
    // Hämta valda spelare från kön
    const selectedPlayers = matchmakingQueue.filter(p => 
      selectedIds.includes(p.socketId) || p.socketId === socket.id
    );
    
    // Minst 2 spelare krävs
    if (selectedPlayers.length < 2) {
      socket.emit('error', { message: 'Minst 2 spelare krävs för att starta' });
      return;
    }
    
    // Max 7 spelare
    if (selectedPlayers.length > 7) {
      socket.emit('error', { message: 'Max 7 spelare tillåtna' });
      return;
    }
    
    // Flytta den som startade till första plats (blir värd)
    const starterIndex = selectedPlayers.findIndex(p => p.socketId === socket.id);
    if (starterIndex > 0) {
      const starter = selectedPlayers.splice(starterIndex, 1)[0];
      selectedPlayers.unshift(starter);
    }
    
    const hostPlayer = selectedPlayers[0];
    
    // Skapa rum med värden
    const room = await createRoom(hostPlayer.socketId, hostPlayer.name);
    
    // Lägg till övriga spelare
    for (let i = 1; i < selectedPlayers.length; i++) {
      const player = selectedPlayers[i];
      room.players.push({
        id: player.socketId,
        name: player.name,
        hand: [],
        score: 0,
        connected: true
      });
    }
    
    await saveRoom(room);
    
    // Flytta valda spelare till rummet, ta bort dem från kön
    for (const player of selectedPlayers) {
      const playerSocket = io.sockets.sockets.get(player.socketId);
      if (playerSocket) {
        playerSocket.join(room.code);
        playerSocket.emit('matchmakingGameStarted', { 
          code: room.code,
          playerName: player.name 
        });
      }
      removeFromMatchmaking(player.socketId);
    }
    
    // Uppdatera kön för de som blev kvar
    broadcastMatchmakingState();
    
    // Skicka rumstillstånd till alla i det nya rummet
    emitRoomState(room);
    
    console.log(`[Matchmaking] Spel startat med ${room.players.length} valda spelare i rum ${room.code}, ${matchmakingQueue.length} kvar i kö`);
  });
  
  // Bekräfta att spelare gått med i matchmaking-rum (för att sätta currentRoom)
  socket.on('confirmMatchmakingJoin', async (code) => {
    const room = await getRoom(code);
    if (room && room.players.some(p => p.id === socket.id)) {
      currentRoom = code;
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        playerName = player.name;
      }
      inMatchmaking = false;
      console.log(`[Matchmaking] ${playerName} bekräftade join till rum ${code}`);
    }
  });
  
  // ============================================
  // ROOM EVENTS
  // ============================================
  
  // Skapa rum
  socket.on('createRoom', async (name) => {
    playerName = name;
    const room = await createRoom(socket.id, name);
    currentRoom = room.code;
    socket.join(room.code);
    
    // Logga händelse
    logStats('room_created', { roomCode: room.code, playerName: name });
    
    socket.emit('roomCreated', { code: room.code });
    emitRoomState(room);
  });
  
  // Gå med i rum
  socket.on('joinRoom', async ({ code, name }) => {
    const room = await getRoom(code);
    
    if (!room) {
      socket.emit('error', { message: 'Rummet finns inte' });
      return;
    }
    
    if (room.state !== 'lobby') {
      socket.emit('error', { message: 'Spelet har redan startat' });
      return;
    }
    
    if (room.players.length >= 7) {
      socket.emit('error', { message: 'Rummet är fullt (max 7 spelare)' });
      return;
    }
    
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      socket.emit('error', { message: 'Namnet är redan taget' });
      return;
    }
    
    playerName = name;
    currentRoom = room.code;
    
    room.players.push({
      id: socket.id,
      name,
      hand: [],
      score: 0,
      connected: true
    });
    
    room.lastActivity = Date.now();
    await saveRoom(room);
    
    // Logga händelse
    logStats('player_joined', { roomCode: room.code, playerName: name });
    
    socket.join(room.code);
    socket.emit('roomJoined', { code: room.code });
    emitRoomState(room);
  });
  
  // Återanslut till rum (efter disconnect)
  socket.on('rejoinRoom', async ({ code, name }) => {
    console.log(`Försöker återansluta ${name} till rum ${code}`);
    
    const room = await getRoom(code);
    
    if (!room) {
      console.log(`Rum ${code} finns inte i Redis/cache`);
      socket.emit('rejoinFailed', { message: 'Rummet finns inte längre' });
      return;
    }
    
    // Rensa bort gamla frånkopplade spelare först
    await cleanupDisconnectedPlayers(room);
    
    // Hitta spelaren med samma namn
    const existingPlayer = room.players.find(p => 
      p.name.toLowerCase() === name.toLowerCase()
    );
    
    if (existingPlayer) {
      // Uppdatera spelarens socket-id
      const oldId = existingPlayer.id;
      existingPlayer.id = socket.id;
      existingPlayer.connected = true;
      existingPlayer.disconnectedAt = null;
      
      // Uppdatera host om det var denna spelare
      if (room.hostId === oldId) {
        room.hostId = socket.id;
      }
      
      // Uppdatera asken-hållare om det var denna spelare
      if (room.askenHolderId === oldId) {
        room.askenHolderId = socket.id;
      }
      
      playerName = name;
      currentRoom = room.code;
      
      room.lastActivity = Date.now();
      await saveRoom(room);
      
      socket.join(room.code);
      socket.emit('rejoinSuccess', { code: room.code });
      emitRoomState(room);
      console.log(`Spelare ${name} återansluten till rum ${code}`);
    } else {
      // Spelaren fanns inte - försök gå med som ny om möjligt
      if (room.state === 'lobby' && room.players.length < 7) {
        playerName = name;
        currentRoom = room.code;
        
        room.players.push({
          id: socket.id,
          name,
          hand: [],
          score: 0,
          connected: true,
          disconnectedAt: null
        });
        
        room.lastActivity = Date.now();
        await saveRoom(room);
        
        socket.join(room.code);
        socket.emit('rejoinSuccess', { code: room.code });
        emitRoomState(room);
        console.log(`Ny spelare ${name} gick med i rum ${code}`);
      } else {
        console.log(`Kunde inte återansluta ${name} till rum ${code} (spelet pågår eller fullt)`);
        socket.emit('rejoinFailed', { message: 'Kunde inte återansluta - spelet har redan börjat' });
      }
    }
  });
  
  // Keepalive ping
  socket.on('ping', async () => {
    socket.emit('pong');
    
    // Uppdatera rummets lastActivity
    if (currentRoom) {
      const room = await getRoom(currentRoom);
      if (room) {
        room.lastActivity = Date.now();
        
        // Markera spelaren som ansluten
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
          player.connected = true;
          player.disconnectedAt = null;
        }
        
        // Rensa bort gamla frånkopplade spelare
        await cleanupDisconnectedPlayers(room);
        
        await saveRoom(room);
      }
    }
  });
  
  // Lägg till robot
  socket.on('addBot', async () => {
    const room = await getRoom(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    
    if (room.state !== 'lobby') {
      socket.emit('error', { message: 'Kan bara lägga till robotar i lobbyn' });
      return;
    }
    
    if (room.players.length >= 7) {
      socket.emit('error', { message: 'Rummet är fullt (max 7 spelare)' });
      return;
    }
    
    const existingNames = room.players.map(p => p.name);
    const botName = getRandomBotName(existingNames);
    const botId = `bot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    room.players.push({
      id: botId,
      name: botName,
      hand: [],
      score: 0,
      connected: true,
      isBot: true
    });
    
    room.lastActivity = Date.now();
    await saveRoom(room);
    
    emitRoomState(room);
    console.log(`Robot ${botName} tillagd i rum ${room.code}`);
  });
  
  // Ta bort robot
  socket.on('removeBot', async (botId) => {
    const room = await getRoom(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    
    if (room.state !== 'lobby') {
      socket.emit('error', { message: 'Kan bara ta bort robotar i lobbyn' });
      return;
    }
    
    const botIndex = room.players.findIndex(p => p.id === botId && p.isBot);
    if (botIndex === -1) {
      socket.emit('error', { message: 'Roboten hittades inte' });
      return;
    }
    
    const botName = room.players[botIndex].name;
    room.players.splice(botIndex, 1);
    
    room.lastActivity = Date.now();
    await saveRoom(room);
    
    emitRoomState(room);
    console.log(`Robot ${botName} borttagen från rum ${room.code}`);
  });
  
  // Sätt robotsvårighetsgrad
  socket.on('setBotDifficulty', async (difficulty) => {
    const room = await getRoom(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    
    if (room.state !== 'lobby') {
      socket.emit('error', { message: 'Kan bara ändra svårighetsgrad i lobbyn' });
      return;
    }
    
    const validDifficulties = ['dumb', 'medium', 'smart'];
    if (!validDifficulties.includes(difficulty)) {
      socket.emit('error', { message: 'Ogiltig svårighetsgrad' });
      return;
    }
    
    room.botDifficulty = difficulty;
    room.lastActivity = Date.now();
    await saveRoom(room);
    
    emitRoomState(room);
    console.log(`Robotsvårighetsgrad satt till ${difficulty} i rum ${room.code}`);
  });
  
  // Sätt hjälpläge
  socket.on('setHelpMode', async (helpMode) => {
    const room = await getRoom(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    
    if (room.state !== 'lobby') {
      socket.emit('error', { message: 'Kan bara ändra hjälpläge i lobbyn' });
      return;
    }
    
    room.helpMode = helpMode === true;
    room.lastActivity = Date.now();
    await saveRoom(room);
    
    emitRoomState(room);
    console.log(`Hjälpläge satt till ${room.helpMode ? 'på' : 'av'} i rum ${room.code}`);
  });
  
  // Starta spel
  socket.on('startGame', async (mode) => {
    const room = await getRoom(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    
    if (room.players.length < 3) {
      socket.emit('error', { message: 'Minst 3 spelare krävs' });
      return;
    }
    
    room.mode = mode || 'quick';
    room.dealerIndex = 0;
    dealCards(room);
    
    room.lastActivity = Date.now();
    await saveRoom(room);
    
    // Logga händelse
    const humans = room.players.filter(p => !p.isBot).map(p => p.name);
    const bots = room.players.filter(p => p.isBot).map(p => p.name);
    logStats('game_started', { 
      roomCode: room.code, 
      playerCount: room.players.length,
      humanCount: humans.length,
      humans: humans,
      bots: bots,
      mode: room.mode
    });
    
    emitRoomStateToAll(room);
    
    // Om första spelaren är en robot, kör dess tur
    const firstPlayer = room.players[room.currentPlayerIndex];
    if (firstPlayer && firstPlayer.isBot) {
      executeBotTurn(room);
    }
  });
  
  // Välj kort
  socket.on('selectCards', async (cardIds) => {
    const room = await getRoom(currentRoom);
    if (!room || room.state !== 'playing' || room.roundEnded) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    
    const playerIndex = room.players.indexOf(player);
    if (playerIndex !== room.currentPlayerIndex) return;
    
    const selectedCards = cardIds.map(id => player.hand.find(c => c.id === id)).filter(Boolean);
    
    socket.emit('cardsSelected', cardIds);
  });
  
  // ============================================
  // CHAT
  // ============================================
  
  socket.on('chatMessage', async (text) => {
    if (!currentRoom || !playerName) return;
    
    // Begränsa meddelandelängd
    const cleanText = String(text).trim().slice(0, 200);
    if (!cleanText) return;
    
    const room = await getRoom(currentRoom);
    if (!room) return;
    
    const chatData = {
      sender: playerName,
      text: cleanText,
      timestamp: Date.now()
    };
    
    // Skicka till alla i rummet
    io.to(currentRoom).emit('chatMessage', chatData);
    
    console.log(`[Chat] ${playerName} i ${currentRoom}: ${cleanText}`);
  });
  
  // Spela kort
  socket.on('playCards', async (cardIds) => {
    const room = await getRoom(currentRoom);
    if (!room) {
      socket.emit('error', { message: 'Rummet finns inte längre' });
      return;
    }
    if (room.state !== 'playing') {
      socket.emit('error', { message: 'Spelet är inte igång' });
      return;
    }
    if (room.roundEnded) {
      socket.emit('error', { message: 'Rundan är redan slut' });
      return;
    }
    
    const player = room.players.find(p => p.id === socket.id);
    if (!player) {
      socket.emit('error', { message: 'Du är inte med i spelet' });
      return;
    }
    
    const playerIndex = room.players.indexOf(player);
    if (playerIndex !== room.currentPlayerIndex) {
      socket.emit('error', { message: 'Det är inte din tur' });
      return;
    }
    
    const selectedCards = cardIds.map(id => player.hand.find(c => c.id === id)).filter(Boolean);
    if (selectedCards.length === 0) {
      socket.emit('error', { message: 'Inga giltiga kort valda' });
      return;
    }
    
    console.log('Försöker spela kort:', cardIds);
    console.log('Tableau:', JSON.stringify(room.tableau));
    console.log('Valda kort:', selectedCards.map(c => `${c.suit}-${c.rank}`));
    
    const orderedCards = getPlayableOrder(selectedCards, room.tableau);
    if (!orderedCards) {
      console.log('getPlayableOrder returnerade null');
      
      // Om hjälpläge är av, skicka detaljerat invalidMove
      if (!room.helpMode) {
        const invalidMessage = buildInvalidMoveMessage(selectedCards, room.tableau);
        socket.emit('invalidMove', { message: invalidMessage });
      } else {
        socket.emit('error', { message: 'Korten kan inte spelas i denna ordning' });
      }
      return;
    }
    
    console.log('Ordnade kort:', orderedCards.map(c => `${c.suit}-${c.rank}`));
    
    // Spara vilka kort som spelades (för att markera på spelplanen)
    room.lastPlayedCards = orderedCards.map(c => c.id);
    
    // Ta bort kort från hand
    for (const card of orderedCards) {
      const index = player.hand.findIndex(c => c.id === card.id);
      if (index >= 0) player.hand.splice(index, 1);
    }
    
    // Uppdatera tableau
    for (const card of orderedCards) {
      if (!room.tableau[card.suit]) {
        room.tableau[card.suit] = { low: card.rank, high: card.rank };
      } else {
        if (card.rank < room.tableau[card.suit].low) {
          room.tableau[card.suit].low = card.rank;
        }
        if (card.rank > room.tableau[card.suit].high) {
          room.tableau[card.suit].high = card.rank;
        }
      }
    }
    
    // Kolla om rundan är slut
    if (player.hand.length === 0) {
      endRound(room);
    } else {
      room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
    }
    
    room.lastActivity = Date.now();
    await saveRoom(room);
    
    emitRoomStateToAll(room);
    
    // Om nästa spelare är en robot, kör dess tur
    if (room.state === 'playing' && !room.roundEnded) {
      const nextPlayer = room.players[room.currentPlayerIndex];
      if (nextPlayer && nextPlayer.isBot) {
        executeBotTurn(room);
      }
    }
  });
  
  // Passa
  socket.on('pass', async () => {
    const room = await getRoom(currentRoom);
    if (!room || room.state !== 'playing' || room.roundEnded) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    
    const playerIndex = room.players.indexOf(player);
    if (playerIndex !== room.currentPlayerIndex) return;
    
    // Kolla om spelaren har spelbara kort
    const hasPlayable = player.hand.some(c => canBePartOfSequence(c, player.hand, room.tableau));
    if (hasPlayable) {
      // I standardläge (helpMode av): visa detaljerad modal
      if (!room.helpMode) {
        socket.emit('invalidMove', { message: 'Du har kort som kan spelas och måste därför lägga!' });
      } else {
        socket.emit('error', { message: 'Du måste spela om du kan!' });
      }
      return;
    }
    
    room.askenHolderId = player.id;
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
    
    room.lastActivity = Date.now();
    await saveRoom(room);
    
    emitRoomStateToAll(room);
    
    // Om nästa spelare är en robot, kör dess tur
    const nextPlayer = room.players[room.currentPlayerIndex];
    if (nextPlayer && nextPlayer.isBot) {
      executeBotTurn(room);
    }
  });
  
  // Nästa runda
  socket.on('nextRound', async () => {
    const room = await getRoom(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    
    // Stäng modal hos alla spelare först
    io.to(room.code).emit('closeModal');
    
    room.roundNumber++;
    room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
    room.roundScores = null; // Rensa föregående rundas poäng
    dealCards(room);
    
    room.lastActivity = Date.now();
    await saveRoom(room);
    
    emitRoomStateToAll(room);
    
    // Om första spelaren är en robot, kör dess tur
    const firstPlayer = room.players[room.currentPlayerIndex];
    if (firstPlayer && firstPlayer.isBot) {
      executeBotTurn(room);
    }
  });
  
  // Nytt spel
  socket.on('newGame', async () => {
    const room = await getRoom(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    
    // Stäng modal hos alla spelare först
    io.to(room.code).emit('closeModal');
    
    room.players.forEach(p => p.score = 0);
    room.roundNumber = 1;
    room.state = 'lobby';
    room.roundEnded = false;
    room.roundWinners = [];
    room.roundScores = null;
    
    room.lastActivity = Date.now();
    await saveRoom(room);
    
    emitRoomState(room);
  });
  
  // Värden avslutar spelet
  socket.on('hostEndGame', async () => {
    const room = await getRoom(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    
    // Meddela alla andra spelare
    socket.to(room.code).emit('hostEndedGame');
    
    // Ta bort rummet
    await deleteRoom(room.code);
    currentRoom = null;
    
    console.log(`Värd avslutade spel i rum ${room.code}`);
  });
  
  // Lämna rum
  socket.on('leaveRoom', async () => {
    await leaveCurrentRoom();
  });
  
  // Frånkoppling
  socket.on('disconnect', async () => {
    console.log('Spelare frånkopplad:', socket.id);
    
    // Ta bort från matchmaking-kön om där
    if (inMatchmaking) {
      removeFromMatchmaking(socket.id);
    }
    
    // Markera spelaren som frånkopplad
    if (currentRoom) {
      const room = await getRoom(currentRoom);
      if (room) {
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
          player.connected = false;
          player.disconnectedAt = Date.now();
          await saveRoom(room);
          
          // Informera andra spelare om frånkopplingen
          emitRoomState(room);
          
          console.log(`Spelare ${player.name} markerad som frånkopplad i rum ${currentRoom}`);
        }
      }
    }
  });
  
  // Periodisk rensning av frånkopplade spelare (körs vid varje ny anslutning)
  async function cleanupDisconnectedPlayers(room) {
    if (!room) return false;
    
    const now = Date.now();
    const DISCONNECT_TIMEOUT = 43200000; // 12 timmar timeout (spelare kan sova och fortsätta)
    let changed = false;
    
    // Hitta spelare som varit frånkopplade för länge
    const playersToRemove = room.players.filter(p => 
      !p.isBot && 
      !p.connected && 
      p.disconnectedAt && 
      (now - p.disconnectedAt > DISCONNECT_TIMEOUT)
    );
    
    for (const player of playersToRemove) {
      const index = room.players.indexOf(player);
      if (index >= 0) {
        console.log(`Tar bort frånkopplad spelare ${player.name} från rum ${room.code}`);
        room.players.splice(index, 1);
        changed = true;
        
        // Om det var host, sätt ny host
        if (room.hostId === player.id && room.players.length > 0) {
          const newHost = room.players.find(p => !p.isBot);
          if (newHost) {
            room.hostId = newHost.id;
          }
        }
      }
    }
    
    // Om rummet är tomt, ta bort det
    if (room.players.length === 0) {
      await deleteRoom(room.code);
      console.log(`Rum ${room.code} borttaget (tomt efter cleanup)`);
      return true;
    }
    
    if (changed) {
      await saveRoom(room);
      emitRoomState(room);
    }
    
    return changed;
  }
  
  async function leaveCurrentRoom() {
    if (!currentRoom) return;
    
    const room = await getRoom(currentRoom);
    if (!room) return;
    
    // Hitta spelarens namn innan vi tar bort dem
    const leavingPlayer = room.players.find(p => p.id === socket.id);
    const leavingPlayerName = leavingPlayer ? leavingPlayer.name : 'En spelare';
    
    // Om spelet är igång (inte i lobby), avsluta hela spelet
    if (room.state === 'playing' || room.state === 'roundEnd') {
      // Meddela alla andra spelare att spelet avslutats
      socket.to(room.code).emit('gameEnded', { 
        playerName: leavingPlayerName,
        reason: 'left'
      });
      
      // Ta bort rummet helt
      await deleteRoom(room.code);
      socket.leave(currentRoom);
      currentRoom = null;
      return;
    }
    
    // I lobby - ta bara bort spelaren
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex >= 0) {
      room.players.splice(playerIndex, 1);
    }
    
    socket.leave(currentRoom);
    
    if (room.players.length === 0) {
      await deleteRoom(currentRoom);
    } else {
      if (room.hostId === socket.id) {
        room.hostId = room.players[0].id;
      }
      await saveRoom(room);
      emitRoomState(room);
    }
    
    currentRoom = null;
  }
  
  function endRound(room) {
    room.roundEnded = true;
    
    // Beräkna och spara rundpoäng för varje spelare
    room.roundScores = room.players.map(player => {
      const cardPoints = player.hand.reduce((sum, c) => sum + getCardPoints(c), 0);
      const askenPoints = player.id === room.askenHolderId ? 50 : 0;
      const roundTotal = cardPoints + askenPoints;
      player.score += roundTotal;
      
      return {
        playerId: player.id,
        name: player.name,
        cardPoints,
        askenPoints,
        roundTotal
      };
    });
    
    // Rundvinnare = lägst poäng DENNA RUNDA (inte totalt)
    const lowestRoundScore = Math.min(...room.roundScores.map(rs => rs.roundTotal));
    const roundWinnerIds = room.roundScores
      .filter(rs => rs.roundTotal === lowestRoundScore)
      .map(rs => rs.playerId);
    room.roundWinners = room.players.filter(p => roundWinnerIds.includes(p.id));
    
    room.state = 'roundEnd';
  }
  
  function emitRoomState(room) {
    for (const player of room.players) {
      if (player.isBot) continue;
      
      const socketId = player.id;
      const playerSocket = io.sockets.sockets.get(socketId);
      if (!playerSocket) continue;
      
      const isGameOver = room.mode === 'quick' || room.players.some(p => p.score >= 500);
      const hasBots = room.players.some(p => p.isBot);
      
      const state = {
        code: room.code,
        hostId: room.hostId,
        state: room.state,
        mode: room.mode,
        roundNumber: room.roundNumber,
        currentPlayerIndex: room.currentPlayerIndex,
        dealerIndex: room.dealerIndex,
        starterIndex: room.starterIndex,
        tableau: room.tableau,
        askenHolderId: room.askenHolderId,
        roundEnded: room.roundEnded,
        roundWinners: room.roundWinners.map(w => ({ id: w.id, name: w.name })),
        roundScores: room.roundScores || null,
        lastPlayedCards: room.lastPlayedCards || [],
        botDifficulty: room.botDifficulty || 'dumb',
        helpMode: room.helpMode || false,
        hasBots,
        isGameOver,
        myId: player.id,
        players: room.players.map((p, index) => ({
          id: p.id,
          name: p.name,
          cardCount: p.hand.length,
          score: p.score,
          hand: p.id === player.id ? p.hand : null,
          isMe: p.id === player.id,
          isCurrent: index === room.currentPlayerIndex,
          isHost: p.id === room.hostId,
          isDealer: index === room.dealerIndex,
          isStarter: index === room.starterIndex,
          hasAsken: p.id === room.askenHolderId,
          isWinner: room.roundWinners.some(w => w.id === p.id),
          connected: p.connected,
          isBot: p.isBot || false
        }))
      };
      
      // Om det är spelarens tur
      if (player.id === room.players[room.currentPlayerIndex]?.id && room.state === 'playing' && !room.roundEnded) {
        if (room.helpMode) {
          // Hjälpläge på: visa bara spelbara kort
          state.playableCardIds = player.hand
            .filter(c => canBePartOfSequence(c, player.hand, room.tableau))
            .map(c => c.id);
        } else {
          // Hjälpläge av: alla kort är "valbara"
          state.playableCardIds = player.hand.map(c => c.id);
        }
      }
      
      playerSocket.emit('gameState', state);
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Asken-server körs på port ${PORT}`);
  console.log(`Redis: ${redis ? 'aktiverat' : 'ej konfigurerat'}`);
});

// Periodisk synkronisering av cache till Redis (var 5:e minut)
setInterval(async () => {
  if (!redis) return;
  
  let syncCount = 0;
  for (const [code, room] of roomsCache.entries()) {
    try {
      await redis.set(`room:${code}`, JSON.stringify(room), { ex: ROOM_EXPIRY });
      syncCount++;
    } catch (err) {
      console.error(`Kunde inte synka rum ${code}:`, err.message);
    }
  }
  
  if (syncCount > 0) {
    console.log(`Synkade ${syncCount} rum till Redis`);
  }
}, 300000); // 5 minuter

// Logga aktiva anslutningar periodiskt (var 10:e minut)
setInterval(() => {
  const sockets = io.sockets.sockets;
  const roomCount = roomsCache.size;
  console.log(`Status: ${sockets.size} anslutna sockets, ${roomCount} aktiva rum i cache`);
}, 600000); // 10 minuter
