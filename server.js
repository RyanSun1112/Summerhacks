const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const FAKE = process.env.FAKE !== '0';          // fake crowd on by default
const FAKE_N = parseInt(process.env.FAKE_N || '58', 10);

const venue = JSON.parse(fs.readFileSync(path.join(__dirname, 'venue.json'), 'utf8'));
const zoneById = Object.fromEntries(venue.zones.map(z => [z.id, z]));

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.redirect('/dashboard.html'));
app.get('/venue', (_, res) => res.json(venue));
// curl this if the dashboard looks wrong — it's the exact payload being broadcast
app.get('/state.json', (_, res) => res.json(publicState()));

// The single event-wide poster. No zone in the URL — GPS resolves it, and
// anyone whose GPS never gets a usable fix stays in the check-in zone.
// Registered before /qr/:zone.svg because that pattern would swallow it.
app.get('/qr/event.svg', async (req, res) => {
  const origin = process.env.PUBLIC_URL || `http://${req.headers.host}`;
  const svg = await QRCode.toString(`${origin}/join.html`, { type: 'svg', margin: 1, color: { dark: '#0A0C14', light: '#FFFFFF' } });
  res.type('svg').send(svg);
});

app.get('/qr/:zone.svg', async (req, res) => {
  const origin = process.env.PUBLIC_URL || `http://${req.headers.host}`;
  const url = `${origin}/join.html?zone=${encodeURIComponent(req.params.zone)}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#0A0C14', light: '#FFFFFF' } });
  res.type('svg').send(svg);
});

// --------------------------------------------------------------- helpers
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp  = (a, b, t) => a + (b - a) * clamp(t, 0, 1);
const mean  = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const stdev = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };
const pick  = a => a[Math.floor(Math.random() * a.length)];

function anchorInZone(zoneId) {
  const z = zoneById[zoneId] || venue.zones[0];
  return { x: z.x + 0.14 * z.w + Math.random() * 0.72 * z.w,
           y: z.y + 0.14 * z.h + Math.random() * 0.72 * z.h };
}

// ------------------------------------------------------------------- geo
// GPS -> normalized map coords. venue.geo.origin is map (0,0); bearing is the
// compass heading of the map's +x axis, so the site can sit at any angle to
// north. Everything here fails closed: a bad fix leaves the person where they
// were rather than teleporting them, because a dot jumping across the map
// during the demo reads as broken to anyone watching.
const GEO = venue.geo || null;
const M_PER_DEG = 111320;

const GPS_MAX_ACCURACY = 25;   // metres — ignore fixes vaguer than this
const NEAREST_MAX_M    = 18;   // don't claim a zone from further away than this
const ZONE_SWITCH_VOTES = 3;   // consecutive agreeing fixes before switching zone

let gpsRejects = 0, gpsWarned = false;

function geoToNorm(lat, lon) {
  if (!GEO) return null;
  const b = GEO.bearing * Math.PI / 180;
  const dNorth = (lat - GEO.origin.lat) * M_PER_DEG;
  const dEast  = (lon - GEO.origin.lon) * M_PER_DEG * Math.cos(GEO.origin.lat * Math.PI / 180);
  // project onto the map axes: +x lies at `bearing`, +y is 90deg clockwise of it
  return { x: (dEast * Math.sin(b) + dNorth * Math.cos(b)) / GEO.spanX,
           y: (dEast * Math.cos(b) - dNorth * Math.sin(b)) / GEO.spanY };
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Distances are measured in metres, not normalized units — the map is 2.9x
// wider than it is tall, so normalized distance would badly skew which zone
// counts as "nearest".
function zoneAt(x, y) {
  for (const z of venue.zones) {
    if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) return { id: z.id, inside: true, d: 0 };
  }
  let best = null;
  for (const z of venue.zones) {
    const dx = (x - (z.x + z.w / 2)) * GEO.spanX, dy = (y - (z.y + z.h / 2)) * GEO.spanY;
    const d = Math.hypot(dx, dy);
    if (!best || d < best.d) best = { id: z.id, inside: false, d };
  }
  return best;
}

// ----------------------------------------------------------------- state
const attendees = new Map();
const TIMEOUT_MS = 45000;

// every key computeCrowd sets, so /state.json has a stable shape from t=0
// rather than growing fields two seconds after boot
let crowd = { energy: 0, sync: 0, arousal: 0, density: 0, trend: 0, count: 0, peak: 0, dwell: 0,
              steps: 0, distance: 0, located: 0 };
let history = [];
// Host owns the deck. Palette is derived in the host's browser from the live
// audio spectrum and mirrored to every phone.
let music = { title: '—', artist: '', playing: false, position: 0, duration: 0, bpm: null };
let frame  = { bass: 0, mid: 0, treble: 0, level: 0, centroid: 0.35, beat: 0, hue: 0, spectrum: [] };

const alive = p => Date.now() - p.lastSeen < TIMEOUT_MS;

function computeCrowd() {
  const list = [...attendees.values()].filter(alive);
  const energies = list.map(p => p.energy);
  const energy = mean(energies);
  const sync = list.length < 3 ? 0 : clamp(1 - stdev(energies) / (mean(energies) + 0.06), 0, 1);

  // heart rate as a delta from each person's OWN baseline — raw bpm averaged
  // across a crowd is noise, since resting rates run 50 to 90.
  const withHr = list.filter(p => p.hr && p.hrBaseline);
  const arousal = withHr.length
    ? clamp(mean(withHr.map(p => (p.hr - p.hrBaseline) / p.hrBaseline)) / 0.55, 0, 1)
    : energy * 0.8;

  const inEvent = list.filter(p => (zoneById[p.zone] || {}).kind === 'event').length;
  const density = list.length ? inEvent / list.length : 0;
  const old = history[Math.max(0, history.length - 12)];
  const trend = old ? energy - old.energy : 0;
  const dwell = list.length ? mean(list.map(p => (Date.now() - p.joinedAt) / 60000)) : 0;

  const steps = list.reduce((s, p) => s + (p.steps || 0), 0);
  const distance = list.reduce((s, p) => s + (p.distance || 0), 0);
  const located = list.filter(p => p.gps && !p.gpsNote).length;

  crowd = { energy, sync, arousal, density, trend, count: list.length,
            peak: Math.max(crowd.peak, list.length), dwell, steps, distance, located };
  history.push({ t: Date.now(), energy, arousal, count: list.length });
  if (history.length > 240) history.shift();
}

function zoneCounts() {
  const out = {};
  venue.zones.forEach(z => (out[z.id] = { n: 0, energy: 0 }));
  for (const p of attendees.values()) {
    if (!alive(p) || !out[p.zone]) continue;
    out[p.zone].n++;
    out[p.zone].energy += p.energy;
  }
  for (const k in out) if (out[k].n) out[k].energy /= out[k].n;
  return out;
}

function publicState() {
  const people = [...attendees.values()].filter(alive).map(p => ({
    id: p.id, name: p.name, zone: p.zone, anchor: p.anchor, energy: p.energy,
    hr: p.hr ? Math.round(p.hr) : null, hrBaseline: p.hrBaseline ? Math.round(p.hrBaseline) : null,
    joinedAt: p.joinedAt, seed: p.seed, team: p.team,
    gps: p.gps || null, gpsNote: p.gpsNote || null,
    steps: p.steps || 0, distance: Math.round(p.distance || 0)
  }));
  return { people, crowd, music, zones: zoneCounts(), history: history.slice(-120) };
}

// --------------------------------------------------------------- sockets
io.on('connection', socket => {
  socket.emit('venue', venue);
  socket.emit('state', publicState());

  socket.on('join', ({ id, name, zone }, ack) => {
    const pid = id || socket.id;
    const z = zoneById[zone] ? zone : 'entrance1';
    const existing = attendees.get(pid);
    const person = existing || {
      id: pid, name: (name || 'Guest').slice(0, 24), joinedAt: Date.now(),
      energy: 0, hr: null, hrBaseline: null, hrSamples: [], seed: Math.random(), team: 'Guest',
      gps: null, gpsNote: null, zoneCand: null, zoneVotes: 0, steps: 0, distance: 0
    };
    if (name) person.name = name.slice(0, 24);
    if (!existing || person.zone !== z) person.anchor = anchorInZone(z);
    person.zone = z; person.lastSeen = Date.now();
    attendees.set(pid, person);
    socket.data.pid = pid;
    if (ack) ack({ ok: true, id: pid, zone: z, zoneLabel: zoneById[z].label });
  });

  socket.on('motion', ({ energy }) => {
    const p = attendees.get(socket.data.pid);
    if (!p || typeof energy !== 'number') return;
    p.energy = p.energy * 0.6 + clamp(energy, 0, 1) * 0.4;   // smooth out single shakes
    p.lastSeen = Date.now();
  });

  // One fix per second, already throttled on the phone. Zone changes need
  // ZONE_SWITCH_VOTES agreeing fixes in a row, so a single stray reading
  // between two adjacent containers can't yank someone across the map.
  socket.on('geo', ({ lat, lon, accuracy }) => {
    const p = attendees.get(socket.data.pid);
    if (!p || typeof lat !== 'number' || typeof lon !== 'number') return;
    p.lastSeen = Date.now();
    p.gps = { lat, lon, accuracy: typeof accuracy === 'number' ? accuracy : null };

    if (p.gps.accuracy != null && p.gps.accuracy > GPS_MAX_ACCURACY) { p.gpsNote = 'weak'; return; }
    const n = geoToNorm(lat, lon);
    if (!n) return;

    if (!pointInPolygon(n.x, n.y, venue.outline)) {
      p.gpsNote = 'offsite';
      gpsRejects++;
      if (!gpsWarned && gpsRejects > 20) {
        gpsWarned = true;
        console.warn('[geo] GPS fixes keep landing outside the venue outline. venue.geo is almost' +
                     ' certainly uncalibrated — open /calibrate.html on site. Zone assignment is' +
                     ' falling back to the zone people checked in with.');
      }
      return;
    }
    p.gpsNote = null;

    // real position drives the dot, eased so GPS jitter doesn't make it twitch
    p.anchor = { x: lerp(p.anchor.x, n.x, 0.35), y: lerp(p.anchor.y, n.y, 0.35) };

    const hit = zoneAt(n.x, n.y);
    if (!hit || hit.id === p.zone || hit.d > NEAREST_MAX_M) { p.zoneCand = null; p.zoneVotes = 0; return; }
    if (p.zoneCand === hit.id) p.zoneVotes++;
    else { p.zoneCand = hit.id; p.zoneVotes = 1; }
    if (p.zoneVotes >= ZONE_SWITCH_VOTES) { p.zone = hit.id; p.zoneCand = null; p.zoneVotes = 0; }
  });

  // Counters are cumulative on the phone, so take the max and never go
  // backwards on a reconnect.
  socket.on('steps', ({ steps, distance }) => {
    const p = attendees.get(socket.data.pid);
    if (!p || typeof steps !== 'number') return;
    p.steps = Math.max(p.steps || 0, Math.round(steps));
    if (typeof distance === 'number') p.distance = Math.max(p.distance || 0, distance);
    p.lastSeen = Date.now();
  });

  socket.on('hr', ({ bpm }) => {
    const p = attendees.get(socket.data.pid);
    if (!p || !bpm || bpm < 30 || bpm > 220) return;
    p.hr = bpm; p.lastSeen = Date.now();
    if (!p.hrBaseline) {
      p.hrSamples.push(bpm);
      if (Date.now() - p.joinedAt > 45000 && p.hrSamples.length > 8) {
        const s = [...p.hrSamples].sort((a, b) => a - b);
        p.hrBaseline = s[Math.floor(s.length / 2)];          // median resists outliers
      }
    }
  });

  // host deck -> everyone
  socket.on('music:state', m => { music = { ...music, ...m }; io.emit('music:state', music); });
  socket.on('music:frame', f => { frame = f; socket.broadcast.emit('music:frame', f); });

  socket.on('disconnect', () => {
    const p = attendees.get(socket.data.pid);
    if (p) p.lastSeen = Date.now() - TIMEOUT_MS + 15000;     // grace for reconnects
  });
});

setInterval(computeCrowd, 2000);
setInterval(() => io.emit('state', publicState()), 400);

// -------------------------------------------------------------- fake data
if (FAKE) {
  const FIRST = ['Ava','Noah','Mia','Kai','Zoe','Leo','Ivy','Max','Nia','Eli','Sam','Rae','Jun','Ada','Ozzy','Lux','Wren','Theo','Nova','Finn','Amara','Dev','Priya','Omar','Yuki','Sana','Cole','Tariq','Elena','Jae','Marco','Hana','Ruth','Ben','Sofia','Idris','Mei','Luca','Nadia','Ezra','Talia','Rhys','Anya','Kofi','Lena','Sid','Bea','Otto','Rina','Jonas','Zara','Pax','Ines','Vik','Noor','Emre','Cleo','Dara'];
  const TEAMS = ['Latency','Nightshift','Kernel Panic','Bitrate','Overclock','Half-Life','Downtime','Sudo','Segfault','Null Pointer'];
  // event zones pull hardest, food spikes at meal times, outdoor is a slow trickle
  const WEIGHTS = { event: 5.0, social: 2.2, food: 1.6, market: 1.0, outdoor: 0.7, transit: 0.4 };

  // weight by kind AND capacity, so the big session halls actually fill up
  // instead of every zone getting an identical slice
  function weightedZone() {
    const pool = [];
    venue.zones.forEach(z => {
      const w = Math.round((WEIGHTS[z.kind] || 1) * Math.sqrt(z.cap || 30));
      for (let i = 0; i < w; i++) pool.push(z.id);
    });
    return pick(pool);
  }

  for (let i = 0; i < FAKE_N; i++) {
    const z = weightedZone();
    const base = 58 + Math.random() * 26;
    attendees.set('sim-' + i, {
      id: 'sim-' + i, name: FIRST[i % FIRST.length] + (i >= FIRST.length ? ' ' + (i + 1) : ''),
      team: pick(TEAMS), zone: z, anchor: anchorInZone(z),
      joinedAt: Date.now() - Math.random() * 3.5 * 3600e3,
      energy: 0.2, hr: base, hrBaseline: base, hrSamples: [],
      seed: Math.random(), lastSeen: Date.now(), sim: true,
      // each person has their own tempo and reactivity, so the crowd never moves as one blob
      rate: 0.5 + Math.random() * 1.6, react: 0.35 + Math.random() * 0.9,
      hasHr: Math.random() < 0.42,
      // they've been on site a while, so they arrive with a plausible step count
      steps: Math.round(400 + Math.random() * 5200), distance: 0,
      // most phones report a usable fix; a few sit in the weak/no-fix state so
      // the dashboard shows what the real mix looks like
      gps: null, gpsNote: null, hasGps: Math.random() < 0.82
    });
  }

  let phase = 0;
  setInterval(() => {
    phase += 0.010;
    const room = (Math.sin(phase) * 0.5 + 0.5) * 0.7 + 0.15;        // slow build and release
    const beat = frame.bass || 0;
    for (const p of attendees.values()) {
      if (!p.sim) continue;
      const kind = (zoneById[p.zone] || {}).kind;
      const pull = kind === 'event' ? 1 : kind === 'social' ? 0.62 : 0.34;
      // the fake crowd responds to whatever is actually playing
      const target = clamp(room * pull * (0.55 + p.react * (0.4 + beat * 0.9)), 0, 1);
      p.energy = lerp(p.energy, target * (0.75 + Math.random() * 0.5), 0.22);
      if (p.hasHr) p.hr = clamp(p.hrBaseline * (1 + 0.42 * p.energy) + (Math.random() - 0.5) * 3, 45, 195);
      else p.hr = null;
      p.lastSeen = Date.now();
      // steps accrue with movement, so the People tab isn't a column of zeros
      if (p.energy > 0.12) p.steps += Math.round(p.energy * 1.7 + Math.random());
      p.distance = p.steps * 0.75;
      if (p.hasGps) {
        p.gps = { lat: null, lon: null, accuracy: 4 + Math.random() * 9 };
        p.gpsNote = p.gps.accuracy > GPS_MAX_ACCURACY ? 'weak' : null;
      }
      if (Math.random() < 0.0022) { p.zone = weightedZone(); p.anchor = anchorInZone(p.zone); }
    }
  }, 400);
  console.log(`Fake crowd: ${FAKE_N} attendees`);
}

server.listen(PORT, () => {
  console.log(`\n  Dashboard  http://localhost:${PORT}/dashboard.html`);
  console.log(`  Phone      http://localhost:${PORT}/join.html?zone=northhall`);
  console.log(`  QR poster  http://localhost:${PORT}/qr/northhall.svg\n`);
});
