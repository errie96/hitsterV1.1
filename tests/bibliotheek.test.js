// Tests voor het inlezen van de Hitster-Excel
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readXlsx, buildLibrary } = require('../hitster-library');

const FILE = path.join(__dirname, '..', 'data', 'Hitster-bibliotheek.xlsx');

test('de meegeleverde Hitster-bibliotheek wordt volledig ingelezen', { skip: !fs.existsSync(FILE) }, () => {
  const lib = buildLibrary(readXlsx(fs.readFileSync(FILE)), 'Hitster-bibliotheek.xlsx');
  assert.ok(lib.categories.length >= 10);
  for (const c of lib.categories) {
    assert.ok(c.songs.length > 0, c.name);
    for (const s of c.songs) {
      assert.ok(s.title && s.artist, `${c.name}: titel/artiest`);
      assert.ok(s.year >= 1900 && s.year <= new Date().getFullYear() + 1, `${c.name}: ${s.title} ${s.year}`);
    }
  }
  assert.ok(!lib.categories.some(c => /^(uitleg|bronnen)$/i.test(c.name)), 'Uitleg en Bronnen zijn geen categorie');
  assert.ok(lib.categories.some(c => c.playlist), 'playlist-links uit Bronnen');
});

test('ongeldige rijen worden gemeld en overgeslagen', () => {
  const sheets = [{
    name: 'Hitster - Test',
    rows: [
      ['Titel', 'Artiest', 'Jaar', 'Startkaart', 'Jaar check'],
      ['Goed', 'Iemand', '1980', 'Ja', ''],
      ['Geen jaar', 'Iemand', 'onbekend', '', ''],
      ['Toekomst', 'Iemand', '2999', '', ''],
      ['', 'Zonder titel', '1990', '', ''],
      ['Goed', 'Iemand', '1980', '', ''],
      ['Remaster', 'Band', '2011', '', 'Ja']
    ]
  }];
  const lib = buildLibrary(sheets, 'test.xlsx');
  const songs = lib.categories[0].songs;
  assert.equal(lib.categories[0].name, 'Test');
  assert.equal(songs.length, 2);
  assert.equal(songs[0].start, true);
  assert.equal(songs[1].check, true);
  const w = lib.warnings.join('\n');
  assert.match(w, /2 rij\(en\) overgeslagen, geen geldig jaartal \(rij 3, 4\)/);
  assert.match(w, /zonder titel of artiest \(rij 5\)/);
  assert.match(w, /1 dubbel nummer/);
});
