// The mesh: BE-Aero devices talking to each other.
//
// Transport: TLS 1.3 with both sides presenting their device certificate
// (identity.js) and PINNED by device ID - certificate authorities play no
// part. Messages are length-prefixed frames: [u32 length][u8 kind][payload],
// kind 0 = JSON, 1 = binary (file chunks, later).
//
// A connection from a PAIRED device carries requests ({t:'req', id, op,
// args} -> {t:'res', id, ok, result|error}); every op is checked against the
// permissions the user gave that device before its handler runs. A
// connection from an UNKNOWN device can do exactly one thing: present a
// pairing code while the pairing window is open (5 minutes, 5 attempts),
// and then only the user's approval on this side adds it.
//
// One connection per pair of devices: when both dial at once, each side
// keeps the connection dialed by the device with the smaller ID.
//
// LAN discovery: a small UDP announcement ({id, name, port}, no secrets)
// every 30 s; announcements fill the "nearby" list and refresh addresses of
// paired devices.
const tls = require('tls');
const dgram = require('dgram');
const crypto = require('crypto');
const os = require('os');
const { EventEmitter } = require('events');
const { deviceIdFromCert } = require('./identity');

const DEFAULT_PORT = 41801;
const DISCOVERY_PORT = 41802;
const MAX_FRAME = 16 * 1024 * 1024;
const PAIR_WINDOW_MS = 5 * 60 * 1000;
const PAIR_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 30000;
const RECONNECT_MS = 15000;
const ANNOUNCE_MS = 30000;
const PROTOCOL = 1;

// What a newly paired device may do. Files are limited to the File Pool by
// the file service until the user shares more (design: decision 4).
const FORGET_KEEP_MS = 180 * 24 * 3600 * 1000;    // how long a removed device is remembered to tell it
const TOLD_GRACE_MS = 10 * 60 * 1000;               // after first telling it, keep telling for this long
const DEFAULT_PERMS = Object.freeze({ files: true, pool: true, state: true, aiBus: true, notify: true, clipboard: true, media: true });
const PERM_NAMES = Object.keys(DEFAULT_PERMS);

// ------------------------------------------------------------ framing
function encodeFrame(obj, kind = 0) {
  const payload = kind === 1 ? obj : Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length + 1, 0);
  head.writeUInt8(kind, 4);
  return Buffer.concat([head, payload]);
}

class FrameReader {
  constructor(onFrame, onError) { this.buf = Buffer.alloc(0); this.parts = []; this.have = 0; this.need = 0; this.onFrame = onFrame; this.onError = onError; }
  push(chunk) {
    // A large frame arrives in many small pieces: keep them and join once it
    // is complete (joining on every piece copied a 10 MB frame ~600 times).
    if (this.need) {
      this.parts.push(chunk); this.have += chunk.length;
      if (this.have < this.need) return;
      this.buf = Buffer.concat([this.buf, ...this.parts]); this.parts = []; this.have = 0; this.need = 0;
    } else this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len < 1 || len > MAX_FRAME) { this.onError(new Error(`bad frame length ${len}`)); return; }
      if (this.buf.length < 4 + len) { this.need = 4 + len - this.buf.length; return; }
      const kind = this.buf[4];
      const payload = this.buf.subarray(5, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      if (kind === 0) {
        let obj;
        try { obj = JSON.parse(payload.toString('utf8')); } catch { this.onError(new Error('bad JSON frame')); return; }
        this.onFrame(obj, null);
      } else this.onFrame(null, Buffer.from(payload));
    }
  }
}

// ------------------------------------------------------------ connection
class Conn extends EventEmitter {
  constructor(socket, { outbound, peerId }) {
    super();
    this.socket = socket;
    this.outbound = outbound;
    this.peerId = peerId;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    const reader = new FrameReader((obj, bin) => this.emit('frame', obj, bin), (err) => this.close(err.message));
    socket.on('data', (d) => reader.push(d));
    socket.on('close', () => this.close('closed'));
    socket.on('error', () => this.close('socket error'));
    socket.setKeepAlive(true, 20000);
  }

  send(obj) { if (!this.closed) this.socket.write(encodeFrame(obj)); }

  request(op, args = {}, timeout = REQUEST_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    this.send({ t: 'req', id, op, args });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${op} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  settle(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || 'refused'));
  }

  close(why = 'closed') {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`connection ${why}`)); }
    this.pending.clear();
    try { this.socket.destroy(); } catch { /* gone */ }
    this.emit('close', why);
  }
}

// ------------------------------------------------------------ the mesh
class Mesh extends EventEmitter {
  // identity: { keyPem, certPem, id, name }
  // peers:    { load() -> [peer], save([peer]) } - peer: { id, name, addresses, perms, pairedAt, lastSeen }
  // approvePairing({ id, name, address }) -> Promise<bool>   (asks the user)
  // role: 'device' (BE-Aero) or 'relay' (the BE-Aero Relay Server), told to peers in hello.
  // forgotten: { load() -> [{ id, at }], save(list) } - devices removed here that
  // still have to hear about it (they were offline); optional (memory only).
  constructor({ identity, peers, approvePairing, port = DEFAULT_PORT, discoveryPort = DISCOVERY_PORT, discovery = true, log = () => {}, role = 'device', forgotten = null }) {
    super();
    this.forgottenStore = forgotten;
    this.forgotten = new Map(((forgotten && forgotten.load()) || []).filter((f) => f && f.id && Date.now() - (f.at || 0) < FORGET_KEEP_MS).map((f) => [f.id, f.at]));
    this.role = role;
    this.identity = identity;
    this.peerStore = peers;
    this.approvePairing = approvePairing || (async () => false);
    this.port = port;
    this.discoveryPort = discoveryPort;
    this.discoveryOn = discovery;
    this.log = log;
    this.peers = new Map((peers.load() || []).map((p) => [p.id, { addresses: [], ...p, perms: { ...DEFAULT_PERMS, ...(p.perms || {}) } }]));
    this.conns = new Map();          // peerId -> Conn
    this.handlers = new Map();       // op -> { perm, fn }
    this.nearby = new Map();         // id -> { id, name, address, port, seen }
    this.pairing = null;             // { code, expires, attempts }
    this.server = null;
    this.udp = null;
    this.timers = [];
    this.handle('ping', null, async () => ({ pong: Date.now(), name: this.identity.name }));
  }

  // ---- lifecycle
  async start() {
    this.stopped = false;
    this.server = tls.createServer({
      key: this.identity.keyPem, cert: this.identity.certPem,
      requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3'
    }, (socket) => this.onInbound(socket));
    this.server.on('tlsClientError', () => { /* scanners, wrong protocol */ });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => { this.server.off('error', reject); resolve(); });
    });
    this.port = this.server.address().port;
    this.timers.push(setInterval(() => this.reconnectAll(), RECONNECT_MS));
    if (this.discoveryOn) this.startDiscovery();
    setImmediate(() => this.reconnectAll());
    return this.port;
  }

  stop() {
    // Dials still in flight finish later: attach() refuses them once stopped.
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const c of this.conns.values()) c.close('stopping');
    this.conns.clear();
    if (this.server) { this.server.close(); this.server = null; }
    if (this.udp) { try { this.udp.close(); } catch { /* closed */ } this.udp = null; }
  }

  // ---- ops
  // perm: null = any paired device; else the permission the caller needs.
  handle(op, perm, fn) { this.handlers.set(op, { perm, fn }); }

  async request(peerId, op, args, timeout) {
    const c = this.conns.get(peerId);
    if (!c) throw new Error('device is offline');
    return c.request(op, args, timeout);
  }

  // ---- state for the UI
  state() {
    return {
      id: this.identity.id, name: this.identity.name, port: this.port,
      pairing: this.pairing && Date.now() < this.pairing.expires ? { code: this.pairing.code, expires: this.pairing.expires } : null,
      peers: [...this.peers.values()].map((p) => ({ ...p, online: this.conns.has(p.id) })),
      nearby: [...this.nearby.values()].filter((n) => !this.peers.has(n.id) && n.id !== this.identity.id && Date.now() - n.seen < 3 * ANNOUNCE_MS)
    };
  }

  changed() { this.emit('change', this.state()); }

  savePeers() { this.peerStore.save([...this.peers.values()]); }

  setPerms(peerId, perms) {
    const p = this.peers.get(peerId);
    if (!p) return false;
    for (const k of PERM_NAMES) if (k in perms) p.perms[k] = !!perms[k];
    this.savePeers();
    this.changed();
    return true;
  }

  // Folders shared with one device (besides the File Pool).
  setShares(peerId, shares) {
    const p = this.peers.get(peerId);
    if (!p) return false;
    p.shares = (Array.isArray(shares) ? shares : []).filter((s) => s && typeof s.path === 'string').slice(0, 50)
      .map((s) => ({ path: s.path, name: String(s.name || '').slice(0, 80) }));
    this.savePeers();
    this.changed();
    return true;
  }

  // A device moved (a new IP address): try it there first, now.
  setAddress(peerId, host, port) {
    const p = this.peers.get(peerId);
    if (!p) return false;
    const a = `${host}:${Number(port) || p.port || DEFAULT_PORT}`;
    p.addresses = [a, ...(p.addresses || []).filter((x) => x !== a)].slice(0, 5);
    if (port) p.port = Number(port);
    this.savePeers();
    this.changed();
    if (!this.conns.has(peerId)) this.connect(p).catch(() => {});
    return true;
  }

  rename(peerId, name) {
    const p = this.peers.get(peerId);
    if (!p) return false;
    p.label = String(name || '').slice(0, 60);
    this.savePeers();
    this.changed();
    return true;
  }

  // Removing a device removes it on both sides: connected, it is told now
  // ("forget" - it drops this device too); offline, it is told the next time
  // it connects. A device told to forget us calls this with fromRemote.
  removePeer(peerId, { fromRemote = false } = {}) {
    const c = this.conns.get(peerId);
    if (c && !fromRemote) this.farewell(c);
    else if (c) c.close('removed by the other device');
    if (!fromRemote && this.peers.has(peerId)) this.rememberForgotten(peerId, !c);
    const had = this.peers.delete(peerId);
    this.savePeers();
    this.changed();
    if (had) this.log(fromRemote ? `${peerId.slice(0, 7)} removed this device; removed it here too` : `removed ${peerId.slice(0, 7)}`);
    return had;
  }

  // Tell a connection to forget us, give the frame time to leave, then close.
  farewell(conn) {
    try { conn.send({ t: 'forget' }); } catch { /* closing anyway */ }
    setTimeout(() => conn.close('device removed'), 500);
  }

  rememberForgotten(peerId, pending) {
    if (pending) this.forgotten.set(peerId, Date.now()); else this.forgotten.delete(peerId);
    if (this.forgottenStore) this.forgottenStore.save([...this.forgotten].map(([id, at]) => ({ id, at })));
  }

  // ---- pairing (this side shows the code)
  openPairing() {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    this.pairing = { code, expires: Date.now() + PAIR_WINDOW_MS, attempts: PAIR_ATTEMPTS };
    this.changed();
    return { code, expires: this.pairing.expires };
  }

  closePairing() { this.pairing = null; this.changed(); }

  // ---- pairing (this side types the code). Connects to address:port, shows
  // the other device's name and ID through confirm(), then presents the code.
  async pairWith(host, port, code, confirm = async () => true) {
    const socket = await this.dial(host, port);
    const remoteId = deviceIdFromCert(socket.getPeerCertificate(true).raw);
    if (remoteId === this.identity.id) { socket.destroy(); throw new Error('that is this device'); }
    const conn = new Conn(socket, { outbound: true, peerId: remoteId });
    try {
      const hello = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no answer from that device')), 8000);
        conn.once('frame', (m) => { clearTimeout(t); resolve(m); });
        conn.once('close', () => { clearTimeout(t); reject(new Error('connection closed')); });
      });
      // "hello" (not "hello-unpaired"): that device still has an old pairing
      // with this one. Pairing again replaces it there with a fresh one.
      const stale = !!hello && hello.t === 'hello';
      if (!hello || (hello.t !== 'hello-unpaired' && !stale)) throw new Error('not a BE-Aero device ready to pair');
      if (!(await confirm({ id: remoteId, name: hello.name }))) throw new Error('cancelled');
      conn.send({ t: 'pair', code: String(code || '').trim(), name: this.identity.name, port: this.port });
      const res = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('the other device did not approve in time')), PAIR_WINDOW_MS);
        // An older version never answers a pairing over its old one: say what to do.
        let heard = false;
        const t2 = stale ? setTimeout(() => { if (!heard) { clearTimeout(t); reject(new Error('that device still has an old pairing with this one and is too old to replace it: remove this device in its Settings > Devices (or update BE-Aero there), then pair again')); } }, 12000) : null;
        const on = (m) => {
          if (!m || !m.t) return;
          if (m.t === 'pair-wait') { heard = true; return; }
          if (m.t !== 'pair-ok' && m.t !== 'pair-no') return;      // other traffic on an old pairing
          clearTimeout(t); clearTimeout(t2); conn.off('frame', on); resolve(m);
        };
        conn.on('frame', on);
        conn.once('close', () => { clearTimeout(t); clearTimeout(t2); reject(new Error('the other device closed the connection')); });
      });
      if (!res || res.t !== 'pair-ok') throw new Error((res && res.error) || 'pairing refused');
      this.addPeer({ id: remoteId, name: hello.name, address: host, port });
      conn.close('paired');
      setTimeout(() => this.connect(this.peers.get(remoteId)), 200);
      return { id: remoteId, name: hello.name };
    } catch (err) {
      conn.close('pairing failed');
      throw err;
    }
  }

  addPeer({ id, name, address, port }) {
    if (this.forgotten.has(id)) { this.rememberForgotten(id, false); if (this.told) this.told.delete(id); }     // paired again
    const prev = this.peers.get(id);
    const addr = address ? `${address}:${port || DEFAULT_PORT}` : null;
    const peer = prev || { id, name, addresses: [], perms: { ...DEFAULT_PERMS }, pairedAt: Date.now() };
    peer.name = name || peer.name;
    if (addr && !peer.addresses.includes(addr)) peer.addresses.unshift(addr);
    peer.addresses = peer.addresses.slice(0, 5);
    this.peers.set(id, peer);
    this.savePeers();
    this.changed();
    return peer;
  }

  // ---- connections
  dial(host, port) {
    return new Promise((resolve, reject) => {
      const s = tls.connect({
        host, port, key: this.identity.keyPem, cert: this.identity.certPem,
        rejectUnauthorized: false, checkServerIdentity: () => undefined, minVersion: 'TLSv1.3'
      });
      const t = setTimeout(() => { s.destroy(); reject(new Error('timed out')); }, 8000);
      s.once('secureConnect', () => { clearTimeout(t); resolve(s); });
      s.once('error', (e) => { clearTimeout(t); reject(e); });
    });
  }

  async connect(peer) {
    if (this.stopped || !peer || this.conns.has(peer.id)) return;
    for (const a of peer.addresses || []) {
      const i = a.lastIndexOf(':');
      const host = a.slice(0, i);
      const port = Number(a.slice(i + 1)) || DEFAULT_PORT;
      try {
        const socket = await this.dial(host, port);
        const id = deviceIdFromCert(socket.getPeerCertificate(true).raw);
        if (id !== peer.id) { socket.destroy(); continue; }      // someone else at that address
        this.attach(new Conn(socket, { outbound: true, peerId: id }), host);
        return;
      } catch { /* next address */ }
    }
  }

  reconnectAll() {
    for (const p of this.peers.values()) if (!this.conns.has(p.id)) this.connect(p).catch(() => {});
  }

  onInbound(socket) {
    if (this.stopped) { socket.destroy(); return; }
    const cert = socket.getPeerCertificate(true);
    if (!cert || !cert.raw) { socket.destroy(); return; }
    const id = deviceIdFromCert(cert.raw);
    const conn = new Conn(socket, { outbound: false, peerId: id });
    if (this.peers.has(id)) { this.attach(conn, socket.remoteAddress); return; }
    // A device removed here while it was offline: now it hears about it.
    // It may dial twice at once and keep the other connection, so every
    // connection is told for a while after the first, then it is dropped.
    if (this.forgotten.has(id)) {
      this.farewell(conn);
      if (!this.told) this.told = new Map();
      if (!this.told.has(id)) { this.told.set(id, Date.now()); this.log(`told ${id.slice(0, 7)} it was removed`); }
      else if (Date.now() - this.told.get(id) > TOLD_GRACE_MS) { this.told.delete(id); this.rememberForgotten(id, false); }
      return;
    }
    this.servePairing(conn, socket.remoteAddress);
  }

  // An unknown device: it may present a code while the window is open.
  servePairing(conn, address) {
    const open = this.pairing && Date.now() < this.pairing.expires;
    if (!open) { conn.close('not paired'); return; }
    conn.send({ t: 'hello-unpaired', name: this.identity.name, protocol: PROTOCOL });
    const t = setTimeout(() => conn.close('pairing timeout'), PAIR_WINDOW_MS);
    conn.once('frame', async (m) => {
      if (!m || m.t !== 'pair') { clearTimeout(t); conn.close('bad pairing'); return; }
      await this.acceptPair(conn, m, address);
      clearTimeout(t);
    });
  }

  // A device presents the code (new, or paired before - its old record here
  // is then replaced by a fresh one): check it, ask the user, add it.
  async acceptPair(conn, m, address) {
    if (!this.pairing || Date.now() >= this.pairing.expires) { conn.send({ t: 'pair-no', error: 'pairing is not open on that device' }); setTimeout(() => conn.close('bad pairing'), 300); return false; }
    conn.send({ t: 'pair-wait' });                    // heard it; the user may still have to approve
    const want = Buffer.from(this.pairing.code);
    const got = Buffer.from(String(m.code || '').padEnd(want.length).slice(0, want.length));
    const ok = crypto.timingSafeEqual(want, got) && String(m.code).length === want.length;
    if (!ok) {
      this.pairing.attempts -= 1;
      if (this.pairing.attempts <= 0) this.closePairing();      // guessing: shut the window
      conn.send({ t: 'pair-no', error: 'wrong code' });
      setTimeout(() => conn.close('wrong code'), 300);       // let the answer leave first
      return false;
    }
    const name = String(m.name || 'Unknown device').slice(0, 60);
    let approved = false;
    try { approved = await this.approvePairing({ id: conn.peerId, name, address }); } catch { approved = false; }
    if (!approved || conn.closed) { conn.send({ t: 'pair-no', error: 'not approved' }); setTimeout(() => conn.close('declined'), 300); return false; }
    this.pairing = null;
    // Paired before (a stale record): start over - a fresh record, default permissions.
    if (this.peers.has(conn.peerId)) { this.peers.delete(conn.peerId); this.log(`${conn.peerId.slice(0, 7)} paired again: old pairing replaced`); }
    this.addPeer({ id: conn.peerId, name, address, port: Number(m.port) || DEFAULT_PORT });
    conn.send({ t: 'pair-ok' });
    setTimeout(() => conn.close('paired'), 100);
    return true;
  }

  // A pinned, paired connection: keep one per device, then serve requests.
  attach(conn, address) {
    if (this.stopped) { conn.close('stopped'); return; }
    const id = conn.peerId;
    const existing = this.conns.get(id);
    if (existing && !existing.closed) {
      // Both sides dialed: keep the one dialed by the smaller device ID.
      const keepOutbound = this.identity.id < id;
      if (conn.outbound !== keepOutbound) { conn.close('duplicate'); return; }
      existing.close('duplicate');
    }
    this.conns.set(id, conn);
    conn.on('close', () => { if (this.conns.get(id) === conn) { this.conns.delete(id); this.changed(); } });
    conn.on('frame', (m) => this.onFrame(conn, m));
    conn.send({ t: 'hello', name: this.identity.name, port: this.port, protocol: PROTOCOL, role: this.role });
    const peer = this.peers.get(id);
    if (peer) {
      peer.lastSeen = Date.now();
      // Keep its certificate (pinned by the ID): its public key is what we
      // encrypt to when it is offline and messages go through a relay.
      try { const raw = conn.socket.getPeerCertificate(true).raw; if (raw && deviceIdFromCert(raw) === id) peer.cert = raw.toString('base64'); } catch { /* no cert */ }
      if (address) {
        const a = `${String(address).replace(/^::ffff:/, '')}:${peer.port || DEFAULT_PORT}`;
        if (conn.outbound && !peer.addresses.includes(a)) { peer.addresses.unshift(a); peer.addresses = peer.addresses.slice(0, 5); }
      }
      this.savePeers();
    }
    this.changed();
    this.emit('online', id);
  }

  async onFrame(conn, m) {
    if (!m || typeof m !== 'object') return;
    const peer = this.peers.get(conn.peerId);
    if (!peer) { conn.close('no longer paired'); return; }
    // The other device removed us: remove it here too.
    if (m.t === 'forget') { this.removePeer(conn.peerId, { fromRemote: true }); return; }
    // It lost its pairing with us (we still have one) and is pairing again.
    if (m.t === 'pair') { await this.acceptPair(conn, m, String(conn.socket.remoteAddress || '').replace(/^::ffff:/, '')); return; }
    if (m.t === 'hello') {
      peer.name = String(m.name || peer.name).slice(0, 60);
      peer.role = m.role === 'relay' ? 'relay' : 'device';
      if (m.port) {
        peer.port = Number(m.port);
        // An inbound connection tells us where this device listens.
        const host = String(conn.socket.remoteAddress || '').replace(/^::ffff:/, '');
        const a = `${host}:${peer.port}`;
        if (host && !peer.addresses.includes(a)) { peer.addresses.unshift(a); peer.addresses = peer.addresses.slice(0, 5); }
      }
      this.savePeers();
      this.changed();
      return;
    }
    if (m.t === 'res') { conn.settle(m); return; }
    if (m.t !== 'req') return;
    const h = this.handlers.get(m.op);
    const reply = (ok, payload) => conn.send(ok ? { t: 'res', id: m.id, ok: true, result: payload } : { t: 'res', id: m.id, ok: false, error: payload });
    if (!h) { reply(false, `unknown request ${m.op}`); return; }
    if (h.perm && !(peer.perms && peer.perms[h.perm])) { reply(false, `this device has not allowed "${h.perm}" for ${peer.label || peer.name}`); return; }
    try { reply(true, await h.fn(m.args || {}, { id: peer.id, name: peer.label || peer.name })); } catch (err) { reply(false, String(err && err.message || err)); }
  }

  // ---- LAN discovery
  startDiscovery() {
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp = udp;
    udp.on('error', (e) => { this.log(`discovery: ${e.message}`); });
    udp.on('message', (buf, rinfo) => {
      let m;
      try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
      if (!m || m.app !== 'be-aero' || !m.id || m.id === this.identity.id) return;
      const port = Number(m.port) || DEFAULT_PORT;
      this.nearby.set(m.id, { id: m.id, name: String(m.name || '').slice(0, 60), address: rinfo.address, port, seen: Date.now() });
      const peer = this.peers.get(m.id);
      if (peer) {
        const a = `${rinfo.address}:${port}`;
        if (!peer.addresses.includes(a)) { peer.addresses.unshift(a); peer.addresses = peer.addresses.slice(0, 5); this.savePeers(); }
        if (!this.conns.has(m.id)) this.connect(peer).catch(() => {});
      }
      this.changed();
    });
    udp.bind(this.discoveryPort, () => {
      try { udp.setBroadcast(true); } catch { /* not allowed */ }
      this.announce();
      this.timers.push(setInterval(() => this.announce(), ANNOUNCE_MS));
    });
  }

  announce() {
    if (!this.udp) return;
    const msg = Buffer.from(JSON.stringify({ app: 'be-aero', v: PROTOCOL, id: this.identity.id, name: this.identity.name, port: this.port }));
    for (const addr of broadcastAddresses()) this.udp.send(msg, this.discoveryPort, addr, () => {});
  }
}

// 255.255.255.255 plus each IPv4 interface's subnet broadcast address.
function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

module.exports = { Mesh, Conn, FrameReader, encodeFrame, DEFAULT_PERMS, PERM_NAMES, DEFAULT_PORT, DISCOVERY_PORT, broadcastAddresses };
