# Pulse — STACKT Market

A live venue dashboard where the colour scheme is generated from the music, and everyone in the room appears on a map of the actual site.

Built for Summerhacks at STACKT Market, Toronto. Plain Node + Express + Socket.io serving static HTML
with vanilla JS and canvas — **no build step, no bundler, no framework.** You edit a file and reload
the page. That's deliberate: at 3am a broken bundler config costs hours nobody has.

## Setup

You need **Node 18 or newer** and git. Check with `node --version`.

```bash
git clone https://github.com/RyanSun1112/Summerhacks.git
cd Summerhacks
npm install
node server.js
```

Then open **http://localhost:3000/dashboard.html**.

58 simulated attendees start automatically, so the dashboard is fully alive with zero phones connected
— you can develop the whole thing without touching a phone.

| URL | What it is |
|---|---|
| `/dashboard.html` | Host dashboard — map, people, zones, venues editor, radio, sign-in |
| `/owner.html` | Standalone venue-owner page (the dashboard has the same sign-in built in) |
| `/join.html` | What a phone sees after scanning |
| `/qr/event.svg` | The single event-wide QR poster |
| `/qr/venue/<id>.svg` | A specific venue's QR, e.g. `/qr/venue/stackt.svg` |
| `/qr/<zone>.svg` | Per-zone poster, e.g. `/qr/northhall.svg` |
| `/calibrate.html` | Two-point GPS calibration tool (see below) |
| `/state.json` | The exact payload broadcast to clients — curl this to debug |
| `/sensor-test` | Standalone raw-sensor capture page (writes to the same snapshot store) |
| `/api/snapshots` | The collected sensor data — see **Data collection** |

### Venue-owner accounts

Attendees on `/join.html` stay anonymous — accounts gate the **host dashboard** and venue
create/update/delete. With accounts on, opening `/dashboard.html` signed out sends you to
`/owner.html`; signing in lands you on the owner screen (your venues, unclaimed pool, **Live
dashboard** button), and signing out returns you there. An account that owns **no venues yet** gets
a dashboard with only the Venues tab, opened on a blank editor — build or claim your first venue and
the map/people/zones/data tabs unlock. This is front-door UX, not a security boundary — the live
state APIs stay open for phones. The server picks one of three modes at boot (the log says which):

- **local** — the default, zero setup. Accounts live on the Pulse server itself, in the same SQLite
  database as the collected sensor data (`backend/data.db` — passwords scrypt-hashed, never stored).
  Sign up takes ten seconds and works offline.
- **supabase** — set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` in `.env`
  (create a project, run `supabase/schema.sql`, and turn **off** Confirm email under Auth →
  Providers → Email). Accounts live in Supabase, ownership in its `venue_owners` table.
- **off** — `AUTH_MODE=off` in `.env`. No accounts; venue writes are open to anyone with the page.

Venue geometry lives as JSON in `venues/` in every mode; auth only stores *who owns which venue*.

With auth on, the venue list is **scoped to the signed-in account**: signed out you see only the
LIVE venue (it's on the projector — always public); signed in you see the live venue plus **your
own** — never another account's, and not unclaimed ones either. Ownerless venues (created before
accounts, or seeds) live in an **Unclaimed** section on `/owner.html` with a Claim button — claim
one and it's yours to edit, delete and see in your list (saving over an unclaimed venue also claims
it). This is list tidiness, not secrecy — the live map still serves the active venue's geometry to
everyone, and ownership is enforced on writes. The rail's **Owner page →** link and the account
modal both go to `/owner.html`.

Environment variables, all optional:

| Variable | Default | Does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `FAKE` | on | `FAKE=0` disables the simulated crowd |
| `FAKE_N` | `58` | How many simulated attendees |
| `PUBLIC_URL` | — | Host encoded into QR posters. Required when tunnelling |
| `DJ_PROFILES_PATH` | `data/songProfiles.json` | Override the preprocessed song-profile database
|
| `SONGS_DIR` | `data/songs` if it contains audio, otherwise `songs` | Audio directory served to Auto-DJ |
| `OPENAI_DJ_MODEL` | `gpt-5-mini` | Optional final-selector model |
| `DJ_AI_TOKEN` | — | Required in `X-DJ-Token` before the HTTP endpoint may spend AI credits |
| `OPENAI_API_KEY` | — | Enables OpenAI-backed venue-plan reading and optional DJ selection; server-side only |
| `GEMINI_API_KEY` | — | Enables venue-plan reading with Gemini. Free key from [AI Studio] (https://aistudio.google.com/apikey) |
| `AI_PROVIDER` | auto | `openai` or `gemini`. Only needed if both keys are set |
| `OPENAI_MODEL` | `gpt-5.4` | Vision model that reads the plan |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Vision model that reads the plan |
| `VENUE` | first found | Which venue to start live |
| `AUTH_MODE` | `local` | `off` opens venue writes; Supabase keys switch to hosted accounts |
| `SUPABASE_URL` + `_ANON_KEY` + `_SERVICE_ROLE_KEY` | — | All three together enable Supabase auth |

```bash
FAKE=0 node server.js            # real check-ins only
FAKE_N=120 node server.js        # bigger fake crowd
```

On **Windows PowerShell** the inline `VAR=value cmd` form doesn't work — use:

```powershell
$env:FAKE=0; node server.js
Remove-Item Env:FAKE             # undo it afterwards
```

(There used to be an `npm run sim` script that set `SIMULATE=1` — a variable the server never read. It
was removed; use the variables above.)

## Project layout

```
server.js          all server logic — sockets, metrics, GPS→zone, QR routes, fake crowd
venue.json         the venue: outline, zones, streets, entrances, GPS anchor
public/
  dashboard.html   host view (map/people/zones tabs + radio). Self-contained: markup, CSS, canvas JS
  join.html        phone view — check-in, sensors, mini map
  calibrate.html   two-point GPS calibration tool
docs/data.md       API/data notes
docs/song-preprocessing.md  offline song-profile generation
CLAUDE.md          conventions and hard constraints — read before changing architecture
```

Each HTML file is standalone: styles in a `<style>` block, logic in a `<script>` block, no imports and
no shared bundle. To change the dashboard, open `public/dashboard.html` and edit it. Reload to see it.
Only `server.js` changes need a restart.

## Offline song preprocessing

The optional Python utility analyzes legitimate local audio files before an event and
creates `data/songProfiles.json`. The live Node application consumes only that compact
profile database; it does not run librosa or call an LLM for song features. See
[the preprocessing guide](docs/song-preprocessing.md) for setup, metadata matching,
caching, audio-only testing, and full-library commands.

The private local event library is `songs/`: copy local MP3/WAV/FLAC/M4A files there
and run `python preprocess_songs.py`. Its audio contents are Git-ignored and analyzed
in place. A metadata template is available at `data/tracks.example.json`.

For a small redistribution-safe catalogue that must ship with the deployed demo,
put the files under `data/songs/` and preprocess with `--audio-dir ./data/songs`.
New profiles contain an exact `audioFile` mapping; the live server prefers that over
filename guessing and automatically serves `data/songs/` when it contains audio.

## Auto-DJ — the crowd chooses the next song

The final loop is closed: the room's sensors pick the music. Press **Auto-DJ** in the radio player
(or **Start Auto-DJ** on the DJ tab — one tap, browsers refuse audio without a gesture) and:

1. A profiled song with a matching audio file starts on the deck.
2. At the song's **midpoint**, the server captures *the moment* — a real `CrowdState` built from
   everyone's sensors: movement energy, the sync metric as rhythm, zone clustering, phone-mic
   loudness from the snapshot store, steps-per-minute as mobility, and each one's trend vs a minute
   ago.
3. The DJ engine turns that moment into a target, ranks the whole library, and queues the winner.
4. When the song ends, the queued pick plays. Repeat.

Setup: put private local tracks in `songs/`, or redistribution-safe deployed tracks in
`data/songs/`; run `python preprocess_songs.py --audio-dir <that-directory>` to build
`data/songProfiles.json`, then restart. New profiles use their exact relative `audioFile` path;
older profiles fall back to conservative title/ID matching. Until a profile and file are both
present, the track can rank but cannot play, and the DJ tab says so.

No music of your own? `node tools/fetch_cc_songs.js` fills `songs/` with ~200 Creative-Commons
electronic tracks from the Internet Archive's netlabel collections (Kahvi, Monotonik, Thinner…) —
legal to play, and the committed `data/songProfiles.json` was built from exactly that set, so after
downloading, the library plays without re-running preprocessing.

The **DJ tab** (host-only, like the whole dashboard) shows the decision being made: the song meter
with the capture marker at the midpoint, the captured moment's factors with trend arrows next to the
policy's target and what the chosen song actually delivers, every candidate's score with the
engine's reasons, and live 2-second averages of everyone's sensors with sparklines.

Selection is deterministic by design — the optional OpenAI judge stays behind `DJ_AI_TOKEN` on
`/api/dj/select`, so a dead API can cost a suggestion, never the playlist.

## Adaptive song selection

The deterministic DJ engine consumes a validated `CrowdState` and the
preprocessed profiles. It converts the room state into an explicit musical target,
ranks eligible songs, explains its scores, and optionally lets OpenAI choose among
only the top ten. AI is server-side and never required: missing keys, timeouts,
invalid output, or unknown song IDs automatically fall back to the highest numeric
score.

```bash
npm run select-song -- --scenario dancingGrowing
npm run select-song -- --scenario socializing
npm run select-song -- --scenario losingDanceFloor --json
npm run select-song -- --scenario dancingGrowing --mode match
npm run select-song -- --scenario dancingGrowing --mode blend --guidance-strength 0.35
npm run select-song -- --list-scenarios
```

Add `--ai` to request the optional final judge. Without `data/songProfiles.json`, the
CLI and API clearly fall back to fictional `data/songProfiles.example.json` records.
Selection defaults to `guide`; use `match` to mirror the current room or `blend` with
a `0`–`1` guidance strength to interpolate between matching and intervention.
The server also exposes `GET /api/dj/scenarios` and `POST /api/dj/select`; neither
route changes the currently playing track. See [the DJ selection guide](docs/dj-selection.md).

## Making changes

| To change… | Edit | Restart needed? |
|---|---|---|
| Venue geometry, zones, capacities | `venue.json` | Yes — read once at boot |
| Anything the host sees | `public/dashboard.html` | No, just reload |
| Anything a phone sees | `public/join.html` | No, just reload |
| Metrics, sockets, fake crowd | `server.js` | Yes |
| API keys, ports, model | `.env` | Yes — read once at boot |

**Use `npm run dev` while working.** It does two things: starts a cloudflared quick tunnel (when the
binary is present — fetch it once with `npm run get-tunnel`) and runs `node --watch server.js` with
`PUBLIC_URL` set to the tunnel, so the server restarts on every save **and QR codes automatically
encode the tunnel URL**. The tunnel lives outside the server process, so its URL survives those
restarts. No binary → it still runs, just without a tunnel (`npm run dev:local` is the plain
watcher). Forgetting to restart is the most common way a change appears not to have worked: the old
process keeps answering, so the dashboard and `/ai` look healthy while serving code from before your
edit. Reload the browser with Ctrl+Shift+R too, or a cached `dashboard.html` will hide client-side
changes the same way.

`venue.json` is entirely normalized 0–1 coordinates, so changing venue means editing that one file —
never hardcode coordinates in the clients. After editing it, check every zone corner still falls inside
the `outline` polygon and that no two zones overlap; broken geometry renders as zones floating outside
the site.

Read `CLAUDE.md` before changing architecture. It records constraints that were decided the hard way —
why there's no build step, why heart rate can never be load-bearing, why Spotify isn't an option, and
which bugs are already fixed and shouldn't be reintroduced.

## Verifying a change

There is no test suite. Verify by reading state and loading the page:

```bash
node --check server.js                        # syntax
node server.js
curl -s localhost:3000/state.json | head -40  # exact broadcast payload
```

If the map looks wrong, `/state.json` tells you whether the problem is the data or the rendering.

## The palette comes from the audio

Hit **Load track** in the radio player and pick any MP3. Nothing is preconfigured — the browser runs the audio through a Web Audio `AnalyserNode` and derives the palette from the signal every frame:

| Measurement | Drives |
|---|---|
| Spectral centroid (log-scaled) | Hue position on the ramp: indigo → violet → magenta → coral → amber |
| Bass onset vs rolling average | Beat flash on the site outline and zone fills |
| Combined band level | Glow intensity |

Load something bass-heavy and the venue sits deep indigo. A bright, hi-hat-driven track pushes it toward amber. The drop lands and the whole map pulses on the kick.

Centroid is log-scaled because brightness is heard logarithmically — a linear centroid sticks near the bottom of the range and the palette barely moves. The tone value is also eased at 0.03 per frame, so it drifts rather than strobes.

The host's browser is the only thing that touches audio. It broadcasts the derived spectrum and beat over the socket, and every phone renders the same reactive visuals without playing sound — so you get one sound system, not sixty.

## Venues tab — building a new map

The **Venues** tab is a full editor, and the left rail on the Map tab switches between what you've
built.

1. **+ New venue**, give it a name (you'll be asked to sign in the first time).
2. **Drop in a floor plan image.** Zones are found automatically — no drawing required. The image is
   traced over, never rendered on the live map, and its proportions set the venue's `aspect`, which is
   what makes coordinates line up with the real site.
3. **Say where it is.** Type the address (or paste `lat, lon`, or press **I'm here now** on site) and
   hit **Centre venue there** — one location is enough to turn GPS on, assuming a 120 m-wide site
   unless a scale bar said otherwise. The **Check it on Google Maps** link shows exactly where the map
   now sits. For metre accuracy, refine with the two corner pins: if the drawing carried a scale bar,
   a north arrow or an address they arrive pre-filled; otherwise paste coordinates from Google Maps or
   stand at a corner and capture.
4. **Save**, or **Save & make active** to move the live event onto it. **Show check-in QR** gives the
   venue its own scannable code (also available from the map's left rail).

### Editing what came back

Detection gets you most of the way; the last 10% is yours. Everything it produced is editable:

| Do this | To |
|---|---|
| Drag a zone | Move it |
| Drag its handles | Resize from any edge or corner |
| Arrow keys | Nudge by a hair — for lining up with a wall |
| Shift + arrows | Nudge in bigger steps |
| Alt + arrows | Resize instead of move |
| Delete / Backspace | Remove the selected zone |
| Drag empty space | Add a new zone |
| Click a zone, or a row in the list | Select it, then edit label, kind and capacity |

The selected zone shows eight grab handles, and the cursor changes over them, so resizing isn't a
secret. Zones turn amber the moment they leave the outline or overlap a neighbour — you see the
problem while dragging rather than when you hit Save.

**Trace outline** clicks out a non-rectangular site, **Place ref pin** moves a calibration pin.
`event` zones get the accent colour and drive the "in sessions" metric; `transit` is where phones land
when GPS can't place them.

### Letting AI read the plan

There are two readers. **AI** sends the image to Gemini, which reads a plan the way a person does —
it picks up room names printed on the drawing, understands that a rectangle labelled "Kitchen" is a
food area, and copes with site maps and photographs that defeat pure image processing. **Local** is
the built-in geometric reader described below, needs no key, no network, and no quota.

Either **OpenAI** or **Gemini** works. The simplest way to set a key is a `.env` file, because it
avoids shell quoting entirely — the syntax for setting an environment variable differs between
PowerShell, cmd and Git Bash, and getting it wrong is the most common way this fails to start.

```bash
cp .env.example .env      # then edit .env and paste your key
node server.js
```

You should see `Loaded 1 setting from .env` at boot. That's it — no `export`, no `$env:`, no `set`.

If you'd rather use the shell, the syntax depends on which one you're in:

| Shell | Prompt looks like | Command |
|---|---|---|
| PowerShell | `PS C:\Workspace\Summerhacks>` | `$env:OPENAI_API_KEY="sk-..."` |
| Command Prompt | `C:\Workspace\Summerhacks>` | `set OPENAI_API_KEY=sk-...` (no quotes — cmd keeps them) |
| Git Bash | `user@host MINGW64 /c/...$` | `export OPENAI_API_KEY=sk-...` |

Either way it only applies to that one window, and only to servers started from it afterwards.
Anything set in the shell overrides `.env`.

Keys: OpenAI at [platform.openai.com/api-keys](https://platform.openai.com/api-keys), Gemini free at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey).

Whichever key is present is used. With both set, `AI_PROVIDER=openai|gemini` decides. Defaults are
`gpt-5.4` and `gemini-2.0-flash`; override with `OPENAI_MODEL` / `GEMINI_MODEL`. The model must be
vision-capable — a text-only model will fail with a clear error rather than silently misbehaving.

Without a key the AI option disables itself in the dropdown and the local reader is selected. Nothing
breaks; you just get the weaker reader.

**The key never reaches the browser.** The dashboard is served over a public tunnel, so a key in
client-side JS would be handed to anyone who opened the page — and OpenAI keys are billable. The
browser posts the image to `POST /detect`, the server calls the model, and only the resulting zones
come back. OpenAI is called with a `Bearer` header, and both providers are asked for structured JSON
(`strict: true` on OpenAI) rather than free text that needs parsing out of prose.

The image is downscaled to 1152px before upload — a phone photo of a plan is several megabytes, and
that's latency and tokens spent on detail the model doesn't need.

**Model output is repaired, never trusted.** A vision model returns plausible rectangles, not valid
geometry: boxes overlap, coordinates run past the edge, `kind` comes back as something that isn't in
the vocabulary, two rooms share a name. Everything is clamped into range, degenerate boxes dropped,
overlaps trimmed, strays pulled inside the outline, ids de-duplicated and kinds coerced — the same
guarantees the local reader makes, so whichever reader ran, what reaches `validateVenue` is sound.

If the call fails for any reason — no quota, bad key, timeout, malformed answer — the editor falls
back to the local reader and tells you what went wrong rather than leaving you stuck.

### Can AI do the GPS calibration too?

Partly, and the split is worth understanding because it's not a limitation of the model.

Calibration needs three things. A drawing can carry two of them:

| Needs | Where it comes from | Can AI read it? |
|---|---|---|
| Size in metres | A scale bar | **Yes** |
| Rotation vs north | A north arrow | **Yes**, when the arrow is unambiguous |
| Position on Earth | Nothing on the drawing | **Only** if an address is printed |

So when you drop a plan, the model is also asked for the scale bar, the north arrow and any printed
address. A found address is geocoded through OpenStreetMap's Nominatim (free, no key), and the result
back-projects into the two corner pins so they arrive **pre-filled with real coordinates you can
correct**, rather than empty.

It is reported as `estimated`, never `calibrated`. That distinction is deliberate: geocoding an
address lands you within tens of metres of the building, and zones here are around 10m, so an
address-derived anchor is a good starting point and a bad final answer. The flag only flips to
calibrated when you edit a pin yourself — the claim of accuracy stays yours.

Everything is validated before it's believed: a scale read as 3m or 9km is treated as a misread, and a
plan carrying none of the three markings comes back with `usable: false` and says so, rather than
inventing an anchor. Tested both ways — an annotated plan resolved `290 Bremner Blvd` to the real CN
Tower and read its scale bar to within 6%; an unannotated one returned `from: []` and left the pins
empty.

The honest summary: it saves you finding coordinates for a venue whose address is on the drawing, and
gets the size and rotation right. It does not remove the two-pin step if you want zone-level accuracy.

### Which model to use

Model choice matters far more than it looks. Every model tried found all 7 rooms in a labelled test
plan and named them correctly — the difference is entirely in **how tightly the rectangles land**,
which is exactly what zone accuracy depends on. Scored as IoU against the true room boxes, three runs
each:

| Model | Box accuracy (IoU) | Time | Tokens |
|---|---|---|---|
| **gpt-5.4** (default) | **0.91** | 3.2s | 1474 |
| gpt-5.6-luna | 0.90 | 5.7s | 1800 |
| gpt-5.6-terra | 0.90 | 6.9s | 1780 |
| gpt-5.5 | 0.90 | 16.4s | 2510 |
| gpt-5 | 0.58 | 36.9s | 4949 |
| gpt-4.1 | 0.51 | 2.2s | 1623 |
| gpt-4o | 0.47 | 4.9s | 1598 |

`gpt-5.4` wins on all three axes, so it's the default. An IoU of 0.47 means a box overlapping the real
room less than halfway — zones that look plausible in the editor and put people in the wrong place.
The 5.6 variants are equally accurate but slower; there's no plain `gpt-5.6`, only `-luna`, `-sol` and
`-terra`.

Re-run this yourself if you want to check a newer model — the scoring harness is small, and the models
your key can reach are listed by `GET https://api.openai.com/v1/models`.

### How the local detection works

Two strategies run over the image, because plans differ wildly:

- **Line art** — dark walls enclosing light rooms. Otsu threshold (nudged by the **Detail** slider),
  then flood-fill each enclosed light region.
- **Colour regions** — quantise colours and group by matching key. Site maps and satellite crops use
  coloured blocks with no walls at all, and thresholding alone finds nothing in them.

Whichever reads the image better wins. Regions touching the image border are the page, not a room.

For each surviving region the zone is its **largest inscribed rectangle**, not its bounding box. That
matters: a box drawn around an L-shaped room swallows walls and half its neighbour, whereas an
inscribed rectangle is always real floor. It also makes overlaps structurally impossible, because
regions are disjoint and each rectangle stays inside its own.

The **outline** is a traced polygon, not a rectangle. A column-wise silhouette of the site is padded
outward and simplified (Douglas–Peucker), which is what gives a real shape with diagonals — the kind
of outline STACKT has, rather than a box around everything. It's traced over the content *and* the
accepted zones, so on a site map of detached blocks the zones can't end up outside it. Anything still
straddling the edge is shrunk toward its centre until it fits, or dropped.

Verified in headless Chrome against four synthetic plans — clean line art, L-shaped rooms, coloured
blocks with no walls, and a non-rectangular site with a diagonal. 24/24: every room found, no
overlaps, every zone inside the outline, every zone centre landing on real floor, a 12-point polygon
for the diagonal site, and all four passing the server's validator. Pure noise returns zero zones,
a blank image doesn't throw.

**Where it still struggles:** photographs, and open-plan spaces where a gap in a wall lets the fill
leak between rooms and merge them. Move the **Detail** slider and re-run, or draw the odd zone by
hand — everything stays editable.

### Why a generated venue used to look bare

STACKT's `venue.json` is hand-traced and carries a lot the editor can't infer: container grids, street
labels, entrances, an event route. A generated venue has none of that, so it was drawing plain
rectangles on a plain rectangle.

Two things close the gap. The outline is now a real traced polygon, and the floor plan is drawn faintly
(30%) beneath the live map for venues that have one — the checkbox in the editor turns it off. STACKT
is unaffected: it has no plan image, and its traced detail is doing that job already.

Zones turn amber the moment they fall outside the outline or overlap another, and the server refuses
to save broken geometry — `POST /venues` returns the specific problems. That check used to be
something you had to remember to run by hand.

Switching venues in the left rail only **previews** — the running event stays put until you press
*Make active*, which confirms first. A stray click can't relocate everyone mid-demo. Previewing hides
the people, because their positions are coordinates in the live venue and mean nothing on another map.

The **simulated crowd** panel sets headcount, liveliness, what fraction wear heart monitors, and
whether they spread by capacity or evenly. Changing it regenerates the crowd immediately, so a
newly-built venue is demo-able the second it goes live.

Venues live as JSON in `venues/`, seeded from `venue.json` on first boot. They're tracked in git so a
venue you build can be shared; the traced-over plan images are not.

| Route | Does |
|---|---|
| `GET /venues` | list, with which is active |
| `GET /venues/:id` | one venue's full JSON |
| `POST /venues` | create or update — validates geometry, 400s with problems |
| `POST /venues/:id/activate` | move the live event |
| `DELETE /venues/:id` | remove (409s if it's live) |
| `PUT /venues/:id/plan` | upload floor plan as a data URL |
| `GET`/`POST /crowd` | simulated crowd settings |

## The map

`venue.json` is traced from the STACKT Market floor plan: the real site polygon (Tecumseth to Bathurst, with the Front St. diagonal), the container unit grids, the street labels, all three entrances, and the Summerhacks route from Entrance 1 through to Studio 3-101.

Everything is in normalized 0–1 coordinates, so it scales to any screen. To change the venue, edit `venue.json` only — no code changes.

```json
{ "id": "northhall", "label": "North Hall", "short": "N. HALL",
  "kind": "event", "x": 0.497, "y": 0.310, "w": 0.075, "h": 0.066, "cap": 120 }
```

`kind` sets the visual treatment (`event` zones get the accent colour, everything else stays neutral) and drives the "in sessions" metric. `cap` drives the occupancy fill and the capacity column.

There's a geometry check worth rerunning if you edit the file — every zone corner should fall inside the outline polygon, and zones shouldn't overlap each other.

## What's on screen

**Map** — the venue, live. Zone fills brighten with occupancy and lift on every beat. Each person is a dot; anyone with a heart monitor gets a ring that expands at their actual pulse. When the room locks in, the rings visibly fall into step with one another. That's the shot to put in the demo video.

**People** — every attendee, sorted by movement, with team, zone, heart rate as a percentage over their own resting baseline, and dwell time.

**Zones** — occupancy against capacity, and average movement per zone.

**Radio** — spectrum, transport, seek, volume, and the four palette swatches currently derived from the track. Bottom-right on the dashboard, pinned to the bottom on phones.

## Data collection

Every checked-in phone quietly contributes to a research dataset on top of the live metrics. Once
someone taps **Start movement & location**, the phone captures a 5-second batch of raw readings at
~10 Hz — accelerometer x/y/z, orientation α/β/γ, and mic loudness (level only, never audio, and only
if the mic was allowed) — plus its latest GPS fix, and uploads the batch every 30 seconds. Batches,
never a stream: 100 phones is ~3 requests/second.

It lands in SQLite at `backend/data.db` using the exact schema the Flask backend in `backend/`
defined (`snapshots` + `snapshot_readings`), so anything written against that backend — including
plain Python `sqlite3` — reads the same file. The API is the same too, now served by the one Node
server over the one tunnel:

| Route | Does |
|---|---|
| `POST /api/snapshots` | store one capture (snapshot row + one row per reading) |
| `GET /api/snapshots` | list, newest first, with reading counts (`?limit=`) |
| `GET /api/snapshots/<id>` | one capture with all its readings |
| `GET /api/snapshots.csv` | the whole dataset as CSV, one row per reading |
| `GET /api/data/summary` | totals for the dashboard tiles |
| `GET /sensor-test` | the standalone capture/test page |

The dashboard's **Data** tab shows totals (snapshots, readings, phones seen, DB size), the latest
captures with GPS fixes, and a per-snapshot chart of accel magnitude and audio level — plus one-click
CSV export.

Privacy shape: snapshots are stored under the phone's random `pulse:id`, never the name; the check-in
consent text says exactly what is collected. Requires `better-sqlite3@11` (v12+ needs Node 22); if the
native module fails to load, the store disables itself with a `[data]` log line and everything else
runs normally.

## Metrics

Two are worth defending when a judge asks what's actually new:

**Arousal uses personal baselines.** Resting heart rate runs 50–90 across a crowd, so a raw average is meaningless. Each person's first 45 seconds sets their own median baseline, and the metric is the percentage climb above it. Without this, heart rate data is decorative.

**Sync measures whether the room moves as one body** rather than as N separate people — low spread relative to the mean. It's the actual difference between a crowd and a queue.

## One QR for the whole event

Print `/qr/event.svg` once. It encodes `/join.html` with no zone, and GPS takes over from there —
zone membership updates on its own as people move. Anyone whose GPS never gets a usable fix stays in
`entrance1`, which is also where everyone starts.

### Getting a QR that actually scans

**Open `/qr` through your tunnel URL, not through localhost.** That's the whole rule.

```
https://your-tunnel.trycloudflare.com/qr        ← print this
http://localhost:3000/qr                        ← will warn you it won't work
```

`/qr` is a printable poster: the code, and underneath it the exact URL encoded inside. If that URL
can't work from a phone it says so in orange and explains why, so a dead poster can't look fine.

The QR is generated per request from the address you reached the server on, so loading the poster
through the tunnel is what puts the tunnel's hostname in the code. There are only two ways it goes
wrong, and the poster names both:

| Poster opened via | QR encodes | Result |
|---|---|---|
| `localhost:3000` | `http://localhost:3000/join.html` | **Dead** — a phone resolves `localhost` to itself |
| the tunnel | `https://…trycloudflare.com/join.html` | Works |

Proxies terminate TLS and forward plain HTTP, so the server is told the request was `http` even when
the phone will speak `https`. `x-forwarded-proto` is honoured to get this right — without that the
QR encodes `http://` to an HTTPS-only host, which fails in the least helpful way possible: the page
may load, and then motion and GPS are silently blocked because it isn't a secure context.

Setting `PUBLIC_URL` still works and overrides all of this — worth doing if you're printing posters
in advance, since it pins the URL regardless of how you open the page. Just remember quick tunnels
get a new hostname on every restart, so a poster printed against an old one is waste paper.

`/qr?zone=northhall` gives the per-zone poster and `/qr?v=<venueId>` a specific venue's poster
(it warns if that venue isn't the live one — scans always join whatever is live). `/qr/event.svg`,
`/qr/venue/<id>.svg` and `/qr/<zone>.svg` return the bare SVG if you'd rather place it yourself.
The dashboard's **Check-in QR** button shows the same code in a modal, with the same warnings.

To save one as a printable PNG:

```bash
node -e "require('qrcode').toFile('qr-event.png','https://YOUR-TUNNEL.trycloudflare.com/join.html',{width:900,margin:2})"
```

<img src="docs/qr-event.png" width="220" alt="Event check-in QR">

⚠️ **The QR above is a snapshot from 2026-08-08 and is almost certainly dead.** Cloudflare quick
tunnels get a new random hostname every restart, so this image only worked for the session that
generated it — and it will never be right on your machine. It's here to show what the poster looks
like. Generate your own with the command above, or just print `/qr/event.svg`.

If you want a QR that stays valid, you need a stable hostname: a named Cloudflare tunnel
(`cloudflared tunnel create`), an ngrok reserved domain, or any real deploy. Quick tunnels are
deliberately ephemeral.

**Calibrate before the event or GPS does nothing.** `venue.geo` ships with estimated numbers. Open
`/calibrate.html`, fix two known points that are far apart (opposite corners, or two gates), and paste
the resulting block into `venue.json`. It solves for the site's real origin, size and rotation, holding
the aspect ratio from `venue.json` fixed. Restart the server afterwards — `venue.json` is read once at
boot.

There are two ways to fix each point, and **you do not have to be on site**:

- **Type the coordinates.** Right-click the spot in Google Maps, hit its copy-coordinates entry, and
  paste — `43.643300, -79.408100`, a bare space-separated pair, or a full `maps/@lat,lon,19z` URL all
  parse. This is *more* accurate than a phone fix (six decimal places is ~0.1m) and you can do it at a
  desk before the event.
- **Stand there and capture.** Averages five GPS fixes at that spot. Do it outdoors with a clear sky.

Prefer typing where you can identify the corners on a map. Capture is the fallback for points you
can't pick out from satellite view.

Until it's calibrated, GPS points map outside the site outline and are rejected: the People tab shows
`off site` in the Fix column and the server logs a warning. Nobody gets moved to a wrong zone, they
just don't get moved at all.

### What GPS can and can't do here

Measured against the traced geometry, assuming a ~153m × 53m site:

| Fix accuracy | Wrong zone named | Spurious zone changes while standing still |
|---|---|---|
| ±3 m | 1.2% | ~1 per 30 min per person |
| ±5 m | 5.8% | ~1 per 24 min |
| ±8 m | 17.3% | ~1 per 2.7 min |
| ±12 m | 31.7% | ~1 per 1.5 min |

Three guards keep that from showing on the projector: fixes worse than 25m are ignored outright, a zone
change needs three consecutive agreeing fixes, and the dot position is eased rather than snapped
(≈10s to converge, so people slide into place instead of teleporting).

The hard limit is the short axis. The site is 2.884× wider than tall, so most zones are only a few
metres deep in `y` — below GPS resolution no matter how good the fix. Expect the long axis to resolve
well and the short axis to lean on the nearest-zone fallback.

## Phone check-in

QR → name → one tap to enable motion and location → live view. The phone samples the accelerometer at
device rate and sends a single summarised float every 500ms; sending raw 30Hz from 100 phones would
melt the server. GPS is throttled to one fix a second, and step count comes from peak detection on the
accelerometer stream that's already being sampled.

The phone also shows a live **sound level** in approximate dB, derived from the same mic RMS the
snapshot store records (level only, never audio; phones aren't calibrated SPL meters, hence
"approx"). Heart-rate pairing was dropped from the phone UI — iOS has no Web Bluetooth, so it could
never work for most of the room — but the server's HR pipeline and the dashboard's pulse rings
remain, fed by the simulator.

## localhost vs the tunnel

These are **the same server**, byte for byte — one Node process, two ways in. The tunnel is a public
HTTPS front door that forwards to `localhost:3000`; it isn't a copy or a deploy. Stop the server and
both go dark.

| | `http://localhost:3000` | `https://…trycloudflare.com` |
|---|---|---|
| Who can reach it | only your machine | anyone with the link |
| Transport | HTTP | HTTPS |
| Motion, GPS, Bluetooth | **blocked** except on your own machine | work everywhere |
| Round trip | ~17ms | ~165ms |
| Lifetime | stable | new random hostname each restart |

The sensor row is the one that matters. Browsers only expose `DeviceMotionEvent`, geolocation and Web
Bluetooth in a *secure context* — HTTPS, or `localhost`. Your laptop gets the localhost exemption; a
phone does not, because to the phone `localhost` means the phone. So a phone on plain HTTP checks in
happily and then reports `0.00` movement forever.

Use localhost for developing the dashboard, and the tunnel whenever a phone is involved.

## You must be on HTTPS

`DeviceMotionEvent` and Web Bluetooth are hard-blocked on plain HTTP. Phones will check in fine and then report 0.00 movement forever, with no error anywhere. This is the most common way this project fails.

A Cloudflare quick tunnel gives you a public HTTPS URL with no account and no config — and it's
automated here:

```bash
npm run get-tunnel     # one time: downloads the official cloudflared binary (~60 MB, gitignored)
npm run dev            # every time: tunnel + server together
```

`npm run dev` starts the tunnel, waits for its URL, and launches the server with `PUBLIC_URL` already
set — it prints the dashboard and QR-poster links to open. QR codes encode the tunnel automatically,
even if you're browsing the dashboard on localhost. (macOS: `brew install cloudflared` instead of
`get-tunnel`; `TUNNEL=0 npm run dev` skips the tunnel on purpose.)

Doing it by hand still works — run `cloudflared tunnel --url http://localhost:3000` yourself and start
the server with that URL in `PUBLIC_URL`:

```powershell
$env:PUBLIC_URL="https://your-tunnel.trycloudflare.com"; node server.js
```

`PUBLIC_URL` is what gets encoded into the QR posters, and it overrides the request's Host header
entirely, so posters are correct no matter which address generated them. The tunnel URL is random and
changes every time the tunnel restarts, so regenerate posters after restarting `npm run dev`.

**Don't count on the local network instead.** Campus and guest Wi-Fi (UofT's included) normally run
client isolation, so a phone cannot reach your laptop's LAN address even on the same SSID — and plain
HTTP wouldn't give you sensors anyway. The tunnel solves both at once.

## If it breaks

- **`Cannot GET /dashboard.html`** → the HTML must live in `public/`; that's the directory `server.js` serves.
- **`EADDRINUSE`** → something's already on port 3000. `PORT=3001 node server.js`, or kill the old one.
- **Phones report 0.00 movement** → you're on HTTP. Nothing else causes this.
- **QR scans but nothing happens** → open `/qr` and read the URL under the code; it tells you what is wrong.
- **Everyone stuck in Entrance 1, Fix column says "off site"** → `venue.geo` isn't calibrated. Run `/calibrate.html`.
- **Dots drift between neighbouring containers** → GPS accuracy is worse than the zones are wide. Check the Fix column; anything over ±8m will do this.
- **Palette never changes** → no track loaded, or the browser blocked autoplay. Click the page once.
- **Map is blank** → `curl localhost:3000/state.json` for the exact broadcast payload.
- **Everyone in one zone** → you printed the same QR twice.
- **Spectrum flat on phones** → phones mirror the host; the host tab has to be open and playing.

## Privacy

The check-in screen states what's collected before anyone taps through — movement, location, step
count, and heart rate if a monitor is connected. Location is read only while the page is open, and the
browser's own permission prompt gates it. Nothing is written to disk: state lives in memory and dies
with the process. Judges will ask, especially now that it's tracking location, and having the answer
already on screen turns it into a point in your favour.
