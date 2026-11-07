// =====================================================================
// Hitster-bibliotheek uit Excel
//
// Leest het Hitster-Excelbestand (één tabblad per Hitster-editie/categorie,
// met de nummers van de Primera-websites) zonder extra npm-pakketten.
// Kolommen worden herkend aan de kop (Titel / Artiest / Jaar, optioneel Spotify).
// Een tabblad "Playlists" (kolommen Categorie + Spotify playlist) koppelt een
// categorie handmatig aan een officiële HITSTER-playlist op Spotify.
// =====================================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_FILE = path.join(DATA_DIR, 'hitster-liedjes.xlsx');
const MIX_ID = '__mix__';

// ---------- Minimale .xlsx-lezer (een .xlsx is een zip met XML) ----------
function unzip(buf) {
  // End of central directory zoeken (achteraan het bestand)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Dit is geen geldig .xlsx-bestand.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compSize);
    files[name] = () => (method === 0 ? data : zlib.inflateRawSync(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decodeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&amp;/g, '&');

const attr = (tag, name) => {
  const m = tag.match(new RegExp('\\s' + name + '="([^"]*)"'));
  return m ? decodeXml(m[1]) : null;
};

// Alle <t>-stukjes samenvoegen (ook bij opgemaakte tekst), maar geen fonetische hulptekst
function textOf(xml) {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(clean))) out += decodeXml(m[1]);
  return out;
}

function colIndex(ref) {
  const letters = String(ref || '').replace(/[^A-Z]/gi, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXlsx(buf) {
  const files = unzip(buf);
  const get = (name) => (files[name] ? files[name]().toString('utf8') : null);

  const shared = [];
  const ss = get('xl/sharedStrings.xml');
  if (ss) {
    const re = /<si>([\s\S]*?)<\/si>|<si\/>/g;
    let m;
    while ((m = re.exec(ss))) shared.push(m[1] ? textOf(m[1]) : '');
  }

  const wb = get('xl/workbook.xml');
  const rels = get('xl/_rels/workbook.xml.rels') || '';
  if (!wb) throw new Error('Werkmap niet gevonden in het bestand.');
  const relMap = {};
  for (const tag of rels.match(/<Relationship\b[^>]*>/g) || []) relMap[attr(tag, 'Id')] = attr(tag, 'Target');

  const sheets = [];
  for (const tag of wb.match(/<sheet\b[^>]*>/g) || []) {
    const name = attr(tag, 'name');
    const rid = attr(tag, 'r:id');
    let target = relMap[rid] || '';
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    const xml = get(target);
    if (!xml) continue;
    const rows = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml))) {
      const row = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) {
        const head = '<c' + cm[1] + '>';
        const body = cm[2] || '';
        const type = attr(head, 't');
        const idx = colIndex(attr(head, 'r'));
        let value = '';
        if (type === 'inlineStr') value = textOf(body);
        else {
          const v = body.match(/<v>([\s\S]*?)<\/v>/);
          const raw = v ? decodeXml(v[1]) : '';
          value = type === 's' ? (shared[Number(raw)] || '') : raw;
        }
        row[idx >= 0 ? idx : row.length] = String(value).trim();
      }
      rows.push(Array.from(row, (c) => (c == null ? '' : c)));
    }
    sheets.push({ name, rows });
  }
  return sheets;
}

// ---------- Tabbladen omzetten naar categorieën met nummers ----------
const HEADERS = {
  title: /^(titel|title|nummer|song|track|liedje|naam nummer)$/i,
  artist: /^(artiest|artist|artiesten|uitvoerder|zanger|band|artiest\(en\))$/i,
  year: /^(jaar|year|jaartal|release|uitgebracht)$/i,
  spotify: /spotify|uri|link|audio/i,
  start: /^startkaart/i,
  check: /^jaar\s*check/i
};
const SKIP_SHEETS = /^(info|uitleg|instructies?|readme|leesmij|overzicht|playlists?|bronnen)$/i;
const isYes = (v) => /^(ja|yes|j|y|x|1|true|waar)$/i.test(String(v || '').trim());

const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'categorie';

function findColumns(rows) {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const cols = {};
    rows[r].forEach((cell, i) => {
      const c = String(cell).replace(/[:*]/g, '').trim();
      for (const key of ['title', 'artist', 'year', 'start', 'check']) if (cols[key] == null && HEADERS[key].test(c)) cols[key] = i;
      if (cols.spotify == null && HEADERS.spotify.test(c) && !/playlist/i.test(c)) cols.spotify = i;
    });
    if (cols.title != null && cols.artist != null && cols.year != null) return { headerRow: r, ...cols };
  }
  // Geen kop gevonden: kolom met jaartallen zoeken, de eerste twee tekstkolommen zijn titel en artiest
  const sample = rows.slice(0, 30);
  const width = Math.max(0, ...sample.map((r) => r.length));
  let yearCol = -1, best = 0;
  for (let i = 0; i < width; i++) {
    const hits = sample.filter((r) => /^(19|20)\d{2}$/.test(String(r[i] || '').trim())).length;
    if (hits > best) { best = hits; yearCol = i; }
  }
  if (yearCol < 0 || best < 3) return null;
  const textCols = [];
  for (let i = 0; i < width && textCols.length < 2; i++) if (i !== yearCol) textCols.push(i);
  if (textCols.length < 2) return null;
  return { headerRow: -1, title: textCols[0], artist: textCols[1], year: yearCol };
}

function parseYear(v) {
  const s = String(v || '').trim();
  if (/^\d{4}(\.0+)?$/.test(s)) return Math.round(Number(s));          // gewoon jaartal (ook 2999: dat keurt de controle af)
  const n = Number(s);
  // Excel-datum (een dagnummer, bijv. 31-12-1985 = 31412) als jaartal
  if (Number.isFinite(n) && n >= 10000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + n * 86400000).getUTCFullYear();
  const m = s.match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

function parsePlaylistsSheet(sheet) {
  const map = {};
  // Kop zoeken (Bronnen-tabblad van de familiequiz: Tabblad | Liedjeslijst | Spotify-playlist)
  let nameCol = 0, linkCol = 1, start = 0;
  for (let r = 0; r < Math.min(sheet.rows.length, 10); r++) {
    const row = sheet.rows[r].map((c) => String(c).toLowerCase());
    const n = row.findIndex((c) => /^(tabblad|categorie|naam)/.test(c));
    const l = row.findIndex((c) => /spotify|playlist/.test(c));
    if (n >= 0 && l >= 0) { nameCol = n; linkCol = l; start = r + 1; break; }
  }
  for (const row of sheet.rows.slice(start)) {
    const name = row[nameCol], link = row[linkCol];
    if (!name || !link || !/spotify|^[a-z0-9]{22}$/i.test(link)) continue;
    map[slug(name)] = String(link).trim();
  }
  return map;
}

function buildLibrary(sheets, fileName) {
  const playlists = {};
  for (const sh of sheets.filter((s) => /^(playlists?|bronnen)$/i.test(s.name.trim()))) Object.assign(playlists, parsePlaylistsSheet(sh));
  const categories = [];
  const warnings = [];

  for (const sheet of sheets) {
    if (SKIP_SHEETS.test(sheet.name.trim())) continue;
    const cols = findColumns(sheet.rows);
    if (!cols) { warnings.push(`Tabblad "${sheet.name}": geen kolommen Titel/Artiest/Jaar gevonden.`); continue; }
    const songs = [];
    const seen = new Set();
    const maxYear = new Date().getFullYear() + 1;
    const bad = { year: [], missing: [], dup: [] };   // rijnummers zoals in Excel (1 = eerste rij)
    for (let r = cols.headerRow + 1; r < sheet.rows.length; r++) {
      const row = sheet.rows[r];
      const title = String(row[cols.title] || '').trim();
      const artist = String(row[cols.artist] || '').trim();
      const rawYear = String(row[cols.year] || '').trim();
      if (!title && !artist && !rawYear) continue;                 // lege rij
      if (!title || !artist) { bad.missing.push(r + 1); continue; }
      const year = parseYear(rawYear);
      if (!year || year < 1900 || year > maxYear) { bad.year.push(r + 1); continue; }
      const key = (title + '|' + artist).toLowerCase();
      if (seen.has(key)) { bad.dup.push(r + 1); continue; }
      seen.add(key);
      const song = { title: title.slice(0, 200), artist: artist.slice(0, 200), year };
      const sp = cols.spotify != null ? String(row[cols.spotify] || '').trim() : '';
      if (/spotify[:.].*track|^spotify:track:/i.test(sp)) song.spotify = sp.slice(0, 200);
      else if (/^https?:\/\//i.test(sp)) song.audio = sp.slice(0, 500);       // eigen audiobestand
      if (cols.start != null && isYes(row[cols.start])) song.start = true;    // mag startkaart zijn
      if (cols.check != null && isYes(row[cols.check])) song.check = true;    // jaartal via Spotify controleren
      songs.push(song);
    }
    const rowsText = (list) => list.slice(0, 6).join(', ') + (list.length > 6 ? ` en nog ${list.length - 6}` : '');
    if (bad.year.length) warnings.push(`Tabblad "${sheet.name}": ${bad.year.length} rij(en) overgeslagen, geen geldig jaartal (rij ${rowsText(bad.year)}).`);
    if (bad.missing.length) warnings.push(`Tabblad "${sheet.name}": ${bad.missing.length} rij(en) zonder titel of artiest (rij ${rowsText(bad.missing)}).`);
    if (bad.dup.length) warnings.push(`Tabblad "${sheet.name}": ${bad.dup.length} dubbel nummer(s) overgeslagen (rij ${rowsText(bad.dup)}).`);
    if (!songs.length) { warnings.push(`Tabblad "${sheet.name}": geen nummers gevonden.`); continue; }
    let id = slug(sheet.name);
    while (categories.some((c) => c.id === id)) id += '-2';
    const years = songs.map((s) => s.year);
    categories.push({
      id,
      name: sheet.name.trim().replace(/^hitster\s*[-:–]\s*/i, '') || sheet.name.trim(),
      sheet: sheet.name.trim(),
      playlist: playlists[id] || null,
      minYear: Math.min(...years),
      maxYear: Math.max(...years),
      songs
    });
  }
  return { file: fileName, loadedAt: new Date().toISOString(), categories, warnings };
}

// ---------- Laden, verversen en vervangen ----------
let library = null;
let libraryMtime = 0;
let libraryPath = null;

function findExcelFile() {
  if (process.env.HITSTER_EXCEL && fs.existsSync(process.env.HITSTER_EXCEL)) return process.env.HITSTER_EXCEL;
  if (fs.existsSync(DEFAULT_FILE)) return DEFAULT_FILE;
  if (!fs.existsSync(DATA_DIR)) return null;
  const files = fs.readdirSync(DATA_DIR).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$'));
  const pick = files.find((f) => /hitster/i.test(f)) || files[0];
  return pick ? path.join(DATA_DIR, pick) : null;
}

// Leest het bestand opnieuw als het op schijf is aangepast (wijzigen kan tot vlak voor het spel)
function getLibrary() {
  const file = findExcelFile();
  if (!file) return library;
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (!library || file !== libraryPath || mtime !== libraryMtime) {
      library = buildLibrary(readXlsx(fs.readFileSync(file)), path.basename(file));
      libraryMtime = mtime;
      libraryPath = file;
      console.log(`Hitster-Excel geladen: ${library.categories.length} categorieën uit ${library.file}`);
    }
  } catch (e) {
    console.warn('Hitster-Excel lezen mislukt:', e.message);
  }
  return library;
}

// Nieuw bestand van de host (upload in de lobby)
function replaceLibrary(buf, originalName) {
  const lib = buildLibrary(readXlsx(buf), originalName || 'hitster-liedjes.xlsx');
  if (!lib.categories.length) throw new Error(lib.warnings[0] || 'Geen enkel tabblad met nummers gevonden.');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DEFAULT_FILE, buf);
    libraryPath = DEFAULT_FILE;
    libraryMtime = fs.statSync(DEFAULT_FILE).mtimeMs;
  } catch (e) {
    console.warn('Excel opslaan mislukt (alleen in geheugen):', e.message);
  }
  library = lib;
  return lib;
}

// Nummers van een categorie (of alles door elkaar)
function songsFor(categoryId) {
  const lib = getLibrary();
  if (!lib) return [];
  if (categoryId === MIX_ID) return lib.categories.flatMap((c) => c.songs);
  const cat = lib.categories.find((c) => c.id === categoryId);
  return cat ? cat.songs : [];
}

module.exports = { readXlsx, buildLibrary, getLibrary, replaceLibrary, songsFor, MIX_ID };
