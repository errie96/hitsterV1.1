const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const hitsterLib = require('./hitster-library');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Hitster-Excel (categorieën + nummers) ----------
function libraryPayload() {
  const lib = hitsterLib.getLibrary();
  if (!lib) return { ok: false, categories: [], warnings: [] };
  return { ok: true, file: lib.file, loadedAt: lib.loadedAt, categories: lib.categories, warnings: lib.warnings };
}

app.get('/api/hitster-library', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(libraryPayload());
});

// Spiekmelding als noodroute: de pagina stuurt dit met sendBeacon als de app naar de achtergrond gaat
app.post('/api/spiek', express.text({ type: () => true, limit: '2kb' }), (req, res) => {
  try {
    const d = JSON.parse(req.body || '{}');
    const room = rooms[String(d.pin || '')];
    const player = room ? room.players[d.playerId] : null;
    if (room && player) handleSpiek(room, player, !!d.away);
  } catch (e) {}
  res.status(204).end();
});

// Alleen een host met een geldige kamer mag een nieuwe Excel uploaden
app.post('/api/hitster-library', express.raw({ type: () => true, limit: '15mb' }), (req, res) => {
  const room = rooms[String(req.get('x-host-pin') || '')];
  if (!room || room.hostToken !== req.get('x-host-token')) return res.status(403).json({ ok: false, error: 'Alleen de host kan een Excel uploaden.' });
  try {
    hitsterLib.replaceLibrary(req.body, decodeURIComponent(req.get('x-file-name') || 'hitster-liedjes.xlsx'));
    res.json(libraryPayload());
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Pool met bekende hits voor gevarieerde willekeurige startkaarten
const STARTER_DECK = [
  { title: "Bohemian Rhapsody", artist: "Queen", year: 1975 },
  { title: "Stayin' Alive", artist: "Bee Gees", year: 1977 },
  { title: "Billie Jean", artist: "Michael Jackson", year: 1982 },
  { title: "Sweet Child O' Mine", artist: "Guns N' Roses", year: 1987 },
  { title: "Smells Like Teen Spirit", artist: "Nirvana", year: 1991 },
  { title: "Wannabe", artist: "Spice Girls", year: 1996 },
  { title: "In The End", artist: "Linkin Park", year: 2000 },
  { title: "Mr. Brightside", artist: "The Killers", year: 2004 },
  { title: "Viva La Vida", artist: "Coldplay", year: 2008 },
  { title: "Wake Me Up", artist: "Avicii", year: 2013 },
  { title: "Blinding Lights", artist: "The Weeknd", year: 2019 },
  { title: "Roller Coaster", artist: "Danny Vera", year: 2019 }
];

// --- Willekeurige startkaarten via iTunes ---
// De STARTER_DECK hierboven is alleen nog een noodoptie als iTunes niet bereikbaar is.
const STARTER_TERMS = [
  "50s hits", "60s hits", "70s hits", "80s hits", "90s hits", "2000s hits", "2010s hits", "2020s hits",
  "disco classics", "soul classics", "motown", "funk classics", "rock classics", "hard rock hits",
  "punk classics", "new wave", "britpop", "grunge", "hip hop classics", "r&b hits", "eurodance",
  "house classics", "pop classics", "country classics", "reggae classics", "nederpop hits",
  "nederlandstalig", "latin pop hits", "boybands hits", "girl groups", "synthpop", "top 40"
];
const POOL_TARGET = 80;   // zoveel kaarten proberen we klaar te hebben
const POOL_LOW = 20;      // hieronder vullen we op de achtergrond bij
let starterPool = [];
let refilling = null;

async function fetchTracksForTerm(term) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=50&country=NL`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const data = await res.json();
  const thisYear = new Date().getFullYear();
  return (data.results || [])
    .filter(i => i.trackName && i.artistName && i.releaseDate)
    .map(i => ({ title: i.trackName, artist: i.artistName, year: new Date(i.releaseDate).getFullYear() }))
    .filter(t => t.year >= 1950 && t.year <= thisYear);
}

function refillStarterPool() {
  if (refilling) return refilling;
  refilling = (async () => {
    try {
      // Een paar verschillende willekeurige zoektermen tegelijk
      const terms = [...STARTER_TERMS].sort(() => 0.5 - Math.random()).slice(0, 4);
      const batches = await Promise.all(terms.map(t => fetchTracksForTerm(t).catch(() => [])));
      const seen = new Set(starterPool.map(t => `${t.title}|${t.artist}`));
      for (const track of batches.flat()) {
        const key = `${track.title}|${track.artist}`;
        if (!seen.has(key)) {
          seen.add(key);
          starterPool.push(track);
        }
      }
      if (starterPool.length > POOL_TARGET * 2) starterPool.length = POOL_TARGET * 2;
    } catch (e) {
      console.warn('Startkaarten ophalen mislukt:', e.message);
    } finally {
      refilling = null;
    }
  })();
  return refilling;
}

function takeFromPool(pool) {
  const idx = Math.floor(Math.random() * pool.length);
  return pool.splice(idx, 1)[0];
}

const trackKey = (t) => (String(t.title) + '|' + String(t.artist)).toLowerCase().replace(/\s+/g, ' ').trim();

function markUsed(room, track) {
  if (!room) return;
  const key = trackKey(track);
  if (!room.usedKeys.has(key)) {
    room.usedKeys.add(key);
    room.used.push({ title: track.title, artist: track.artist });
  }
}

// Startkaarten uit de gekozen Hitster-categorie van de Excel (als die er is)
// Voorkeur: nummers met Startkaart = Ja, dan nummers met een zeker jaartal (geen Jaar check), dan alles
function startersFromLibrary(room) {
  const free = hitsterLib.songsFor(room.settings.category).filter(t => !room.usedKeys.has(trackKey(t)));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const pools = [free.filter(t => t.start), free.filter(t => !t.check), free];
  let picked = [];
  for (const pool of pools) {
    for (const t of [...pool].sort(() => 0.5 - Math.random())) {
      if (picked.length < 2 && !picked.some(p => p.year === t.year || p === t)) picked.push(t);
    }
    if (picked.length === 2) break;
  }
  if (picked.length < 2) return null;
  return picked.map(cardOf);
}

async function getRandomStarters(room) {
  const fromLib = room ? startersFromLibrary(room) : null;
  if (fromLib) {
    fromLib.forEach(t => markUsed(room, t));
    return fromLib.sort((a, b) => a.year - b.year);
  }

  if (starterPool.length < 2) await refillStarterPool();
  else if (starterPool.length < POOL_LOW) refillStarterPool(); // op de achtergrond

  let picked = null;
  if (starterPool.length >= 2) {
    // Twee kaarten met een verschillend jaartal, zodat de tijdlijn meteen iets betekent
    for (let attempt = 0; attempt < 10 && !picked; attempt++) {
      const a = takeFromPool(starterPool);
      const bIdx = starterPool.findIndex(t => t.year !== a.year);
      if (bIdx === -1) { starterPool.push(a); break; }
      const b = starterPool.splice(bIdx, 1)[0];
      picked = [a, b];
    }
  }

  if (!picked) {
    const shuffled = [...STARTER_DECK].sort(() => 0.5 - Math.random());
    picked = [shuffled[0], shuffled[1]];
  }
  picked.forEach(t => markUsed(room, t));
  return picked.sort((a, b) => a.year - b.year);
}

// Pool alvast vullen bij het opstarten
refillStarterPool();

// =====================================================================
// Kamers, spelers en teams
//
// Spelers worden herkend aan een vaste code (playerId) in plaats van aan hun
// verbinding. Daardoor kan iemand de pagina verversen en terugkomen waar hij was.
// Na elke wijziging krijgt iedereen zijn eigen volledige status ("snapshot").
// =====================================================================
const rooms = {};
const socketIndex = {}; // socket.id -> { pin, role: 'host' | 'player', playerId }

const MAX_TOKENS = 5;
const START_TOKENS = 2;
const SWAP_COST = 3; // een ander nummer kiezen kost 3 fiches
const TARGETS = [0, 5, 7, 10, 15, 20]; // 0 = geen limiet
const HOST_GRACE_MS = Number(process.env.HOST_GRACE_MS) || 15 * 60 * 1000;  // kamer blijft bestaan als de host weg is
const LOBBY_GRACE_MS = Number(process.env.LOBBY_GRACE_MS) || 10 * 60 * 1000; // speler in de lobby die wegvalt mag terugkomen
// Korte pauze voordat de kaart vanzelf wordt onthuld, zodat iedereen de laatste keuze nog even ziet
const autoRevealDelay = () => Number(process.env.AUTO_REVEAL_MS) || 2000;
const ACTIVE_GRACE_MS = Number(process.env.ACTIVE_GRACE_MS) || 15 * 1000;   // speler aan zet die wegvalt: beurt overdragen

const TEAM_DEFS = {
  A: { id: 'A', name: 'Team Roze', color: '#ff2e93' },
  B: { id: 'B', name: 'Team Cyaan', color: '#22d3ee' }
};
// Standaardcategorie: het eerste tabblad van de Excel, anders de oude ingebouwde lijst
function defaultCategory() {
  const lib = hitsterLib.getLibrary();
  return lib && lib.categories.length ? lib.categories[0].id : 'original';
}
const otherTeam = (id) => (id === 'A' ? 'B' : 'A');

// ---------- Hulpfuncties ----------
const makeId = (n) => crypto.randomBytes(n || 12).toString('hex');
const cardOf = (t) => ({ title: t.title, artist: t.artist, year: t.year });
const cleanText = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 80);
const playersOf = (room) => Object.values(room.players);
const connectedPlayers = (room) => playersOf(room).filter(p => p.connected);
const teamMembers = (room, teamId) => playersOf(room).filter(p => p.teamId === teamId);
const smallerTeam = (room) => (teamMembers(room, 'A').length <= teamMembers(room, 'B').length ? 'A' : 'B');

function newPin() {
  let pin;
  do { pin = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms[pin]);
  return pin;
}

function insertSorted(timeline, card) {
  let i = timeline.findIndex(c => c.year > card.year);
  if (i === -1) i = timeline.length;
  timeline.splice(i, 0, card);
}

function validSlot(timeline, slot) {
  return Number.isInteger(slot) && slot >= 0 && slot <= timeline.length;
}

// Klopt het jaar met de gekozen plek in deze tijdlijn?
function slotCorrect(timeline, slot, year) {
  if (!validSlot(timeline, slot)) return false;
  const prev = slot === 0 ? -Infinity : timeline[slot - 1].year;
  const next = slot === timeline.length ? Infinity : timeline[slot].year;
  return year >= prev && year <= next;
}

// ---------- Titel & artiest: spelfouten tolereren, host beslist ----------
function norm(s) {
  return String(s || '').split(' - ')[0].toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(feat|ft|featuring)\b.*$/, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/^the /, '')
    .replace(/\s+/g, ' ').trim();
}

// Afstand tussen twee teksten; twee omgedraaide letters ("sogn" i.p.v. "song") tellen als één fout
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev2 = null;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      }
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

function similar(guess, answer) {
  const a = norm(guess), b = norm(answer);
  if (!a || !b) return false;
  if (a === b) return true;
  return 1 - lev(a, b) / Math.max(a.length, b.length) >= 0.8;
}

function artistMatches(guess, artist) {
  if (similar(guess, artist)) return true;
  return String(artist).split(/,|&|\bfeat\.?\b|\bft\.?\b|\bx\b/i).some(part => similar(guess, part));
}

// ---------- Teams ----------
async function makeTeams(room) {
  room.teams = {};
  for (const id of ['A', 'B']) {
    room.teams[id] = { ...TEAM_DEFS[id], timeline: await getRandomStarters(room), tokens: START_TOKENS };
  }
  room.turnIdx = { A: 0, B: 0 };
}

function pickActivePlayer(room, teamId) {
  const members = teamMembers(room, teamId);
  if (!members.length) return null;
  const online = members.filter(m => m.connected);
  const pool = online.length ? online : members;
  const idx = room.turnIdx[teamId] || 0;
  room.turnIdx[teamId] = idx + 1;
  return pool[idx % pool.length];
}

// keep: bij een ander nummer blijft dezelfde speler aan zet
function startTeamRound(room, keep) {
  let teamId, playerId;
  if (keep) {
    teamId = keep.teamId;
    playerId = keep.playerId;
  } else {
    teamId = room.turn % 2 === 1 ? 'A' : 'B';
    if (!teamMembers(room, teamId).length) teamId = otherTeam(teamId);
    const player = pickActivePlayer(room, teamId);
    playerId = player ? player.id : null;
  }
  room.active = {
    teamId,
    playerId,
    submitted: false,
    slotIndex: null,
    exactYear: null,
    title: '',
    artist: '',
    steal: { status: 'idle', teamId: null, playerId: null, slotIndex: null, paid: false }
  };
}

// Fiches terug als de host een ronde overslaat
function refundOpenRound(room) {
  if (room.phase !== 'ACTIVE') return;
  if (room.settings.mode === 'teams') {
    const a = room.active;
    if (a && a.steal.paid && room.teams[a.steal.teamId]) {
      const t = room.teams[a.steal.teamId];
      t.tokens = Math.min(MAX_TOKENS, t.tokens + 1);
    }
  } else {
    for (const p of playersOf(room)) {
      if (p.guess && p.guess.usedToken) p.tokens = Math.min(MAX_TOKENS, p.tokens + 1);
    }
  }
}

// ---------- Verbinding en herstel ----------
function attachPlayer(socket, room, player) {
  if (player.socketId && player.socketId !== socket.id) {
    // Een oudere verbinding (ander tabblad of apparaat) wordt overgenomen
    io.to(player.socketId).emit('replaced');
    delete socketIndex[player.socketId];
  }
  clearTimeout(player.dropTimer);
  player.socketId = socket.id;
  player.connected = true;
  socketIndex[socket.id] = { pin: room.pin, role: 'player', playerId: player.id };
  socket.join(room.pin);
}

function scheduleDropHandling(room, player) {
  clearTimeout(player.dropTimer);
  if (room.state === 'LOBBY') {
    // Wie in de lobby wegvalt en niet terugkomt, verdwijnt uit de lijst
    player.dropTimer = setTimeout(() => {
      if (!player.connected && room.players[player.id]) {
        delete room.players[player.id];
        broadcastState(room);
      }
    }, LOBBY_GRACE_MS);
  } else if (room.settings.mode === 'teams' && room.phase === 'ACTIVE' && room.active &&
             room.active.playerId === player.id && !room.active.submitted) {
    // Speler aan zet is weg: na een korte tijd mag een teamgenoot het overnemen
    player.dropTimer = setTimeout(() => {
      const a = room.active;
      if (player.connected || !a || a.playerId !== player.id || a.submitted || room.phase !== 'ACTIVE') return;
      const next = teamMembers(room, a.teamId).find(m => m.connected && m.id !== player.id);
      if (next) {
        a.playerId = next.id;
        broadcastState(room);
      }
    }, ACTIVE_GRACE_MS);
  }
}

function closeRoom(room, notify) {
  clearTimeout(room.hostTimer);
  clearTimeout(room.revealTimer);
  for (const p of playersOf(room)) {
    clearTimeout(p.dropTimer);
    if (p.socketId) delete socketIndex[p.socketId];
  }
  if (room.hostSocketId) delete socketIndex[room.hostSocketId];
  if (notify) io.to(room.pin).emit('room_closed');
  delete rooms[room.pin];
}

// ---------- Spiekmelding (zonder geluid) ----------
// Gaat een speler tijdens een ronde uit de app (bijv. om het nummer op te zoeken), dan ziet de host dat.
function spiekCounts(room, p) {
  if (room.state !== 'GAME' || room.phase !== 'ACTIVE' || room.swap) return false;
  if (room.settings.mode === 'teams') {
    const a = room.active;
    // Zolang het team aan zet nog moet plaatsen of de tegenstander nog over inbreken beslist
    return !!(a && !(a.submitted && a.steal.status !== 'pending'));
  }
  return !p.submitted;
}

function handleSpiek(room, p, away) {
  if (!room.settings.spiek) return;
  if (!room.spiek || room.spiek.round !== room.round) room.spiek = { round: room.round, list: {} };
  let e = room.spiek.list[p.id];
  const now = Date.now();
  if (away) {
    if (!spiekCounts(room, p)) return;
    if (!e) e = room.spiek.list[p.id] = { playerId: p.id, name: p.name, teamId: p.teamId, count: 0, secs: 0, awaySince: null };
    if (e.awaySince) return;                 // al gemeld (socket én beacon)
    e.awaySince = now;
    e.count += 1;
    notifyHost(room, { kind: 'spiek', text: `👀 ${p.name} verlaat de app… spieken?` });
  } else {
    if (!e || !e.awaySince) return;
    const secs = Math.max(1, Math.round((now - e.awaySince) / 1000));
    e.secs += secs;
    e.awaySince = null;
    notifyHost(room, { kind: 'spiek', text: `👀 ${p.name} is terug (${secs} s weg)` });
    if (p.connected && p.socketId) io.to(p.socketId).emit('announce', { kind: 'spiek-self', text: '👀 De host heeft gezien dat je even weg was.' });
  }
  broadcastState(room);
}

function notifyHost(room, msg) {
  if (room.hostConnected && room.hostSocketId) io.to(room.hostSocketId).emit('announce', msg);
}

function spiekList(room) {
  if (!room.spiek || room.spiek.round !== room.round) return [];
  return Object.values(room.spiek.list).map(e => ({ playerId: e.playerId, name: e.name, teamId: e.teamId, count: e.count, secs: e.secs, away: !!e.awaySince }));
}

// ---------- Uitslag ----------
function revealSolo(room) {
  const track = room.currentTrack;
  const actual = track.year;
  const card = cardOf(track);
  const exactWinners = playersOf(room).filter(p => p.guess && p.guess.exactYear === actual).map(p => p.name);
  const results = {};

  for (const p of playersOf(room)) {
    const g = p.guess;
    let wonCard = false, pointsEarned = 0, tokenReturned = false;

    if (g) {
      const iHadExact = g.exactYear === actual;
      const someoneElseHadExact = exactWinners.length > 0 && !iHadExact;
      if (iHadExact) {
        wonCard = true;
        pointsEarned = g.usedToken ? 3 : 2;
      } else if (!someoneElseHadExact && g.slotIndex !== null && slotCorrect(p.timeline, g.slotIndex, actual)) {
        wonCard = true;
        pointsEarned = g.usedToken ? 2 : 1;
      }
      if (wonCard && g.usedToken) {
        p.tokens = Math.min(MAX_TOKENS, p.tokens + 1);
        tokenReturned = true;
      }
    }

    // Exact jaartal goed = +1 fiche. Het systeem weet het jaar, de host hoeft niets te controleren.
    const yearGuess = g ? g.exactYear : null;
    const yearCorrect = yearGuess !== null && yearGuess === actual;
    let yearToken = false;
    if (yearCorrect) {
      const before = p.tokens;
      p.tokens = Math.min(MAX_TOKENS, p.tokens + 1);
      yearToken = p.tokens > before;
    }

    if (wonCard) {
      p.score += pointsEarned;
      insertSorted(p.timeline, card);
    }
    results[p.id] = { wonCard, pointsEarned, tokenReturned, hadGuess: !!g, yearGuess, yearCorrect, yearToken };
  }
  return { track: card, exactWinners, results };
}

function revealTeams(room) {
  const a = room.active;
  const actual = room.currentTrack.year;
  const card = cardOf(room.currentTrack);
  const activeTeam = room.teams[a.teamId];

  let outcome = 'none';
  let winnerTeamId = null;
  if (a.submitted && slotCorrect(activeTeam.timeline, a.slotIndex, actual)) {
    outcome = 'active';
    winnerTeamId = a.teamId;
  } else if (a.steal.status === 'stolen' && slotCorrect(activeTeam.timeline, a.steal.slotIndex, actual)) {
    // Inbraak gelukt: de kaart komt in de tijdlijn van het team dat inbrak
    outcome = 'stolen';
    winnerTeamId = a.steal.teamId;
  }
  // Exact jaartal van de speler aan zet goed = +1 fiche voor het team (automatisch gecontroleerd)
  const yearGuess = a.submitted ? a.exactYear : null;
  const yearCorrect = yearGuess !== null && yearGuess === actual;
  let yearToken = false;
  if (yearCorrect) {
    const t = room.teams[a.teamId];
    const before = t.tokens;
    t.tokens = Math.min(MAX_TOKENS, t.tokens + 1);
    yearToken = t.tokens > before;
  }

  // Tijdlijn zoals die was toen de plekken gekozen werden (voor het terugkijken)
  const activeTimelineBefore = activeTeam.timeline.map(c => ({ ...c }));
  if (winnerTeamId) insertSorted(room.teams[winnerTeamId].timeline, card);

  return {
    track: card,
    outcome,
    winnerTeamId,
    activeTeamId: a.teamId,
    activePlayerId: a.playerId,
    stealStatus: a.steal.status,
    stealTeamId: a.steal.teamId,
    activeTimeline: activeTimelineBefore,
    chosenSlot: a.submitted ? a.slotIndex : null,
    stealSlot: a.steal.status === 'stolen' ? a.steal.slotIndex : null,
    yearGuess,
    yearCorrect,
    yearToken
  };
}

function buildJudgements(room) {
  room.judgements = {};
  if (!room.settings.guessTitle) return;
  const t = room.currentTrack;
  let guessers = [];

  if (room.settings.mode === 'teams') {
    const a = room.active;
    const p = a && a.submitted ? room.players[a.playerId] : null;
    if (p) guessers.push({ p, title: a.title, artist: a.artist });
  } else {
    guessers = playersOf(room).filter(p => p.guess).map(p => ({ p, title: p.guess.title, artist: p.guess.artist }));
  }

  for (const g of guessers) {
    if (!g.title && !g.artist) continue;
    room.judgements[g.p.id] = {
      playerId: g.p.id,
      name: g.p.name,
      teamId: g.p.teamId,
      title: g.title,
      artist: g.artist,
      // Hulpje voor de host: lijkt het goed ondanks typfouten?
      suggestTitle: !!g.title && similar(g.title, t.title),
      suggestArtist: !!g.artist && artistMatches(g.artist, t.artist),
      status: 'pending'
    };
  }
}

function checkWinner(room) {
  const target = room.settings.target;
  if (!target) return null;

  if (room.settings.mode === 'teams') {
    const reached = ['A', 'B'].map(id => room.teams[id]).filter(t => t.timeline.length >= target);
    if (!reached.length) return null;
    const best = Math.max(...reached.map(t => t.timeline.length));
    const w = reached.filter(t => t.timeline.length === best);
    return { names: w.map(t => t.name), color: w.length === 1 ? w[0].color : null };
  }

  const reached = playersOf(room).filter(p => p.timeline.length >= target);
  if (!reached.length) return null;
  const best = Math.max(...reached.map(p => p.timeline.length));
  const w = reached.filter(p => p.timeline.length === best);
  return { names: w.map(p => p.name), color: null };
}

// ---------- Snapshots: wat ziet de host, wat ziet een speler ----------
function teamList(room) {
  return ['A', 'B'].map(id => {
    const t = room.teams ? room.teams[id] : null;
    return {
      id,
      name: TEAM_DEFS[id].name,
      color: TEAM_DEFS[id].color,
      count: t ? t.timeline.length : 0,
      tokens: t ? t.tokens : START_TOKENS,
      timeline: t ? t.timeline : [],
      members: teamMembers(room, id).map(m => ({ id: m.id, name: m.name, connected: m.connected }))
    };
  });
}

function publicReveal(room) {
  const lr = room.lastReveal;
  if (!lr) return null;
  const out = { track: lr.track, exactWinners: lr.exactWinners || [] };
  if (room.settings.mode === 'teams') {
    const nm = (id) => (id && room.teams[id] ? room.teams[id].name : null);
    const ap = room.players[lr.activePlayerId];
    Object.assign(out, {
      outcome: lr.outcome,
      winnerTeamId: lr.winnerTeamId,
      winnerTeamName: nm(lr.winnerTeamId),
      activeTeamId: lr.activeTeamId,
      activeTeamName: nm(lr.activeTeamId),
      activeTeamColor: lr.activeTeamId ? TEAM_DEFS[lr.activeTeamId].color : null,
      activePlayerName: ap ? ap.name : '',
      stealStatus: lr.stealStatus,
      stealTeamId: lr.stealTeamId,
      stealTeamName: nm(lr.stealTeamId),
      stealTeamColor: lr.stealTeamId ? TEAM_DEFS[lr.stealTeamId].color : null,
      activeTimeline: lr.activeTimeline,
      chosenSlot: lr.chosenSlot,
      stealSlot: lr.stealSlot,
      yearGuess: lr.yearGuess,
      yearCorrect: lr.yearCorrect,
      yearToken: lr.yearToken
    });
  }
  return out;
}

function hostTr(room) {
  const a = room.active;
  const at = room.teams[a.teamId];
  const ot = room.teams[otherTeam(a.teamId)];
  const ap = room.players[a.playerId];
  return {
    activeTeamId: at.id,
    activeTeamName: at.name,
    activeColor: at.color,
    oppTeamName: ot.name,
    activePlayerName: ap ? ap.name : '?',
    submitted: a.submitted,
    chosenSlot: a.submitted ? a.slotIndex : null,
    stealStatus: a.steal.status,
    stealTeamName: a.steal.teamId ? room.teams[a.steal.teamId].name : null,
    stealColor: a.steal.teamId ? TEAM_DEFS[a.steal.teamId].color : null,
    stealSlot: a.steal.status === 'stolen' ? a.steal.slotIndex : null
  };
}

// Zijn alle acties gedaan? Teams: het team aan zet heeft geplaatst en de tegenstander heeft ingebroken of gepast.
// Individueel: alle verbonden spelers hebben ingediend.
function submissionStatus(room) {
  if (room.settings.mode === 'teams') {
    const a = room.active;
    return { submitted: a && a.submitted ? 1 : 0, total: 1, allReady: !!(a && a.submitted && a.steal.status !== 'pending') };
  }
  const online = connectedPlayers(room);
  const done = online.filter(p => p.submitted).length;
  return { submitted: done, total: online.length, allReady: online.length > 0 && done === online.length };
}

// De kaart onthullen (door de host, of vanzelf als alles binnen is)
function doReveal(room) {
  clearTimeout(room.revealTimer);
  room.revealTimer = null;
  if (room.state !== 'GAME' || room.phase !== 'ACTIVE' || !room.currentTrack) return false;

  room.lastReveal = room.settings.mode === 'teams' ? revealTeams(room) : revealSolo(room);
  room.phase = 'REVEALED';
  buildJudgements(room);

  const winner = checkWinner(room);
  if (winner) {
    room.winner = winner;
    room.state = 'OVER';
  }
  broadcastState(room);
  return true;
}

// Alles binnen? Dan onthult de server de kaart na een korte pauze, zonder dat de host hoeft te tikken.
// Alleen na een echte actie van een speler (niet als iemand wegvalt).
function maybeScheduleAutoReveal(room) {
  if (!room.settings.autoReveal || room.revealTimer || room.swap) return;
  if (room.state !== 'GAME' || room.phase !== 'ACTIVE' || !submissionStatus(room).allReady) return;
  const round = room.round;
  room.revealTimer = setTimeout(() => {
    room.revealTimer = null;
    if (rooms[room.pin] === room && room.phase === 'ACTIVE' && room.round === round && !room.swap && submissionStatus(room).allReady) {
      doReveal(room);
    }
  }, autoRevealDelay());
}

function hostSnapshot(room) {
  const teamMode = room.settings.mode === 'teams';
  const status = submissionStatus(room);
  return {
    pin: room.pin,
    settings: room.settings,
    state: room.state,
    phase: room.phase,
    round: room.round,
    turn: room.turn,
    revealing: !!room.revealTimer,
    swap: room.swap ? { byName: room.swap.byName, teamName: room.swap.teamId && room.teams ? room.teams[room.swap.teamId].name : null } : null,
    players: playersOf(room).map(p => {
      const own = teamMode && room.teams ? room.teams[p.teamId] : p;
      return {
        id: p.id,
        name: p.name,
        connected: p.connected,
        teamId: p.teamId,
        score: p.score,
        count: own.timeline.length,
        tokens: own.tokens,
        submitted: p.submitted
      };
    }),
    teams: teamMode ? teamList(room) : null,
    track: room.phase === 'IDLE' ? null : room.currentTrack,
    used: room.used,   // al gebruikte nummers (startkaarten en gespeeld), zodat de host niets herhaalt
    spiek: spiekList(room),
    status,
    tr: teamMode && room.active && room.state !== 'LOBBY' ? hostTr(room) : null,
    reveal: room.phase === 'REVEALED' ? publicReveal(room) : null,
    judgements: room.phase === 'REVEALED' ? Object.values(room.judgements) : [],
    winner: room.winner
  };
}

function judgementFor(room, p) {
  if (!room.settings.guessTitle) return null;
  if (room.settings.mode === 'teams') {
    const a = room.active;
    if (!a || p.teamId !== a.teamId) return null;
    const j = room.judgements[a.playerId];
    return j ? { status: j.status, name: j.name } : null;
  }
  const j = room.judgements[p.id];
  return j ? { status: j.status, name: j.name } : null;
}

function playerTr(room, p) {
  const a = room.active;
  const at = room.teams[a.teamId];
  const ot = room.teams[otherTeam(a.teamId)];
  const ap = room.players[a.playerId];
  const mineOpp = p.teamId === ot.id;
  const iAmActive = a.playerId === p.id;
  return {
    activeTeamId: at.id,
    activeTeamName: at.name,
    activeColor: at.color,
    oppTeamName: ot.name,
    activePlayerName: ap ? ap.name : '?',
    iAmActive,
    myTeamActive: p.teamId === at.id,
    submitted: a.submitted,
    chosenSlot: a.submitted ? a.slotIndex : null,
    myYear: iAmActive ? a.exactYear : null,
    myTitle: iAmActive ? a.title : '',
    myArtist: iAmActive ? a.artist : '',
    stealStatus: a.steal.status,
    stealTeamName: a.steal.teamId ? room.teams[a.steal.teamId].name : null,
    stealColor: a.steal.teamId ? TEAM_DEFS[a.steal.teamId].color : null,
    stealSlot: a.steal.status === 'stolen' ? a.steal.slotIndex : null,
    canSteal: room.phase === 'ACTIVE' && a.submitted && a.steal.status === 'pending' && mineOpp && ot.tokens > 0,
    activeTimeline: at.timeline
  };
}

function playerSnapshot(room, p) {
  const teamMode = room.settings.mode === 'teams';
  const team = teamMode && room.teams ? room.teams[p.teamId] : null;
  const own = team || p;

  let reveal = null;
  if (room.phase === 'REVEALED' && room.lastReveal) {
    reveal = publicReveal(room);
    reveal.personal = teamMode ? null : (room.lastReveal.results[p.id] || null);
    reveal.titleJudgement = judgementFor(room, p);
  }

  return {
    pin: room.pin,
    playerId: p.id,
    name: p.name,
    mode: room.settings.mode,
    target: room.settings.target,
    guessTitle: room.settings.guessTitle,
    guessYear: room.settings.guessYear,
    spiekOn: !!room.settings.spiek,
    state: room.state,
    phase: room.phase,
    round: room.round,
    turn: room.turn,
    revealing: !!room.revealTimer,
    swap: room.swap ? { byName: room.swap.byName } : null,
    canSwap: canSwapNow(room, p),
    swapCost: SWAP_COST,
    hostConnected: room.hostConnected,
    teamId: teamMode ? p.teamId : null,
    teamName: teamMode ? TEAM_DEFS[p.teamId].name : null,
    teamColor: teamMode ? TEAM_DEFS[p.teamId].color : null,
    teams: teamMode ? teamList(room) : null,
    timeline: own.timeline,
    tokens: own.tokens,
    score: p.score,
    submitted: p.submitted,
    guess: p.guess,
    tr: teamMode && room.active && room.state !== 'LOBBY' ? playerTr(room, p) : null,
    reveal,
    winner: room.winner
  };
}

function broadcastState(room) {
  if (room.hostConnected && room.hostSocketId) {
    io.to(room.hostSocketId).emit('host_state', hostSnapshot(room));
  }
  for (const p of playersOf(room)) {
    if (p.connected && p.socketId) io.to(p.socketId).emit('player_state', playerSnapshot(room, p));
  }
}

// Mag deze speler nu een ander nummer kiezen?
function canSwapNow(room, p) {
  if (room.state !== 'GAME' || room.phase !== 'ACTIVE' || room.swap) return false;
  if (room.settings.mode === 'teams') {
    const a = room.active;
    return !!(a && a.playerId === p.id && !a.submitted && room.teams[a.teamId].tokens >= SWAP_COST);
  }
  return !p.submitted && p.tokens >= SWAP_COST;
}

// Starters voor spelers die nog geen kaarten hebben (solo-modus)
async function ensurePlayerStarters(room) {
  if (room.settings.mode === 'teams') return;
  for (const p of playersOf(room)) {
    if (!p.timeline.length) {
      p.timeline = await getRandomStarters(room);
      p.score = p.timeline.length;
    }
  }
}

function hostRoom(socket) {
  const ctx = socketIndex[socket.id];
  return ctx && ctx.role === 'host' ? rooms[ctx.pin] || null : null;
}

function playerCtx(socket) {
  const ctx = socketIndex[socket.id];
  if (!ctx || ctx.role !== 'player') return {};
  const room = rooms[ctx.pin];
  const player = room ? room.players[ctx.playerId] : null;
  return room && player ? { room, player } : {};
}

// =====================================================================
// Socket-gebeurtenissen
// =====================================================================
io.on('connection', (socket) => {
  // Levensteken van de host: houdt de server wakker op gratis hosting
  socket.on('keepalive', () => {});

  // ---------- Host ----------
  socket.on('create_room', () => {
    const pin = newPin();
    const room = {
      pin,
      hostToken: makeId(16),
      hostSocketId: socket.id,
      hostConnected: true,
      hostTimer: null,
      settings: { mode: 'solo', target: 10, guessTitle: true, guessYear: true, autoReveal: true, spiek: true, category: defaultCategory() },
      state: 'LOBBY',        // LOBBY | GAME | OVER
      phase: 'IDLE',         // IDLE | ACTIVE | REVEALED
      round: 0,              // telt elk nummer (ook een vervangen nummer); de pagina wist hiermee invoer
      turn: 0,               // telt beurten; een ander nummer is geen nieuwe beurt
      swap: null,            // lopend verzoek om een ander nummer
      revealTimer: null,     // loopt als alles binnen is en de kaart vanzelf wordt onthuld
      players: {},
      teams: null,
      turnIdx: { A: 0, B: 0 },
      currentTrack: null,
      active: null,          // teams: wie is aan zet en wat is er gekozen
      lastReveal: null,
      judgements: {},
      winner: null,
      starting: false,
      used: [],              // al gebruikte nummers
      usedKeys: new Set()
    };
    rooms[pin] = room;
    socketIndex[socket.id] = { pin, role: 'host' };
    socket.join(pin);
    socket.emit('room_created', { pin, hostToken: room.hostToken });
    broadcastState(room);
  });

  socket.on('resume_host', ({ pin, hostToken } = {}) => {
    const room = rooms[String(pin || '')];
    if (!room || !hostToken || room.hostToken !== hostToken) return socket.emit('resume_failed');
    clearTimeout(room.hostTimer);
    if (room.hostSocketId && room.hostSocketId !== socket.id) delete socketIndex[room.hostSocketId];
    room.hostSocketId = socket.id;
    room.hostConnected = true;
    socketIndex[socket.id] = { pin: room.pin, role: 'host' };
    socket.join(room.pin);
    broadcastState(room);
  });

  socket.on('update_settings', (s = {}) => {
    const room = hostRoom(socket);
    if (!room || room.state !== 'LOBBY') return;
    if (s.mode === 'solo' || s.mode === 'teams') room.settings.mode = s.mode;
    if (TARGETS.includes(Number(s.target))) room.settings.target = Number(s.target);
    if (typeof s.guessTitle === 'boolean') room.settings.guessTitle = s.guessTitle;
    if (typeof s.guessYear === 'boolean') room.settings.guessYear = s.guessYear;
    if (typeof s.autoReveal === 'boolean') room.settings.autoReveal = s.autoReveal;
    if (typeof s.spiek === 'boolean') room.settings.spiek = s.spiek;
    if (typeof s.category === 'string') room.settings.category = s.category.slice(0, 80);
    broadcastState(room);
  });

  socket.on('set_team', ({ playerId, teamId } = {}) => {
    const room = hostRoom(socket);
    if (!room || room.state !== 'LOBBY') return;
    const p = room.players[playerId];
    if (!p || !TEAM_DEFS[teamId]) return;
    p.teamId = teamId;
    broadcastState(room);
  });

  socket.on('shuffle_teams', () => {
    const room = hostRoom(socket);
    if (!room || room.state !== 'LOBBY') return;
    const ids = playersOf(room).map(p => p.id).sort(() => 0.5 - Math.random());
    ids.forEach((id, i) => { room.players[id].teamId = i % 2 === 0 ? 'A' : 'B'; });
    broadcastState(room);
  });

  socket.on('start_game', async () => {
    const room = hostRoom(socket);
    if (!room || room.state !== 'LOBBY' || room.starting) return;
    const teamMode = room.settings.mode === 'teams';
    if (!playersOf(room).length) return socket.emit('start_error', 'Er zijn nog geen spelers.');
    if (teamMode && (!teamMembers(room, 'A').length || !teamMembers(room, 'B').length)) {
      return socket.emit('start_error', 'Elk team heeft minstens één speler nodig.');
    }

    room.starting = true;
    try {
      if (teamMode) await makeTeams(room);
      else await ensurePlayerStarters(room);
    } finally {
      room.starting = false;
    }
    if (!rooms[room.pin]) return;

    room.state = 'GAME';
    room.phase = 'IDLE';
    room.round = 0;
    room.turn = 0;
    room.swap = null;
    room.winner = null;
    broadcastState(room);

    // Wie tijdens het starten nog binnenkwam, krijgt ook kaarten
    await ensurePlayerStarters(room);
    if (rooms[room.pin]) broadcastState(room);
  });

  socket.on('new_track', ({ track } = {}) => {
    const room = hostRoom(socket);
    if (!room || room.state !== 'GAME') return;
    if (!track || !track.title || !track.artist || !Number.isFinite(Number(track.year))) return;

    clearTimeout(room.revealTimer);
    room.revealTimer = null;
    const isSwap = !!room.swap;
    const keep = isSwap && room.active ? { teamId: room.active.teamId, playerId: room.active.playerId } : null;
    refundOpenRound(room);
    room.currentTrack = {
      title: String(track.title).slice(0, 200),
      artist: String(track.artist).slice(0, 200),
      year: Math.round(Number(track.year)),
      previewUrl: String(track.previewUrl || '').slice(0, 500),
      uri: String(track.uri || '').slice(0, 100)
    };
    markUsed(room, room.currentTrack);
    room.round += 1;
    if (!isSwap) room.turn += 1;
    room.swap = null;
    room.phase = 'ACTIVE';
    room.lastReveal = null;
    room.judgements = {};
    for (const p of playersOf(room)) {
      p.submitted = false;
      p.guess = null;
    }
    if (room.settings.mode === 'teams') startTeamRound(room, keep);
    broadcastState(room);
  });

  socket.on('reveal_track', () => {
    const room = hostRoom(socket);
    if (room) doReveal(room);
  });

  // De host keurt een titel/artiest-gok goed of af (spelfouten!). Goed = +1 fiche.
  socket.on('judge_title', ({ playerId, approved } = {}) => {
    const room = hostRoom(socket);
    if (!room || room.phase !== 'REVEALED') return;
    const j = room.judgements[playerId];
    if (!j || j.status !== 'pending') return;
    j.status = approved ? 'approved' : 'rejected';
    if (approved) {
      const holder = room.settings.mode === 'teams' ? room.teams[j.teamId] : room.players[playerId];
      if (holder) holder.tokens = Math.min(MAX_TOKENS, holder.tokens + 1);
    }
    broadcastState(room);
  });

  socket.on('remove_player', ({ playerId } = {}) => {
    const room = hostRoom(socket);
    if (!room || room.state !== 'LOBBY') return;
    const p = room.players[playerId];
    if (!p) return;
    clearTimeout(p.dropTimer);
    if (p.socketId) {
      io.to(p.socketId).emit('removed');
      delete socketIndex[p.socketId];
    }
    delete room.players[playerId];
    broadcastState(room);
  });

  socket.on('close_room', () => {
    const room = hostRoom(socket);
    if (room) closeRoom(room, true);
  });

  // ---------- Speler ----------
  socket.on('join_room', async ({ pin, name, reclaim } = {}) => {
    const room = rooms[String(pin || '')];
    if (!room) return socket.emit('join_error', 'Kamer niet gevonden!');
    const cleanName = cleanText(name).slice(0, 15);
    if (!cleanName) return socket.emit('join_error', 'Vul je naam in.');

    // Dezelfde naam als een speler die er al is: dan komt die speler terug (ook als het spel al klaar is)
    const existing = playersOf(room).find(p => p.name.toLowerCase() === cleanName.toLowerCase());
    if (room.state === 'OVER' && !existing) return socket.emit('join_error', 'Dit spel is afgelopen.');
    let player;
    if (existing) {
      // Staat hij nog als verbonden (bijv. een oude, half dode verbinding)? Dan eerst vragen of hij het is.
      if (existing.connected && !reclaim) return socket.emit('name_taken', { name: existing.name });
      player = existing;
    } else {
      player = {
        id: makeId(),
        name: cleanName,
        teamId: smallerTeam(room),
        score: 0,
        tokens: START_TOKENS,
        timeline: [],
        submitted: false,
        guess: null,
        connected: false,
        socketId: null,
        dropTimer: null
      };
      room.players[player.id] = player;
      if (room.state === 'GAME') await ensurePlayerStarters(room);
    }
    if (!rooms[room.pin]) return;

    attachPlayer(socket, room, player);
    socket.emit('joined', { pin: room.pin, playerId: player.id });
    broadcastState(room);
  });

  socket.on('resume_player', ({ pin, playerId } = {}) => {
    const room = rooms[String(pin || '')];
    const player = room ? room.players[playerId] : null;
    if (!room || !player) return socket.emit('resume_failed');
    attachPlayer(socket, room, player);
    broadcastState(room);
  });

  socket.on('leave_room', () => {
    const ctx = socketIndex[socket.id];
    if (!ctx || ctx.role !== 'player') return;
    const room = rooms[ctx.pin];
    const player = room ? room.players[ctx.playerId] : null;
    delete socketIndex[socket.id];
    if (!room || !player) return;
    player.connected = false;
    player.socketId = null;
    if (room.state === 'LOBBY') delete room.players[player.id];
    else scheduleDropHandling(room, player);
    broadcastState(room);
  });

  // Ander nummer kiezen: kost 3 fiches, alleen voordat je je keuze hebt ingediend.
  // De host zoekt daarna een nieuw nummer; dezelfde speler blijft aan zet.
  socket.on('request_new_track', () => {
    const { room, player } = playerCtx(socket);
    if (!room || !canSwapNow(room, player)) return;
    if (room.settings.mode === 'teams') room.teams[room.active.teamId].tokens -= SWAP_COST;
    else player.tokens -= SWAP_COST;
    room.swap = { byPlayerId: player.id, byName: player.name, teamId: player.teamId };
    const who = room.settings.mode === 'teams' && room.teams ? `${player.name} (${room.teams[player.teamId].name})` : player.name;
    io.to(room.pin).emit('announce', {
      kind: 'swap',
      byPlayerId: player.id,
      text: `🔄 ${who} zet ${SWAP_COST} fiches in voor een ander nummer!`
    });
    broadcastState(room);
  });

  // Spiekmelding: speler gaat uit de app of komt terug. pin + playerId meesturen, want na het
  // terugkomen kan dit aankomen voordat de verbinding weer aan de speler gekoppeld is.
  socket.on('spiek', ({ pin, playerId, away } = {}) => {
    let { room, player } = playerCtx(socket);
    if (!room) {
      room = rooms[String(pin || '')];
      player = room ? room.players[playerId] : null;
    }
    if (room && player) handleSpiek(room, player, !!away);
  });

  socket.on('submit_turn', (data = {}) => {
    const { room, player } = playerCtx(socket);
    if (!room || room.state !== 'GAME' || room.phase !== 'ACTIVE' || player.submitted || room.swap) return;

    const title = room.settings.guessTitle ? cleanText(data.guessTitle) : '';
    const artist = room.settings.guessTitle ? cleanText(data.guessArtist) : '';
    const slot = Number.isInteger(data.slotIndex) ? data.slotIndex : null;
    const exact = parseInt(data.exactYear, 10);
    const exactYear = room.settings.guessYear && Number.isFinite(exact) && exact >= 1900 && exact <= 2100 ? exact : null;

    if (room.settings.mode === 'teams') {
      const a = room.active;
      if (!a || a.playerId !== player.id || a.submitted) return;
      const team = room.teams[a.teamId];
      if (!validSlot(team.timeline, slot)) return;

      a.submitted = true;
      a.slotIndex = slot;
      a.exactYear = exactYear;
      a.title = title;
      a.artist = artist;
      player.submitted = true;

      // Inbreken kan alleen als het andere team een fiche heeft en iemand online is
      const opp = room.teams[otherTeam(a.teamId)];
      const oppOnline = teamMembers(room, opp.id).some(m => m.connected);
      a.steal.status = opp.tokens > 0 && oppOnline ? 'pending' : 'passed';
    } else {
      const slotOk = validSlot(player.timeline, slot);
      if (!slotOk && exactYear === null) return;

      const usedToken = !!data.usedToken && player.tokens > 0;
      if (usedToken) player.tokens -= 1;
      player.submitted = true;
      player.guess = { slotIndex: slotOk ? slot : null, exactYear, usedToken, title, artist };
    }
    maybeScheduleAutoReveal(room);
    broadcastState(room);
  });

  // Inbreken: het andere team zet een fiche in en kiest een andere plek in de tijdlijn van het team dat aan zet is
  socket.on('submit_steal', ({ slotIndex } = {}) => {
    const { room, player } = playerCtx(socket);
    if (!room || room.settings.mode !== 'teams' || room.phase !== 'ACTIVE' || room.swap) return;
    const a = room.active;
    if (!a || !a.submitted || a.steal.status !== 'pending') return;
    if (player.teamId !== otherTeam(a.teamId)) return;

    const opp = room.teams[player.teamId];
    const activeTeam = room.teams[a.teamId];
    if (opp.tokens < 1) return;
    if (!validSlot(activeTeam.timeline, slotIndex) || slotIndex === a.slotIndex) return;

    opp.tokens -= 1;
    a.steal = { status: 'stolen', teamId: opp.id, playerId: player.id, slotIndex, paid: true };
    maybeScheduleAutoReveal(room);
    broadcastState(room);
  });

  socket.on('pass_steal', () => {
    const { room, player } = playerCtx(socket);
    if (!room || room.settings.mode !== 'teams' || room.phase !== 'ACTIVE' || room.swap) return;
    const a = room.active;
    if (!a || !a.submitted || a.steal.status !== 'pending') return;
    if (player.teamId !== otherTeam(a.teamId)) return;
    a.steal.status = 'passed';
    maybeScheduleAutoReveal(room);
    broadcastState(room);
  });

  // ---------- Verbinding weg ----------
  socket.on('disconnect', () => {
    const ctx = socketIndex[socket.id];
    delete socketIndex[socket.id];
    if (!ctx) return;
    const room = rooms[ctx.pin];
    if (!room) return;

    if (ctx.role === 'host') {
      // Een nieuwere host-verbinding (refresh) heeft het overgenomen
      if (room.hostSocketId !== socket.id) return;
      room.hostConnected = false;
      clearTimeout(room.hostTimer);
      room.hostTimer = setTimeout(() => {
        if (!room.hostConnected) closeRoom(room, true);
      }, HOST_GRACE_MS);
      broadcastState(room);
    } else {
      const player = room.players[ctx.playerId];
      if (!player || player.socketId !== socket.id) return;
      player.connected = false;
      scheduleDropHandling(room, player);
      broadcastState(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Hitster Server live op poort ${PORT}`);
});
