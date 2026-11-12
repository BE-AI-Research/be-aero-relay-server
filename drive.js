// The relay's storage: encrypted objects from my devices (Shared storage
// and the File Pool copy). Each object is a sealed metadata blob plus the
// encrypted bytes; the relay cannot read either.
//
//   <data>/drive/index.json  every object's record (one file: fast start)
//   <data>/drive/<id>.bin    the encrypted content
//   <data>/drive/<id>.part   an upload in progress (resumable)
//
// Objects carry an opaque `key` (an HMAC of the path, made on the devices)
// so the relay can tell two objects are the same file without knowing its
// name. A commit names the object it replaces (`base`); if another device
// changed that file meanwhile, the commit comes back as a conflict instead
// of overwriting - the device decides (keep both, newest wins, or drop).
// Every change gets a sequence number, so devices fetch only what changed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^d[a-f0-9]{23}$/;
const KEY_RE = /^[a-f0-9]{16,64}$/;
const MAX_META = 16 * 1024;
const MAX_CHUNK = 2 * 1024 * 1024;
const MAX_UPLOADS_PER_DEVICE = 16;
const MAX_TOMBSTONES = 20000;

class DriveStore {
  // { dir, budget: () => bytes free for the drive, log }
  constructor({ dir, budget = () => Infinity, log = () => {} }) {
    this.dir = path.join(dir, 'drive');
    this.budget = budget;
    this.log = log;
    this.objects = new Map();      // id -> { id, meta, size, at, key, by, seq }
    this.uploads = new Map();      // id -> { meta, size, at, key, base, by, next }
    this.removed = new Map();      // id -> seq (tombstones, for incremental index reads)
    this.seq = 0;
    this.floor = 0;                // tombstones older than this were dropped
    this.saveTimer = null;
    fs.mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  indexFile() { return path.join(this.dir, 'index.json'); }

  load() {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(this.indexFile(), 'utf8')); } catch { j = null; }
    if (j && j.objects) {
      this.seq = Number(j.seq) || 0;
      this.floor = Number(j.floor) || 0;
      for (const o of Object.values(j.objects)) if (ID_RE.test(o.id)) this.objects.set(o.id, o);
      for (const [id, s] of Object.entries(j.removed || {})) this.removed.set(id, s);
    } else {
      // Before 1.0.1: one .meta file per object. Read them once, then keep the index.
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.endsWith('.meta')) continue;
        const id = f.slice(0, -5);
        if (!ID_RE.test(id)) continue;
        try {
          const meta = fs.readFileSync(path.join(this.dir, f), 'utf8');
          const st = fs.statSync(path.join(this.dir, `${id}.bin`));
          this.objects.set(id, { id, meta, size: st.size, at: st.mtimeMs, key: '', by: '', seq: ++this.seq });
        } catch { /* half an object: dropped */ }
      }
      this.saveNow();
      for (const f of fs.readdirSync(this.dir)) if (f.endsWith('.meta')) fs.rmSync(path.join(this.dir, f), { force: true });
    }
    // Unfinished uploads from before a restart stay resumable for a while.
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.upload.json')) continue;
      const id = f.slice(0, -12);
      try {
        const u = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        const st = fs.statSync(this.file(id, 'part'));
        // Chunks are written in order, so the part file's size is how far it got.
        this.uploads.set(id, { ...u, next: Math.min(st.size, Number(u.size) || 0) });
      } catch { this.dropUpload(id); }
    }
  }

  save() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.saveNow(), 500); }

  saveNow() {
    clearTimeout(this.saveTimer);
    const tmp = `${this.indexFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ seq: this.seq, floor: this.floor, objects: Object.fromEntries(this.objects), removed: Object.fromEntries(this.removed) }));
    fs.renameSync(tmp, this.indexFile());
  }

  file(id, ext) { if (!ID_RE.test(String(id))) throw new Error('bad object id'); return path.join(this.dir, `${id}.${ext}`); }
  used() { let n = 0; for (const o of this.objects.values()) n += o.size; for (const u of this.uploads.values()) n += u.size; return n; }
  count() { return this.objects.size; }

  // Everything (since = 0), or only what changed after `since`.
  index(since = 0) {
    const s = Number(since) || 0;
    const full = !s || s < this.floor;
    const pick = (o) => ({ id: o.id, meta: o.meta, size: o.size, at: o.at, key: o.key || '', seq: o.seq });
    return {
      seq: this.seq, full,
      objects: [...this.objects.values()].filter((o) => full || o.seq > s).map(pick),
      removed: full ? [] : [...this.removed].filter(([, q]) => q > s).map(([id]) => id)
    };
  }

  begin(meta, size, { key = '', base = null, by = '' } = {}) {
    const m = String(meta || '');
    if (!m || m.length > MAX_META) throw new Error('bad metadata');
    const k = String(key || '');
    if (k && !KEY_RE.test(k)) throw new Error('bad key');
    const n = Math.max(0, Number(size) || 0);
    if (n > this.budget()) throw new Error('the relay is full');
    if ([...this.uploads.values()].filter((u) => u.by === by).length >= MAX_UPLOADS_PER_DEVICE) throw new Error('too many uploads at once - finish some first');
    const id = `d${crypto.randomBytes(12).toString('hex').slice(0, 23)}`;
    fs.writeFileSync(this.file(id, 'part'), Buffer.alloc(0));
    const u = { meta: m, size: n, at: Date.now(), key: k, base: base && ID_RE.test(base) ? base : null, by, next: 0 };
    this.uploads.set(id, u);
    this.saveUpload(id);
    return id;
  }

  saveUpload(id) {
    const u = this.uploads.get(id);
    if (u) fs.writeFileSync(path.join(this.dir, `${id}.upload.json`), JSON.stringify({ ...u, next: u.next }));
  }

  dropUpload(id) {
    this.uploads.delete(id);
    for (const f of [`${id}.part`, `${id}.upload.json`]) { try { fs.rmSync(path.join(this.dir, f), { force: true }); } catch { /* gone */ } }
  }

  // How much of an upload arrived (to resume after a dropped connection).
  status(id) {
    const u = this.uploads.get(id);
    if (!u) return { exists: this.objects.has(id), committed: this.objects.has(id) };
    return { next: u.next, size: u.size };
  }

  chunk(id, offset, data, by) {
    const u = this.uploads.get(id);
    if (!u) throw new Error('no such upload');
    if (u.by && by && u.by !== by) throw new Error('not your upload');
    const buf = Buffer.from(String(data || ''), 'base64');
    const at = Math.max(0, Number(offset) || 0);
    if (buf.length > MAX_CHUNK || at + buf.length > u.size) throw new Error('chunk out of range');
    if (at > u.next) throw new Error(`out of order: expected offset ${u.next}`);
    const fd = fs.openSync(this.file(id, 'part'), 'r+');
    try { fs.writeSync(fd, buf, 0, buf.length, at); } finally { fs.closeSync(fd); }
    u.next = Math.max(u.next, at + buf.length);
    u.at = Date.now();
    return { next: u.next };
  }

  // -> { ok } or { conflict, current: [object] } (the upload stays pending).
  // force: replace whatever is there. asNew: { meta, key } - keep it beside
  // the others under another name (a conflict copy).
  commit(id, { force = false, asNew = null, by = '' } = {}) {
    const u = this.uploads.get(id);
    if (!u) {
      if (this.objects.has(id)) return { ok: true, already: true };      // a retried commit
      throw new Error('no such upload');
    }
    if (u.by && by && u.by !== by) throw new Error('not your upload');
    const st = fs.statSync(this.file(id, 'part'));
    if (st.size !== u.size || u.next !== u.size) throw new Error(`upload incomplete (${u.next} of ${u.size} bytes)`);
    if (asNew) {
      const m = String(asNew.meta || '');
      if (!m || m.length > MAX_META) throw new Error('bad metadata');
      u.meta = m;
      u.key = KEY_RE.test(String(asNew.key || '')) ? String(asNew.key) : '';
      u.base = null;
    }
    const same = u.key ? [...this.objects.values()].filter((o) => o.key === u.key) : [];
    const replaces = u.base ? same.filter((o) => o.id === u.base) : [];
    const others = same.filter((o) => o.id !== u.base);
    if (others.length && !force) {
      return { conflict: true, current: others.map((o) => ({ id: o.id, meta: o.meta, size: o.size, at: o.at, by: o.by })) };
    }
    fs.renameSync(this.file(id, 'part'), this.file(id, 'bin'));
    try { fs.rmSync(path.join(this.dir, `${id}.upload.json`), { force: true }); } catch { /* gone */ }
    this.uploads.delete(id);
    this.objects.set(id, { id, meta: u.meta, size: u.size, at: Date.now(), key: u.key, by: u.by, seq: ++this.seq });
    this.remove([...replaces, ...(force ? others : [])].map((o) => o.id));
    this.save();
    return { ok: true };
  }

  abort(id, by) {
    const u = this.uploads.get(id);
    if (!u) return false;
    if (u.by && by && u.by !== by) throw new Error('not your upload');
    this.dropUpload(id);
    return true;
  }

  read(id, offset, length) {
    const o = this.objects.get(id);
    if (!o) throw new Error('no such object');
    const at = Math.max(0, Number(offset) || 0);
    const len = Math.max(0, Math.min(MAX_CHUNK, Number(length) || MAX_CHUNK, o.size - at));
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(this.file(id, 'bin'), 'r');
    try { fs.readSync(fd, buf, 0, len, at); } finally { fs.closeSync(fd); }
    return { data: buf.toString('base64'), size: o.size, eof: at + len >= o.size };
  }

  // New metadata (a rename); key moves with it.
  setMeta(id, meta, key) {
    const o = this.objects.get(id);
    if (!o) throw new Error('no such object');
    const m = String(meta || '');
    if (!m || m.length > MAX_META) throw new Error('bad metadata');
    o.meta = m;
    if (key !== undefined) o.key = KEY_RE.test(String(key || '')) ? String(key) : '';
    o.seq = ++this.seq;
    this.save();
    return true;
  }

  remove(ids) {
    let n = 0;
    for (const id of [].concat(ids || [])) {
      if (!this.objects.has(id)) continue;
      this.objects.delete(id);
      this.removed.set(id, ++this.seq);
      try { fs.rmSync(this.file(id, 'bin'), { force: true }); } catch { /* gone */ }
      n++;
    }
    // Keep the tombstone list bounded; older readers then get a full index.
    if (this.removed.size > MAX_TOMBSTONES) {
      const sorted = [...this.removed].sort((a, b) => a[1] - b[1]);
      const drop = sorted.slice(0, this.removed.size - MAX_TOMBSTONES);
      for (const [id] of drop) this.removed.delete(id);
      this.floor = drop[drop.length - 1][1];
    }
    if (n) this.save();
    return n;
  }

  // Uploads abandoned for a day are dropped (an interrupted one can resume until then).
  sweep(now = Date.now()) {
    for (const [id, u] of [...this.uploads]) if (now - u.at > 24 * 3600 * 1000) this.dropUpload(id);
  }

  flush() { if (this.saveTimer) this.saveNow(); }
}

module.exports = { DriveStore };
