// The relay's control panel in the terminal: be-aero-relay panel
//
//   1 Health    uptime, CPU, memory, disk, storage, traffic, uploads (live)
//   2 Devices   paired devices: online, last seen, waiting; u = unpair
//   3 Settings  name, port, storage cap, message lifetime, LAN announcements
//   4 Log       the relay's recent log
//
//   p pair (shows a code)   r restart the relay   q quit
// It talks to the running relay over its admin port (this machine only,
// with the token in the relay's data folder). No dependencies: ANSI codes
// and raw keyboard input, so it works in any modern terminal.
const ESC = '\x1b[';
const TABS = ['Health', 'Devices', 'Settings', 'Log'];
const c = { dim: (s) => `${ESC}2m${s}${ESC}0m`, bold: (s) => `${ESC}1m${s}${ESC}0m`, green: (s) => `${ESC}32m${s}${ESC}0m`, red: (s) => `${ESC}31m${s}${ESC}0m`, yellow: (s) => `${ESC}33m${s}${ESC}0m`, cyan: (s) => `${ESC}36m${s}${ESC}0m`, inv: (s) => `${ESC}7m${s}${ESC}0m` };
const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const mb = (n) => (n == null ? '?' : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`);
const rate = (bytesPerMin) => { const b = (bytesPerMin || 0) / 60; return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB/s` : b >= 1024 ? `${(b / 1024).toFixed(0)} KB/s` : `${Math.round(b)} B/s`; };
const dur = (s) => { s = Math.max(0, Math.round(s || 0)); const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`; };
const ago = (t) => (t ? dur((Date.now() - t) / 1000) + ' ago' : 'never');
function bar(frac, width = 24) {
  const f = Math.max(0, Math.min(1, frac || 0));
  const n = Math.round(f * width);
  const s = '█'.repeat(n) + '░'.repeat(width - n);
  return f > 0.9 ? c.red(s) : f > 0.7 ? c.yellow(s) : c.green(s);
}

async function run({ admin, fields, self }) {
  const out = process.stdout;
  const inp = process.stdin;
  if (!inp.isTTY) throw new Error('the panel needs an interactive terminal');
  const st = { tab: 0, sel: 0, health: null, config: null, effective: null, log: [], error: '', message: '', input: null, confirm: null, pairing: null };

  const fieldKeys = Object.keys(fields);
  async function refresh() {
    try {
      st.health = await admin('GET', '/health');
      if (st.tab === 2 || !st.config) { const r = await admin('GET', '/config'); st.config = r.config; st.effective = r.effective; }
      if (st.tab === 3) st.log = (await admin('GET', '/log')).lines;
      st.error = '';
    } catch (err) { st.error = err.message; }
    draw();
  }

  function lines() {
    const L = [];
    const h = st.health;
    const W = Math.max(60, out.columns || 80);
    L.push(c.bold(` BE-Aero Relay Server ${h ? `${h.version}  ·  ${h.name}` : ''}`));
    L.push(` ${TABS.map((t, i) => (i === st.tab ? c.inv(` ${i + 1} ${t} `) : c.dim(` ${i + 1} ${t} `))).join(' ')}`);
    L.push(c.dim('─'.repeat(W - 1)));
    if (st.error) { L.push(c.red(` ${st.error}`)); return L; }
    if (!h) { L.push(' Connecting…'); return L; }
    if (st.tab === 0) {
      const used = (h.mail.bytes || 0) + (h.drive.bytes || 0);
      L.push(` ${c.bold('Status')}       ${c.green('● running')}  for ${dur(h.uptimeSec)}   (machine up ${dur(h.hostUptimeSec)})`);
      L.push(` ${c.bold('Address')}      ${h.addresses.join(', ') || '?'}  port ${h.port}`);
      L.push(` ${c.bold('Relay ID')}     ${h.id}`);
      L.push('');
      L.push(` ${c.bold('CPU')}          ${String(h.cpuPct).padStart(5)} %   load ${h.load.map((x) => x.toFixed(2)).join(' ')}`);
      L.push(` ${c.bold('Memory')}       ${mb(h.memory.rss).padStart(8)} used by the relay   ${bar(1 - h.memory.hostFree / h.memory.hostTotal)} ${mb(h.memory.hostTotal - h.memory.hostFree)} of ${mb(h.memory.hostTotal)} on this machine`);
      if (h.disk) L.push(` ${c.bold('Disk')}         ${bar(1 - h.disk.free / h.disk.total)} ${mb(h.disk.free)} free of ${mb(h.disk.total)}`);
      L.push(` ${c.bold('Storage')}      ${bar(used / h.cap)} ${mb(used)} of ${mb(h.cap)}   (${h.drive.objects} files, ${h.mail.items} messages waiting)`);
      L.push(` ${c.bold('Uploads')}      ${h.drive.uploads} in progress`);
      L.push(` ${c.bold('Traffic')}      in ${rate(h.traffic.lastMinute.in)}  out ${rate(h.traffic.lastMinute.out)}   (last minute)   total in ${mb(h.traffic.total.in)}, out ${mb(h.traffic.total.out)}`);
      L.push('');
      const on = h.devices.filter((d) => d.online).length;
      L.push(` ${c.bold('Devices')}      ${on} of ${h.devices.length} online`);
      if (h.pairing) L.push(` ${c.yellow(`Pairing open: code ${h.pairing.code} (closes in ${dur((h.pairing.expires - Date.now()) / 1000)})`)}`);
    } else if (st.tab === 1) {
      if (!h.devices.length) L.push(` No devices paired yet. Press ${c.bold('p')} to open pairing.`);
      h.devices.forEach((d, i) => {
        const row = ` ${d.online ? c.green('●') : c.dim('○')} ${d.name.padEnd(26).slice(0, 26)} ${d.id.slice(0, 15)}…  ${(d.online ? 'online' : ago(d.lastSeen)).padEnd(14)} waiting ${String(d.waiting).padStart(3)}  ${c.dim(d.address || '')}`;
        L.push(i === st.sel ? c.inv(strip(row)) : row);
      });
      L.push('');
      L.push(c.dim(' ↑↓ choose   u unpair the chosen device   p pair a new device'));
    } else if (st.tab === 2) {
      const e = st.effective || {};
      fieldKeys.forEach((k, i) => {
        const v = e[k] === undefined ? '' : String(e[k]);
        const env = (e.fromEnv || []).includes(k) ? c.yellow(' (set by the environment)') : '';
        const row = ` ${fields[k].label.padEnd(36)} ${v}${env}${fields[k].restart ? c.dim('  · restart to apply') : ''}`;
        L.push(i === st.sel ? c.inv(strip(row)) : row);
      });
      L.push('');
      L.push(c.dim(' ↑↓ choose   Enter change   r restart the relay to apply'));
      L.push(c.dim(` Saved in the relay's data folder (config.json); environment variables win over it.`));
    } else if (st.tab === 3) {
      const H = Math.max(5, (out.rows || 24) - 7);
      for (const line of st.log.slice(-H)) L.push(` ${line.slice(0, W - 2)}`);
    }
    return L;
  }

  function draw() {
    const L = lines();
    const H = out.rows || 24;
    while (L.length < H - 3) L.push('');
    const foot = st.input ? c.cyan(` ${st.input.label}: ${st.input.value}█   (Enter to save, Esc to cancel)`)
      : st.confirm ? c.yellow(` ${st.confirm.text}  (y / n)`)
      : st.message ? c.cyan(` ${st.message}`) : c.dim(' ←→ or 1-4 switch   p pair   r restart   q quit');
    out.write(`${ESC}H${ESC}2J${L.slice(0, H - 2).join('\n')}\n${foot}`);
  }

  const done = new Promise((resolve) => {
    const quit = () => {
      clearInterval(timer);
      inp.setRawMode(false);
      inp.pause();
      out.write(`${ESC}?25h${ESC}?1049l`);
      resolve();
    };
    out.write(`${ESC}?1049h${ESC}?25l`);
    inp.setRawMode(true);
    inp.resume();
    inp.setEncoding('utf8');
    out.on('resize', draw);
    const timer = setInterval(refresh, 2000);
    refresh();

    inp.on('data', async (k) => {
      // a value being typed (settings)
      if (st.input) {
        if (k === '\r' || k === '\n') {
          const { key, value } = st.input;
          st.input = null;
          try {
            const r = await admin('PUT', '/config', { [key]: value });
            st.config = r.config; st.effective = r.effective;
            st.message = r.restartNeeded && r.restartNeeded.length ? `Saved. Press r to restart the relay so it takes effect.` : 'Saved.';
          } catch (err) { st.message = `Not saved: ${err.message}`; }
        } else if (k === '\x1b') { st.input = null; st.message = ''; }
        else if (k === '\x7f' || k === '\b') st.input.value = st.input.value.slice(0, -1);
        else if (k >= ' ' && k.length === 1) st.input.value += k;
        draw();
        return;
      }
      if (st.confirm) {
        const fn = st.confirm.yes;
        st.confirm = null;
        if (/^y$/i.test(k)) { try { st.message = await fn(); } catch (err) { st.message = err.message; } } else st.message = '';
        draw();
        return;
      }
      st.message = '';
      if (k === 'q' || k === '\x03') { quit(); return; }
      if (k === '\x1b[C' || k === '\t') { st.tab = (st.tab + 1) % TABS.length; st.sel = 0; }
      else if (k === '\x1b[D') { st.tab = (st.tab + TABS.length - 1) % TABS.length; st.sel = 0; }
      else if (/^[1-4]$/.test(k)) { st.tab = Number(k) - 1; st.sel = 0; }
      else if (k === '\x1b[A') st.sel = Math.max(0, st.sel - 1);
      else if (k === '\x1b[B') {
        const max = st.tab === 1 ? (st.health ? st.health.devices.length : 0) : st.tab === 2 ? fieldKeys.length : 0;
        st.sel = Math.min(Math.max(0, max - 1), st.sel + 1);
      } else if ((k === '\r' || k === '\n') && st.tab === 2) {
        const key = fieldKeys[st.sel];
        st.input = { key, label: fields[key].label, value: String((st.effective || {})[key] ?? '') };
      } else if (k === 'u' && st.tab === 1 && st.health && st.health.devices[st.sel]) {
        const d = st.health.devices[st.sel];
        st.confirm = { text: `Unpair ${d.name}? It will need pairing again to use this relay.`, yes: async () => { await admin('POST', '/unpair', { id: d.id }); return `${d.name} unpaired.`; } };
      } else if (k === 'p') {
        try { const r = await admin('POST', '/pair'); st.message = `Pairing code ${r.code} - on the device: Settings > Devices > Pair by address, ${r.addresses[0] || 'this address'}:${r.port}`; } catch (err) { st.message = err.message; }
      } else if (k === 'r') {
        st.confirm = { text: 'Restart the relay now? Devices reconnect within a minute.', yes: async () => { await admin('POST', '/restart'); return 'Restarting…'; } };
      }
      await refresh();
    });
  });
  await done;
  if (self) process.stdout.write(`Closed the panel. The relay keeps running (${self} status for a summary).\n`);
}

module.exports = { run };
