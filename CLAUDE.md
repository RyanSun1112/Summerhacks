# Pulse

Live venue dashboard for a hackathon at STACKT Market, Toronto. Phones report movement (and optional heart rate); the host dashboard shows everyone on a map of the real site. The colour palette is derived from the music in real time.

Hackathon project, <24h build. Bias toward demo reliability over correctness or completeness.

## Hard constraints — do not relitigate these

**No build step.** Plain Node + Express + Socket.io serving static HTML with vanilla JS and canvas. No bundler, no framework, no TypeScript. This is deliberate: at 3am a broken bundler config costs hours we don't have. Do not introduce React/Vite/Next unless explicitly asked.

**Sensors require HTTPS.** `DeviceMotionEvent` and Web Bluetooth are hard-blocked on plain HTTP. Phones check in fine and then report `0.00` movement forever with no error in any console. This is the #1 failure mode. Dev via `cloudflared tunnel --url http://localhost:3000` and pass `PUBLIC_URL` so QR codes encode the tunnel host, not localhost.

**iOS has no Web Bluetooth.** Heart rate works only on Chrome/Android and desktop. Movement energy must remain the primary signal and every metric must degrade gracefully when `hr` is null. Never make HR load-bearing. **The phone UI no longer offers HR pairing at all** (decided 2026-08-08: replaced by a sound-level tile off the mic RMS already collected). The `hr` socket path, baselines and the ring visual all remain — fed by the simulator — so reinstating a real HR source is one button, not a rebuild.

**iOS motion needs a user gesture.** `DeviceMotionEvent.requestPermission()` must be called inside a real tap handler. Don't move it into page load.

**Spotify is not an option.** Spotify blocked new API apps from the Audio Features, Audio Analysis, and Recommendations endpoints in Nov 2024, with no replacement. Don't propose it for BPM/energy metadata.

## Conventions

- All venue geometry is normalized 0–1. Never hardcode coordinates in the clients.
- **Venues are plural now.** They live as JSON in `venues/`, seeded from `venue.json` on first boot; `venue.json` is the committed built-in and is never written to. The active one is swapped at runtime by `setActive()`, so `venue`, `zoneById` and `GEO` are mutable — don't turn them back into boot-time `const`s.
- Only `outline`, `zones`, `aspect` and `name` are guaranteed. `containers`, `route`, `streets` and `entrances` exist on STACKT but not on anything built in the editor — guard every one of them before iterating, or the map throws on a new venue. This bit join.html for real: an unguarded `venue.containers.forEach` killed the phone's whole draw loop on editor-built venues, showing outline-only maps in the room. Nothing on a phone may assume STACKT fields, and no client page may hardcode the venue name — it comes from the `venue` socket event.
- Nothing may assume a zone id exists. `entrance1` is STACKT-specific; use `defaultZone()`, which prefers a `transit` zone and falls back to the first.
- **AI keys stay server-side.** The dashboard is served over a public tunnel, so anything in client JS is public — and OpenAI keys are billable. The browser posts the image to `POST /detect` and the server calls the model. Never move a key into a page.
- OpenAI and Gemini are both supported behind one interface (`askOpenAI` / `askGemini`, both returning raw JSON text). Adding a provider means adding one function and a schema, not touching `/detect`. Note the schema dialects differ: Gemini wants uppercase type names, OpenAI strict mode requires `additionalProperties:false` and every property in `required`.
- **The vision model is chosen by measurement, not vintage.** Every model tried finds the rooms and labels them right; they differ almost entirely in how tightly the boxes land, which is the only thing zone accuracy depends on. Scored as IoU against known room boxes: gpt-5.4 ≈0.91, gpt-5.6-* ≈0.90, gpt-5 ≈0.58, gpt-4o ≈0.47. gpt-5.4 is also the fastest and cheapest of the accurate ones. Don't change the default on the strength of a version number — re-run the comparison.
- **Never trust model geometry.** `repairGeometry()` clamps, de-overlaps, drops degenerates, coerces `kind` and de-duplicates ids before anything reaches `validateVenue`. A vision model returns plausible rectangles, not valid ones.
- AI detection must stay optional. No key → the local reader is selected and the AI option disables itself; any API failure falls back to local with the reason shown. Don't make the editor depend on the network.
- `validateVenue()` enforces the geometry rules (corners inside the outline, no overlaps, unique ids) instead of leaving them to memory. The editor mirrors it client-side to flag zones as you draw.
- `venue.png` is the source floor plan the geometry was traced from. Check any geometry change against it.
- After editing `venue.json`, verify every zone corner falls inside the `outline` polygon and no two zones overlap. Broken geometry renders as zones floating outside the site.
- Phones send **one summarised float per 500ms**, never raw accelerometer samples. Raw 30Hz from 100 phones melts the server. GPS is throttled separately to one fix per second; step count rides on the accelerometer stream that's already being sampled.
- **The one sanctioned exception is the snapshot batch.** For the research store, phones capture 5s of raw readings at ~10 Hz (accel x/y/z, orientation α/β/γ, mic RMS) and upload them as ONE `POST /api/snapshots` every 30s — a batch, never a stream. Don't shorten the cadence or raise the rate without redoing the arithmetic (100 phones ≈ 3.3 req/s, ~170 rows/s as shipped).
- **The snapshot store is the collaborator's schema, verbatim.** `backend/data.db`, tables `snapshots` + `snapshot_readings`, same routes as `backend/app.py` (`/api/snapshots[.csv]`, `/api/snapshots/:id`, `/api/health`) now served by server.js so one server and one tunnel carry everything; the Flask app and Python's sqlite3 read the identical file (tested). `session_id` is the anonymous `pulse:id`, never a name. Pin `better-sqlite3@11` — v12+ segfaults on Node 20 — and the store loads inside try/catch: a broken native module logs `[data] DISABLED` and the demo boots anyway. Never make boot depend on it.
- Static files are served from `public/`. `server.js` and `venue.json` stay at the repo root and are deliberately not web-reachable.
- Live crowd state is in-memory only and dies with the process. No database for live state — this is intentional. The SQLite snapshot store is the deliberate exception: recorded research data, worthless if it dies with the process.
- **Venue-owner auth has three modes**, picked at boot: `local` (default — accounts + ownership in `data/owners.json`, scrypt-hashed, endpoints under `/auth/*`), `supabase` (all three `SUPABASE_*` set; ownership in its `venue_owners` table), `off` (`AUTH_MODE=off`). Gate create/update/delete/plan uploads — never join.html or the live map/metrics pipeline. Service role key is server-only; clients learn the mode via `GET /auth/config`. The sign-in UI lives in the dashboard itself (modal, session shared with owner.html via localStorage `pulseOwnerSession`); don't reintroduce a redirect to a separate login page mid-save.
- **`GET /venues` is scoped to the asker** when auth is on: signed out → the LIVE venue only (always public — it's the projector); signed in → also own venues + unclaimed ones. Other accounts' venues are filtered out. This is list tidiness, not secrecy — `GET /venues/:id` stays public because the map needs geometry, and writes are what ownership protects. Clients must send the Bearer token with the list fetch and re-fetch it on sign-in/out, or the rail shows a stale scope.
- **Showing a stylesheet-hidden element needs an explicit inline value.** `el.style.display=''` only clears the inline style, so a CSS `display:none` rule wins again — this kept the Sign in chip invisible for an evening while the test suite passed, because the test asserted the inline style instead of `getComputedStyle`. UI-visibility assertions must use computed style.
- **Auth failures must be loud.** The original owner page hung on "Creating account…" forever when auth wasn't configured (null client, uncaught async throw). Every auth path needs: disabled buttons + on-screen reason when unavailable, a deadline on remote calls (a paused Supabase project hangs, never rejects), and errors landing in the UI rather than a dead promise.
- `/state.json` returns the exact socket broadcast payload — use it to debug rendering without a browser.

## Design system

Do not swap these for defaults; they were chosen deliberately.

- **Palette is computed, not configured.** Spectral centroid (log-scaled) picks a position on a 5-stop ramp: indigo → violet → magenta → coral → amber. Bass onset vs rolling average drives beat flash. Log scaling is required — on a linear centroid the value never leaves the bottom of the range and the palette barely moves.
- **Tone easing is `0.03`/frame.** At full speed it strobes hard enough to be unpleasant on a projector. Don't raise it.
- **Signature element: heart-rate rings.** Each dot has a ring expanding at that person's real BPM, sharp attack (`pow(1-phase, 2.6)`), long decay. When the room syncs, rings visibly fall into step. This is the demo money shot — keep it, and keep everything around it quiet.
- Type: Space Grotesk (display/UI) + IBM Plex Mono (all numbers, zone labels, tabular data). Wide-tracked uppercase for small labels.
- Only `event`-kind zones get the accent colour. Everything else stays neutral so the sessions read at a glance.

## Metrics rationale

- **`arousal` uses each person's own baseline**, not raw BPM. Resting HR runs 50–90 across a crowd, so a raw average is meaningless noise. First 45s sets a median baseline; the metric is percentage climb above it. Never change this to a raw average.
- **`sync`** = `1 - stdev(energies)/(mean+0.06)`. Measures whether the room moves as one body rather than N individuals. This is the novel metric — it's what gets pointed at when judges ask what's new.

## Bugs already fixed — don't regress these

- **Wall-clock fallback for playback.** Position originally came only from the dashboard's `<audio>`. If audio failed to load, the engine froze silently. Any playback logic needs a fallback clock.
- **Recency penalty must stay weaker than feature match.** In the earlier auto-DJ selector, a heavy recency penalty ratcheted track selection one direction through the library with no way back down when the room cooled. If auto-selection is reintroduced, keep recency weight ≈1.2 vs 2.0/1.5/0.8 on bpm/energy/valence, and scale recency memory depth to library size.
- **Fake crowd distribution is capacity-weighted** (`kindWeight * sqrt(cap)`). Without the capacity term, the 120-person North Hall showed 5 people while tiny zones looked packed.

## Current state

Built: host dashboard (map/people/zones/data/venues tabs), phone check-in + participant view, radio player on both, audio-derived palette, runtime-configurable simulator, multi-venue store with an in-dashboard editor (floor plan tracing, zone drawing, one-location GPS centring, two-point GPS calibration), venue-owner accounts (local by default, Supabase optional) with in-dashboard sign-in, per-venue check-in QR codes surfaced in a dashboard modal, and the sensor data-collection pipeline: phones auto-upload raw snapshot batches into the collaborator's SQLite schema, browsable and CSV-exportable from the Data tab, with `/sensor-test` serving the original capture page.

Also built: an offline Python song-profile generator and a deterministic-first Node
song-selection engine. The selector accepts mock/future `CrowdState`, produces an
explicit target, ranks the preprocessed library, and can optionally use a server-side
OpenAI final judge with mandatory deterministic fallback. It does not control the
host deck yet.

Positioning is GPS-based off a single event-wide QR (`/qr/event.svg`). Per-venue QRs exist too
(`/qr/venue/:id.svg`, poster `/qr?v=<id>`, dashboard "Check-in QR" modal) — the `v` param is a label,
not a router: scans always join whichever venue is live. Per-zone QRs still work and set the starting
zone. `venue.geo` maps GPS onto the normalized map via origin + span + bearing. Two calibration paths:
**one location** (editor "Where is it?" — address via `/geocode` (Nominatim, with shortened-name
retries), pasted coords, or on-site fix; centres the map there with a 120 m default width and marks
`calibrated + centered`) and **two pins** for metre accuracy (`/calibrate.html` or the editor pins).
One-location is deliberately allowed to claim `calibrated`: the outline-rejection guard means a wrong
centre degrades to "nobody moves", never "everyone scatters".

GPS is deliberately fail-safe, and these guards exist because the zones are smaller than GPS error —
do not loosen them without re-measuring:
- Fixes worse than `GPS_MAX_ACCURACY` (25m) are ignored.
- A zone change needs `ZONE_SWITCH_VOTES` (3) consecutive agreeing fixes. At ±8m accuracy this is the
  difference between a spurious zone change every 2.7 minutes and every few seconds.
- Points landing outside the `outline` polygon are rejected and the person keeps their zone. This is
  what makes an uncalibrated venue degrade into "nobody moves" rather than "everyone scatters".
- Dot position is eased at 0.35/fix toward the real position, never snapped.

Measured misassignment against the traced geometry: 1.2% at ±3m, 5.8% at ±5m, 17.3% at ±8m, 31.7% at
±12m. The short axis is the hard limit — the site is 2.884× wider than tall, so most zones are only a
few metres deep in `y`, below GPS resolution regardless of fix quality.

Deliberately not built yet:
- Real sensor-to-`CrowdState` analysis or automatic playback (music remains host-controlled). The raw
  material for it now exists in the snapshot store; the analysis itself does not.
- Persistence for live state (snapshot research data does persist, in SQLite)
- BLE trilateration and accelerometer dead reckoning — both evaluated and rejected as hackathon-infeasible.

## Verifying changes

```bash
node --check server.js
node server.js                 # 58 fake attendees by default
FAKE=0 node server.js          # real check-ins only
FAKE_N=120 node server.js
curl -s localhost:3000/state.json | python3 -m json.tool | head -40
```

There is no test suite. Verify by reading `/state.json` and by loading the dashboard.
