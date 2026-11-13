#!/usr/bin/env node
// BE-Aero Relay Server: keeps your BE-Aero devices in touch when they are
// not online at the same time. It pairs like a device, then stores and
// forwards: state changes, AI requests and answers, notifications and
// clipboard sends, each sealed end to end for its recipient (it cannot read
// them), plus encrypted Shared storage and a File Pool copy. It sees only
// who, to whom, what kind, how big and when.
//
//   be-aero-relay (or: node relay.js)   run the relay
//   be-aero-relay panel                 the control panel (health, devices, settings, log)
//   be-aero-relay pair                  open pairing on the running relay (prints a code)
//   be-aero-relay status                what is paired, online and waiting
//
// Settings: <data>/config.json (edit in the panel), overridden by the
// environment: RELAY_DATA (~/.be-aero-relay), RELAY_PORT (41811),
// RELAY_ADMIN_PORT (41813, this machine only), RELAY_MAX_GB (2),
// RELAY_TTL_DAYS (30), RELAY_NAME, RELAY_DISCOVERY (1 = announce on the LAN).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const VERSION = '1.0.2';
const { Mesh } = require('./lib/mesh');
const { loadIdentity } = require('./lib/identity');
const { MailStore, DEV_RE } = require('./store');
const { DriveStore } = require('./drive');

const env = process.env;
const DATA = env.RELAY_DATA || path.join(os.homedir(), '.be-aero-relay');
const ADMIN_PORT = Number(env.RELAY_ADMIN_PORT) || 41813;
// How to run this again: "node relay.js" from source, else the executable.
const SELF = /\.js$/i.test(process.argv[1] || '') ? 'node relay.js' : path.basename(process.execPath);

// ---- settings: config.json, then the environment on top
// autoUpdate: null = never chosen (off; setup asks once), true / false = chosen.
const DEFAULTS = { name: '', port: 41811, maxGB: 2, ttlDays: 30, discovery: true, autoUpdate: null };
const onOff = (v) => (typeof v === 'boolean' ? v : /^(1|true|yes|on|y)$/i.test(String(v).trim()));
const CONFIG_FIELDS = {
  name: { label: 'Name your devices see', parse: (v) => String(v || '').trim().slice(0, 60), restart: true },
  port: { label: 'Port devices connect to (TCP)', parse: (v) => { const n = Math.round(Number(v)); if (!(n >= 1024 && n <= 65535)) throw new Error('a port from 1024 to 65535'); return n; }, restart: true },
  maxGB: { label: 'Storage cap (GB)', parse: (v) => { const n = Number(v); if (!(n >= 0.1 && n <= 100000)) throw new Error('a size in GB'); return Math.round(n * 10) / 10; } },
  ttlDays: { label: 'Keep uncollected messages (days)', parse: (v) => { const n = Math.round(Number(v)); if (!(n >= 1 && n <= 3650)) throw new Error('1 to 3650 days'); return n; } },
  discovery: { label: 'Announce on the local network', parse: (v) => (typeof v === 'boolean' ? v : /^(1|true|yes|on)$/i.test(String(v))), restart: true },
  autoUpdate: { label: 'Install updates automatically (daily)', parse: onOff }
};
const ENV_OF = { name: 'RELAY_NAME', port: 'RELAY_PORT', maxGB: 'RELAY_MAX_GB', ttlDays: 'RELAY_TTL_DAYS', discovery: 'RELAY_DISCOVERY' };
const configFile = (dir = DATA) => path.join(dir, 'config.json');
function readConfig(dir = DATA) { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configFile(dir), 'utf8')) }; } catch { return { ...DEFAULTS }; } }
function writeConfig(cfg, dir = DATA) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, cfg[k]]));
  fs.writeFileSync(configFile(dir), JSON.stringify(out, null, 2), { mode: 0o600 });
}
function effective(dir = DATA) {
  const c = readConfig(dir);
  return {
    name: env.RELAY_NAME || c.name || `BE-Aero Relay Server (${os.hostname()})`,
    port: Number(env.RELAY_PORT) || Number(c.port) || 41811,
    maxGB: Number(env.RELAY_MAX_GB) || Number(c.maxGB) || 2,
    ttlDays: Number(env.RELAY_TTL_DAYS) || Number(c.ttlDays) || 30,
    discovery: env.RELAY_DISCOVERY !== undefined ? env.RELAY_DISCOVERY !== '0' : c.discovery !== false,
    autoUpdate: c.autoUpdate === true,
    fromEnv: Object.keys(DEFAULTS).filter((k) => env[ENV_OF[k]] !== undefined)
  };
}

// ---- a small log kept in memory for the panel
const LOG = [];
const log = (...a) => {
  const line = `${new Date().toISOString()} ${a.join(' ')}`;
  console.log(line);
  LOG.push(line);
  if (LOG.length > 300) LOG.shift();
};

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

// ---- the admin port: this machine only, and only with the token in the
// data folder (readable by the relay's own user and administrators)
const tokenFile = (dir = DATA) => path.join(dir, 'admin.token');
function adminToken(dir = DATA, create = false) {
  try { return fs.readFileSync(tokenFile(dir), 'utf8').trim(); } catch {
    if (!create) return '';
    const t = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenFile(dir), t, { mode: 0o600 });
    return t;
  }
}

function admin(method, route, body = null) {
  const token = adminToken();
  if (!token) return Promise.reject(new Error(`cannot read ${tokenFile()} - run this as the relay's user (Linux service: sudo be-aero-relay ...) or set RELAY_DATA`));
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: ADMIN_PORT, method, path: route, timeout: 8000, headers: { authorization: `Bearer ${token}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { let j; try { j = JSON.parse(b); } catch { reject(new Error(b || 'bad answer')); return; } if (res.statusCode >= 400) reject(new Error(j.error || `error ${res.statusCode}`)); else resolve(j); });
    });
    req.on('error', () => reject(new Error(`the relay is not running here (admin port ${ADMIN_PORT})`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('the relay did not answer')); });
    if (data) req.write(data);
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
    console.log(`${s.name}  v${s.version}  ID ${s.id}\nListening on port ${s.port}. Stored: ${s.store.items} messages, ${s.drive.objects} files; ${((s.store.bytes + s.drive.bytes) / 1048576).toFixed(1)} of ${(s.store.maxBytes / 1048576).toFixed(0)} MB.\n`);
    if (!s.peers.length) console.log(`No devices paired yet. Run: ${SELF} pair`);
    for (const p of s.peers) console.log(`  ${p.online ? '●' : '○'} ${p.name}  (${p.id.slice(0, 15)}…)  ${p.online ? 'online' : `last seen ${p.lastSeen ? new Date(p.lastSeen).toLocaleString() : 'never'}`}  waiting: ${p.waiting}`);
    return;
  }
  if (cmd === 'panel') { await require('./panel').run({ admin, fields: CONFIG_FIELDS, self: SELF }); return; }
  if (cmd === '--version' || cmd === 'version') { console.log(VERSION); return; }
  // Automatic updates (the daily be-aero-relay-update timer reads this):
  //   auto-update on | off   choose;   auto-update   show (on / off / unset)
  if (cmd === 'auto-update') {
    const want = process.argv[3];
    const cfg = readConfig();
    if (want) {
      if (!/^(on|off|yes|no|true|false|1|0)$/i.test(want)) throw new Error('use: auto-update on | off');
      cfg.autoUpdate = onOff(want);
      writeConfig(cfg);
    }
    console.log(cfg.autoUpdate === true ? 'on' : cfg.autoUpdate === false ? 'off' : 'unset');
    return;
  }
  console.log(`BE-Aero Relay Server ${VERSION}\nusage: ${SELF}            run the relay\n       ${SELF} panel      the control panel: health, devices, settings, log\n       ${SELF} pair       open pairing on the running relay\n       ${SELF} status     paired devices and what waits for them\n       ${SELF} auto-update on|off   install new releases by itself (daily)`);
}

// The relay itself, without the admin port: used by main() and by tests.
function createRelay({ dataDir = DATA, port, name, maxBytes, ttlMs, discovery, quiet = false } = {}) {
  const say = quiet ? () => {} : log;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const cfg = effective(dataDir);
  const identity = loadIdentity(path.join(dataDir, 'identity'), { name: name || cfg.name });
  const peersFile = path.join(dataDir, 'peers.json');
  const peers = {
    load: () => { try { return JSON.parse(fs.readFileSync(peersFile, 'utf8')); } catch { return []; } },
    save: (list) => { const tmp = `${peersFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 }); fs.renameSync(tmp, peersFile); }
  };
  const store = new MailStore({
    dir: dataDir,
    maxBytes: maxBytes || Math.max(0.1, cfg.maxGB) * 1024 ** 3,
    ttlMs: ttlMs || Math.max(1, cfg.ttlDays) * 24 * 3600 * 1000
  });
  // Storage for my devices (Shared storage, the File Pool copy): encrypted
  // on the devices, opaque here. It shares the size cap with the mailbox.
  const drive = new DriveStore({ dir: dataDir, budget: () => store.maxBytes - store.used() - drive.used(), log: say });
  // A pairing code was shown on this machine (pair): whoever presents it is
  // approved - the code is the proof.
  const mesh = new Mesh({ identity, peers, port: port !== undefined ? port : cfg.port, discovery: discovery !== undefined ? discovery : cfg.discovery, approvePairing: async () => true, role: 'relay', log: say });
  const paired = (id) => mesh.peers.has(id);

  // Traffic, for the panel: bytes in and out, per minute.
  const traffic = { in: 0, out: 0, inTotal: 0, outTotal: 0, history: [] };
  const count = (dir, b64) => { const n = Math.floor(String(b64 || '').length * 0.75); traffic[dir] += n; traffic[`${dir}Total`] += n; };
  const trafficTimer = setInterval(() => { traffic.history.push({ at: Date.now(), in: traffic.in, out: traffic.out }); if (traffic.history.length > 60) traffic.history.shift(); traffic.in = 0; traffic.out = 0; }, 60000);
  if (trafficTimer.unref) trafficTimer.unref();

  // Tell an online device its mail is waiting.
  const nudge = (id) => {
    const n = store.list(id).length;
    if (n && mesh.conns.has(id)) mesh.request(id, 'relay.mail', { waiting: n }, 8000).catch(() => {});
  };

  mesh.handle('relay.info', null, async (_a, from) => ({
    role: 'relay', version: VERSION, name: identity.name,
    waiting: store.list(from.id).length,
    store: { bytes: store.used() + drive.used(), maxBytes: store.maxBytes },
    peers: [...mesh.peers.values()].map((p) => ({ id: p.id, name: p.label || p.name, online: mesh.conns.has(p.id), lastSeen: p.lastSeen || null, cert: p.cert || null }))
  }));
  mesh.handle('relay.put', null, async (a, from) => {
    const to = String(a.to || '');
    if (!DEV_RE.test(to) || !paired(to)) throw new Error('that device is not paired with this relay');
    if (to === from.id) throw new Error('cannot send to yourself');
    count('in', a.data);
    const m = store.put({ from: from.id, to, kind: a.kind, key: a.key, data: a.data });
    say(`item ${m.kind}${m.key ? ` ${m.key}` : ''} ${m.size} B for ${to.slice(0, 7)} from ${from.id.slice(0, 7)}`);
    nudge(to);
    return { ok: true, id: m.id };
  });
  mesh.handle('relay.list', null, async (_a, from) => ({ items: store.list(from.id).map(({ id, from: f, kind, key, size, at }) => ({ id, from: f, kind, key, size, at })) }));
  mesh.handle('relay.get', null, async (a, from) => {
    const it = store.get(from.id, String(a.id || ''));
    if (!it) throw new Error('no such item');
    const data = it.data.toString('base64');
    count('out', data);
    return { id: it.meta.id, from: it.meta.from, kind: it.meta.kind, key: it.meta.key, at: it.meta.at, data };
  });
  mesh.handle('relay.ack', null, async (a, from) => ({ removed: store.ack(from.id, a.ids) }));

  // Storage. drive.index: everything, or what changed since a sequence
  // number. Uploads are resumable (drive.status) and committed with the
  // version they replace (base) - a mismatch is a conflict, not an overwrite.
  let stored = 0;
  let storedTimer = null;
  const noteStored = (from) => {
    stored++;
    if (!storedTimer) storedTimer = setTimeout(() => { say(`stored ${stored} file(s) from ${from.slice(0, 7)} (${drive.count()} in all)`); stored = 0; storedTimer = null; }, 10000);
  };
  mesh.handle('drive.index', null, async (a) => ({ ...drive.index(a && a.since), used: store.used() + drive.used(), maxBytes: store.maxBytes, version: 2 }));
  mesh.handle('drive.begin', null, async (a, from) => ({ id: drive.begin(a.meta, a.size, { key: a.key, base: a.base, by: from.id }) }));
  mesh.handle('drive.status', null, async (a) => drive.status(String(a.id)));
  mesh.handle('drive.chunk', null, async (a, from) => { count('in', a.data); return { ok: true, ...drive.chunk(String(a.id), a.offset, a.data, from.id) }; });
  mesh.handle('drive.commit', null, async (a, from) => {
    const r = drive.commit(String(a.id), { force: !!a.force, asNew: a.asNew || null, by: from.id });
    await drive.durable();          // "stored" only once the index says so on disk
    if (r.ok && !r.already) noteStored(from.id);
    return r;
  });
  mesh.handle('drive.abort', null, async (a, from) => ({ ok: drive.abort(String(a.id), from.id) }));
  mesh.handle('drive.read', null, async (a) => { const r = drive.read(String(a.id), a.offset, a.length); count('out', r.data); return r; });
  mesh.handle('drive.meta', null, async (a) => { const ok = drive.setMeta(String(a.id), a.meta, a.key); await drive.durable(); return { ok }; });
  mesh.handle('drive.remove', null, async (a) => { const removed = drive.remove(a.ids); await drive.durable(); return { removed }; });

  mesh.on('online', (id) => { say(`online: ${(mesh.peers.get(id) || {}).name || id}`); setTimeout(() => nudge(id), 1500); });
  mesh.on('change', () => {
    // A device unpaired here: drop its mail.
    for (const to of Object.keys(store.stats().byRecipient)) if (!paired(to)) store.forget(to);
  });
  let sweeper = null;
  const started = Date.now();
  let cpuPrev = process.cpuUsage();
  let cpuAt = Date.now();
  return {
    identity, mesh, store, drive, traffic, started,
    health() {
      const now = Date.now();
      const cpu = process.cpuUsage(cpuPrev);
      const cpuPct = Math.round(((cpu.user + cpu.system) / 1000) / Math.max(1, now - cpuAt) * 1000) / 10;
      cpuPrev = process.cpuUsage(); cpuAt = now;
      const mem = process.memoryUsage();
      let disk = null;
      try { const s = fs.statfsSync(dataDir); disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { disk = null; }
      const st = store.stats();
      return {
        version: VERSION, name: identity.name, id: identity.id, port: mesh.port, addresses: lanAddresses(), dataDir,
        uptimeSec: Math.round((now - started) / 1000), hostUptimeSec: Math.round(os.uptime()),
        cpuPct, memory: { rss: mem.rss, heap: mem.heapUsed, hostFree: os.freemem(), hostTotal: os.totalmem() }, load: os.loadavg(), disk,
        mail: { items: st.items, bytes: st.bytes },
        drive: { objects: drive.count(), bytes: drive.used(), uploads: drive.uploads.size },
        cap: store.maxBytes,
        traffic: { lastMinute: traffic.history.length ? traffic.history[traffic.history.length - 1] : { in: traffic.in, out: traffic.out }, thisMinute: { in: traffic.in, out: traffic.out }, total: { in: traffic.inTotal, out: traffic.outTotal } },
        devices: [...mesh.peers.values()].map((p) => ({ id: p.id, name: p.label || p.name, online: mesh.conns.has(p.id), lastSeen: p.lastSeen || null, waiting: (st.byRecipient[p.id] || {}).items || 0, address: (p.addresses || [])[0] || null })),
        pairing: mesh.pairing && Date.now() < mesh.pairing.expires ? { code: mesh.pairing.code, expires: mesh.pairing.expires } : null
      };
    },
    async start() { await mesh.start(); sweeper = setInterval(() => { const n = store.sweep(); if (n) say(`expired ${n} item(s)`); drive.sweep(); }, 3600 * 1000); return mesh.port; },
    stop() { clearInterval(sweeper); clearInterval(trafficTimer); drive.flush(); mesh.stop(); }
  };
}

async function main() {
  const relay = createRelay();
  const { identity, mesh, store, drive } = relay;
  await relay.start();
  const cfg = effective();
  log(`${identity.name} v${VERSION} - ID ${identity.id}`);
  log(`listening on port ${mesh.port}; data in ${DATA}; ${mesh.peers.size} device(s) paired; ${drive.count()} stored file(s)${cfg.discovery ? '; announcing on the LAN' : ''}`);
  if (!mesh.peers.size) log(`no devices paired yet: run "${SELF} pair" on this machine`);
  const token = adminToken(DATA, true);

  // Admin: this machine only, with the token.
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const auth = String(req.headers.authorization || '');
    const given = Buffer.from(auth.replace(/^Bearer /, ''));
    const want = Buffer.from(token);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(401, { error: 'not allowed' });
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      let json = {};
      try { json = body ? JSON.parse(body) : {}; } catch { return send(400, { error: 'bad request' }); }
      const url = String(req.url || '');
      try {
        if (req.method === 'POST' && url === '/pair') {
          const { code, expires } = mesh.openPairing();
          log('pairing open for 5 minutes');
          return send(200, { code, expires, name: identity.name, port: mesh.port, addresses: lanAddresses() });
        }
        if (req.method === 'POST' && url === '/pair/close') { mesh.closePairing(); return send(200, { ok: true }); }
        if (req.method === 'GET' && url === '/status') {
          const st = store.stats();
          return send(200, {
            name: identity.name, id: identity.id, version: VERSION, port: mesh.port, store: st, drive: { objects: drive.count(), bytes: drive.used() },
            peers: [...mesh.peers.values()].map((p) => ({ id: p.id, name: p.label || p.name, online: mesh.conns.has(p.id), lastSeen: p.lastSeen || null, waiting: (st.byRecipient[p.id] || {}).items || 0 }))
          });
        }
        if (req.method === 'GET' && url === '/health') return send(200, relay.health());
        if (req.method === 'GET' && url === '/log') return send(200, { lines: LOG.slice(-200) });
        if (req.method === 'GET' && url === '/config') return send(200, { config: readConfig(), effective: effective() });
        if (req.method === 'PUT' && url === '/config') {
          const cur = readConfig();
          const restart = [];
          for (const [k, v] of Object.entries(json || {})) {
            const f = CONFIG_FIELDS[k];
            if (!f) throw new Error(`unknown setting ${k}`);
            const val = f.parse(v);
            if (cur[k] !== val && f.restart) restart.push(k);
            cur[k] = val;
          }
          writeConfig(cur);
          // Live where possible: the cap and lifetime at once; the rest after a restart.
          const e = effective();
          store.maxBytes = Math.max(0.1, e.maxGB) * 1024 ** 3;
          store.ttlMs = Math.max(1, e.ttlDays) * 24 * 3600 * 1000;
          log(`settings changed: ${Object.keys(json || {}).join(', ')}`);
          return send(200, { ok: true, config: cur, effective: e, restartNeeded: restart });
        }
        if (req.method === 'POST' && url === '/unpair') {
          const id = String(json.id || '');
          if (!mesh.peers.has(id)) throw new Error('no such device');
          const nm = (mesh.peers.get(id) || {}).name;
          mesh.removePeer(id);
          log(`unpaired ${nm || id}`);
          return send(200, { ok: true });
        }
        if (req.method === 'POST' && url === '/restart') {
          log('restarting (from the panel)');
          send(200, { ok: true });
          // Exit non-zero: the service manager (systemd / the scheduled task) starts it again.
          setTimeout(() => { relay.stop(); server.close(); process.exit(75); }, 300);
          return undefined;
        }
        return send(404, { error: 'not found' });
      } catch (err) { return send(400, { error: err.message }); }
    });
  });
  server.listen(ADMIN_PORT, '127.0.0.1');
  const stop = () => { log('stopping'); relay.stop(); server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('uncaughtException', (err) => { log(`unexpected error: ${err && err.stack || err}`); });
  process.on('unhandledRejection', (err) => { log(`unexpected error: ${err && err.stack || err}`); });
}

module.exports = { createRelay, VERSION, readConfig, writeConfig, effective, CONFIG_FIELDS };

if (require.main === module) {
  const cmd = process.argv[2];
  (cmd ? cli(cmd) : main()).catch((err) => { console.error(err.message || err); process.exit(1); });
}
