#!/usr/bin/env node
// BE-Aero Relay Server: keeps your BE-Aero devices in touch when they are
// not online at the same time. It pairs like a device, then stores and
// forwards: state changes, AI requests and answers, notifications and
// clipboard sends, each sealed end to end for its recipient (it cannot read
// them). It sees only who, to whom, what kind, how big and when.
//
//   be-aero-relay (or: node relay.js)   run the relay
//   be-aero-relay pair                  open pairing on the running relay (prints a code)
//   be-aero-relay status                what is paired, online and waiting
//
// Settings (environment): RELAY_DATA (~/.be-aero-relay), RELAY_PORT (41811),
// RELAY_ADMIN_PORT (41813, this machine only), RELAY_MAX_GB (2),
// RELAY_TTL_DAYS (30), RELAY_NAME, RELAY_DISCOVERY (0).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const VERSION = '1.0.0';
const { Mesh } = require('./lib/mesh');
const { loadIdentity } = require('./lib/identity');
const { MailStore, DEV_RE } = require('./store');
const { DriveStore } = require('./drive');

const env = process.env;
const DATA = env.RELAY_DATA || path.join(os.homedir(), '.be-aero-relay');
const PORT = Number(env.RELAY_PORT) || 41811;
const ADMIN_PORT = Number(env.RELAY_ADMIN_PORT) || 41813;
const NAME = env.RELAY_NAME || `BE-Aero Relay Server (${os.hostname()})`;

const log = (...a) => console.log(new Date().toISOString(), ...a);
// How to run this again: "node relay.js" from source, else the executable.
const SELF = /\.js$/i.test(process.argv[1] || '') ? 'node relay.js' : path.basename(process.execPath);

async function admin(method, route) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: ADMIN_PORT, method, path: route, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error(body || 'bad answer')); } });
    });
    req.on('error', () => reject(new Error(`the relay is not running here (admin port ${ADMIN_PORT})`)));
    req.end();
  });
}

async function cli(cmd) {
  if (cmd === 'pair') {
    const r = await admin('POST', '/pair');
    console.log(`Pairing is open for 5 minutes.\n\n  Relay:   ${r.name}\n  Address: ${r.addresses.join(', ')}  (port ${r.port})\n  Code:    ${r.code}\n\nIn BE-Aero: Settings > Devices > Pair by address, enter an address and port above, then the code.`);
    return;
  }
  if (cmd === 'status') {
    const s = await admin('GET', '/status');
    console.log(`${s.name}  v${s.version}  ID ${s.id}\nListening on port ${s.port}. Stored: ${s.store.items} items, ${(s.store.bytes / 1048576).toFixed(1)} of ${(s.store.maxBytes / 1048576).toFixed(0)} MB.\n`);
    if (!s.peers.length) console.log(`No devices paired yet. Run: ${SELF} pair`);
    for (const p of s.peers) console.log(`  ${p.online ? '●' : '○'} ${p.name}  (${p.id.slice(0, 15)}…)  ${p.online ? 'online' : `last seen ${p.lastSeen ? new Date(p.lastSeen).toLocaleString() : 'never'}`}  waiting: ${p.waiting}`);
    return;
  }
  console.log(`BE-Aero Relay Server ${VERSION}
usage: ${SELF}            run the relay
       ${SELF} pair       open pairing on the running relay
       ${SELF} status     paired devices and what waits for them`);
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

// The relay itself, without the admin port: used by main() and by tests.
function createRelay({ dataDir = DATA, port = PORT, name = NAME, maxBytes, ttlMs, discovery = env.RELAY_DISCOVERY === '1', quiet = false } = {}) {
  const say = quiet ? () => {} : log;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const identity = loadIdentity(path.join(dataDir, 'identity'), { name });
  const peersFile = path.join(dataDir, 'peers.json');
  const peers = {
    load: () => { try { return JSON.parse(fs.readFileSync(peersFile, 'utf8')); } catch { return []; } },
    save: (list) => { const tmp = `${peersFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 }); fs.renameSync(tmp, peersFile); }
  };
  const store = new MailStore({
    dir: dataDir,
    maxBytes: maxBytes || Math.max(64, Number(env.RELAY_MAX_GB || 2) * 1024) * 1024 * 1024,
    ttlMs: ttlMs || Math.max(1, Number(env.RELAY_TTL_DAYS) || 30) * 24 * 3600 * 1000
  });
  // A pairing code was shown on this machine (relay.js pair): whoever
  // presents it is approved - the code is the proof.
  // Storage for my devices (Shared storage, the File Pool copy): encrypted
  // on the devices, opaque here. It shares the size cap with the mailbox.
  const drive = new DriveStore({ dir: dataDir, budget: () => store.maxBytes - store.used() - drive.used() });
  const mesh = new Mesh({ identity, peers, port, discovery, approvePairing: async () => true, role: 'relay', log: say });
  const paired = (id) => mesh.peers.has(id);

  // Tell an online device its mail is waiting.
  const nudge = (id) => {
    const n = store.list(id).length;
    if (n && mesh.conns.has(id)) mesh.request(id, 'relay.mail', { waiting: n }, 8000).catch(() => {});
  };

  mesh.handle('relay.info', null, async (_a, from) => ({
    role: 'relay', version: VERSION, name: identity.name,
    waiting: store.list(from.id).length,
    store: { bytes: store.used(), maxBytes: store.maxBytes },
    peers: [...mesh.peers.values()].map((p) => ({ id: p.id, name: p.label || p.name, online: mesh.conns.has(p.id), lastSeen: p.lastSeen || null, cert: p.cert || null }))
  }));
  mesh.handle('relay.put', null, async (a, from) => {
    const to = String(a.to || '');
    if (!DEV_RE.test(to) || !paired(to)) throw new Error('that device is not paired with this relay');
    if (to === from.id) throw new Error('cannot send to yourself');
    const m = store.put({ from: from.id, to, kind: a.kind, key: a.key, data: a.data });
    say(`item ${m.kind}${m.key ? ` ${m.key}` : ''} ${m.size} B for ${to.slice(0, 7)} from ${from.id.slice(0, 7)}`);
    nudge(to);
    return { ok: true, id: m.id };
  });
  mesh.handle('relay.list', null, async (_a, from) => ({ items: store.list(from.id).map(({ id, from: f, kind, key, size, at }) => ({ id, from: f, kind, key, size, at })) }));
  mesh.handle('relay.get', null, async (a, from) => {
    const it = store.get(from.id, String(a.id || ''));
    if (!it) throw new Error('no such item');
    return { id: it.meta.id, from: it.meta.from, kind: it.meta.kind, key: it.meta.key, at: it.meta.at, data: it.data.toString('base64') };
  });
  mesh.handle('relay.ack', null, async (a, from) => ({ removed: store.ack(from.id, a.ids) }));
  mesh.handle('drive.index', null, async () => ({ objects: drive.index(), used: store.used() + drive.used(), maxBytes: store.maxBytes }));
  mesh.handle('drive.begin', null, async (a) => ({ id: drive.begin(a.meta, a.size) }));
  mesh.handle('drive.chunk', null, async (a) => ({ ok: drive.chunk(String(a.id), a.offset, a.data) }));
  mesh.handle('drive.commit', null, async (a, from) => { drive.commit(String(a.id)); say(`stored object ${String(a.id).slice(0, 9)} from ${from.id.slice(0, 7)}`); return { ok: true }; });
  mesh.handle('drive.read', null, async (a) => drive.read(String(a.id), a.offset, a.length));
  mesh.handle('drive.meta', null, async (a) => ({ ok: drive.setMeta(String(a.id), a.meta) }));
  mesh.handle('drive.remove', null, async (a) => ({ removed: drive.remove(a.ids) }));

  mesh.on('online', (id) => { say(`online: ${(mesh.peers.get(id) || {}).name || id}`); setTimeout(() => nudge(id), 1500); });
  mesh.on('change', () => {
    // A device unpaired here: drop its mail.
    for (const to of Object.keys(store.stats().byRecipient)) if (!paired(to)) store.forget(to);
  });
  let sweeper = null;
  return {
    identity, mesh, store,
    drive,
    async start() { await mesh.start(); sweeper = setInterval(() => { const n = store.sweep(); if (n) say(`expired ${n} item(s)`); drive.sweep(); }, 3600 * 1000); return mesh.port; },
    stop() { clearInterval(sweeper); mesh.stop(); }
  };
}

async function main() {
  const relay = createRelay();
  const { identity, mesh, store } = relay;
  await relay.start();
  log(`${identity.name} v${VERSION} - ID ${identity.id}`);
  log(`listening on port ${mesh.port}; data in ${DATA}; ${mesh.peers.size} device(s) paired`);
  if (!mesh.peers.size) log(`no devices paired yet: run "${SELF} pair" on this machine`);

  // Admin: this machine only.
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'POST' && req.url === '/pair') {
      const { code, expires } = mesh.openPairing();
      log('pairing open for 5 minutes');
      return send(200, { code, expires, name: identity.name, port: mesh.port, addresses: lanAddresses() });
    }
    if (req.method === 'GET' && req.url === '/status') {
      const st = store.stats();
      return send(200, {
        name: identity.name, id: identity.id, version: VERSION, port: mesh.port, store: st,
        peers: [...mesh.peers.values()].map((p) => ({ id: p.id, name: p.label || p.name, online: mesh.conns.has(p.id), lastSeen: p.lastSeen || null, waiting: (st.byRecipient[p.id] || {}).items || 0 }))
      });
    }
    send(404, { error: 'not found' });
  });
  server.listen(ADMIN_PORT, '127.0.0.1');
  const stop = () => { log('stopping'); relay.stop(); server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { createRelay, VERSION };

if (require.main === module) {
  const cmd = process.argv[2];
  (cmd ? cli(cmd) : main()).catch((err) => { console.error(err.message || err); process.exit(1); });
}
