const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

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
  if (card.rank === 1) return 15;
  if (card.rank >= 10) return 10;
  return card.rank;
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

const rooms = new Map();

function createRoom(hostId, hostName) {
  let code = generateRoomCode();
  while (rooms.has(code)) {
    code = generateRoomCode();
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
    state: 'lobby', // lobby, playing, roundEnd
    mode: 'quick',
    currentPlayerIndex: 0,
    dealerIndex: 0,
    tableau: { spades: null, hearts: null, diamonds: null, clubs: null },
    askenHolderId: null,
    roundNumber: 1,
    roundEnded: false,
    roundWinners: []
  };
  
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(code?.toUpperCase());
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
  socket.on('createRoom', (name) => {
    playerName = name;
    const room = createRoom(socket.id, name);
    currentRoom = room.code;
    socket.join(room.code);
    
    socket.emit('roomCreated', { code: room.code });
    emitRoomState(room);
  });
  
  // Gå med i rum
  socket.on('joinRoom', ({ code, name }) => {
    const room = getRoom(code);
    
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
    
    socket.join(room.code);
    socket.emit('roomJoined', { code: room.code });
    emitRoomState(room);
  });
  
  // Starta spel
  socket.on('startGame', (mode) => {
    const room = getRoom(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    
    if (room.players.length < 3) {
      socket.emit('error', { message: 'Minst 3 spelare krävs' });
      return;
    }
    
    room.mode = mode || 'quick';
    room.dealerIndex = 0;
    dealCards(room);
    emitRoomState(room);
  });
  
  // Välj kort
  socket.on('selectCards', (cardIds) => {
    const room = getRoom(currentRoom);
    if (!room || room.state !== 'playing' || room.roundEnded) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    
    const playerIndex = room.players.indexOf(player);
    if (playerIndex !== room.currentPlayerIndex) return;
    
    // Validera att korten finns i handen
    const selectedCards = cardIds.map(id => player.hand.find(c => c.id === id)).filter(Boolean);
    
    // Skicka tillbaka vilka kort som är valda (för att synka UI)
    socket.emit('cardsSelected', cardIds);
  });
  
  // Spela kort
  socket.on('playCards', (cardIds) => {
    const room = getRoom(currentRoom);
    if (!room || room.state !== 'playing' || room.roundEnded) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    
    const playerIndex = room.players.indexOf(player);
    if (playerIndex !== room.currentPlayerIndex) return;
    
    const selectedCards = cardIds.map(id => player.hand.find(c => c.id === id)).filter(Boolean);
    if (selectedCards.length === 0) return;
    
    const orderedCards = getPlayableOrder(selectedCards, room.tableau);
    if (!orderedCards) {
      socket.emit('error', { message: 'Ogiltigt val av kort' });
      return;
    }
    
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
    
    emitRoomState(room);
  });
  
  // Passa
  socket.on('pass', () => {
    const room = getRoom(currentRoom);
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
    
    emitRoomState(room);
  });
  
  // Nästa runda
  socket.on('nextRound', () => {
    const room = getRoom(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    
    room.roundNumber++;
    room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
    dealCards(room);
    emitRoomState(room);
  });
  
  // Nytt spel
  socket.on('newGame', () => {
    const room = getRoom(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    
    room.players.forEach(p => p.score = 0);
    room.roundNumber = 1;
    room.state = 'lobby';
    room.roundEnded = false;
    room.roundWinners = [];
    
    emitRoomState(room);
  });
  
  // Lämna rum
  socket.on('leaveRoom', () => {
    leaveCurrentRoom();
  });
  
  // Frånkoppling
  socket.on('disconnect', () => {
    console.log('Spelare frånkopplad:', socket.id);
    leaveCurrentRoom();
  });
  
  function leaveCurrentRoom() {
    if (!currentRoom) return;
    
    const room = getRoom(currentRoom);
    if (!room) return;
    
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex >= 0) {
      room.players.splice(playerIndex, 1);
    }
    
    socket.leave(currentRoom);
    
    if (room.players.length === 0) {
      rooms.delete(currentRoom);
    } else {
      // Om hosten lämnar, ge till nästa
      if (room.hostId === socket.id) {
        room.hostId = room.players[0].id;
      }
      emitRoomState(room);
    }
    
    currentRoom = null;
  }
  
  function endRound(room) {
    room.roundEnded = true;
    
    const scores = calculateScores(room);
    
    const lowestScore = Math.min(...room.players.map(p => p.score));
    room.roundWinners = room.players.filter(p => p.score === lowestScore);
    
    room.state = 'roundEnd';
  }
  
  function emitRoomState(room) {
    // Skicka personlig state till varje spelare
    for (const player of room.players) {
      const socketId = player.id;
      const playerSocket = io.sockets.sockets.get(socketId);
      if (!playerSocket) continue;
      
      const isGameOver = room.mode === 'quick' || room.players.some(p => p.score >= 500);
      
      // Bygg state med dold information för andra spelare
      const state = {
        code: room.code,
        hostId: room.hostId,
        state: room.state,
        mode: room.mode,
        roundNumber: room.roundNumber,
        currentPlayerIndex: room.currentPlayerIndex,
        dealerIndex: room.dealerIndex,
        tableau: room.tableau,
        askenHolderId: room.askenHolderId,
        roundEnded: room.roundEnded,
        roundWinners: room.roundWinners.map(w => ({ id: w.id, name: w.name })),
        isGameOver,
        myId: player.id,
        players: room.players.map((p, index) => ({
          id: p.id,
          name: p.name,
          cardCount: p.hand.length,
          score: p.score,
          // Visa bara egen hand
          hand: p.id === player.id ? p.hand : null,
          isMe: p.id === player.id,
          isCurrent: index === room.currentPlayerIndex,
          isHost: p.id === room.hostId,
          isDealer: index === room.dealerIndex,
          hasAsken: p.id === room.askenHolderId,
          isWinner: room.roundWinners.some(w => w.id === p.id)
        }))
      };
      
      // Lägg till spelbar-info för nuvarande spelare
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
