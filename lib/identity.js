// Device identity for the mesh: an ECDSA P-256 key pair and a self-signed
// X.509 certificate, made once per device and kept in the app data folder.
//
// The device ID is the SHA-256 of the certificate (DER), written in base32
// and grouped - the same idea as Syncthing's device IDs. Nothing central
// issues IDs: an ID names exactly one certificate, and only the holder of its
// private key can complete a TLS handshake with it, so pinning the ID is
// pinning the device.
//
// Node can make keys but not certificates, so the certificate is assembled
// here as DER (a fixed, small structure) and signed with crypto.sign.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ------------------------------------------------------------ DER helpers
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
function oid(dotted) {
  const p = dotted.split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (const n of p.slice(2)) {
    const b = [];
    let v = n;
    do { b.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
    for (let i = 0; i < b.length - 1; i++) b[i] |= 0x80;
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
function int(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);   // keep it positive
  return tlv(0x02, b);
}
const utf8 = (s) => tlv(0x0c, Buffer.from(String(s), 'utf8'));
function time(d) {
  // UTCTime before 2050, GeneralizedTime from 2050 (RFC 5280 4.1.2.5).
  const z = (n, w = 2) => String(n).padStart(w, '0');
  const y = d.getUTCFullYear();
  const rest = `${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`;
  return y < 2050 ? tlv(0x17, Buffer.from(`${z(y % 100)}${rest}`, 'latin1')) : tlv(0x18, Buffer.from(`${y}${rest}`, 'latin1'));
}
const ECDSA_SHA256 = () => seq(oid('1.2.840.10045.4.3.2'));
const CN = (name) => seq(set(seq(oid('2.5.4.3'), utf8(name))));

// A self-signed v3 certificate for `keyPair` with common name `name`.
function selfSignedCert(keyPair, name, now = new Date()) {
  const spki = keyPair.publicKey.export({ type: 'spki', format: 'der' });
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  const notAfter = new Date(Date.UTC(2099, 11, 31, 23, 59, 59));
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))),               // [0] version v3
    int(crypto.randomBytes(16)),                     // serial
    ECDSA_SHA256(),
    CN(name),                                        // issuer
    seq(time(notBefore), time(notAfter)),
    CN(name),                                        // subject = issuer
    spki
  );
  const sig = crypto.sign('sha256', tbs, { key: keyPair.privateKey, dsaEncoding: 'der' });
  const der = seq(tbs, ECDSA_SHA256(), tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  return der;
}

const pem = (label, der) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

// ------------------------------------------------------------ device IDs
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// Luhn mod 32 check character (Syncthing's luhnBase32): catches a mistyped
// or transposed character when an ID is typed in by hand.
function luhn32(s) {
  let factor = 1;
  let sum = 0;
  for (const ch of s) {
    let addend = factor * B32.indexOf(ch);
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / 32) + (addend % 32);
    sum += addend;
  }
  return B32[(32 - (sum % 32)) % 32];
}

// SHA-256 of a certificate (DER) -> 56 characters in 8 groups of 7: the 52
// base32 characters in four chunks of 13, each followed by its check character.
function deviceIdFromCert(der) {
  const h = base32(crypto.createHash('sha256').update(der).digest());   // 52 chars
  let withChecks = '';
  for (let i = 0; i < 4; i++) { const chunk = h.slice(i * 13, i * 13 + 13); withChecks += chunk + luhn32(chunk); }
  return withChecks.match(/.{7}/g).join('-');
}

// Accepts IDs typed with or without dashes, any case; '' when malformed or a
// check character does not match (a typo).
function normalizeId(id) {
  const s = String(id || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (s.length !== 56) return '';
  for (let i = 0; i < 4; i++) {
    const chunk = s.slice(i * 14, i * 14 + 13);
    if (luhn32(chunk) !== s[i * 14 + 13]) return '';
  }
  return s.match(/.{7}/g).join('-');
}

// The short form shown in lists: first two groups.
const shortId = (id) => String(id || '').split('-').slice(0, 2).join('-');

// ------------------------------------------------------------ load / create
// The private key is the device's identity: whoever copies it can be this
// device. It is stored ENCRYPTED when `protect` is available (Electron
// safeStorage: DPAPI on Windows, the desktop keyring on Linux), as
// device-key.enc; a plain device-key.pem from an older run is converted and
// removed. Without protection (no keyring), it falls back to a 0600 file and
// says so through `identity.protected`.
//   protect: { available() -> bool, encrypt(Buffer|string) -> Buffer, decrypt(Buffer) -> string }
function loadIdentity(dir, { name, protect } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const encFile = path.join(dir, 'device-key.enc');
  const plainFile = path.join(dir, 'device-key.pem');
  const certFile = path.join(dir, 'device-cert.pem');
  const canProtect = !!(protect && protect.available());
  let keyPem = null;
  let certPem = null;
  try {
    certPem = fs.readFileSync(certFile, 'utf8');
    new crypto.X509Certificate(certPem);
    if (fs.existsSync(encFile)) {
      if (!canProtect) throw new Error('the device key is encrypted, but the OS keyring is not available');
      keyPem = protect.decrypt(fs.readFileSync(encFile));
    } else if (fs.existsSync(plainFile)) {
      keyPem = fs.readFileSync(plainFile, 'utf8');
    }
    // The key must belong to the certificate.
    if (!keyPem || !new crypto.X509Certificate(certPem).checkPrivateKey(crypto.createPrivateKey(keyPem))) keyPem = null;
  } catch (err) {
    if (/keyring is not available/.test(String(err && err.message))) throw err;   // never overwrite an identity we cannot read
    keyPem = null;
  }
  if (!keyPem) {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const der = selfSignedCert(kp, `BE-Aero ${name || os.hostname()}`);
    keyPem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
    certPem = pem('CERTIFICATE', der);
    fs.writeFileSync(certFile, certPem, { mode: 0o644 });
    try { fs.rmSync(encFile, { force: true }); } catch { /* none */ }
  }
  // Store the key the safest way available; convert a plain key once.
  if (canProtect) {
    if (!fs.existsSync(encFile)) fs.writeFileSync(encFile, protect.encrypt(keyPem), { mode: 0o600 });
    if (fs.existsSync(plainFile)) {
      try { fs.writeFileSync(plainFile, crypto.randomBytes(256)); } catch { /* best effort overwrite */ }
      fs.rmSync(plainFile, { force: true });
    }
  } else if (!fs.existsSync(plainFile)) {
    fs.writeFileSync(plainFile, keyPem, { mode: 0o600 });
  }
  const certDer = new crypto.X509Certificate(certPem).raw;
  return { keyPem, certPem, certDer, id: deviceIdFromCert(certDer), name: name || os.hostname(), protected: canProtect };
}

module.exports = { loadIdentity, selfSignedCert, deviceIdFromCert, normalizeId, shortId, base32 };
