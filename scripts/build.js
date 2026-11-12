// Build the BE-Aero Relay Server release files into dist/:
//   be-aero-relay-<v>-windows-x64.zip   be-aero-relay.exe + install-windows.ps1
//   be-aero-relay-<v>-linux-x64.tar.gz  be-aero-relay (binary) + install-linux.sh
//   be-aero-relay-<v>-node.tar.gz       the plain sources, for Node.js / Docker
//   install.sh                          the one-line Linux installer
//
// The executables are Node.js single executable applications: the relay,
// bundled into one script, injected into a copy of the Node runtime - so
// they run with nothing else installed. Both use the same Node version as
// this build (the Linux runtime is fetched from nodejs.org and checked
// against its published SHA-256).
//
//   node scripts/build.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const cache = path.join(root, '.cache');
const version = require(path.join(root, 'package.json')).version;
const NODE = process.version;                          // e.g. v24.14.1
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const MODULES = ['relay.js', 'store.js', 'drive.js', 'lib/mesh.js', 'lib/identity.js'];
const DOCS = ['README.md', 'LICENSE'];

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', ...opts });

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); resolve(get(res.headers.location)); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`${url}: HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// ---- 1. one script: every module wrapped, required by its relative path
function bundle() {
  const parts = [];
  for (const rel of MODULES) {
    let src = fs.readFileSync(path.join(root, rel), 'utf8').replace(/^#!.*\n/, '');
    if (rel === 'relay.js') src = src.replace('if (require.main === module) {', 'if (true) {   // the executable runs the relay');
    parts.push(`${JSON.stringify(rel)}: function (module, exports, require) {\n${src}\n}`);
  }
  return `// BE-Aero Relay Server ${version} (bundled)
'use strict';
const __builtin = require;
const __defs = {
${parts.join(',\n')}
};
const __cache = {};
function __load(id) {
  if (__cache[id]) return __cache[id].exports;
  const module = { exports: {} };
  __cache[id] = module;
  const dir = id.includes('/') ? id.slice(0, id.lastIndexOf('/') + 1) : '';
  const req = (name) => {
    if (!name.startsWith('.')) return __builtin(name);
    const parts = (dir + name.replace(/^\\.\\//, '')).split('/');
    const out = [];
    for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.') out.push(p); }
    let target = out.join('/');
    if (!target.endsWith('.js')) target += '.js';
    if (!__defs[target]) throw new Error('bundle: missing module ' + target);
    return __load(target);
  };
  __defs[id](module, module.exports, req);
  return module.exports;
}
__load('relay.js');
`;
}

async function linuxNode() {
  const name = `node-${NODE}-linux-x64`;
  const bin = path.join(cache, name, 'bin', 'node');
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(cache, { recursive: true });
  const base = `https://nodejs.org/dist/${NODE}`;
  console.log(`downloading ${name}.tar.xz from nodejs.org...`);
  const [tar, sums] = await Promise.all([get(`${base}/${name}.tar.xz`), get(`${base}/SHASUMS256.txt`)]);
  const want = (sums.toString().split('\n').find((l) => l.endsWith(`  ${name}.tar.xz`)) || '').split(' ')[0];
  const got = crypto.createHash('sha256').update(tar).digest('hex');
  if (!want || want !== got) throw new Error(`checksum mismatch for ${name}.tar.xz`);
  const file = path.join(cache, `${name}.tar.xz`);
  fs.writeFileSync(file, tar);
  sh('tar', ['-xJf', `${name}.tar.xz`, `${name}/bin/node`], { cwd: cache });
  return bin;
}

// A .tar.gz written here, so file modes are exact on any build machine
// (Windows' tar cannot mark the Linux executable as executable).
// files: [{ name, data: Buffer, mode }] ; directories are implied by names.
function tarGz(files) {
  const zlib = require('zlib');
  const blocks = [];
  const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  const header = (name, size, mode, type) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write(octal(mode, 8), 100); h.write(octal(0, 8), 108); h.write(octal(0, 8), 116);
    h.write(octal(size, 12), 124); h.write(octal(Math.floor(Date.now() / 1000), 12), 136);
    h.write('        ', 148); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
    h.write('root', 265); h.write('root', 297);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
  };
  const dirs = new Set();
  for (const f of files) {
    const parts = f.name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = `${parts.slice(0, i).join('/')}/`;
      if (!dirs.has(d)) { dirs.add(d); blocks.push(header(d, 0, 0o755, '5')); }
    }
    blocks.push(header(f.name, f.data.length, f.mode, '0'), f.data);
    if (f.data.length % 512) blocks.push(Buffer.alloc(512 - (f.data.length % 512)));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
}

function inject(exe) {
  sh('npx', ['--yes', 'postject@1.0.0-alpha.6', exe, 'NODE_SEA_BLOB', path.join(dist, 'sea-prep.blob'), '--sentinel-fuse', FUSE, '--overwrite']);
}

async function main() {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });

  // the bundle must run before it is packed
  const bundled = path.join(dist, 'be-aero-relay.bundle.js');
  fs.writeFileSync(bundled, bundle());
  execFileSync(process.execPath, [bundled, 'help'], { stdio: 'pipe' });

  fs.writeFileSync(path.join(dist, 'sea-config.json'), JSON.stringify({ main: bundled, output: path.join(dist, 'sea-prep.blob'), disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }));
  execFileSync(process.execPath, ['--experimental-sea-config', path.join(dist, 'sea-config.json')], { stdio: 'inherit' });

  // Windows
  const win = path.join(dist, 'windows', 'be-aero-relay.exe');
  fs.mkdirSync(path.dirname(win), { recursive: true });
  if (process.platform !== 'win32') throw new Error('build on Windows (it uses this machine\'s node.exe for the Windows executable)');
  fs.copyFileSync(process.execPath, win);
  inject(win);
  const help = execFileSync(win, ['help'], { encoding: 'utf8' });
  if (!/usage: node relay\.js|usage:/.test(help)) throw new Error('the Windows executable did not run');

  // Linux
  const lin = path.join(dist, 'linux', 'be-aero-relay');
  fs.mkdirSync(path.dirname(lin), { recursive: true });
  fs.copyFileSync(await linuxNode(), lin);
  inject(lin);

  for (const d of DOCS) { fs.copyFileSync(path.join(root, d), path.join(dist, 'windows', d)); fs.copyFileSync(path.join(root, d), path.join(dist, 'linux', d)); }
  fs.copyFileSync(path.join(root, 'install-windows.ps1'), path.join(dist, 'windows', 'install-windows.ps1'));
  fs.writeFileSync(path.join(dist, 'linux', 'install-linux.sh'), fs.readFileSync(path.join(root, 'install-linux.sh'), 'utf8').replace(/\r\n/g, '\n'), { mode: 0o755 });

  const winZip = `be-aero-relay-${version}-windows-x64.zip`;
  const linTar = `be-aero-relay-${version}-linux-x64.tar.gz`;
  const srcTar = `be-aero-relay-${version}-node.tar.gz`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path 'windows\\*' -DestinationPath '${winZip}' -Force`], { cwd: dist, stdio: 'inherit' });
  const L = (f) => fs.readFileSync(path.join(dist, 'linux', f));
  fs.writeFileSync(path.join(dist, linTar), tarGz([
    { name: 'be-aero-relay', data: L('be-aero-relay'), mode: 0o755 },
    { name: 'install-linux.sh', data: L('install-linux.sh'), mode: 0o755 },
    { name: 'README.md', data: L('README.md'), mode: 0o644 },
    { name: 'LICENSE', data: L('LICENSE'), mode: 0o644 }
  ]));
  const top = `be-aero-relay-${version}`;
  fs.writeFileSync(path.join(dist, srcTar), tarGz([...MODULES, ...DOCS, 'package.json', 'Dockerfile', 'install-linux.sh', 'install-windows.ps1'].map((f) => ({
    name: `${top}/${f}`, data: Buffer.from(fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, f.endsWith('.ps1') ? '\r\n' : '\n')), mode: f.endsWith('.sh') ? 0o755 : 0o644
  }))));
  fs.copyFileSync(path.join(root, 'install.sh'), path.join(dist, 'install.sh'));
  // stable names, for links that always point at the newest release
  fs.copyFileSync(path.join(dist, winZip), path.join(dist, 'be-aero-relay-windows-x64.zip'));
  fs.copyFileSync(path.join(dist, linTar), path.join(dist, 'be-aero-relay-linux-x64.tar.gz'));
  const sums = [winZip, linTar, srcTar, 'install.sh'].map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, f))).digest('hex')}  ${f}`).join('\n');
  fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), `${sums}\n`);
  console.log(`\nbuilt dist/${winZip}, dist/${linTar}, dist/${srcTar}, dist/install.sh (Node ${NODE})`);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
