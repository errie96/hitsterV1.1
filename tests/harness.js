// Testopstelling: laadt server.js met een nep-express en nep-socket.io,
// zodat de spelregels zonder netwerk en zonder browser getest kunnen worden.
const Module = require('module');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');

function loadServer() {
  const emitted = [];
  const routes = {};
  let connectionHandler = null;

  const fakeExpress = () => {
    const app = () => {};
    app.use = () => {};
    app.get = (p, ...h) => { routes['GET ' + p] = h[h.length - 1]; };
    app.post = (p, ...h) => { routes['POST ' + p] = h[h.length - 1]; };
    return app;
  };
  fakeExpress.static = () => () => {};
  fakeExpress.raw = () => () => {};
  fakeExpress.text = () => () => {};
  fakeExpress.json = () => () => {};

  class FakeServer {
    on(ev, fn) { if (ev === 'connection') connectionHandler = fn; }
    to(target) { return { emit: (ev, data) => emitted.push({ to: target, ev, data: JSON.parse(JSON.stringify(data === undefined ? null : data)) }) }; }
  }
  const fakeHttp = { ...require('http'), createServer: () => ({ listen: () => {} }) };

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'express') return fakeExpress;
    if (request === 'socket.io') return { Server: FakeServer };
    if (request === 'http') return fakeHttp;
    return origLoad.apply(this, arguments);
  };
  const origFetch = global.fetch;
  global.fetch = async () => { throw new Error('geen netwerk in tests'); };
  const origLog = console.log;
  console.log = () => {};
  delete require.cache[SERVER];
  try {
    require(SERVER);
  } finally {
    Module._load = origLoad;
    console.log = origLog;
  }

  let n = 0;
  function connect(name) {
    const id = (name || 'sock') + '-' + (++n);
    const handlers = {};
    const socket = {
      id,
      on: (ev, fn) => { handlers[ev] = fn; },
      emit: (ev, data) => emitted.push({ to: id, ev, data: JSON.parse(JSON.stringify(data === undefined ? null : data)) }),
      join: () => {}
    };
    connectionHandler(socket);
    const call = async (ev, data) => { if (handlers[ev]) await handlers[ev](data); };
    const last = (ev) => {
      for (let i = emitted.length - 1; i >= 0; i--) if (emitted[i].to === id && emitted[i].ev === ev) return emitted[i].data;
      return null;
    };
    return { id, call, last };
  }

  const restore = () => { global.fetch = origFetch; };
  return { connect, emitted, routes, restore };
}

// Plek in de tijdlijn waar een jaartal hoort
function correctSlot(timeline, year) {
  const i = timeline.findIndex(c => c.year > year);
  return i < 0 ? timeline.length : i;
}
// Een plek waar het jaartal zeker NIET hoort
function wrongSlot(timeline, year) {
  const ok = correctSlot(timeline, year);
  for (let i = 0; i <= timeline.length; i++) {
    const before = i > 0 ? timeline[i - 1].year : -Infinity;
    const after = i < timeline.length ? timeline[i].year : Infinity;
    if (i !== ok && !(year >= before && year <= after)) return i;
  }
  return null;
}

// Kamer met spelers opzetten en starten
async function setupGame(srv, { names = ['Anna', 'Bas'], mode = 'solo', settings = {} } = {}) {
  const host = srv.connect('host');
  await host.call('create_room');
  const pin = host.last('room_created').pin;
  const players = [];
  for (const name of names) {
    const p = srv.connect(name);
    await p.call('join_room', { pin, name });
    players.push(p);
  }
  await host.call('update_settings', { mode, autoReveal: false, ...settings });
  await host.call('start_game');
  return { host, pin, players };
}

module.exports = { loadServer, correctSlot, wrongSlot, setupGame };
