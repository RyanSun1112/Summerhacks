# Pulse — Data & API Layer Overview

## 1. Client-side APIs (all run in the check-in browser page)

| API | Purpose | Notes / gotchas |
|---|---|---|
| **DeviceMotionEvent** | Acceleration → movement/dance intensity | iOS requires `DeviceMotionEvent.requestPermission()` behind a user tap. Android generally no prompt needed. |
| **DeviceOrientationEvent** | Rotation/tilt → refines "actively moving" vs. "still in pocket" | Same iOS permission pattern — request alongside DeviceMotion in one combined tap. |
| **Web Audio API** (`getUserMedia` + `AnalyserNode`) | Ambient volume/amplitude → crowd noise energy | Needs mic permission. Use `AnalyserNode.getByteFrequencyData` or RMS of the waveform, not raw audio storage — you only need magnitude, never record/store actual audio for privacy reasons. |
| **Geolocation API** (`watchPosition`) | Live position → heatmap | `enableHighAccuracy: true`. Indoor accuracy will be poor — planned and accepted, rendered as smoothed heatmap not exact points. |
| **Screen Wake Lock API** | Keeps screen active so motion/audio sampling isn't throttled | Request on check-in success; re-request if released (browsers can drop it on their own). |
| **Page Visibility API** | Flags abandoned/stale sessions (not motion detection) | Used for data hygiene in `energy_log`, not as an energy signal itself. |
| **Vibration API** (optional polish) | Haptic confirmation on check-in | Cheap, makes check-in feel confirmed. |

### Permission flow (all requested together at check-in, one tap)
1. User scans/opens check-in link → lands on check-in page
2. Single "Join the Pulse" button tap triggers: DeviceMotion permission → DeviceOrientation permission → mic permission → geolocation permission → wake lock acquired
3. On success: haptic buzz (Vibration API), session created server-side, client begins local buffering

---

## 2. Client-side data flow (per session)

- All four signals (motion, orientation, audio, GPS) are sampled **continuously and buffered locally** — do not stream raw samples to the server.
- **15–20 seconds before the current song ends** (server pushes this timing to the client, or client polls current track progress), the client:
  1. Computes a rolling aggregate over the buffer window: motion magnitude (avg + peak), orientation variance, audio RMS, smoothed lat/lng
  2. Sends **one snapshot payload** to the server via WebSocket
  3. Clears/restarts the buffer for the next song
- This keeps backend load to one payload per phone per song, not a constant stream.

**Snapshot payload shape (example):**
```json
{
  "session_id": "abc123",
  "song_id": "track_45",
  "motion_avg": 0.62,
  "motion_peak": 0.91,
  "orientation_variance": 0.34,
  "audio_rms": 0.71,
  "lat": 37.7749,
  "lng": -122.4194,
  "timestamp": "2026-08-08T22:14:03Z"
}
```

---

## 3. Backend — what to set up

### Server
- Node/Express (or Supabase Edge Functions if minimizing custom backend code)
- **WebSocket layer** (`ws` or Socket.IO) for:
  - Ingesting snapshot payloads from clients
  - Pushing live updates out to the dashboard (energy scores, now-playing, heatmap)
- **Aggregation job**: on each snapshot batch (i.e., once per song cycle), compute the composite energy score and write to `energy_log`

### Composite energy score (define and keep simple/explainable)
```
energy = 0.5 * motion_avg + 0.3 * audio_rms + 0.2 * orientation_variance
```
Normalize each input to 0–1 first. Round, explainable weights beat a black-box formula when judges ask you to justify it.

### Database schema
| Table | Fields |
|---|---|
| `sessions` | session_id, joined_at, last_seen, status (active/stale) |
| `snapshots` | session_id, song_id, motion_avg, motion_peak, orientation_variance, audio_rms, lat, lng, timestamp |
| `energy_log` | timestamp, song_id, aggregate_energy — **time-series backbone for TECHNATION** |
| `tracks` | track_id, spotify_uri, bpm, energy_tag, genre |
| `play_log` | timestamp, track_id, triggering_energy |

### Rules engine
- Reads current `aggregate_energy`
- Matches against `tracks` table (your curated, pre-tagged catalog) by nearest energy_tag/BPM band
- Triggers Spotify playback for the selected track
- Logs the choice to `play_log` with the energy value that triggered it (this is your "did energy actually predict the music" proof for TECHNATION)

---

## 4. Third-party services / accounts to set up now

- [ ] **Spotify Developer account** — register the app, get Client ID/Secret
- [ ] Confirm **Development Mode** access is sufficient (Search, Playback, Playlists, Web Playback SDK) — no extended quota needed since you're not using Audio Features/Recommendations
- [ ] Add all team member Spotify accounts as **allowed users** (up to 25 in Development Mode)
- [ ] Confirm at least one team member has **Spotify Premium** (required for Web Playback SDK)
- [ ] Curate the **~60–100 track catalog** and tag each with BPM + energy_tag (manual tagging or a public BPM lookup source)
- [ ] Hosting: pick somewhere with WebSocket support (Render, Fly.io, Railway — confirm your host allows long-lived WS connections, some serverless platforms don't)
- [ ] Database: Postgres (Supabase is a fast option — gives you Realtime + Postgres + auth-lite in one place, worth considering given you need both a DB and live push)
- [ ] HTTPS is **required** for DeviceMotion/Geolocation/getUserMedia in browsers — make sure your dev/demo URL is HTTPS from day one, not just at deploy time, or you'll lose hours debugging silent permission failures

---

## 5. Dashboard (consumes the same data layer)

- Subscribes to the same WebSocket channel (or polls `energy_log` / a live endpoint)
- **Views to build:**
  - Live energy-over-time chart, track changes annotated
  - Heatmap overlay on venue map (smoothed/blobbed positions, not raw pins)
  - Now-playing panel
  - "Room energy right now" gauge
- No auth needed on the dashboard side — it's the public artifact anyone can visit

---

## 6. Build order (risk-first, unchanged from before, now mapped to this layer)
1. Check-in page: permissions flow (motion + orientation + audio + geo + wake lock) working end to end, even logging to console before any backend exists
2. WebSocket pipeline: client buffer → snapshot → server → `energy_log`, with fake/manual data first
3. Composite score + rules engine + curated track catalog
4. Spotify playback integration
5. Dashboard: energy chart + heatmap, wired to live data
6. Reve visual pass on dashboard + venue map
7. Demo choreography rehearsal
