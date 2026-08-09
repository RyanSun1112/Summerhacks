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
  srv.on('exit', code => {
    if (restarting) { restarting = false; return; } // deliberate — a new server is coming
    if (tun) try { tun.kill(); } catch {}
    process.exit(code == null ? 0 : code);
  });
}
// The server's PUBLIC_URL is baked in at spawn, so a changed tunnel URL means
// a server restart — the only way QR codes stay truthful.
let restarting = false;
function restartServer(publicUrl) {
  if (srv) { restarting = true; try { srv.kill(); } catch {} }
  setTimeout(() => startServer(publicUrl), 1200);   // let the port free up
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

  // Quick tunnels are not stable: cloudflared can lose its edge connection
  // and re-register under a NEW random hostname — the process lives on while
  // the old name goes NXDOMAIN and every open tab and printed QR dies. So:
  // watch for new URLs forever, restart the server on a change (PUBLIC_URL
  // is baked in at spawn), and respawn the tunnel if it exits.
  let started = false, currentUrl = null, tunRespawns = 0;
  const tail = [];
  const keepTail = d => String(d).split(/\r?\n/).forEach(l => {
    if (l.trim()) { tail.push(l.trim().slice(0, 160)); if (tail.length > 6) tail.shift(); }
  });
  const explain = () => { if (tail.length) { console.log('[dev] cloudflared said:'); tail.forEach(l => console.log('        ' + l)); } };
  const banner = url => {
    console.log(`\n[dev] tunnel up:  ${url}`);
    console.log(`[dev] dashboard:  ${url}/dashboard.html`);
    console.log(`[dev] QR poster:  ${url}/qr`);
    console.log('[dev] (the URL is random — it changes on restart AND on tunnel reconnect; reprint posters after)\n');
  };
  const begin = url => {
    if (started) return;
    started = true;
    currentUrl = url;
    if (url) banner(url);
    startServer(url);
  };

  function startTunnel() {
    console.log('[dev] starting cloudflared quick tunnel…');
    // --protocol http2 is load-bearing: cloudflared defaults to QUIC (UDP),
    // and networks that blackhole UDP produce tunnels that REGISTER but never
    // serve — hostname resolves, page shows Cloudflare 1033/530, everything
    // local looks healthy. One full day was lost to this. TCP always works.
    tun = spawn(bin, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://localhost:${PORT}`]);
    let buf = '';
    const onData = d => {
      buf = (buf + d).slice(-4096); keepTail(d);
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
      if (!m) return;
      const url = m[m.length - 1];
      if (!started) return begin(url);
      if (url !== currentUrl) {
        currentUrl = url;
        console.log('\n[dev] ⚠ TUNNEL URL CHANGED — cloudflared reconnected and was issued a new hostname.');
        console.log('[dev] Old tabs and printed QR codes are DEAD. The new address:');
        banner(url);
        console.log('[dev] restarting the server so QR codes encode the new URL…');
        restartServer(url);
      }
    };
    tun.stdout.on('data', onData);
    tun.stderr.on('data', onData);
    tun.on('exit', code => {
      if (!started) {
        console.log(`[dev] tunnel died before giving a URL (exit ${code}) — starting without it.`);
        explain();
        begin(null);
        return;
      }
      if (!srv) return;
      if (tunRespawns++ < 8) {
        console.log(`[dev] tunnel exited (code ${code}) — starting a fresh one…`);
        explain();
        setTimeout(startTunnel, 2500);
      } else {
        console.log('[dev] the tunnel keeps dying — giving up on it. QR codes are stale until dev.js restarts.');
        explain();
      }
    });
  }
  startTunnel();

  // Zombie watch. A connector can lose the edge and retry forever without
  // exiting or minting a new URL — pages serve 1033/530 while everything
  // local looks healthy. So probe our own public URL from here: sustained
  // failure kills the tunnel process, which flows into the normal respawn
  // path and a fresh hostname. Patience rules matter — a new tunnel can take
  // a couple of minutes to become reachable, and a flapping edge must not
  // cause endless hostname churn.
  let wdUrl = null, wdFails = 0, wdHealthy = false;
  setInterval(async () => {
    if (!currentUrl || !tun) return;
    if (wdUrl !== currentUrl) { wdUrl = currentUrl; wdFails = 0; wdHealthy = false; }
    let ok = false;
    try { ok = (await fetch(currentUrl + '/api/health', { signal: AbortSignal.timeout(15000) })).ok; } catch {}
    if (ok) {
      if (!wdHealthy) console.log('[dev] tunnel confirmed reachable from the public internet ✓');
      wdHealthy = true; wdFails = 0; tunRespawns = 0;
      return;
    }
    wdFails++;
    const limit = wdHealthy ? 4 : 7;               // ~3 min once healthy, ~5 min from cold
    if (wdFails >= limit) {
      console.log(`[dev] ⚠ tunnel unreachable from the internet (${wdFails} consecutive checks${wdHealthy ? '' : ' since start'}) — recycling it for a fresh hostname…`);
      try { tun.kill(); } catch {}
      wdFails = 0; wdHealthy = false;
    }
  }, 45000);

  // no URL after 25s (offline, blocked, rate-limited) → run anyway
  setTimeout(() => {
    if (!started) {
      console.log('[dev] no tunnel URL after 25s — starting without it. QRs stay localhost-only.');
      explain();
      begin(null);
    }
  }, 25000);
})();
