// The relay's storage: encrypted objects from my devices (Shared storage
// and the File Pool copy). Each object is a sealed metadata blob plus the
// encrypted bytes; the relay cannot read either.
//
//   <data>/drive/<id>.meta   base64 sealed metadata (path, size, ... - opaque here)
//   <data>/drive/<id>.bin    the encrypted content
//   <data>/drive/<id>.part   an upload in progress
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^d[a-f0-9]{23}$/;
const MAX_META = 16 * 1024;
const MAX_CHUNK = 2 * 1024 * 1024;

class DriveStore {
  // { dir, budget: () => bytes free for the drive }
  constructor({ dir, budget = () => Infinity }) {
    this.dir = path.join(dir, 'drive');
    this.budget = budget;
    this.objects = new Map();      // id -> { id, meta, size, at }
    this.uploads = new Map();      // id -> { meta, size, at }
    fs.mkdirSync(this.dir, { recursive: true });
    for (const f of fs.readdirSync(this.dir)) {
      const id = f.replace(/\.(meta|bin|part)$/, '');
      if (!ID_RE.test(id)) continue;
      if (f.endsWith('.part')) { fs.rmSync(path.join(this.dir, f), { force: true }); continue; }   // unfinished
      if (!f.endsWith('.meta')) continue;
      try {
        const meta = fs.readFileSync(path.join(this.dir, f), 'utf8');
        const st = fs.statSync(path.join(this.dir, `${id}.bin`));
        this.objects.set(id, { id, meta, size: st.size, at: st.mtimeMs });
      } catch { /* half an object: dropped */ }
    }
  }

  file(id, ext) { if (!ID_RE.test(String(id))) throw new Error('bad object id'); return path.join(this.dir, `${id}.${ext}`); }
  used() { let n = 0; for (const o of this.objects.values()) n += o.size; for (const u of this.uploads.values()) n += u.size; return n; }
  index() { return [...this.objects.values()].map(({ id, meta, size, at }) => ({ id, meta, size, at })); }

  begin(meta, size) {
    const m = String(meta || '');
    if (!m || m.length > MAX_META) throw new Error('bad metadata');
    const n = Math.max(0, Number(size) || 0);
    if (n > this.budget()) throw new Error('the relay is full');
    const id = `d${crypto.randomBytes(12).toString('hex').slice(0, 23)}`;
    fs.writeFileSync(this.file(id, 'part'), Buffer.alloc(0));
    this.uploads.set(id, { meta: m, size: n, at: Date.now() });
    return id;
  }

  chunk(id, offset, data) {
    const u = this.uploads.get(id);
    if (!u) throw new Error('no such upload');
    const buf = Buffer.from(String(data || ''), 'base64');
    const at = Math.max(0, Number(offset) || 0);
    if (buf.length > MAX_CHUNK || at + buf.length > u.size) throw new Error('chunk out of range');
    const fd = fs.openSync(this.file(id, 'part'), 'r+');
    try { fs.writeSync(fd, buf, 0, buf.length, at); } finally { fs.closeSync(fd); }
    u.at = Date.now();
    return true;
  }

  commit(id) {
    const u = this.uploads.get(id);
    if (!u) throw new Error('no such upload');
    const st = fs.statSync(this.file(id, 'part'));
    if (st.size !== u.size) throw new Error(`upload incomplete (${st.size} of ${u.size} bytes)`);
    fs.renameSync(this.file(id, 'part'), this.file(id, 'bin'));
    fs.writeFileSync(this.file(id, 'meta'), u.meta);
    this.uploads.delete(id);
    this.objects.set(id, { id, meta: u.meta, size: u.size, at: Date.now() });
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

  setMeta(id, meta) {
    const o = this.objects.get(id);
    if (!o) throw new Error('no such object');
    const m = String(meta || '');
    if (!m || m.length > MAX_META) throw new Error('bad metadata');
    fs.writeFileSync(this.file(id, 'meta'), m);
    o.meta = m;
    return true;
  }

  remove(ids) {
    let n = 0;
    for (const id of [].concat(ids || [])) {
      if (!this.objects.has(id)) continue;
      this.objects.delete(id);
      for (const ext of ['bin', 'meta']) { try { fs.rmSync(this.file(id, ext), { force: true }); } catch { /* gone */ } }
      n++;
    }
    return n;
  }

  // Uploads abandoned for an hour are dropped.
  sweep(now = Date.now()) {
    for (const [id, u] of [...this.uploads]) if (now - u.at > 3600 * 1000) { this.uploads.delete(id); try { fs.rmSync(this.file(id, 'part'), { force: true }); } catch { /* gone */ } }
  }
}

module.exports = { DriveStore };
