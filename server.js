const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const {
  MOCK_SCENARIOS,
  getMockScenario,
  loadSongProfiles,
  indexSongs,
  resolveSongIds,
  OpenAISelector,
  selectNextSong
} = require('./lib/dj');

// Load .env before anything reads process.env. Ten lines beats adding a
// dependency, and it means an API key never has to survive a shell-quoting
// round trip — which differs between PowerShell, cmd and Git Bash and is the
// single most common way this fails to start.
(() => {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  let n = 0;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim().replace(/\s+#.*$/, '');          // trailing comment, not a # inside a key
    if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
    if (!(m[1] in process.env)) { process.env[m[1]] = v; n++; }   // a real env var still wins
  }
  if (n) console.log(`Loaded ${n} setting${n > 1 ? 's' : ''} from .env`);
})();

const PORT = process.env.PORT || 3000;
const FAKE = process.env.FAKE !== '0';          // fake crowd on by default
const FAKE_N = parseInt(process.env.FAKE_N || '58', 10);

// ----------------------------------------------------------- the database
// Optional local SQLite for research snapshots (Data tab). better-sqlite3 is
// NOT a package dependency — its native build fails on some hosts (Render's
// default Node). Deployed demo uses Supabase for auth/captures; the store
// disables cleanly when the module is absent. To turn snapshots on locally:
//   npm install better-sqlite3@11
const SNAPSHOT_DB = process.env.SNAPSHOT_DB || path.join(__dirname, 'backend', 'data.db');
let snapDb = null;
try {
  const Database = require('better-sqlite3');
  fs.mkdirSync(path.dirname(SNAPSHOT_DB), { recursive: true });
  snapDb = new Database(SNAPSHOT_DB);
  snapDb.pragma('journal_mode = WAL');           // concurrent phone uploads
  console.log(`[db] ${path.relative(__dirname, SNAPSHOT_DB)} (WAL)`);
} catch (e) {
  console.warn('[db] snapshot store off — better-sqlite3 not installed (' + e.message + ')');
  console.warn('[db] Auth/captures use Supabase; Flask backend/ can still read the same schema locally.');
}

// -------------------------------------------------------------- owner auth
// Venue JSON stays on disk (venues/) in every mode. Three modes:
//   supabase — accounts in Supabase Auth, ownership in venue_owners.
//              Set AUTH_MODE=supabase explicitly on deploy (and all three
//              SUPABASE_* keys). Never put the service role in client JS.
//   local    — zero-setup accounts in the same SQLite db as the sensor
//              snapshots (JSON-file fallback). The dev default. This
//              implementation was lost once in a merge and every venue
//              request then crashed the server — if you touch this section,
//              boot in local mode and hit /venues before you push.
//   off      — AUTH_MODE=off: venue writes stay open, no accounts anywhere.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const hasSupabaseKeys = !!(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY);

function resolveAuthMode() {
  const raw = (process.env.AUTH_MODE || '').toLowerCase().trim();
  if (raw === 'off') return 'off';
  if (raw === 'supabase') {
    // Explicit supabase must never fall through to broken local mode.
    if (!hasSupabaseKeys) {
      console.error('[auth] AUTH_MODE=supabase but SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY are incomplete.');
      console.error('[auth] Refusing local fallback — auth disabled until keys are set.');
      return 'off';
    }
    return 'supabase';
  }
  if (raw === 'local') return 'local';
  // Auto: prefer Supabase when fully configured, else local (dev default).
  return hasSupabaseKeys ? 'supabase' : 'local';
}

const AUTH_MODE = resolveAuthMode();
const AUTH_ENABLED = AUTH_MODE !== 'off';

const supabaseAuth = AUTH_MODE === 'supabase'
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;
const supabaseAdmin = AUTH_MODE === 'supabase'
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

// Local accounts. Passwords are scrypt-hashed with a per-user salt; sessions
// are random tokens. Stored in the SAME SQLite database as the sensor
// snapshots (backend/data.db) so persistence lives in one place — the
// collaborator's tables are untouched, these sit beside them. When the
// native module is unavailable, a JSON file keeps auth working. Persisted at
// all because `node --watch` restarts on every file edit, and being signed
// out each time would make the editor unusable.
const OWNERS_PATH = process.env.OWNERS_PATH || path.join(__dirname, 'data', 'owners.json');
let authStore = null;

function jsonAuthStore() {
  let db = { users: [], sessions: {}, owners: {} };
  try { db = { ...db, ...JSON.parse(fs.readFileSync(OWNERS_PATH, 'utf8')) }; } catch { /* first boot */ }
  const save = () => {
    fs.mkdirSync(path.dirname(OWNERS_PATH), { recursive: true });
    fs.writeFileSync(OWNERS_PATH, JSON.stringify(db, null, 2));
  };
  return {
    kind: 'json (' + path.relative(__dirname, OWNERS_PATH) + ')',
    userByEmail: e => db.users.find(u => u.email === e) || null,
    addUser: u => { db.users.push(u); save(); },
    addSession: (t, id) => { db.sessions[t] = { userId: id, createdAt: Date.now() }; save(); },
    delSession: t => { if (db.sessions[t]) { delete db.sessions[t]; save(); } },
    sessionUser: t => {
      const s = t && db.sessions[t];
      const u = s && db.users.find(u => u.id === s.userId);
      return u ? { id: u.id, email: u.email } : null;
    },
    ownerOf: v => db.owners[v] || null,
    setOwner: (v, id) => {
      if (db.owners[v] && db.owners[v] !== id) throw new Error('already owned');
      db.owners[v] = id; save();
    },
    clearOwner: v => { if (db.owners[v]) { delete db.owners[v]; save(); } },
    allOwners: () => ({ ...db.owners }),
    ownedBy: id => Object.entries(db.owners).filter(([, o]) => o === id).map(([v]) => v),
    raw: db
  };
}

function sqliteAuthStore() {
  snapDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
      salt TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS venue_owners (
      venue_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  const q = {
    userByEmail: snapDb.prepare('SELECT * FROM users WHERE email = ?'),
    addUser: snapDb.prepare('INSERT INTO users (id, email, salt, hash, created_at) VALUES (?, ?, ?, ?, ?)'),
    addSession: snapDb.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)'),
    delSession: snapDb.prepare('DELETE FROM sessions WHERE token = ?'),
    sessionUser: snapDb.prepare(`SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`),
    ownerOf: snapDb.prepare('SELECT owner_id FROM venue_owners WHERE venue_id = ?'),
    setOwner: snapDb.prepare('INSERT INTO venue_owners (venue_id, owner_id, created_at) VALUES (?, ?, ?)'),
    clearOwner: snapDb.prepare('DELETE FROM venue_owners WHERE venue_id = ?'),
    allOwners: snapDb.prepare('SELECT venue_id, owner_id FROM venue_owners'),
    ownedBy: snapDb.prepare('SELECT venue_id FROM venue_owners WHERE owner_id = ?'),
    countUsers: snapDb.prepare('SELECT COUNT(*) AS n FROM users')
  };
  // One-time migration: accounts that lived in the JSON file move into the
  // database, sessions included, so nobody gets signed out by the change.
  if (q.countUsers.get().n === 0 && fs.existsSync(OWNERS_PATH)) {
    try {
      const old = JSON.parse(fs.readFileSync(OWNERS_PATH, 'utf8'));
      snapDb.transaction(() => {
        (old.users || []).forEach(u =>
          q.addUser.run(u.id, u.email, u.salt, u.hash, new Date(u.createdAt || Date.now()).toISOString()));
        Object.entries(old.sessions || {}).forEach(([t, s]) =>
          q.addSession.run(t, s.userId, new Date(s.createdAt || Date.now()).toISOString()));
        Object.entries(old.owners || {}).forEach(([v, o]) =>
          q.setOwner.run(v, o, new Date().toISOString()));
      })();
      const n = (old.users || []).length;
      if (n) console.log(`[auth] migrated ${n} account(s) + ownership from ${path.relative(__dirname, OWNERS_PATH)} into the database`);
    } catch (e) { console.warn('[auth] migration from owners.json failed:', e.message); }
  }
  const now = () => new Date().toISOString();
  return {
    kind: 'sqlite (' + path.relative(__dirname, SNAPSHOT_DB) + ')',
    userByEmail: e => q.userByEmail.get(e) || null,
    addUser: u => q.addUser.run(u.id, u.email, u.salt, u.hash, now()),
    addSession: (t, id) => q.addSession.run(t, id, now()),
    delSession: t => q.delSession.run(t),
    sessionUser: t => (t && q.sessionUser.get(t)) || null,
    ownerOf: v => { const r = q.ownerOf.get(v); return r ? r.owner_id : null; },
    setOwner: (v, id) => {
      const cur = q.ownerOf.get(v);
      if (cur && cur.owner_id !== id) throw new Error('already owned');
      if (!cur) q.setOwner.run(v, id, now());
    },
    clearOwner: v => q.clearOwner.run(v),
    allOwners: () => Object.fromEntries(q.allOwners.all().map(r => [r.venue_id, r.owner_id])),
    ownedBy: id => q.ownedBy.all(id).map(r => r.venue_id)
  };
}

if (AUTH_MODE === 'local') authStore = snapDb ? sqliteAuthStore() : jsonAuthStore();

const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
function localSignup(email, password) {
  email = String(email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('that does not look like an email address');
  if (String(password || '').length < 6) throw new Error('password must be at least 6 characters');
  if (authStore.userByEmail(email)) throw new Error('an account with that email already exists — log in instead');
  const salt = crypto.randomBytes(16).toString('hex');
  const user = { id: 'u_' + crypto.randomBytes(8).toString('hex'), email, salt,
                 hash: hashPw(password, salt), createdAt: Date.now() };
  authStore.addUser(user);
  const token = crypto.randomBytes(32).toString('hex');
  authStore.addSession(token, user.id);
  console.log('[auth] local signup:', email);
  return { token, userId: user.id, email };
}
function localLogin(email, password) {
  email = String(email || '').trim().toLowerCase();
  const u = authStore.userByEmail(email);
  // hash against a dummy salt when the user is unknown, so a wrong email and a
  // wrong password take the same time to reject
  const h = Buffer.from(hashPw(password, u ? u.salt : 'no-such-user'), 'hex');
  const ok = u && crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex'));
  if (!ok) throw new Error('wrong email or password');
  const token = crypto.randomBytes(32).toString('hex');
  authStore.addSession(token, u.id);
  console.log('[auth] local login:', email);
  return { token, userId: u.id, email };
}
function localUserByToken(token) {
  return authStore ? authStore.sessionUser(token) : null;
}

if (AUTH_MODE === 'off') {
  console.warn('[auth] mode=off — venue create/update/delete stay open.');
} else if (AUTH_MODE === 'supabase') {
  console.log('[auth] mode=supabase — venue-owner routes + vibe captures');
} else {
  console.log(`[auth] mode=local — accounts in ${authStore.kind}; sign up from the dashboard. (Set SUPABASE_* + AUTH_MODE=supabase for deploy.)`);
}

// ----------------------------------------------------------------- venues
// Venues are JSON files in venues/. venue.json stays the committed built-in
// map and is never written to — it seeds venues/stackt.json on first boot, so
// the editor has something to clone and the tracked file stays pristine.
const VENUES_DIR = process.env.VENUES_DIR || path.join(__dirname, 'venues');  // overridable so tests use a scratch dir
const BUILTIN    = path.join(__dirname, 'venue.json');
const PLAN_MAX    = 8 * 1024 * 1024;            // floor plan upload ceiling
const CAPTURE_MAX = 5 * 1024 * 1024;            // vibe-capture photo ceiling
const CAPTURES_BUCKET = 'captures';

const venues = new Map();                        // id -> venue
let venue = null, zoneById = {}, GEO = null, activeId = null;

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-|-$/g, '').slice(0, 40);

function loadVenues() {
  venues.clear();
  if (!fs.existsSync(VENUES_DIR)) fs.mkdirSync(VENUES_DIR, { recursive: true });
  const seed = path.join(VENUES_DIR, 'stackt.json');
  if (!fs.existsSync(seed) && fs.existsSync(BUILTIN)) fs.copyFileSync(BUILTIN, seed);
  for (const f of fs.readdirSync(VENUES_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const v = JSON.parse(fs.readFileSync(path.join(VENUES_DIR, f), 'utf8'));
      v.id = path.basename(f, '.json');
      venues.set(v.id, v);
    } catch (e) { console.warn(`[venues] skipping ${f}: ${e.message}`); }
  }
  if (!venues.size) throw new Error('no venues in venues/ and venue.json is missing');
}

// New venues have no 'entrance1', so nothing may assume that id exists.
function defaultZone() {
  if (zoneById.entrance1) return 'entrance1';
  const t = venue.zones.find(z => z.kind === 'transit');
  return (t || venue.zones[0]).id;
}

function setActive(id) {
  const v = venues.get(id);
  if (!v) return false;
  activeId = id; venue = v;
  zoneById = Object.fromEntries(venue.zones.map(z => [z.id, z]));
  GEO = venue.geo || null;
  // anyone checked in is pinned to a zone id that may not exist here
  const home = defaultZone();
  for (const p of attendees.values()) {
    // Live event moved — their check-in now belongs to the new active venue.
    if (!p.sim) p.venueId = id;
    if (zoneById[p.zone]) continue;
    p.zone = home; p.anchor = anchorInZone(home); p.zoneCand = null; p.zoneVotes = 0;
  }
  return true;
}

// The geometry checks CLAUDE.md asks for, enforced instead of remembered:
// broken geometry renders as zones floating outside the site.
function validateVenue(v) {
  const errs = [];
  if (!v || typeof v !== 'object') return ['not an object'];
  if (!v.name) errs.push('name is required');
  if (!(v.aspect > 0)) errs.push('aspect must be a positive number');
  if (!Array.isArray(v.outline) || v.outline.length < 3) errs.push('outline needs at least 3 points');
  if (!Array.isArray(v.zones) || !v.zones.length) errs.push('at least one zone is required');
  if (errs.length) return errs;

  const seen = new Set();
  v.zones.forEach((z, i) => {
    const at = `zone ${i + 1} "${z.id || z.label || '?'}"`;
    if (!z.id) errs.push(`${at}: missing id`);
    else if (seen.has(z.id)) errs.push(`${at}: duplicate id`);
    seen.add(z.id);
    if (!(z.w > 0) || !(z.h > 0)) errs.push(`${at}: width and height must be positive`);
    const corners = [[z.x, z.y], [z.x + z.w, z.y], [z.x + z.w, z.y + z.h], [z.x, z.y + z.h]];
    if (!corners.every(c => pointInPolygon(c[0], c[1], v.outline)))
      errs.push(`${at}: a corner falls outside the site outline`);
  });
  for (let i = 0; i < v.zones.length; i++)
    for (let j = i + 1; j < v.zones.length; j++) {
      const a = v.zones[i], b = v.zones[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
        errs.push(`"${a.id}" overlaps "${b.id}"`);
    }
  return errs;
}

function saveVenue(v) {
  const id = slug(v.id || v.name);
  if (!id) throw new Error('could not derive an id from the name');
  const out = { ...v }; delete out.id;
  fs.writeFileSync(path.join(VENUES_DIR, id + '.json'), JSON.stringify(out, null, 2));
  v.id = id; venues.set(id, v);
  if (id === activeId) setActive(id);            // pick up edits to the live one
  return id;
}

// The selector reads precomputed metadata only. In development it falls back to
// fictional example profiles; real events should generate data/songProfiles.json.
const requestedProfilePath = process.env.DJ_PROFILES_PATH || path.join(__dirname, 'data', 'songProfiles.json');
const exampleProfilePath = path.join(__dirname, 'data', 'songProfiles.example.json');
const djProfilePath = fs.existsSync(requestedProfilePath) ? requestedProfilePath : exampleProfilePath;
const DJ_USING_EXAMPLE = path.resolve(djProfilePath) === path.resolve(exampleProfilePath);
let djSongs = [];
let djSongIndex = new Map();
try {
  djSongs = loadSongProfiles(djProfilePath);
  djSongIndex = indexSongs(djSongs);
  if (djProfilePath === exampleProfilePath) {
    console.warn('[dj] data/songProfiles.json not found; selection API is using fictional example profiles.');
  }
} catch (error) {
  console.warn(`[dj] song selection disabled: ${error.message}`);
}

function authorizedDjAI(requestToken) {
  const expected = process.env.DJ_AI_TOKEN;
  if (!expected || typeof requestToken !== 'string') return false;
  const actualBuffer = Buffer.from(requestToken);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Floor plans are editor-only: you trace zones over them, the live map still
// renders vector geometry. Stored beside the venue rather than inlined, so the
// JSON that gets broadcast every switch stays small.
const planPath = id => path.join(VENUES_DIR, id + '-plan.png');

// Two body limits, not one. 64kb protects every ordinary endpoint, but floor
// plans and the image sent for AI reading are megabytes of data URL, and a
// single global limit can't serve both: the small one silently 413s uploads,
// the large one drops the protection everywhere. Registering both as global
// middleware doesn't work either — the first to run wins, so the small limit
// rejected the upload before the large one was ever reached.
const smallJson = express.json({ limit: '64kb' });
const bigJson   = express.json({ limit: PLAN_MAX });
const needsBigBody = req => req.path === '/detect'
  || /^\/venues\/[^/]+\/plan$/.test(req.path)
  || /^\/api\/venues\/[^/]+\/capture$/.test(req.path);
app.use((req, res, next) => (needsBigBody(req) ? bigJson : smallJson)(req, res, next));
// Landing splits attendees vs organizers. Must be before static so `/` is not
// shadowed by any other default, and so we never bounce cold visits into the
// owner-gated dashboard.
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/venue', (_, res) => res.json(venue));

// What the clients need to run auth. Anon key only, never the service role.
app.get('/auth/config', (_, res) => {
  if (AUTH_MODE === 'supabase')
    return res.json({ enabled: true, mode: 'supabase', url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
  if (AUTH_MODE === 'local')
    return res.json({ enabled: true, mode: 'local' });
  res.json({ enabled: false, mode: 'off' });
});

// Local-mode account endpoints. In supabase mode the client talks to Supabase
// directly, so these 404 rather than pretend.
function localOnly(req, res, next) {
  if (AUTH_MODE !== 'local') return res.status(404).json({ error: 'not in local auth mode' });
  next();
}
app.post('/auth/signup', localOnly, (req, res) => {
  try { res.json({ ok: true, ...localSignup(req.body && req.body.email, req.body && req.body.password) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/auth/login', localOnly, (req, res) => {
  try { res.json({ ok: true, ...localLogin(req.body && req.body.email, req.body && req.body.password) }); }
  catch (e) { res.status(401).json({ error: e.message }); }
});
app.post('/auth/logout', localOnly, (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (token) authStore.delSession(token);
  res.json({ ok: true });
});
// Lets a page validate a stored token on load instead of discovering it's
// dead on the first save. BOTH clients restore their session through this —
// when it 404s they treat the session as invalid, wipe localStorage and
// bounce to the sign-in page, which looks exactly like "login is broken".
// It was lost in a merge once; that was the whole symptom.
app.get('/auth/me', localOnly, (req, res) => {
  const header = req.headers.authorization || '';
  const user = localUserByToken(header.startsWith('Bearer ') ? header.slice(7).trim() : '');
  if (!user) return res.status(401).json({ error: 'invalid session' });
  res.json({ user });
});

// Verify Supabase JWT from Authorization: Bearer <access_token>.
async function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();               // AUTH_MODE=off
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    console.log('[auth] fail: missing Authorization on', req.method, req.path);
    return res.status(401).json({ error: 'login required' });
  }
  if (AUTH_MODE === 'local') {
    const user = localUserByToken(token);
    if (!user) {
      console.log('[auth] fail: invalid local session on', req.method, req.path);
      return res.status(401).json({ error: 'invalid session' });
    }
    req.user = user;
    return next();
  }
  try {
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error || !data.user) {
      console.log('[auth] fail: invalid session —', error && error.message || 'no user');
      return res.status(401).json({ error: 'invalid session' });
    }
    req.user = data.user;
    console.log('[auth] ok:', data.user.id, data.user.email || '(no email)', '→', req.method, req.path);
    next();
  } catch (e) {
    console.log('[auth] fail: exception —', e.message);
    return res.status(401).json({ error: 'invalid session' });
  }
}

// Returns the owner_id for a venue, or null if unclaimed.
async function getVenueOwner(venueId) {
  if (!AUTH_ENABLED) return null;
  if (AUTH_MODE === 'local') return authStore.ownerOf(venueId);
  const { data, error } = await supabaseAdmin
    .from('venue_owners').select('owner_id').eq('venue_id', venueId).maybeSingle();
  if (error) {
    console.log('[auth] venue_owners read error:', error.message);
    throw error;
  }
  return data ? data.owner_id : null;
}

// Create ownership row. Fails if another owner already holds the venue.
async function claimVenue(venueId, ownerId) {
  if (AUTH_MODE === 'local') {
    authStore.setOwner(venueId, ownerId);      // throws 'already owned'
    console.log('[auth] claimed venue', venueId, 'for', ownerId);
    return;
  }
  const { error } = await supabaseAdmin
    .from('venue_owners').insert({ venue_id: venueId, owner_id: ownerId });
  if (error) {
    console.log('[auth] claim failed for', venueId, '—', error.message);
    throw error;
  }
  console.log('[auth] claimed venue', venueId, 'for', ownerId);
}

// True if user owns the venue, or may claim it (no owner yet). False if other owner.
async function assertCanWriteVenue(venueId, userId) {
  if (!AUTH_ENABLED) return true;
  const owner = await getVenueOwner(venueId);
  if (!owner) {
    try {
      await claimVenue(venueId, userId);
      return true;
    } catch (e) {
      // Lost a race — re-check
      const again = await getVenueOwner(venueId);
      if (again === userId) return true;
      console.log('[auth] deny: user', userId, 'cannot claim', venueId, '(owner', again, ')');
      return false;
    }
  }
  if (owner !== userId) {
    console.log('[auth] deny: user', userId, 'does not own', venueId, '(owner is', owner, ')');
    return false;
  }
  return true;
}

async function deleteOwnership(venueId) {
  if (!AUTH_ENABLED) return;
  if (AUTH_MODE === 'local') { authStore.clearOwner(venueId); return; }
  const { error } = await supabaseAdmin.from('venue_owners').delete().eq('venue_id', venueId);
  if (error) console.log('[auth] ownership delete error:', error.message);
  else console.log('[auth] cleared ownership for', venueId);
}

const venueSummary = v => {
  const { lat, lon } = venueLatLon(v);             // city pins need coordinates
  return {
    id: v.id, name: v.name, subtitle: v.subtitle || '',
    zones: v.zones.length, calibrated: !!(v.geo && v.geo.calibrated),
    hasPlan: fs.existsSync(planPath(v.id)), active: v.id === activeId,
    lat, lon
  };
};

// Venues owned by the logged-in account, plus the unclaimed pool — the owner
// page shows both, and claiming is how a seed venue gets an owner at all now
// that unclaimed venues stay out of the dashboard rail.
app.get('/api/me/venues', requireAuth, async (req, res) => {
  if (!AUTH_ENABLED) return res.json({ venues: [...venues.values()].map(venueSummary), unclaimed: [] });
  try {
    const owners = await getAllOwners();
    const unclaimed = [...venues.values()].filter(v => !owners[v.id]).map(venueSummary);
    if (AUTH_MODE === 'local') {
      const list = authStore.ownedBy(req.user.id)
        .map(id => venues.get(id) ? venueSummary(venues.get(id)) : { id, name: id, missing: true });
      return res.json({ venues: list, unclaimed, user: req.user });
    }
    const { data, error } = await supabaseAdmin
      .from('venue_owners').select('venue_id, created_at').eq('owner_id', req.user.id);
    if (error) {
      console.log('[auth] /api/me/venues error:', error.message);
      return res.status(500).json({ error: error.message });
    }
    const list = (data || []).map(row => {
      const v = venues.get(row.venue_id);
      if (!v) return { id: row.venue_id, name: row.venue_id, missing: true, created_at: row.created_at };
      return { ...venueSummary(v), created_at: row.created_at };
    });
    res.json({ venues: list, unclaimed, user: { id: req.user.id, email: req.user.email } });
  } catch (e) {
    console.log('[auth] /api/me/venues exception:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Take ownership of a venue nobody owns. Saving over it always claimed it;
// this claims without having to re-save, and 409s if someone got there first.
app.post('/venues/:id/claim', requireAuth, async (req, res) => {
  if (!AUTH_ENABLED || !req.user) return res.status(400).json({ error: 'accounts are off on this server' });
  const id = req.params.id;
  if (!venues.has(id)) return res.status(404).json({ error: 'no such venue' });
  try {
    const owner = await getVenueOwner(id);
    if (owner === req.user.id) return res.json({ ok: true, alreadyYours: true });
    if (owner) return res.status(409).json({ error: 'already owned by another account' });
    await claimVenue(id, req.user.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: 'already owned by another account' });
  }
});

// Optional auth: resolves the user when a valid Bearer token rides along,
// and never rejects — for routes that shape their answer to who's asking.
async function maybeAuth(req) {
  if (!AUTH_ENABLED) return null;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  if (AUTH_MODE === 'local') return localUserByToken(token);
  try {
    const { data, error } = await supabaseAuth.auth.getUser(token);
    return (!error && data.user) ? data.user : null;
  } catch { return null; }
}

// Every venue's owner in one read, for filtering lists.
async function getAllOwners() {
  if (!AUTH_ENABLED) return {};
  if (AUTH_MODE === 'local') return authStore.allOwners();
  const { data, error } = await supabaseAdmin.from('venue_owners').select('venue_id, owner_id');
  if (error) { console.log('[auth] owners read error:', error.message); return {}; }
  return Object.fromEntries((data || []).map(r => [r.venue_id, r.owner_id]));
}

// ------------------------------------------------------------ venue CRUD
// The venue LIST is scoped to the asker when auth is on: the live venue is
// public (it's on the projector); a signed-in account additionally sees ITS
// OWN venues and nothing else — not other accounts', not unclaimed ones.
// Unclaimed venues are managed from the owner page (claim endpoint), so they
// never clutter the rail. GET /venues/:id stays public because the map needs
// geometry. Each row carries `mine` so the dashboard can unlock from
// restricted (zero-owned) mode, plus lat/lon for the city map.
app.get('/venues', async (req, res) => {
  const user = await maybeAuth(req);
  const owners = await getAllOwners();
  const visible = [...venues.values()].filter(v => {
    if (!AUTH_ENABLED) return true;
    if (v.id === activeId) return true;
    return user && owners[v.id] === user.id;
  });
  res.json({
    active: activeId,
    signedIn: !!user,
    venues: visible.map(v => {
      const { lat, lon } = venueLatLon(v);
      return {
        id: v.id, name: v.name, subtitle: v.subtitle || '',
        zones: v.zones.length, calibrated: !!(v.geo && v.geo.calibrated),
        hasPlan: fs.existsSync(planPath(v.id)),
        mine: !!(user && owners[v.id] === user.id),
        unclaimed: AUTH_ENABLED ? !owners[v.id] : false,
        lat, lon
      };
    })
  });
});

app.get('/venues/:id', (req, res) => {
  const v = venues.get(req.params.id);
  return v ? res.json(v) : res.status(404).json({ error: 'no such venue' });
});

app.post('/venues', requireAuth, async (req, res) => {
  const errs = validateVenue(req.body);
  if (errs.length) return res.status(400).json({ error: 'invalid venue', problems: errs });
  const nextId = slug((req.body && (req.body.id || req.body.name)) || '');
  if (!nextId) return res.status(400).json({ error: 'could not derive an id from the name' });
  try {
    if (AUTH_ENABLED && req.user) {
      const ok = await assertCanWriteVenue(nextId, req.user.id);
      if (!ok) return res.status(403).json({ error: 'you do not own this venue' });
    }
    const id = saveVenue(req.body);
    // New slug after rename: ensure ownership lands on the saved id too.
    if (AUTH_ENABLED && req.user && id !== nextId) {
      const ok = await assertCanWriteVenue(id, req.user.id);
      if (!ok) return res.status(403).json({ error: 'you do not own this venue' });
    }
    console.log('[venues] saved', id, AUTH_ENABLED && req.user ? `by ${req.user.id}` : '(auth off)');
    res.json({ ok: true, id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/venues/:id/activate', (req, res) => {
  if (!setActive(req.params.id)) return res.status(404).json({ error: 'no such venue' });
  rebuildCrowd();
  io.emit('venue', venue);
  io.emit('state', publicState());
  console.log(`[venues] active venue is now "${venue.name}" (${activeId})`);
  res.json({ ok: true, active: activeId });
});

app.delete('/venues/:id', requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!venues.has(id)) return res.status(404).json({ error: 'no such venue' });
  if (id === activeId) return res.status(409).json({ error: 'that venue is live — activate another first' });
  try {
    if (AUTH_ENABLED && req.user) {
      const owner = await getVenueOwner(id);
      if (!owner) {
        console.log('[auth] deny delete: unowned venue', id);
        return res.status(403).json({ error: 'venue has no owner' });
      }
      if (owner !== req.user.id) {
        console.log('[auth] deny delete: user', req.user.id, 'does not own', id);
        return res.status(403).json({ error: 'you do not own this venue' });
      }
    }
    fs.unlinkSync(path.join(VENUES_DIR, id + '.json'));
    if (fs.existsSync(planPath(id))) fs.unlinkSync(planPath(id));
    venues.delete(id);
    await deleteOwnership(id);
    console.log('[venues] deleted', id);
    res.json({ ok: true });
  } catch (e) {
    console.log('[venues] delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/venues/:id/plan', (req, res) => {
  const p = planPath(req.params.id);
  return fs.existsSync(p) ? res.type('png').send(fs.readFileSync(p))
                          : res.status(404).end();
});

app.put('/venues/:id/plan', requireAuth, async (req, res) => {
  const id = req.params.id;
  if (!venues.has(id)) return res.status(404).json({ error: 'no such venue' });
  try {
    if (AUTH_ENABLED && req.user) {
      const ok = await assertCanWriteVenue(id, req.user.id);
      if (!ok) return res.status(403).json({ error: 'you do not own this venue' });
    }
    const data = String((req.body && req.body.image) || '');
    const m = data.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'expected a png, jpeg or webp data URL' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > PLAN_MAX) return res.status(413).json({ error: 'floor plan is too large' });
    fs.writeFileSync(planPath(id), buf);
    res.json({ ok: true, bytes: buf.length });
  } catch (e) {
    console.log('[venues] plan upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------------ AI detection
// The key stays on the server. The dashboard is served over a public tunnel,
// so a key in client JS would be handed to anyone who opens the page.
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

// Whichever key is present wins; set AI_PROVIDER explicitly if you have both.
const AI_PROVIDER = (process.env.AI_PROVIDER || '').toLowerCase()
  || (OPENAI_KEY ? 'openai' : GEMINI_KEY ? 'gemini' : '');
const AI_KEY   = AI_PROVIDER === 'openai' ? OPENAI_KEY : GEMINI_KEY;
const AI_MODEL = AI_PROVIDER === 'openai'
  // gpt-5.4 by measurement, not by vintage: on a labelled test plan it places
  // boxes at IoU ~0.91 against the true rooms where gpt-4o manages ~0.47, and
  // it's also the fastest and cheapest of the accurate ones. Every model tried
  // found all 7 rooms and labelled them right — the difference is entirely in
  // how tightly the rectangles land, which is what zone accuracy depends on.
  ? (process.env.OPENAI_MODEL || 'gpt-5.4')
  : (process.env.GEMINI_MODEL || 'gemini-2.0-flash');

// overridable so the request/parse/repair path can be exercised against a stub
const OPENAI_BASE = process.env.OPENAI_BASE || 'https://api.openai.com/v1';
const GEMINI_BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta';

const KINDS = ['event', 'social', 'food', 'market', 'outdoor', 'transit'];

const AI_PROMPT = `You are reading a venue floor plan or site map. Identify the distinct areas a crowd can occupy: rooms, halls, studios, courtyards, stages, food areas, lobbies, entrances.

Return normalized coordinates in 0..1, where (0,0) is the TOP-LEFT of the image and (1,1) the bottom-right. For each zone, x,y is the top-left corner of an axis-aligned rectangle and w,h its size.

Rules:
- Rectangles must NOT overlap each other.
- Every rectangle must lie inside the venue outline you return.
- Give the largest rectangle that fits INSIDE the area, not a box drawn around it.
- Ignore legends, titles, north arrows, scale bars, dimension lines and blocks of text.
- Return between 2 and 30 zones. If the plan is a single open space, return one zone.

"kind" must be exactly one of: event, social, food, market, outdoor, transit.
  event   - halls, rooms, stages, studios, anywhere sessions happen
  social  - lounges, courtyards, seating areas
  food    - kitchens, bars, cafeterias, food halls
  market  - retail units, vendor stalls
  outdoor - lawns, parks, yards
  transit - entrances, lobbies, corridors, stairs, parking

"cap" is a plausible standing capacity for the area.
"label" is the name written on the plan if there is one, otherwise something descriptive.
"outline" is the venue footprint: 3 to 40 points tracing its edge in order.
"name" is the venue's name if the plan states one, otherwise an empty string.

Also report anything on the drawing that fixes it to the real world. Report ONLY what you can actually see — a wrong value here is worse than no value, so use the "unknown" value if you are not sure:
- "widthMetres": how wide the WHOLE IMAGE is in metres. Read it off a scale bar or a printed dimension and extrapolate to the full image width. 0 if there is no scale.
- "northDegrees": the compass bearing that straight UP in the image points to, in degrees, 0 = up is north, 90 = up is east. Read it off a north arrow or compass rose. -1 if there is no north indicator.
- "address": any street address or place name printed on the drawing, exactly as written. Empty string if none.`;

// Gemini wants uppercase type names and ignores additionalProperties
const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING' },
    widthMetres: { type: 'NUMBER' }, northDegrees: { type: 'NUMBER' }, address: { type: 'STRING' },
    outline: { type: 'ARRAY', items: { type: 'OBJECT',
      properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' } }, required: ['x', 'y'] } },
    zones: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      label: { type: 'STRING' }, short: { type: 'STRING' }, kind: { type: 'STRING' },
      x: { type: 'NUMBER' }, y: { type: 'NUMBER' }, w: { type: 'NUMBER' }, h: { type: 'NUMBER' },
      cap: { type: 'INTEGER' }
    }, required: ['label', 'kind', 'x', 'y', 'w', 'h'] } }
  },
  required: ['zones', 'outline']
};

// OpenAI structured outputs are strict: every object needs additionalProperties
// false and every property listed in required, or the request is rejected.
const OPENAI_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['name', 'widthMetres', 'northDegrees', 'address', 'outline', 'zones'],
  properties: {
    name: { type: 'string' },
    widthMetres: { type: 'number' },
    northDegrees: { type: 'number' },
    address: { type: 'string' },
    outline: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } } },
    zones: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['label', 'short', 'kind', 'x', 'y', 'w', 'h', 'cap'],
      properties: {
        label: { type: 'string' }, short: { type: 'string' },
        kind: { type: 'string', enum: KINDS },
        x: { type: 'number' }, y: { type: 'number' },
        w: { type: 'number' }, h: { type: 'number' }, cap: { type: 'integer' }
      } } }
  }
};

// Each returns the model's raw JSON text, or throws with something readable.
async function askGemini(mime, b64, signal) {
  const r = await fetch(`${GEMINI_BASE}/models/${AI_MODEL}:generateContent?key=${AI_KEY}`, {
    method: 'POST', signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: AI_PROMPT }, { inline_data: { mime_type: mime, data: b64 } }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA, temperature: 0.1 }
    })
  });
  const body = await r.json();
  if (!r.ok) throw new Error((body.error && body.error.message) || `HTTP ${r.status}`);
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('the model returned nothing usable');
  return text;
}

async function askOpenAI(mime, b64, signal) {
  const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${AI_KEY}` },
    body: JSON.stringify({
      model: AI_MODEL, temperature: 0.1,
      messages: [{ role: 'user', content: [
        { type: 'text', text: AI_PROMPT },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}`, detail: 'high' } }
      ] }],
      response_format: { type: 'json_schema',
        json_schema: { name: 'venue_layout', strict: true, schema: OPENAI_SCHEMA } }
    })
  });
  const body = await r.json();
  if (!r.ok) throw new Error((body.error && body.error.message) || `HTTP ${r.status}`);
  const choice = body.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('the model ran out of output tokens');
  const text = choice?.message?.content;
  if (!text) throw new Error('the model returned nothing usable');
  return text;
}

// A vision model returns plausible boxes, not valid geometry. Clamp them into
// range, drop the degenerate ones, trim overlaps and pull strays inside the
// outline — the same guarantees the local detector makes, so whichever path
// produced the zones, what reaches validateVenue is sound.
function repairGeometry(zones, outline) {
  const out = [];
  const seen = new Set();
  for (const z of zones) {
    let x = clamp(+z.x || 0, 0, 1), y = clamp(+z.y || 0, 0, 1);
    let w = clamp(+z.w || 0, 0, 1), h = clamp(+z.h || 0, 0, 1);
    if (x + w > 1) w = 1 - x;
    if (y + h > 1) h = 1 - y;
    if (w < 0.014 || h < 0.014) continue;

    let bad = false;
    for (const a of out) {                       // trim along the cheaper axis
      const ox = Math.min(x + w, a.x + a.w) - Math.max(x, a.x);
      const oy = Math.min(y + h, a.y + a.h) - Math.max(y, a.y);
      if (ox <= 0 || oy <= 0) continue;
      if (ox < oy) { if (x < a.x) w = a.x - x; else { const nx = a.x + a.w; w = x + w - nx; x = nx; } }
      else         { if (y < a.y) h = a.y - y; else { const ny = a.y + a.h; h = y + h - ny; y = ny; } }
      if (w < 0.014 || h < 0.014) { bad = true; break; }
    }
    if (bad) continue;

    const fits = () => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
      .every(p => pointInPolygon(p[0], p[1], outline));
    for (let k = 0; k < 8 && !fits(); k++) {
      const cx = x + w / 2, cy = y + h / 2;
      w *= 0.9; h *= 0.9; x = cx - w / 2; y = cy - h / 2;
    }
    if (!fits() || w < 0.014 || h < 0.014) continue;

    let id = slug(z.label) || 'zone';
    let n = 2; while (seen.has(id)) id = slug(z.label) + '-' + n++;
    seen.add(id);

    out.push({
      id, label: String(z.label || id).slice(0, 30),
      short: String(z.short || z.label || id).slice(0, 12).toUpperCase(),
      kind: KINDS.includes(z.kind) ? z.kind : 'event',
      x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +h.toFixed(4),
      cap: clamp(parseInt(z.cap, 10) || Math.round(w * h * 1400), 4, 2000)
    });
    if (out.length >= 40) break;
  }
  return out;
}

// A drawing can pin down size and rotation — a scale bar and a north arrow are
// exactly that information — but nothing on it says where on Earth it sits
// unless an address is printed. So this fills in what's derivable, geocodes the
// address if there is one, and marks the result estimated. It never claims
// calibrated: a geocode lands within tens of metres, and zones here are ~10m,
// so this is a starting point for the two pins, not a replacement for them.
async function geocodeOnce(q) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q='
                          + encodeURIComponent(q),
      { signal: ctrl.signal, headers: { 'user-agent': 'Pulse venue dashboard (hackathon project)' } });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j[0]) return null;
    return { lat: +j[0].lat, lon: +j[0].lon, display: String(j[0].display_name || '').slice(0, 120) };
  } catch { return null; }
  finally { clearTimeout(t); }
}

// Nominatim matches names literally: "STACKT Market, Toronto" finds nothing
// while "STACKT, Toronto" is a direct hit, because OSM names the place just
// "Stackt". So on a miss, retry with the name part progressively shortened.
// Sequential with a delay per Nominatim's one-request-per-second policy.
async function geocode(address) {
  if (!address || address.length < 6) return null;
  const parts = String(address).split(',').map(s => s.trim()).filter(Boolean);
  const tries = [parts.join(', ')];
  const words = (parts[0] || '').split(/\s+/);
  for (let n = words.length - 1; n >= 1 && tries.length < 3; n--) {
    const cand = [words.slice(0, n).join(' '), ...parts.slice(1)].join(', ');
    if (!tries.includes(cand)) tries.push(cand);
  }
  for (let i = 0; i < tries.length; i++) {
    if (i) await new Promise(r => setTimeout(r, 1100));
    const hit = await geocodeOnce(tries[i]);
    if (hit) return hit;
  }
  return null;
}

async function estimateGeo(parsed, aspect) {
  const width = +parsed.widthMetres || 0;
  const north = parsed.northDegrees;
  const address = String(parsed.address || '').trim();

  const got = [];
  const geo = { calibrated: false, estimated: true,
                origin: { lat: 0, lon: 0 }, spanX: 100, spanY: 100 / aspect, bearing: 90 };

  // a scale bar read as 3m or 9km is a misread, not a small or large venue
  if (width >= 8 && width <= 4000) {
    geo.spanX = +width.toFixed(1);
    geo.spanY = +(width / aspect).toFixed(1);
    got.push(`size from a scale bar (${geo.spanX} × ${geo.spanY} m)`);
  }
  // map +x is image-right, which is 90 degrees clockwise of image-up
  if (typeof north === 'number' && north >= 0 && north <= 360) {
    geo.bearing = +(((north + 90) % 360)).toFixed(2);
    got.push(`rotation from a north arrow (up = ${north}°)`);
  }

  const place = await geocode(address);
  if (place) {
    // geocoding returns the venue centre; origin is the map's top-left corner
    const b = geo.bearing * Math.PI / 180;
    const px = 0.5 * geo.spanX, py = 0.5 * geo.spanY;
    const dEast = px * Math.sin(b) + py * Math.cos(b);
    const dNorth = px * Math.cos(b) - py * Math.sin(b);
    geo.origin = {
      lat: +(place.lat - dNorth / M_PER_DEG).toFixed(7),
      lon: +(place.lon - dEast / (M_PER_DEG * Math.cos(place.lat * Math.PI / 180))).toFixed(7)
    };
    got.push(`position from the address "${address}"`);
    geo.placed = place.display;
  }

  geo.from = got;
  geo.usable = got.length > 0;
  return geo;
}

// Address -> coordinates for the editor's "centre the venue here" flow.
// Proxied so the client needs no key and no CORS luck; Nominatim is free.
app.get('/geocode', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.status(400).json({ error: 'give an address to look up' });
  const place = await geocode(q);
  if (!place) return res.status(404).json({ error: `could not find "${q.slice(0, 60)}" — try adding the city, or paste coordinates instead` });
  res.json(place);
});

app.get('/ai', (_, res) => res.json({
  available: !!AI_KEY, provider: AI_KEY ? AI_PROVIDER : null, model: AI_KEY ? AI_MODEL : null
}));

app.post('/detect', async (req, res) => {
  if (!AI_KEY) return res.status(503).json({ error: 'no OPENAI_API_KEY or GEMINI_API_KEY set on the server' });
  const m = String((req.body && req.body.image) || '').match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'expected a png, jpeg or webp data URL' });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const ask = AI_PROVIDER === 'openai' ? askOpenAI : askGemini;
    let text;
    try { text = await ask('image/' + m[1], m[2], ctrl.signal); }
    catch (e) {
      if (e.name === 'AbortError') throw e;
      console.warn(`[ai] ${AI_PROVIDER} rejected the request:`, e.message);
      return res.status(502).json({ error: e.message });
    }

    let parsed;
    try { parsed = JSON.parse(text); }
    catch { return res.status(502).json({ error: 'the model returned malformed JSON' }); }

    let outline = (parsed.outline || [])
      .map(p => [clamp(+p.x || 0, 0, 1), clamp(+p.y || 0, 0, 1)]);
    if (outline.length < 3) outline = [[0, 0], [1, 0], [1, 1], [0, 1]];

    const zones = repairGeometry(parsed.zones || [], outline);
    if (!zones.length) return res.status(422).json({ error: 'the model found no usable zones in that image' });

    const geo = await estimateGeo(parsed, +req.body.aspect || 1.6);

    res.json({ source: 'ai', provider: AI_PROVIDER, model: AI_MODEL,
               name: String(parsed.name || '').slice(0, 40),
               outline: outline.map(p => [+p[0].toFixed(4), +p[1].toFixed(4)]), zones, geo });
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'the model took too long to answer' : e.message;
    console.warn('[ai] detect failed:', msg);
    res.status(502).json({ error: msg });
  } finally { clearTimeout(timer); }
});

// --------------------------------------------------------- data collection
// The sensor-snapshot store, ported from backend/app.py so the whole thing
// runs in ONE server over ONE tunnel. Same routes, same schema, same database
// file — the Flask app and anything written against it keep working on the
// identical data. Phones upload a 5-second capture of raw readings (accel
// x/y/z, orientation α/β/γ, mic audio level at ~10 Hz) plus one GPS fix;
// nothing is scored server-side, raw values only.
//
// Live crowd state stays in-memory and dies with the process — that rule is
// untouched. This store is the deliberate exception: recorded research data,
// which is worthless if it dies with the process.
let snapStmts = null;
if (snapDb) try {
  // schema statements copied from backend/db.py — must stay byte-compatible
  snapDb.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 5000,
        lat REAL,
        lng REAL,
        gps_accuracy REAL
    );
    CREATE TABLE IF NOT EXISTS snapshot_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id TEXT NOT NULL,
        reading_index INTEGER NOT NULL,
        offset_ms INTEGER NOT NULL,
        accel_x REAL NOT NULL,
        accel_y REAL NOT NULL,
        accel_z REAL NOT NULL,
        alpha REAL NOT NULL,
        beta REAL NOT NULL,
        gamma REAL NOT NULL,
        audio_level REAL NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id)
    );
    CREATE INDEX IF NOT EXISTS idx_readings_snapshot ON snapshot_readings(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots(session_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_captured ON snapshots(captured_at);
  `);
  snapStmts = {
    insertSnap: snapDb.prepare(`INSERT INTO snapshots
      (snapshot_id, session_id, captured_at, duration_ms, lat, lng, gps_accuracy)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    insertReading: snapDb.prepare(`INSERT INTO snapshot_readings
      (snapshot_id, reading_index, offset_ms, accel_x, accel_y, accel_z, alpha, beta, gamma, audio_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    list: snapDb.prepare(`SELECT s.*, COALESCE(r.reading_count, 0) AS reading_count
      FROM snapshots s
      LEFT JOIN (SELECT snapshot_id, COUNT(*) AS reading_count FROM snapshot_readings GROUP BY snapshot_id) r
        ON r.snapshot_id = s.snapshot_id
      ORDER BY datetime(s.captured_at) DESC, s.snapshot_id DESC LIMIT ?`),
    one: snapDb.prepare('SELECT * FROM snapshots WHERE snapshot_id = ?'),
    readings: snapDb.prepare('SELECT * FROM snapshot_readings WHERE snapshot_id = ? ORDER BY reading_index ASC, id ASC'),
    summary: snapDb.prepare(`SELECT
      (SELECT COUNT(*) FROM snapshots) AS snapshots,
      (SELECT COUNT(*) FROM snapshot_readings) AS readings,
      (SELECT COUNT(DISTINCT session_id) FROM snapshots) AS sessions,
      (SELECT MAX(captured_at) FROM snapshots) AS newest,
      (SELECT MIN(captured_at) FROM snapshots) AS oldest`),
    exportRows: snapDb.prepare(`SELECT s.session_id, s.snapshot_id, s.captured_at, s.duration_ms,
        s.lat, s.lng, s.gps_accuracy,
        r.reading_index, r.offset_ms, r.accel_x, r.accel_y, r.accel_z, r.alpha, r.beta, r.gamma, r.audio_level
      FROM snapshots s JOIN snapshot_readings r ON r.snapshot_id = s.snapshot_id
      ORDER BY datetime(s.captured_at) ASC, s.snapshot_id ASC, r.reading_index ASC`),
    // room loudness for the DJ's CrowdState: mean mic RMS across every
    // reading phones uploaded recently (ISO strings compare lexicographically)
    recentAudio: snapDb.prepare(`SELECT AVG(r.audio_level) AS rms, COUNT(*) AS n
      FROM snapshots s JOIN snapshot_readings r ON r.snapshot_id = s.snapshot_id
      WHERE s.captured_at >= ?`)
  };
  console.log(`[data] snapshot store ready`);
} catch (e) {
  // a broken schema must never take the demo down with it
  console.warn('[data] snapshot store DISABLED —', e.message);
  snapStmts = null;
}

const noStore = res => res.status(503).json({ error: 'snapshot store unavailable on this server' });
const optFloat = v => (v === null || v === undefined || v === '' ? null : +v);

app.post('/api/snapshots', (req, res) => {
  if (!snapStmts) return noStore(res);
  const data = req.body || {};
  const sessionId = String(data.session_id || 'unknown').slice(0, 64);
  const snapshotId = String(data.snapshot_id || `${sessionId}-${new Date().toISOString()}`).slice(0, 128);
  const capturedAt = String(data.captured_at || new Date().toISOString()).slice(0, 40);
  const readings = Array.isArray(data.readings) ? data.readings.slice(0, 400) : [];
  try {
    snapDb.transaction(() => {
      snapStmts.insertSnap.run(snapshotId, sessionId, capturedAt,
        parseInt(data.duration_ms, 10) || 5000,
        optFloat(data.lat), optFloat(data.lng), optFloat(data.gps_accuracy));
      readings.forEach((r, i) => snapStmts.insertReading.run(snapshotId,
        Number.isFinite(+r.reading_index) ? +r.reading_index : i,
        parseInt(r.offset_ms, 10) || 0,
        +r.accel_x || 0, +r.accel_y || 0, +r.accel_z || 0,
        +r.alpha || 0, +r.beta || 0, +r.gamma || 0,
        +r.audio_level || 0));
    })();
  } catch (e) {
    if (/UNIQUE constraint/.test(e.message))
      return res.status(409).json({ error: 'snapshot_id already exists' });
    console.warn('[data] insert failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
  res.json({ ok: true, snapshot_id: snapshotId, reading_count: readings.length });
});

app.get('/api/snapshots', (req, res) => {
  if (!snapStmts) return noStore(res);
  const limit = clamp(parseInt(req.query.limit, 10) || 500, 1, 10000);
  res.json({ snapshots: snapStmts.list.all(limit) });
});

// registered before /api/snapshots/:id so the extension isn't read as an id
app.get('/api/snapshots.csv', (req, res) => {
  if (!snapStmts) return noStore(res);
  const cols = ['session_id', 'snapshot_id', 'captured_at', 'duration_ms', 'lat', 'lng', 'gps_accuracy',
                'reading_index', 'offset_ms', 'accel_x', 'accel_y', 'accel_z', 'alpha', 'beta', 'gamma', 'audio_level'];
  const esc = v => (v === null || v === undefined) ? ''
    : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const lines = [cols.join(',')];
  for (const row of snapStmts.exportRows.iterate()) lines.push(cols.map(c => esc(row[c])).join(','));
  res.type('text/csv')
     .set('content-disposition', 'attachment; filename="pulse-snapshots.csv"')
     .send(lines.join('\n'));
});

app.get('/api/snapshots/:id', (req, res) => {
  if (!snapStmts) return noStore(res);
  const snapshot = snapStmts.one.get(req.params.id);
  if (!snapshot) return res.status(404).json({ error: 'snapshot not found' });
  res.json({ snapshot, readings: snapStmts.readings.all(req.params.id) });
});

// dashboard Data tab tiles
app.get('/api/data/summary', (_, res) => {
  if (!snapStmts) return res.json({ available: false });
  const s = snapStmts.summary.get();
  let bytes = 0;
  try { bytes = fs.statSync(SNAPSHOT_DB).size; } catch {}
  res.json({ available: true, ...s, bytes });
});

app.get('/api/health', (_, res) => res.json({ status: 'ok' }));

// The collaborator's standalone sensor page, served from the same origin so
// its relative /api/snapshots POST hits this server through the same tunnel.
app.get('/sensor-test', (_, res) => res.sendFile(path.join(__dirname, 'backend', 'sensor_test.html')));

// --------------------------------------------------------- crowd settings
app.get('/crowd', (_, res) => res.json(crowdCfg));
app.post('/crowd', (req, res) => {
  const b = req.body || {};
  if (b.n !== undefined)          crowdCfg.n = clamp(parseInt(b.n, 10) || 0, 0, 400);
  if (b.liveliness !== undefined) crowdCfg.liveliness = clamp(+b.liveliness, 0, 1);
  if (b.hrPct !== undefined)      crowdCfg.hrPct = clamp(+b.hrPct, 0, 1);
  if (b.spread !== undefined)     crowdCfg.spread = b.spread === 'even' ? 'even' : 'capacity';
  rebuildCrowd();
  res.json({ ok: true, ...crowdCfg });
});
// curl this if the dashboard looks wrong — it's the exact payload being broadcast
app.get('/state.json', (_, res) => res.json(publicState()));

// ---------------------------------------------------------- vibe captures
// Permanent photo + live crowd reading. Public write (same trust as join/
// motion sockets); persists in Supabase so it survives process death.
// Tuned against the default FAKE crowd (liveliness ≈0.7): energy usually
// sits ~0.35–0.75 and sync climbs once a few people move together. Thresholds
// stay explainable — judges can hear the rule in one sentence.
function vibeLabel(energy, sync) {
  const e = +energy || 0, s = +sync || 0;
  // Room is both lively AND moving as one body → hype
  if (e > 0.55 && s > 0.45) return 'hype';
  // Quiet floor, regardless of sync → calm
  if (e < 0.28) return 'calm';
  return 'mixed';
}

// City-map pin: approximate venue centre from geo.origin + half the site span.
// Fine at city scale; per-zone GPS precision is a different problem.
function venueLatLon(v) {
  const g = v && v.geo, o = g && g.origin;
  if (!o || typeof o.lat !== 'number' || typeof o.lon !== 'number') return { lat: null, lon: null };
  const halfY = ((g.spanY || 50) / 2) / 111320;
  const halfX = ((g.spanX || 100) / 2) / (111320 * Math.max(0.2, Math.cos(o.lat * Math.PI / 180)));
  return { lat: +(o.lat - halfY).toFixed(6), lon: +(o.lon + halfX).toFixed(6) };
}

// Storage for captures: Supabase when configured; otherwise the same local
// SQLite + disk that carries everything else in local mode. The vibe wall is
// a headline feature — it must not be the one thing that requires cloud
// setup when nothing else does.
const CAPTURES_DIR = process.env.CAPTURES_DIR || path.join(__dirname, 'data', 'captures');
let localCaps = null;
if (snapDb) try {
  snapDb.exec(`CREATE TABLE IF NOT EXISTS captures (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
    venue_id TEXT NOT NULL, venue_name TEXT,
    lat REAL, lon REAL,
    photo_file TEXT NOT NULL,
    energy REAL, sync REAL, arousal REAL,
    vibe_label TEXT, captured_by TEXT, zone_id TEXT)`);
  localCaps = {
    insert: snapDb.prepare(`INSERT INTO captures
      (id, created_at, venue_id, venue_name, lat, lon, photo_file, energy, sync, arousal, vibe_label, captured_by, zone_id)
      VALUES (@id,@created_at,@venue_id,@venue_name,@lat,@lon,@photo_file,@energy,@sync,@arousal,@vibe_label,@captured_by,@zone_id)`),
    list: snapDb.prepare('SELECT * FROM captures ORDER BY created_at DESC LIMIT ?'),
    listVenue: snapDb.prepare('SELECT * FROM captures WHERE venue_id = ? ORDER BY created_at DESC LIMIT ?'),
    one: snapDb.prepare('SELECT * FROM captures WHERE id = ?')
  };
} catch (e) { console.warn('[capture] local table failed:', e.message); }
const capturesAvailable = () => !!(supabaseAdmin || localCaps);

// The city map's premise is public pins for every located venue — unscoped
// on purpose, unlike the dashboard's per-account /venues list. Names and
// approximate coordinates only; geometry stays on /venues/:id.
app.get('/api/city/venues', (_, res) => res.json({
  venues: [...venues.values()]
    .map(v => {
      const { lat, lon } = venueLatLon(v);
      return { id: v.id, name: v.name, lat, lon,
               hasPlan: fs.existsSync(planPath(v.id)), live: v.id === activeId };
    })
    .filter(v => v.lat != null)
}));

// Light double-tap guard: one capture per venue+device every 30s.
const captureCooldown = new Map();               // key -> expiresAt
const CAPTURE_COOLDOWN_MS = 30_000;
function captureAllowed(venueId, deviceId) {
  const key = `${venueId}:${deviceId || 'anon'}`;
  const now = Date.now();
  const until = captureCooldown.get(key) || 0;
  if (until > now) return false;
  captureCooldown.set(key, now + CAPTURE_COOLDOWN_MS);
  if (captureCooldown.size > 2000) {
    for (const [k, t] of captureCooldown) if (t <= now) captureCooldown.delete(k);
  }
  return true;
}

async function uploadCapturePhoto(buf, ext, contentType) {
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const { error } = await supabaseAdmin.storage.from(CAPTURES_BUCKET).upload(name, buf, {
    contentType, upsert: false, cacheControl: '86400'
  });
  if (error) throw new Error(error.message || 'storage upload failed');
  const { data } = supabaseAdmin.storage.from(CAPTURES_BUCKET).getPublicUrl(name);
  if (!data || !data.publicUrl) throw new Error('no public URL from storage');
  return data.publicUrl;
}

// Extract object key from a Supabase public/signed URL, or accept a bare key.
function captureStorageKey(photoUrl) {
  const s = String(photoUrl || '').trim();
  if (!s) return null;
  // .../object/public/captures/<key> or .../object/sign/captures/<key>
  let m = s.match(/\/storage\/v1\/object\/(?:public|sign)\/captures\/([^?#]+)/i);
  if (m) return decodeURIComponent(m[1]);
  // Some SDKs emit /storage/v1/object/public/captures%2F<key>
  m = s.match(/\/captures(?:%2F|\/)([^?#]+)/i);
  if (m) return decodeURIComponent(m[1]);
  // Bare storage key as stored
  if (/^[0-9]+-[a-f0-9]+\.(png|jpe?g|webp)$/i.test(s)) return s;
  // Last path segment if it looks like our upload name
  m = s.match(/\/([0-9]+-[a-f0-9]+\.(?:png|jpe?g|webp))(?:\?|$)/i);
  if (m) return m[1];
  return null;
}

// Browser img tags hit Supabase directly and intermittently 403 (CF / private
// bucket / missing SELECT policy). Always serve photos same-origin instead.
function withProxiedPhoto(row) {
  if (!row || !row.id) return row;
  return Object.assign({}, row, { photo_url: `/api/captures/${row.id}/photo` });
}

// Must be a live, non-sim check-in for THIS venue. device_id is the pulse
// session id from join.html — same trust model as motion/geo sockets.
function assertCaptureCheckIn(venueId, deviceId) {
  if (!deviceId) {
    return { ok: false, status: 401, error: 'check in at this venue first — scan the QR and tap Check in' };
  }
  const p = attendees.get(deviceId);
  if (!p || p.sim) {
    return { ok: false, status: 401, error: 'check in at this venue first — scan the QR and tap Check in' };
  }
  if (!alive(p)) {
    return { ok: false, status: 401, error: 'your check-in expired — reopen the join page and check in again' };
  }
  if (p.venueId !== venueId) {
    console.log('[capture] deny: device', deviceId, 'checked into', p.venueId, 'not', venueId);
    return { ok: false, status: 403, error: 'you are checked into a different venue — scan this venue\'s QR to capture here' };
  }
  return { ok: true, person: p };
}

// Photo + frozen live metrics. Metrics always come from server-side `crowd`
// (recomputed here) — never trust client-supplied energy/sync/arousal.
app.post('/api/venues/:id/capture', async (req, res) => {
  if (!capturesAvailable()) {
    return res.status(503).json({ error: 'captures unavailable — no Supabase and no local database' });
  }
  const id = req.params.id;
  const v = venues.get(id);
  if (!v) return res.status(404).json({ error: 'no such venue' });

  const deviceId = String((req.body && req.body.device_id) || req.get('x-device-id') || '').slice(0, 64);
  const gate = assertCaptureCheckIn(id, deviceId);
  if (!gate.ok) {
    console.log('[capture] deny check-in:', gate.error, 'venue=', id, 'device=', deviceId || '(none)');
    return res.status(gate.status).json({ error: gate.error });
  }

  if (!captureAllowed(id, deviceId)) {
    console.log('[capture] rate-limited', id, deviceId);
    return res.status(429).json({ error: 'slow down — one capture per venue every 30s' });
  }

  const dataUrl = String((req.body && req.body.image) || '');
  const m = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'expected a png, jpeg or webp data URL' });
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); }
  catch { return res.status(400).json({ error: 'invalid base64 image' }); }
  if (!buf.length) return res.status(400).json({ error: 'empty image' });
  if (buf.length < 512) return res.status(400).json({ error: 'photo looks empty — try again with the camera' });
  if (buf.length > CAPTURE_MAX) return res.status(413).json({ error: 'photo is too large (max 5MB)' });

  computeCrowd();
  const energy = +crowd.energy || 0;
  const sync = +crowd.sync || 0;
  const arousal = +crowd.arousal || 0;
  const label = vibeLabel(energy, sync);
  const { lat, lon } = venueLatLon(v);
  const capturedBy = (req.body && req.body.captured_by != null)
    ? String(req.body.captured_by).trim().slice(0, 24) || null
    : null;

  // Local store: photo to disk, row to the shared SQLite db. Same response
  // shape as the Supabase path — the clients cannot tell the difference.
  if (!supabaseAdmin) {
    try {
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
      fs.mkdirSync(CAPTURES_DIR, { recursive: true });
      fs.writeFileSync(path.join(CAPTURES_DIR, name), buf);
      const row = {
        id: 'c_' + crypto.randomBytes(8).toString('hex'),
        created_at: new Date().toISOString(),
        venue_id: id, venue_name: v.name || id,
        lat, lon, photo_file: name,
        energy, sync, arousal,
        vibe_label: label, captured_by: capturedBy,
        zone_id: captureZoneId(gate.person)
      };
      localCaps.insert.run(row);
      const proxied = withProxiedPhoto(row);
      console.log('[capture] ok (local)', row.id, id, label,
        `zone=${row.zone_id || 'none'} e=${energy.toFixed(2)} s=${sync.toFixed(2)} bytes=${buf.length}`);
      io.emit('capture', proxied);
      return res.json({ ok: true, capture: proxied });
    } catch (e) {
      console.log('[capture] local fail:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  try {
    // Create the public bucket on first use if schema.sql hasn't been run yet
    // for Storage (table still must exist — that part needs the SQL editor).
    const { data: buckets } = await supabaseAdmin.storage.listBuckets();
    if (!buckets || !buckets.some(b => b.id === CAPTURES_BUCKET || b.name === CAPTURES_BUCKET)) {
      const { error: bErr } = await supabaseAdmin.storage.createBucket(CAPTURES_BUCKET, {
        public: true, fileSizeLimit: CAPTURE_MAX,
        allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp']
      });
      if (bErr && !/already exists/i.test(bErr.message || '')) {
        console.log('[capture] create bucket fail:', bErr.message);
        return res.status(500).json({
          error: bErr.message + ' — run supabase/schema.sql (creates captures table + storage bucket)'
        });
      }
      console.log('[capture] created storage bucket', CAPTURES_BUCKET);
    }

    const photoUrl = await uploadCapturePhoto(buf, m[1] === 'jpeg' ? 'jpg' : m[1], `image/${m[1]}`);
    // Nearest zone via the SAME geoToNorm + zoneAt path the live map uses for
    // attendee dots — not the check-in zone alone (that can be stale after they
    // walk). Falls back to person.zone when there's no usable position yet.
    const zoneId = captureZoneId(gate.person);
    const row = {
      venue_id: id,
      venue_name: v.name || id,
      lat, lon,
      photo_url: photoUrl,
      energy, sync, arousal,
      vibe_label: label,
      captured_by: capturedBy,
      zone_id: zoneId
    };
    const { data, error } = await supabaseAdmin.from('captures').insert(row).select().single();
    if (error) {
      console.log('[capture] insert fail:', error.message);
      const hint = /could not find the table|schema cache/i.test(error.message || '')
        ? ' — run supabase/schema.sql in the Supabase SQL editor'
        : /zone_id|column/i.test(error.message || '')
          ? ' — run: alter table public.captures add column if not exists zone_id text;'
          : '';
      return res.status(500).json({ error: error.message + hint });
    }
    const proxied = withProxiedPhoto(data);
    console.log('[capture] ok', data.id, id, label,
      `zone=${zoneId || 'none'}`,
      `e=${energy.toFixed(2)} s=${sync.toFixed(2)} a=${arousal.toFixed(2)} bytes=${buf.length}`);
    io.emit('capture', proxied);                  // city.html updates live
    res.json({ ok: true, capture: proxied });
  } catch (e) {
    console.log('[capture] fail:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Same-origin photo bytes. Service role can read even when the public URL 403s.
app.get('/api/captures/:id/photo', async (req, res) => {
  if (!capturesAvailable()) return res.status(503).send('captures unavailable');
  const id = String(req.params.id || '').slice(0, 64);
  if (!supabaseAdmin) {
    const row = localCaps.one.get(id);
    // serve only names our uploader mints — no path traversal via the db
    if (!row || !/^[0-9]+-[a-f0-9]+\.(png|jpe?g|webp)$/i.test(row.photo_file || ''))
      return res.status(404).send('not found');
    const p = path.join(CAPTURES_DIR, row.photo_file);
    if (!fs.existsSync(p)) return res.status(404).send('missing file');
    const ext = row.photo_file.split('.').pop().toLowerCase();
    res.set('Cache-Control', 'public, max-age=86400');
    res.type(ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png');
    return res.send(fs.readFileSync(p));
  }
  try {
    const { data: row, error } = await supabaseAdmin
      .from('captures')
      .select('photo_url')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      console.log('[capture] photo meta fail:', error.message);
      return res.status(500).send('lookup failed');
    }
    if (!row || !row.photo_url) return res.status(404).send('not found');
    const key = captureStorageKey(row.photo_url);
    if (!key) {
      console.log('[capture] bad photo url for', id, '—', String(row.photo_url).slice(0, 120));
      return res.status(404).send('bad photo url');
    }
    const { data: blob, error: dErr } = await supabaseAdmin.storage
      .from(CAPTURES_BUCKET)
      .download(key);
    if (dErr || !blob) {
      console.log('[capture] photo download fail:', dErr && dErr.message, 'key=', key);
      return res.status(404).send('missing file');
    }
    const buf = Buffer.from(await blob.arrayBuffer());
    const ext = (key.split('.').pop() || '').toLowerCase();
    const type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'webp' ? 'image/webp'
      : 'image/png';
    res.set('Cache-Control', 'public, max-age=86400');
    res.type(type);
    res.send(buf);
  } catch (e) {
    console.log('[capture] photo exception:', e.message);
    res.status(500).send('error');
  }
});

// Public artifact — last 200 captures across every venue, newest first.
// Optional ?venue=<id> scopes to one venue (still open — viewing needs no check-in).
// Brief retries: undici "fetch failed" to Supabase is usually a transient DNS/IPv6 blip.
async function listCaptures(limit, venueFilter) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let q = supabaseAdmin
      .from('captures')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (venueFilter) q = q.eq('venue_id', venueFilter);
    const { data, error } = await q;
    if (!error) return { data, error: null };
    lastErr = error;
    const transient = /fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND/i.test(error.message || '');
    if (!transient || attempt === 2) break;
    await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
  }
  return { data: null, error: lastErr };
}

app.get('/api/captures', async (req, res) => {
  if (!capturesAvailable()) {
    return res.status(503).json({ error: 'captures unavailable — no Supabase and no local database', captures: [] });
  }
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const venueFilter = String(req.query.venue || '').trim().slice(0, 40);
  if (!supabaseAdmin) {
    const rows = venueFilter ? localCaps.listVenue.all(venueFilter, limit) : localCaps.list.all(limit);
    return res.json({ captures: rows.map(withProxiedPhoto), venue: venueFilter || null });
  }
  try {
    const { data, error } = await listCaptures(limit, venueFilter);
    if (error) {
      const cause = error.cause && (error.cause.code || error.cause.message);
      console.log('[capture] list fail:', error.message, cause ? '(' + cause + ')' : '');
      return res.status(500).json({ error: error.message, captures: [] });
    }
    res.json({
      captures: (data || []).map(withProxiedPhoto),
      venue: venueFilter || null
    });
  } catch (e) {
    const cause = e.cause && (e.cause.code || e.cause.message);
    console.log('[capture] list exception:', e.message, cause ? '(' + cause + ')' : '');
    res.status(500).json({ error: e.message, captures: [] });
  }
});

// Mock/future CrowdState -> deterministic target/ranking -> optional server-side
// OpenAI final judge. This endpoint never receives audio and never exposes a key.
app.get('/api/dj/scenarios', (_, res) => res.json({
  scenarios: Object.keys(MOCK_SCENARIOS),
  profileSource: path.relative(__dirname, djProfilePath),
  songCount: djSongs.length
}));

app.post('/api/dj/select', async (req, res) => {
  if (!djSongs.length) return res.status(503).json({ error: 'song profile database is unavailable' });
  try {
    const input = req.body || {};
    const crowdState = input.crowdState || getMockScenario(input.scenario || 'dancingGrowing');
    const currentSong = input.currentSongId ? djSongIndex.get(input.currentSongId) : null;
    if (input.currentSongId && !currentSong) throw new Error(`unknown currentSongId: ${input.currentSongId}`);
    const requestedRecentIds = input.recentSongIds || [];
    if (!Array.isArray(requestedRecentIds)) throw new Error('recentSongIds must be an array');
    const recentHistory = resolveSongIds(requestedRecentIds, djSongIndex);
    if (recentHistory.length !== requestedRecentIds.length) throw new Error('one or more recentSongIds are unknown');

    const useAI = input.useAI === true;
    const aiAuthorized = useAI && authorizedDjAI(req.get('x-dj-token'));
    let aiSelector = null;
    if (aiAuthorized) {
      try { aiSelector = new OpenAISelector(); }
      catch (_) { /* engine reports deterministic fallback without exposing secrets */ }
    }
    const decision = await selectNextSong({
      crowdState,
      songs: djSongs,
      currentSong,
      recentHistory,
      useAI,
      aiSelector,
      selectionMode: input.selectionMode,
      guidanceStrength: input.guidanceStrength
    });
    if (decision.aiError) decision.aiError = 'AI unavailable or failed; deterministic fallback used';
    return res.json(decision);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});
// ----------------------------------------------------- live crowd → DJ
// The bridge the DJ engine was waiting for: a real CrowdState built from the
// sensors instead of a mock scenario. Every dimension is an honest proxy and
// says so — this mapping is the product, keep it inspectable:
//   energy     mean per-person movement energy (already 0..1)
//   rhythm     the sync metric — the room moving as one body is the closest
//              live observable to "moving in rhythm"
//   clustering Herfindahl concentration of people across zones, normalized
//   volume     mean mic RMS from the snapshot store's last 90s (phones
//              measure the actual room); host's own audio level as fallback
//   mobility   steps per person per minute over the last minute, ~40/min = 1
//   *Trend     0.5 flat, 1 rising, 0 falling — each metric now vs ~60s ago
const djHist = [];                                  // {t, energy, rhythm, clustering, volume, mobility}
function djMetricsNow() {
  const list = [...attendees.values()].filter(alive);
  const zc = Object.values(zoneCounts());
  const total = zc.reduce((s, z) => s + z.n, 0);
  const K = Math.max(zc.length, 1);
  let clustering = 0;
  if (total && K > 1) {
    const hhi = zc.reduce((s, z) => s + (z.n / total) ** 2, 0);
    clustering = clamp((hhi - 1 / K) / (1 - 1 / K), 0, 1);
  }
  let volume = clamp((frame.level || 0), 0, 1), volumeFrom = 'host-audio';
  if (snapStmts) {
    try {
      const row = snapStmts.recentAudio.get(new Date(Date.now() - 90000).toISOString());
      if (row && row.n > 0 && row.rms != null) { volume = clamp(row.rms * 4, 0, 1); volumeFrom = `phone-mics (${row.n} readings)`; }
    } catch {}
  }
  const steps = list.reduce((s, p) => s + (p.steps || 0), 0);
  const old = djHist.find(h => h.t <= Date.now() - 55000) || djHist[0];
  const stepsPerMin = old && list.length
    ? Math.max(0, steps - old.steps) / ((Date.now() - old.t) / 60000) / list.length
    : 0;
  return {
    t: Date.now(), steps,
    energy: clamp(crowd.energy, 0, 1),
    rhythm: clamp(crowd.sync, 0, 1),
    clustering, volume, volumeFrom,
    mobility: clamp(stepsPerMin / 40, 0, 1),
    stepsPerMin
  };
}
function computeCrowdState() {
  const now = djMetricsNow();
  const then = djHist.find(h => h.t <= now.t - 55000) || djHist[0] || now;
  const trend = (a, b) => clamp(0.5 + (a - b) * 2, 0, 1);
  const cs = {
    energy: now.energy, rhythm: now.rhythm, clustering: now.clustering,
    volume: now.volume, mobility: now.mobility,
    energyTrend: trend(now.energy, then.energy),
    rhythmTrend: trend(now.rhythm, then.rhythm),
    clusteringTrend: trend(now.clustering, then.clustering),
    mobilityTrend: trend(now.mobility, then.mobility),
    volumeTrend: trend(now.volume, then.volume),
    timestamp: now.t
  };
  if (Number.isFinite(music.bpm) && music.bpm > 0) cs.currentBpm = music.bpm;
  return { crowdState: cs, sources: { volumeFrom: now.volumeFrom, stepsPerMin: +now.stepsPerMin.toFixed(1) } };
}

// Audio files for the profiled songs live in songs/ (gitignored). A profile
// plays when a file's name matches its id or title; everything else still
// ranks — it just can't be auto-played.
const SONGS_DIR = process.env.SONGS_DIR || path.join(__dirname, 'songs');
const AUDIO_EXT = /\.(mp3|m4a|wav|flac|ogg)$/i;
// One directory read per call site, matched against every profile — id,
// title, and "artist - title" all count, since tags and filenames disagree
// in the wild.
function audioIndex() {
  let files = [];
  try { files = fs.readdirSync(SONGS_DIR).filter(f => AUDIO_EXT.test(f)); } catch {}
  const slugs = files.map(f => ({ f, s: slug(f.replace(AUDIO_EXT, '')) }));
  return song => {
    const want = [slug(song.id), slug(song.title), slug(`${song.artist} ${song.title}`)]
      .filter(w => w && w.length >= 3);
    const hit = slugs.find(({ s }) => want.some(w => s === w || s.includes(w) || w.includes(s)));
    return hit ? '/songs/' + encodeURIComponent(hit.f) : null;
  };
}
app.use('/songs', express.static(SONGS_DIR));

// Live tiles + sparklines for the DJ tab. Polled while the tab is open.
app.get('/api/dj/crowdstate', (_, res) => {
  const { crowdState, sources } = computeCrowdState();
  const list = [...attendees.values()].filter(alive);
  const withHr = list.filter(p => p.hr);
  res.json({
    crowdState, sources,
    live: {
      count: list.length,
      avgEnergy: +crowd.energy.toFixed(3),
      avgHr: withHr.length ? Math.round(withHr.reduce((s, p) => s + p.hr, 0) / withHr.length) : null,
      hrCount: withHr.length,
      avgSteps: list.length ? Math.round(list.reduce((s, p) => s + (p.steps || 0), 0) / list.length) : 0,
      stepsPerMin: sources.stepsPerMin,
      located: crowd.located,
      sync: +crowd.sync.toFixed(3),
      arousal: +crowd.arousal.toFixed(3)
    },
    history: djHist.slice(-90).map(h => ({ t: h.t, energy: +h.energy.toFixed(3), rhythm: +h.rhythm.toFixed(3),
      clustering: +h.clustering.toFixed(3), volume: +h.volume.toFixed(3), mobility: +h.mobility.toFixed(3) }))
  });
});

// The auto-DJ's one call: the moment (live CrowdState) in, the decision out.
// Deterministic by design — the AI judge stays behind its token on
// /api/dj/select; a dead OpenAI must never stall the night's playlist.
app.post('/api/dj/next', (req, res) => {
  if (!djSongs.length) return res.status(503).json({ error: 'song profile database is unavailable' });
  const input = req.body || {};
  const { crowdState, sources } = computeCrowdState();
  const currentSong = input.currentSongId ? djSongIndex.get(input.currentSongId) || null : null;
  const recentHistory = (Array.isArray(input.recentSongIds) ? input.recentSongIds : [])
    .map(id => djSongIndex.get(id)).filter(Boolean);
  selectNextSong({ crowdState, songs: djSongs, currentSong, recentHistory, useAI: false })
    .then(decision => {
      const match = audioIndex();
      const candidates = decision.candidates.map(c => ({
        id: c.song.id, title: c.song.title, artist: c.song.artist, bpm: c.song.bpm,
        energy: c.song.energy, danceability: c.song.danceability, valence: c.song.valence,
        socialness: c.song.socialness, intensity: c.song.intensity,
        score: +c.score.toFixed(4), reasons: c.reasons,
        audioUrl: match(c.song)
      }));
      res.json({
        crowdState, sources,
        target: decision.target,
        candidates,
        selected: { ...candidates.find(c => c.id === decision.selectedSong.id) },
        selectionMethod: decision.selectionMethod,
        // playable measured across the WHOLE library, not the top candidates —
        // this number is what tells the host whether tonight can actually play
        library: { count: djSongs.length, playable: djSongs.filter(s => match(s)).length,
                   example: DJ_USING_EXAMPLE }
      });
    })
    .catch(e => res.status(500).json({ error: e.message }));
});

// Fixed public origin for QR posters. PUBLIC_URL wins; on Render,
// RENDER_EXTERNAL_URL is injected automatically so QR codes work without a
// second manual step once the service has a hostname.
function configuredPublicUrl() {
  const u = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
  return u ? u.replace(/\/+$/, '') : '';
}

// What a phone should type to reach us. Fixed PUBLIC_URL / RENDER_EXTERNAL_URL
// wins; otherwise trust the proxy headers, because a tunnel terminates TLS and
// forwards plain HTTP — so req.headers.host is the public hostname while the
// scheme looks like http. Hardcoding http:// there produced a QR that pointed
// at an HTTPS-only host and silently killed the sensors.
function publicOrigin(req) {
  const fixed = configuredPublicUrl();
  if (fixed) return fixed;
  const fwd = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const proto = fwd || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}

// A QR is only as good as the URL inside it, and the two ways it goes wrong —
// localhost, or plain http — are both invisible until phones fail in the room.
function originProblem(origin) {
  if (/^https?:\/\/(localhost|127\.|\[?::1)/i.test(origin))
    return 'This points at localhost. Only this machine can open it — a phone resolves localhost to itself. Run "npm run dev" (it starts the tunnel automatically once cloudflared is installed via "npm run get-tunnel").';
  if (origin.startsWith('http://'))
    return 'This is plain HTTP. Phones will check in and then report 0.00 movement forever, because motion and GPS are blocked outside a secure context.';
  return null;
}

// The address phones can actually reach, and what's wrong with it if anything.
// The dashboard's QR modal asks here instead of trusting location.origin —
// the server knows about PUBLIC_URL / the tunnel; the browser only knows how
// it happened to be opened.
app.get('/public-url', (req, res) => {
  const origin = publicOrigin(req);
  res.json({ origin, fixed: !!configuredPublicUrl(), problem: originProblem(origin) });
});

const qrUrlFor = (req, opts = {}) => {
  const q = new URLSearchParams();
  if (opts.venue) q.set('v', opts.venue);
  if (opts.zone) q.set('zone', opts.zone);
  const qs = q.toString();
  return `${publicOrigin(req)}/join.html${qs ? '?' + qs : ''}`;
};
const qrSvg = url => QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#0A0C14', light: '#FFFFFF' } });

// The single event-wide poster. No zone in the URL — GPS resolves it, and
// anyone whose GPS never gets a usable fix stays in the check-in zone.
// Registered before /qr/:zone.svg because that pattern would swallow it.
app.get('/qr/event.svg', async (req, res) => res.type('svg').send(await qrSvg(qrUrlFor(req))));

// Every venue has its own QR from the moment it's saved — the id rides in the
// URL so a poster printed for one venue stays that venue's poster.
app.get('/qr/venue/:id.svg', async (req, res) => {
  if (!venues.has(req.params.id)) return res.status(404).json({ error: 'no such venue' });
  res.type('svg').send(await qrSvg(qrUrlFor(req, { venue: req.params.id })));
});

app.get('/qr/:zone.svg', async (req, res) =>
  res.type('svg').send(await qrSvg(qrUrlFor(req, { zone: req.params.zone }))));

// Printable poster, and the honest answer to "will this QR actually work?" —
// it shows the encoded URL as text and refuses to look fine when it isn't.
app.get('/qr', async (req, res) => {
  const zone = req.query.zone ? String(req.query.zone) : '';
  const forVenue = req.query.v ? venues.get(String(req.query.v)) : null;
  const url = qrUrlFor(req, { zone, venue: forVenue && forVenue.id });
  const problem = originProblem(url);
  const z = zone && !forVenue && zoneById[zone];
  res.type('html').send(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Pulse — check-in poster</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Space+Grotesk:wght@400;600;700&display=swap" rel="stylesheet">
<style>
 body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#fff;color:#0A0C14;
      font-family:'Space Grotesk',system-ui,sans-serif;
      padding:max(20px,env(safe-area-inset-top)) 16px max(24px,env(safe-area-inset-bottom))}
 .card{max-width:min(620px,100%);width:100%;text-align:center}
 h1{font-size:clamp(26px,8vw,40px);margin:0 0 6px;letter-spacing:-.02em;line-height:1.15;word-break:break-word}
 .sub{font-size:clamp(15px,4vw,17px);color:#5A6070;margin:0 0 22px;line-height:1.4}
 .qr{width:min(78vw,380px);max-width:100%;height:auto;display:block;margin:0 auto}
 .url{font-family:'IBM Plex Mono',monospace;font-size:13px;color:#5A6070;margin-top:18px;word-break:break-all;line-height:1.45;padding:0 4px}
 .warn{margin-top:20px;padding:14px 15px;border-radius:11px;text-align:left;
       background:#FFF3E0;border:1px solid #F0A93B;color:#6B4A12;font-size:14px;line-height:1.55;
       overflow-wrap:anywhere}
 .ok{margin-top:20px;font-family:'IBM Plex Mono',monospace;font-size:13px;color:#2E9E6B}
 @media print{.warn{border-color:#999;background:#fff}.noprint{display:none}}
</style>
<div class="card">
  <h1>${z ? z.label : forVenue ? forVenue.name : venue.name}</h1>
  <p class="sub">Scan to join${z ? '' : ' — your zone updates as you move'}</p>
  ${await qrSvg(url).then(s => s.replace('<svg', '<svg class="qr"'))}
  <div class="url">${url}</div>
  ${forVenue && forVenue.id !== activeId
    ? `<div class="warn"><b>“${forVenue.name}” is not the live venue.</b><br>Scanning this QR will say “This venue isn't live right now” until you make it active.</div>` : ''}
  ${problem
    ? `<div class="warn"><b>This QR will not work for phones.</b><br>${problem}</div>`
    : `<div class="ok">HTTPS · reachable from any phone</div>`}
</div>`);
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
const M_PER_DEG = 111320;                        // GEO is set by setActive()

const GPS_MAX_ACCURACY = 25;   // metres — ignore fixes vaguer than this
const NEAREST_MAX_M    = 18;   // don't claim a zone from further away than this
const ZONE_SWITCH_VOTES = 3;   // consecutive agreeing fixes before switching zone
// Fast path, re-measured rather than loosened blindly: at ±5m a single fix
// names the wrong zone 5.8% of the time, so TWO consecutive agreeing good
// fixes are wrong together ~0.3% — safer than three votes at ±8m (17.3%³).
// So when both this fix and the previous one are ≤ GOOD_ACC, two votes are
// enough and a walk into the next zone registers in 2s instead of 3-4.
const GOOD_ACC = 6;            // metres — a fix this sharp earns the fast path
const ZONE_SWITCH_VOTES_GOOD = 2;

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

// Capture-time zone: identical nearest-zone logic the live dashboard already
// trusts (geoToNorm + zoneAt + NEAREST_MAX_M). Prefer a fresh GPS fix; else the
// eased anchor the map draws; else the voted/check-in zone.
function captureZoneId(person) {
  if (!person || !venue) return null;
  let x = null, y = null;
  if (person.gps && person.gpsNote == null
      && typeof person.gps.lat === 'number' && typeof person.gps.lon === 'number') {
    const n = geoToNorm(person.gps.lat, person.gps.lon);
    if (n && pointInPolygon(n.x, n.y, venue.outline)) { x = n.x; y = n.y; }
  }
  if (x == null && person.anchor
      && typeof person.anchor.x === 'number' && typeof person.anchor.y === 'number') {
    x = person.anchor.x; y = person.anchor.y;
  }
  if (x != null && y != null && GEO) {
    const hit = zoneAt(x, y);
    if (hit && (hit.inside || hit.d <= NEAREST_MAX_M)) return hit.id;
  }
  return person.zone || null;
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

  // Check-in. Event-wide QR omits venue → join the live venue (GPS places the
  // zone). Per-venue QR passes v=<id>: must exist and must be the live venue,
  // otherwise the phone gets a clear error instead of silently landing on the
  // wrong map. One active venue drives the dashboard; we do not support
  // multiple simultaneously-live venues.
  socket.on('join', ({ id, name, zone, venue: requestedVenue }, ack) => {
    const want = requestedVenue != null && String(requestedVenue).trim()
      ? String(requestedVenue).trim() : null;
    if (want) {
      if (!venues.has(want)) {
        if (ack) ack({ ok: false, error: 'Venue not found' });
        return;
      }
      if (want !== activeId) {
        if (ack) ack({ ok: false, error: 'This venue isn\'t live right now' });
        return;
      }
    }

    const pid = id || socket.id;
    const z = zoneById[zone] ? zone : defaultZone();
    const existing = attendees.get(pid);
    const person = existing || {
      id: pid, name: (name || 'Guest').slice(0, 24), joinedAt: Date.now(),
      energy: 0, hr: null, hrBaseline: null, hrSamples: [], seed: Math.random(), team: 'Guest',
      gps: null, gpsNote: null, zoneCand: null, zoneVotes: 0, steps: 0, distance: 0
    };
    if (name) person.name = name.slice(0, 24);
    if (!existing || person.zone !== z) person.anchor = anchorInZone(z);
    person.zone = z; person.lastSeen = Date.now();
    // want is either null (event QR → live) or equals activeId (venue QR).
    person.venueId = activeId;                   // capture gated to this venue
    attendees.set(pid, person);
    socket.data.pid = pid;
    if (ack) ack({
      ok: true, id: pid, zone: z, zoneLabel: zoneById[z].label,
      venueId: activeId, venueName: venue && venue.name
    });
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

    // Real position drives the dot, eased so GPS jitter doesn't make it
    // twitch — but eased ADAPTIVELY, or walking feels like wading:
    //   far from the anchor (>30m)  → 0.85, basically snap; that's a real
    //                                 move, not jitter at any accuracy
    //   sharp fix (≤8m)             → 0.55, trust it
    //   ordinary fix                → 0.35, the original smoothing
    const acc = p.gps.accuracy != null ? p.gps.accuracy : 15;
    const dm = Math.hypot((n.x - p.anchor.x) * GEO.spanX, (n.y - p.anchor.y) * GEO.spanY);
    const k = dm > 30 ? 0.85 : acc <= 8 ? 0.55 : 0.35;
    p.anchor = { x: lerp(p.anchor.x, n.x, k), y: lerp(p.anchor.y, n.y, k) };

    const goodNow = acc <= GOOD_ACC;
    const votesNeeded = (goodNow && p.prevFixGood) ? ZONE_SWITCH_VOTES_GOOD : ZONE_SWITCH_VOTES;
    p.prevFixGood = goodNow;

    const hit = zoneAt(n.x, n.y);
    if (!hit || hit.id === p.zone || hit.d > NEAREST_MAX_M) { p.zoneCand = null; p.zoneVotes = 0; return; }
    if (p.zoneCand === hit.id) p.zoneVotes++;
    else { p.zoneCand = hit.id; p.zoneVotes = 1; }
    if (p.zoneVotes >= votesNeeded) { p.zone = hit.id; p.zoneCand = null; p.zoneVotes = 0; }
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

setInterval(() => {
  computeCrowd();
  // the DJ's rolling memory — trends need a minute of past to compare against
  djHist.push(djMetricsNow());
  if (djHist.length > 200) djHist.shift();
}, 2000);
setInterval(() => io.emit('state', publicState()), 400);

// -------------------------------------------------------------- fake data
const FIRST = ['Ava','Noah','Mia','Kai','Zoe','Leo','Ivy','Max','Nia','Eli','Sam','Rae','Jun','Ada','Ozzy','Lux','Wren','Theo','Nova','Finn','Amara','Dev','Priya','Omar','Yuki','Sana','Cole','Tariq','Elena','Jae','Marco','Hana','Ruth','Ben','Sofia','Idris','Mei','Luca','Nadia','Ezra','Talia','Rhys','Anya','Kofi','Lena','Sid','Bea','Otto','Rina','Jonas','Zara','Pax','Ines','Vik','Noor','Emre','Cleo','Dara'];
const TEAMS = ['Latency','Nightshift','Kernel Panic','Bitrate','Overclock','Half-Life','Downtime','Sudo','Segfault','Null Pointer'];
// event zones pull hardest, food spikes at meal times, outdoor is a slow trickle
const WEIGHTS = { event: 5.0, social: 2.2, food: 1.6, market: 1.0, outdoor: 0.7, transit: 0.4 };

// Runtime-editable from the dashboard's Venues tab. FAKE/FAKE_N still set the
// starting point so the existing env vars keep working.
let crowdCfg = { n: FAKE ? FAKE_N : 0, liveliness: 0.7, hrPct: 0.42, spread: 'capacity' };

// weight by kind AND capacity, so the big session halls actually fill up
// instead of every zone getting an identical slice
function weightedZone() {
  const pool = [];
  venue.zones.forEach(z => {
    const w = crowdCfg.spread === 'even' ? 1
            : Math.round((WEIGHTS[z.kind] || 1) * Math.sqrt(z.cap || 30));
    for (let i = 0; i < Math.max(1, w); i++) pool.push(z.id);
  });
  return pick(pool);
}

// Rebuilt whenever the crowd settings change or a different venue goes live —
// sim people hold zone ids, so they can't survive a venue switch.
function rebuildCrowd() {
  for (const [id, p] of attendees) if (p.sim) attendees.delete(id);
  for (let i = 0; i < crowdCfg.n; i++) {
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
      hasHr: Math.random() < crowdCfg.hrPct,
      // they've been on site a while, so they arrive with a plausible step count
      steps: Math.round(400 + Math.random() * 5200), distance: 0,
      // most phones report a usable fix; a few sit in the weak/no-fix state so
      // the dashboard shows what the real mix looks like
      gps: null, gpsNote: null, hasGps: Math.random() < 0.82
    });
  }
  console.log(`Fake crowd: ${crowdCfg.n} attendees in ${venue.name}`);
}

{
  let phase = 0;
  setInterval(() => {
    phase += 0.010;
    const room = ((Math.sin(phase) * 0.5 + 0.5) * 0.7 + 0.15) * (crowdCfg.liveliness / 0.7);
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
}

loadVenues();
setActive(process.env.VENUE && venues.has(process.env.VENUE) ? process.env.VENUE
                                                            : [...venues.keys()][0]);
rebuildCrowd();

// A port clash otherwise surfaces as an unhandled 'error' event and ten lines
// of stack, which reads like the app is broken rather than "something else is
// already there" — and the old server keeps answering, so /ai and the dashboard
// look fine while your new settings never loaded.
server.on('error', e => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`\n  Port ${PORT} is already in use — an older copy is probably still running.`);
  console.error(`  Anything you check on that port is being answered by THAT server, not this one.\n`);
  console.error(`  Find it:  netstat -ano | findstr :${PORT}`);
  console.error(`  Stop it:  taskkill /PID <pid> /F`);
  console.error(`  Or just:  set PORT=3001 && node server.js\n`);
  process.exit(1);
});

server.listen(PORT, () => {
  const pub = configuredPublicUrl();
  console.log(`\n  Venue      ${venue.name}  (${venues.size} available, active: ${activeId})`);
  console.log(`  Home       http://localhost:${PORT}/`);
  console.log(`  Dashboard  http://localhost:${PORT}/dashboard.html`);
  console.log(`  Owner      http://localhost:${PORT}/owner.html`);
  console.log(`  Phone      http://localhost:${PORT}/join.html`);
  console.log(`  City map   http://localhost:${PORT}/city.html`);
  console.log(`  QR poster  http://localhost:${PORT}/qr/event.svg`);
  console.log(`  QR page    http://localhost:${PORT}/qr`);
  console.log(`  Auth       mode=${AUTH_MODE}${AUTH_ENABLED ? ' (venue writes gated)' : ''}`);
  console.log(`  Crowd      FAKE=${FAKE ? 'on' : '0'} (n=${crowdCfg.n})`);
  console.log(pub
    ? `\n  QR codes encode ${pub} (${process.env.PUBLIC_URL ? 'PUBLIC_URL' : 'RENDER_EXTERNAL_URL'})\n`
    : `\n  PUBLIC_URL is not set, so QR codes encode whatever address you opened\n` +
      `  the page with. On Render, RENDER_EXTERNAL_URL is used automatically;\n` +
      `  locally, run npm run dev (tunnel) or set PUBLIC_URL yourself.\n`);
});
