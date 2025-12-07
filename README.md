# Asken Online 🃏

Ett multiplayer-kortspel i realtid byggt med Node.js och Socket.io.

## Installation

```bash
# Packa upp projektet
unzip asken-online.zip
cd asken-online

# Installera beroenden
npm install

# Starta servern
npm start
```

Servern körs på `http://localhost:3000`

## Hur man spelar

1. **Skapa rum**: Ange ditt namn och klicka "Skapa nytt rum"
2. **Dela koden**: Ge den 4-tecken långa rumskoden till dina vänner
3. **Gå med**: Vänner anger koden och sitt namn för att gå med
4. **Starta**: Värden startar spelet när minst 3 spelare är med (max 7)

## Spelregler

- Första spelaren måste lägga ♠7
- Sedan kan man lägga:
  - Vilken 7:a som helst
  - Kort som ansluter till befintliga sekvenser (8 ovanför 7, 6 under 7, osv)
- Kan man inte spela måste man passa och tar då "Asken" (+50 poäng)
- Den som blir av med alla kort först avslutar rundan
- **Vinnaren är den med lägst poäng**, inte nödvändigtvis den som blev av med korten!

## Deploy

För att köra online (t.ex. på Render, Railway, eller Heroku):

1. Pusha till ett git-repo
2. Sätt `PORT` environment variable om nödvändigt
3. Startkommando: `npm start`

### Exempel för Render.com:
- Build command: `npm install`
- Start command: `npm start`
- Environment: Node

## Teknisk översikt

- **Backend**: Node.js + Express + Socket.io
- **Frontend**: Vanilla JavaScript, ingen build-process
- **Realtid**: WebSockets för omedelbar synkronisering

## Filstruktur

```
asken-online/
├── package.json
├── server/
│   └── index.js      # Backend-server med all spellogik
└── public/
    └── index.html    # Frontend (single-file)
```
