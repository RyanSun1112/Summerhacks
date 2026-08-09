// One command for the whole dev loop:
//
//   npm run dev
//
// Starts a cloudflared quick tunnel (when the binary is around), waits for its
// public URL, then runs `node --watch server.js` with PUBLIC_URL set to it.
// Result: QR codes encode the tunnel automatically, however you open the
// dashboard — and because the tunnel lives HERE rather than inside the server,
// its URL survives every --watch restart while you edit code.
//
//   npm run get-tunnel     downloads the official cloudflared binary (once)
//   TUNNEL=0 npm run dev   skip the tunnel on purpose
//
// No tunnel binary → starts anyway and says exactly what to run. Phones can't
// reach localhost, so QRs only work on this machine until the tunnel exists.
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const BIN_LOCAL = path.join(__dirname, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

function findCloudflared() {
  if (fs.existsSync(BIN_LOCAL)) return BIN_LOCAL;
  const w = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8' });
  if (w.status === 0 && w.stdout.trim()) return w.stdout.split(/\r?\n/)[0].trim();
  return null;
}

// --get: fetch the official release binary into the repo root (gitignored).
// Kept explicit rather than automatic — downloading executables should be a
// choice you can see yourself making.
async function getBinary() {
  const asset = process.platform === 'win32' ? 'cloudflared-windows-amd64.exe'
              : process.platform === 'linux' ? 'cloudflared-linux-amd64'
              : null;
  if (!asset) {
    console.log('[dev] on macOS use: brew install cloudflared');
    process.exit(1);
  }
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  console.log(`[dev] downloading ${url}`);
  console.log('[dev] (~60 MB, one time — it lands next to server.js and is gitignored)');
  const res = await fetch(url);
  if (!res.ok) { console.error(`[dev] download failed: HTTP ${res.status}`); process.exit(1); }
  fs.writeFileSync(BIN_LOCAL, Buffer.from(await res.arrayBuffer()));
  if (process.platform !== 'win32') fs.chmodSync(BIN_LOCAL, 0o755);
  console.log(`[dev] saved ${BIN_LOCAL} (${(fs.statSync(BIN_LOCAL).size / 1e6).toFixed(1)} MB)`);
  console.log('[dev] now run: npm run dev');
}

let srv = null, tun = null;
function startServer(publicUrl) {
  const env = { ...process.env };
  if (publicUrl) env.PUBLIC_URL = publicUrl;
  srv = spawn(process.execPath, ['--watch', 'server.js'], { cwd: __dirname, env, stdio: 'inherit' });
  srv.on('exit', code => { if (tun) try { tun.kill(); } catch {} process.exit(code == null ? 0 : code); });
}
function shutdown() {
  if (tun) try { tun.kill(); } catch {}
  if (srv) try { srv.kill(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
  if (process.argv.includes('--get')) return getBinary();

  if (process.env.PUBLIC_URL) {
    console.log(`[dev] PUBLIC_URL is already set (${process.env.PUBLIC_URL}) — not starting a tunnel.`);
    return startServer();
  }
  if (process.env.TUNNEL === '0') return startServer();

  const bin = findCloudflared();
  if (!bin) {
    console.log('[dev] cloudflared not found — starting WITHOUT a tunnel.');
    console.log('[dev] QR codes will only work on this machine. To fix, once:');
    console.log('[dev]   npm run get-tunnel');
    return startServer();
  }

  console.log('[dev] starting cloudflared quick tunnel…');
  tun = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`]);
  let buf = '', started = false;
  // keep the tail of cloudflared's own output, so a failure names its cause
  // (rate-limited, DNS blocked, no network) instead of just "no URL"
  const tail = [];
  const keepTail = d => String(d).split(/\r?\n/).forEach(l => {
    if (l.trim()) { tail.push(l.trim().slice(0, 160)); if (tail.length > 6) tail.shift(); }
  });
  const begin = url => {
    if (started) return;
    started = true;
    if (url) {
      console.log(`\n[dev] tunnel up:  ${url}`);
      console.log(`[dev] dashboard:  ${url}/dashboard.html`);
      console.log(`[dev] QR poster:  ${url}/qr`);
      console.log('[dev] (the URL is random and changes when dev.js restarts — reprint posters after)\n');
    }
    startServer(url);
  };
  const onData = d => {
    buf += d; keepTail(d);
    const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) begin(m[0]);
  };
  tun.stdout.on('data', onData);
  tun.stderr.on('data', onData);
  const explain = () => { if (tail.length) { console.log('[dev] cloudflared said:'); tail.forEach(l => console.log('        ' + l)); } };
  tun.on('exit', code => {
    if (!started) {
      console.log(`[dev] tunnel died before giving a URL (exit ${code}) — starting without it.`);
      explain();
      begin(null);
    } else if (srv) {
      console.log('[dev] tunnel exited — QR codes now point at a dead host. Restart dev.js.');
      explain();
    }
  });
  // no URL after 25s (offline, blocked, rate-limited) → run anyway
  setTimeout(() => {
    if (!started) {
      console.log('[dev] no tunnel URL after 25s — starting without it. QRs stay localhost-only.');
      explain();
      begin(null);
    }
  }, 25000);
})();
