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
        reasons.push(`<strong>${rankName} ${suitName}</strong> kan inte spelas - ${suitName} måste startas med en sjua.`);
      }
    } else {
      // Färgen är startad - kolla om kortet passar
      const canPlayLow = card.rank === suitState.low - 1;
      const canPlayHigh = card.rank === suitState.high + 1;
      
      if (!canPlayLow && !canPlayHigh) {
        if (card.rank < suitState.low) {
          const needed = suitState.low - 1;
          reasons.push(`<strong>${rankName} ${suitName}</strong> kan inte spelas - du måste först lägga ${RANK_NAMES_SV[needed]} ${suitName}.`);
        } else if (card.rank > suitState.high) {
          const needed = suitState.high + 1;
          reasons.push(`<strong>${rankName} ${suitName}</strong> kan inte spelas - du måste först lägga ${RANK_NAMES_SV[needed]} ${suitName}.`);
        } else {
          reasons.push(`<strong>${rankName} ${suitName}</strong> ligger redan på bordet.`);
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
    const DISCONNECT_TIMEOUT = 120000; // 2 minuter timeout
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
