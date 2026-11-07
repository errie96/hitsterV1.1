// Automatische tests voor de spelregels. Draaien met: npm test
process.env.AUTO_REVEAL_MS = '5';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadServer, correctSlot, wrongSlot, setupGame } = require('./harness');

const TRACK = (year, extra = {}) => ({ title: 'Testnummer ' + year, artist: 'Testartiest', year, uri: 'spotify:track:test' + year, ...extra });

test('individueel: goede plek wint de kaart, foute plek niet', async () => {
  const srv = loadServer();
  const { host, players: [a, b] } = await setupGame(srv);
  await host.call('new_track', { track: TRACK(1987) });
  const tlA = a.last('player_state').timeline, tlB = b.last('player_state').timeline;
  await a.call('submit_turn', { slotIndex: correctSlot(tlA, 1987) });
  const bad = wrongSlot(tlB, 1987);
  await b.call('submit_turn', { slotIndex: bad });
  await host.call('reveal_track');
  assert.equal(a.last('player_state').timeline.length, tlA.length + 1);
  assert.equal(b.last('player_state').timeline.length, tlB.length);
  srv.restore();
});

test('individueel: exact jaartal = kaart + fiche, en dan wint alleen die speler', async () => {
  const srv = loadServer();
  const { host, players: [a, b] } = await setupGame(srv);
  await host.call('new_track', { track: TRACK(1991) });
  const sA = a.last('player_state'), sB = b.last('player_state');
  await a.call('submit_turn', { slotIndex: correctSlot(sA.timeline, 1991), exactYear: 1991 });
  await b.call('submit_turn', { slotIndex: correctSlot(sB.timeline, 1991) });
  await host.call('reveal_track');
  const rA = a.last('player_state'), rB = b.last('player_state');
  assert.equal(rA.timeline.length, sA.timeline.length + 1);
  assert.equal(rA.tokens, sA.tokens + 1);
  assert.equal(rB.timeline.length, sB.timeline.length, 'goede plek telt niet als een ander het exacte jaar had');
  srv.restore();
});

test('individueel: fiche inzetten kost 1, bij winst komt hij terug', async () => {
  const srv = loadServer();
  const { host, players: [a] } = await setupGame(srv, { names: ['Anna'] });
  await host.call('new_track', { track: TRACK(1979) });
  const s = a.last('player_state');
  await a.call('submit_turn', { slotIndex: correctSlot(s.timeline, 1979), usedToken: true });
  assert.equal(a.last('player_state').tokens, s.tokens - 1);
  await host.call('reveal_track');
  const r = a.last('player_state');
  assert.equal(r.tokens, s.tokens);
  assert.equal(r.score, s.score + 2);
  srv.restore();
});

test('dubbel indienen telt maar één keer', async () => {
  const srv = loadServer();
  const { host, players: [a] } = await setupGame(srv, { names: ['Anna'] });
  await host.call('new_track', { track: TRACK(1983) });
  const s = a.last('player_state');
  await a.call('submit_turn', { slotIndex: correctSlot(s.timeline, 1983), usedToken: true });
  await a.call('submit_turn', { slotIndex: correctSlot(s.timeline, 1983), usedToken: true });
  assert.equal(a.last('player_state').tokens, s.tokens - 1);
  srv.restore();
});

test('teams: alleen de speler aan zet mag plaatsen, inbreken lukt bij een betere plek', async () => {
  const srv = loadServer();
  const { host, players } = await setupGame(srv, { names: ['Anna', 'Bas', 'Cor', 'Dirk'], mode: 'teams' });
  await host.call('new_track', { track: TRACK(1995) });
  const states = players.map(p => p.last('player_state'));
  const activeIdx = states.findIndex(s => s.tr.iAmActive);
  const active = players[activeIdx];
  const tl = states[activeIdx].tr.activeTimeline;
  const mate = players.find((p, i) => i !== activeIdx && states[i].teamId === states[activeIdx].teamId);
  const thiefIdx = states.findIndex(s => s.teamId !== states[activeIdx].teamId);
  const thief = players[thiefIdx];
  const oppTokens = states[thiefIdx].tokens;

  // Teamgenoot die niet aan zet is: genegeerd
  await mate.call('submit_turn', { slotIndex: correctSlot(tl, 1995) });
  assert.equal(host.last('host_state').tr.submitted, false);

  await active.call('submit_turn', { slotIndex: wrongSlot(tl, 1995) });
  assert.equal(thief.last('player_state').tr.canSteal, true);
  await thief.call('submit_steal', { slotIndex: correctSlot(tl, 1995) });
  await host.call('reveal_track');
  const h = host.last('host_state');
  assert.equal(h.reveal.outcome, 'stolen');
  const thiefTeam = h.teams.find(t => t.id === states[thiefIdx].teamId);
  assert.equal(thiefTeam.tokens, oppTokens - 1);
  assert.equal(thiefTeam.count, states[thiefIdx].timeline.length + 1);
  srv.restore();
});

test('ander nummer: kost 3 fiches en iedereen krijgt een melding', async () => {
  const srv = loadServer();
  const { host, players: [a, b] } = await setupGame(srv);
  // Fiches verdienen met exacte jaartallen
  for (const y of [1971, 1972]) {
    await host.call('new_track', { track: TRACK(y) });
    await a.call('submit_turn', { exactYear: y });
    await b.call('submit_turn', { exactYear: 1900 });
    await host.call('reveal_track');
  }
  await host.call('new_track', { track: TRACK(1999) });
  const before = a.last('player_state').tokens;
  assert.ok(before >= 3);
  await a.call('request_new_track');
  assert.equal(a.last('player_state').tokens, before - 3);
  const ann = srv.emitted.filter(e => e.ev === 'announce' && e.data.kind === 'swap');
  assert.equal(ann.length, 1);
  assert.match(ann[0].data.text, /Anna zet 3 fiches in/);
  srv.restore();
});

test('ongedaan maken: onthulling terugdraaien zet kaarten en fiches terug', async () => {
  const srv = loadServer();
  const { host, players: [a] } = await setupGame(srv, { names: ['Anna'] });
  await host.call('new_track', { track: TRACK(1984) });
  const s = a.last('player_state');
  await a.call('submit_turn', { slotIndex: correctSlot(s.timeline, 1984), exactYear: 1984 });
  await host.call('reveal_track');
  assert.equal(a.last('player_state').timeline.length, s.timeline.length + 1);
  assert.match(host.last('host_state').undo, /onthulling/);

  await host.call('undo');
  const u = a.last('player_state');
  assert.equal(u.phase, 'ACTIVE');
  assert.equal(u.timeline.length, s.timeline.length);
  assert.equal(u.tokens, s.tokens);
  assert.equal(u.submitted, true, 'de ingediende keuze blijft staan');

  // Nog een keer: nu het nieuwe nummer terugdraaien
  await host.call('undo');
  assert.equal(host.last('host_state').phase, 'IDLE');
  srv.restore();
});

test('jaartal aanpassen: uitslag wordt opnieuw berekend', async () => {
  const srv = loadServer();
  const { host, players: [a] } = await setupGame(srv, { names: ['Anna'] });
  await host.call('new_track', { track: TRACK(2006) });
  const s = a.last('player_state');
  await a.call('submit_turn', { exactYear: 1975 });   // Anna wist dat het origineel uit 1975 is
  await host.call('reveal_track');
  assert.equal(a.last('player_state').timeline.length, s.timeline.length);
  assert.equal(host.last('host_state').canFixYear, true);

  await host.call('fix_year', { year: 1975 });
  const r = a.last('player_state');
  assert.equal(r.phase, 'REVEALED');
  assert.equal(r.reveal.track.year, 1975);
  assert.equal(r.timeline.length, s.timeline.length + 1);
  assert.equal(r.tokens, s.tokens + 1);
  srv.restore();
});

test('spiekmelding: alleen tijdens een ronde, en maar één keer per keer weg', async () => {
  const srv = loadServer();
  const { host, pin, players: [a] } = await setupGame(srv, { names: ['Anna'] });
  const id = a.last('player_state').playerId;
  await a.call('spiek', { pin, playerId: id, away: true });            // nog geen ronde
  assert.equal(srv.emitted.filter(e => e.ev === 'announce' && e.data.kind === 'spiek').length, 0);

  await host.call('new_track', { track: TRACK(1980) });
  await a.call('spiek', { pin, playerId: id, away: true });
  await a.call('spiek', { pin, playerId: id, away: true });            // socket én beacon
  await a.call('spiek', { pin, playerId: id, away: false });
  const alerts = srv.emitted.filter(e => e.ev === 'announce' && e.data.kind === 'spiek').map(e => e.data.text);
  assert.equal(alerts.length, 2);
  assert.match(alerts[0], /Anna verlaat de app/);
  assert.match(alerts[1], /Anna is terug/);
  assert.equal(host.last('host_state').spiek[0].count, 1);
  srv.restore();
});

test('host ziet op wie hij wacht, ook als die offline is', async () => {
  const srv = loadServer();
  const { host, players: [a, b] } = await setupGame(srv);
  await host.call('new_track', { track: TRACK(1990) });
  await a.call('submit_turn', { exactYear: 1990 });
  await b.call('disconnect');
  const w = host.last('host_state').status.waiting;
  assert.deepEqual(w, [{ name: 'Bas', connected: false }]);
  srv.restore();
});

test('startkaarten en nummers worden niet herhaald (ook niet via Spotify-ID)', async () => {
  const srv = loadServer();
  const { host, players } = await setupGame(srv, { names: ['A', 'B', 'C', 'D', 'E', 'F'] });
  const all = players.flatMap(p => p.last('player_state').timeline.map(c => c.title + '|' + c.artist));
  assert.equal(new Set(all).size, all.length);
  await host.call('new_track', { track: TRACK(1986, { uri: 'spotify:track:abc' }) });
  const used = host.last('host_state').used;
  assert.ok(used.some(u => u.uri === 'spotify:track:abc'));
  srv.restore();
});
