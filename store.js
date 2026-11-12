// The relay's mailbox: sealed items waiting for a device, on disk.
//
//   <data>/mail/<recipient id>/<item id>.bin   the sealed envelope (opaque)
//   <data>/mail/<recipient id>/<item id>.json  { id, from, to, kind, key, size, at, expires }
//
// An item with a key (a state item, "theme") replaces the older one from
// the same sender for the same recipient: only the newest version waits.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[a-f0-9]{24}$/;
const DEV_RE = /^[A-Z2-7]{7}(-[A-Z2-7]{7}){7}$/;

class MailStore {
  // { dir, maxBytes, maxItem, ttlMs }
  constructor({ dir, maxBytes = 2 * 1024 ** 3, maxItem = 12 * 1024 * 1024, ttlMs = 30 * 24 * 3600 * 1000 }) {
    this.dir = path.join(dir, 'mail');
    this.maxBytes = maxBytes;
    this.maxItem = maxItem;
    this.ttlMs = ttlMs;
    this.items = new Map();       // id -> meta
    fs.mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  load() {
    for (const to of fs.readdirSync(this.dir)) {
      if (!DEV_RE.test(to)) continue;
      for (const f of fs.readdirSync(path.join(this.dir, to))) {
        if (!f.endsWith('.json')) continue;
        try {
          const m = JSON.parse(fs.readFileSync(path.join(this.dir, to, f), 'utf8'));
          if (ID_RE.test(m.id) && fs.existsSync(this.file(m))) this.items.set(m.id, m);
        } catch { /* half-written: dropped by sweep */ }
      }
    }
  }

  file(m) { return path.join(this.dir, m.to, `${m.id}.bin`); }
  metaFile(m) { return path.join(this.dir, m.to, `${m.id}.json`); }
  used() { let n = 0; for (const m of this.items.values()) n += m.size; return n; }

  put({ from, to, kind, key = '', data }) {
    if (!DEV_RE.test(String(to)) || !DEV_RE.test(String(from))) throw new Error('bad device id');
    if (!/^[a-z][a-z0-9._-]{0,40}$/.test(String(kind))) throw new Error('bad kind');
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ''), 'base64');
    if (!buf.length) throw new Error('empty item');
    if (buf.length > this.maxItem) throw new Error(`item too large (max ${Math.round(this.maxItem / 1048576)} MB)`);
    const k = String(key || '').slice(0, 200);
    if (k) for (const m of [...this.items.values()]) if (m.from === from && m.to === to && m.kind === kind && m.key === k) this.remove(m.id);
    if (this.used() + buf.length > this.maxBytes) throw new Error('the relay is full');
    const now = Date.now();
    const m = { id: crypto.randomBytes(12).toString('hex'), from, to, kind, key: k, size: buf.length, at: now, expires: now + this.ttlMs };
    fs.mkdirSync(path.join(this.dir, to), { recursive: true });
    fs.writeFileSync(this.file(m), buf);
    fs.writeFileSync(this.metaFile(m), JSON.stringify(m));
    this.items.set(m.id, m);
    return m;
  }

  list(to) { return [...this.items.values()].filter((m) => m.to === to).sort((a, b) => a.at - b.at); }

  get(to, id) {
    const m = this.items.get(id);
    if (!m || m.to !== to) return null;
    try { return { meta: m, data: fs.readFileSync(this.file(m)) }; } catch { return null; }
  }

  remove(id) {
    const m = this.items.get(id);
    if (!m) return false;
    this.items.delete(id);
    try { fs.rmSync(this.file(m), { force: true }); fs.rmSync(this.metaFile(m), { force: true }); } catch { /* gone */ }
    return true;
  }

  // Delivered items a device acknowledges; only its own.
  ack(to, ids) { let n = 0; for (const id of [].concat(ids || [])) { const m = this.items.get(id); if (m && m.to === to && this.remove(id)) n++; } return n; }

  // Everything addressed to or from a device that is no longer paired.
  forget(deviceId) { for (const m of [...this.items.values()]) if (m.to === deviceId || m.from === deviceId) this.remove(m.id); }

  sweep(now = Date.now()) { let n = 0; for (const m of [...this.items.values()]) if (m.expires <= now && this.remove(m.id)) n++; return n; }

  stats() {
    const by = {};
    for (const m of this.items.values()) { by[m.to] = by[m.to] || { items: 0, bytes: 0 }; by[m.to].items++; by[m.to].bytes += m.size; }
    return { items: this.items.size, bytes: this.used(), maxBytes: this.maxBytes, byRecipient: by };
  }
}

module.exports = { MailStore, DEV_RE };
