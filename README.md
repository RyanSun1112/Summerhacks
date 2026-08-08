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
| `/dashboard.html` | Host dashboard — map, people, zones, radio |
| `/join.html` | What a phone sees after scanning |
| `/qr/event.svg` | The single event-wide QR poster |
| `/qr/<zone>.svg` | Per-zone poster, e.g. `/qr/northhall.svg` |
| `/calibrate.html` | GPS calibration tool (see below) |
| `/state.json` | The exact payload broadcast to clients — curl this to debug |

Environment variables, all optional:

| Variable | Default | Does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `FAKE` | on | `FAKE=0` disables the simulated crowd |
| `FAKE_N` | `58` | How many simulated attendees |
| `PUBLIC_URL` | — | Host encoded into QR posters. Required when tunnelling |

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
CLAUDE.md          conventions and hard constraints — read before changing architecture
```

Each HTML file is standalone: styles in a `<style>` block, logic in a `<script>` block, no imports and
no shared bundle. To change the dashboard, open `public/dashboard.html` and edit it. Reload to see it.
Only `server.js` changes need a restart.

## Making changes

| To change… | Edit | Restart needed? |
|---|---|---|
| Venue geometry, zones, capacities | `venue.json` | Yes — read once at boot |
| Anything the host sees | `public/dashboard.html` | No, just reload |
| Anything a phone sees | `public/join.html` | No, just reload |
| Metrics, sockets, fake crowd | `server.js` | Yes |

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

## Metrics

Two are worth defending when a judge asks what's actually new:

**Arousal uses personal baselines.** Resting heart rate runs 50–90 across a crowd, so a raw average is meaningless. Each person's first 45 seconds sets their own median baseline, and the metric is the percentage climb above it. Without this, heart rate data is decorative.

**Sync measures whether the room moves as one body** rather than as N separate people — low spread relative to the mean. It's the actual difference between a crowd and a queue.

## One QR for the whole event

Print `/qr/event.svg` once. It encodes `/join.html` with no zone, and GPS takes over from there —
zone membership updates on its own as people move. Anyone whose GPS never gets a usable fix stays in
`entrance1`, which is also where everyone starts.

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

Heart rate is optional and uses the standard BLE GATT Heart Rate Service (`0x180D`), so any strap advertising "Bluetooth heart rate" works. Chrome on Android and desktop only — **iOS has no Web Bluetooth at all**, so design the demo assuming most phones contribute movement only.

## You must be on HTTPS

`DeviceMotionEvent` and Web Bluetooth are hard-blocked on plain HTTP. Phones will check in fine and then report 0.00 movement forever, with no error anywhere. This is the most common way this project fails.

A Cloudflare quick tunnel gives you a public HTTPS URL in one command, with no account and no config.

**macOS / Linux**

```bash
brew install cloudflared          # or: https://github.com/cloudflare/cloudflared/releases
cloudflared tunnel --url http://localhost:3000
```

**Windows** — `winget install --id Cloudflare.cloudflared`, or if you don't have winget, the binary
needs no install at all:

```powershell
curl.exe -L -o cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
.\cloudflared.exe tunnel --url http://localhost:3000
```

It prints a `https://something.trycloudflare.com` URL. Restart the server in a second terminal with
that URL in `PUBLIC_URL`:

```bash
PUBLIC_URL=https://your-tunnel.trycloudflare.com node server.js
```
```powershell
$env:PUBLIC_URL="https://your-tunnel.trycloudflare.com"; node server.js
```

`PUBLIC_URL` matters — it's what gets encoded into the QR posters, and it overrides the request's Host
header entirely, so posters are correct no matter which address generated them. Without it they point
at localhost and nobody can check in. The URL is random and changes every time you restart the tunnel,
so regenerate posters after restarting.

**Don't count on the local network instead.** Campus and guest Wi-Fi (UofT's included) normally run
client isolation, so a phone cannot reach your laptop's LAN address even on the same SSID — and plain
HTTP wouldn't give you sensors anyway. The tunnel solves both at once.

## If it breaks

- **`Cannot GET /dashboard.html`** → the HTML must live in `public/`; that's the directory `server.js` serves.
- **`EADDRINUSE`** → something's already on port 3000. `PORT=3001 node server.js`, or kill the old one.
- **Phones report 0.00 movement** → you're on HTTP. Nothing else causes this.
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
