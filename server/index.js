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
  pingTimeout: 60000,
  pingInterval: 25000
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
  'HAL 9000',
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
  'Optimus Prime'
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
const ROOM_EXPIRY = 86400; // Rum försvinner efter 24 timmar utan aktivitet

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

// Spara rum till Redis
async function saveRoom(room) {
  roomsCache.set(room.code, room);
  
  if (redis) {
    try {
      await redis.set(`room:${room.code}`, JSON.stringify(room), { ex: ROOM_EXPIRY });
    } catch (err) {
      console.error('Redis save error:', err.message);
    }
  }
}

// Hämta rum (först från cache, sedan från Redis)
async function getRoom(code) {
  if (!code) return null;
  code = code.toUpperCase();
  
  // Kolla cache först
  if (roomsCache.has(code)) {
    return roomsCache.get(code);
  }
  
  // Annars kolla Redis
  if (redis) {
    try {
      const data = await redis.get(`room:${code}`);
      if (data) {
        const room = typeof data === 'string' ? JSON.parse(data) : data;
        roomsCache.set(code, room);
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

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

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

function getPlayableOrder(selectedCards, tableau) {
  if (selectedCards.length === 0) return null;
  
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

function getBotMove(player, tableau) {
  // Hitta alla spelbara kort
  const playableCards = player.hand.filter(c => canBePartOfSequence(c, player.hand, tableau));
  
  if (playableCards.length === 0) {
    return { action: 'pass' };
  }
  
  // Strategi: Försök spela så många kort som möjligt i ett drag
  // Prioritera att bli av med höga poängkort
  
  // Gruppera spelbara kort per färg
  const bySuit = {};
  for (const card of playableCards) {
    if (!bySuit[card.suit]) bySuit[card.suit] = [];
    bySuit[card.suit].push(card);
  }
  
  // Hitta den bästa sekvensen att spela
  let bestSequence = [];
  let bestScore = -1;
  
  for (const suit of Object.keys(bySuit)) {
    const suitCards = bySuit[suit].sort((a, b) => a.rank - b.rank);
    
    // Testa olika kombinationer av kort i denna färg
    for (let i = 0; i < suitCards.length; i++) {
      for (let j = i; j < suitCards.length; j++) {
        const testCards = suitCards.slice(i, j + 1);
        const ordered = getPlayableOrder(testCards, tableau);
        
        if (ordered && ordered.length > 0) {
          // Beräkna poängvärde av korten (vi vill bli av med höga poäng)
          const points = ordered.reduce((sum, c) => sum + getCardPoints(c), 0);
          const score = ordered.length * 100 + points; // Prioritera antal kort, sedan poäng
          
          if (score > bestScore) {
            bestScore = score;
            bestSequence = ordered;
          }
        }
      }
    }
  }
  
  // Testa även att spela kort från olika färger om det är möjligt
  // (t.ex. flera 7:or, eller kort som bygger på varandra)
  if (playableCards.length > 1) {
    const ordered = getPlayableOrder(playableCards, tableau);
    if (ordered && ordered.length > bestSequence.length) {
      bestSequence = ordered;
    }
  }
  
  if (bestSequence.length > 0) {
    return { action: 'play', cards: bestSequence };
  }
  
  // Fallback: spela första spelbara kortet
  const singleCard = getPlayableOrder([playableCards[0]], tableau);
  if (singleCard) {
    return { action: 'play', cards: singleCard };
  }
  
  return { action: 'pass' };
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
  
  const move = getBotMove(player, freshRoom.tableau);
  
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
  
  room.state = 'roundEnd';
}

function emitRoomStateToAll(room) {
  for (const player of room.players) {
    if (player.isBot) continue; // Robotar behöver inte state
    
    const socketId = player.id;
    const playerSocket = io.sockets.sockets.get(socketId);
    if (!playerSocket) continue;
    
    const isGameOver = room.mode === 'quick' || room.players.some(p => p.score >= 500);
    
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
    
    if (player.id === room.players[room.currentPlayerIndex]?.id && room.state === 'playing' && !room.roundEnded) {
      state.playableCardIds = player.hand
        .filter(c => canBePartOfSequence(c, player.hand, room.tableau))
        .map(c => c.id);
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
  
  // Skapa rum
  socket.on('createRoom', async (name) => {
    playerName = name;
    const room = await createRoom(socket.id, name);
    currentRoom = room.code;
    socket.join(room.code);
    
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
    
    socket.join(room.code);
    socket.emit('roomJoined', { code: room.code });
    emitRoomState(room);
  });
  
  // Återanslut till rum (efter disconnect)
  socket.on('rejoinRoom', async ({ code, name }) => {
    const room = await getRoom(code);
    
    if (!room) {
      socket.emit('rejoinFailed', { message: 'Rummet finns inte längre' });
      return;
    }
    
    // Hitta spelaren med samma namn
    const existingPlayer = room.players.find(p => 
      p.name.toLowerCase() === name.toLowerCase()
    );
    
    if (existingPlayer) {
      // Uppdatera spelarens socket-id
      const oldId = existingPlayer.id;
      existingPlayer.id = socket.id;
      existingPlayer.connected = true;
      
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
          connected: true
        });
        
        room.lastActivity = Date.now();
        await saveRoom(room);
        
        socket.join(room.code);
        socket.emit('rejoinSuccess', { code: room.code });
        emitRoomState(room);
      } else {
        socket.emit('rejoinFailed', { message: 'Kunde inte återansluta' });
      }
    }
  });
  
  // Keepalive ping
  socket.on('ping', () => {
    socket.emit('pong');
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
      socket.emit('error', { message: 'Korten kan inte spelas i denna ordning' });
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
      socket.emit('error', { message: 'Du måste spela om du kan!' });
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
    
    // Markera spelaren som frånkopplad istället för att ta bort
    if (currentRoom) {
      const room = await getRoom(currentRoom);
      if (room) {
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
          player.connected = false;
          await saveRoom(room);
          
          // Vänta 30 sekunder innan vi faktiskt tar bort spelaren
          setTimeout(async () => {
            const roomNow = await getRoom(currentRoom);
            if (roomNow) {
              const playerNow = roomNow.players.find(p => p.name === player.name);
              if (playerNow && !playerNow.connected) {
                // Spelaren har inte återanslutit - ta bort
                const playerIndex = roomNow.players.indexOf(playerNow);
                if (playerIndex >= 0) {
                  roomNow.players.splice(playerIndex, 1);
                }
                
                if (roomNow.players.length === 0) {
                  await deleteRoom(currentRoom);
                  console.log(`Rum ${currentRoom} borttaget (tomt)`);
                } else {
                  if (roomNow.hostId === socket.id) {
                    roomNow.hostId = roomNow.players[0].id;
                  }
                  await saveRoom(roomNow);
                  emitRoomState(roomNow);
                }
              }
            }
          }, 30000);
        }
      }
    }
  });
  
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
      
      if (player.id === room.players[room.currentPlayerIndex]?.id && room.state === 'playing' && !room.roundEnded) {
        state.playableCardIds = player.hand
          .filter(c => canBePartOfSequence(c, player.hand, room.tableau))
          .map(c => c.id);
      }
      
      playerSocket.emit('gameState', state);
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Asken-server körs på port ${PORT}`);
});
