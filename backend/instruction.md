# Running Backend + ngrok

This is an isolated development utility for experimenting with five-second raw
snapshots. It is not wired into the live Node venue server, which continues to use
summarized in-memory phone metrics. Do not expose this Flask service publicly for a
real event without an explicit consent, retention, and ingestion-authentication plan.
 
## 1. Run the backend
 
```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
export SENSOR_ADMIN_TOKEN="replace-with-a-long-random-local-token"
python app.py
```
 
Server runs at `http://localhost:5000`.
 
## 2. Expose it over HTTPS with ngrok
 
Motion, orientation, and GPS APIs only work on HTTPS (or `localhost`), so you need ngrok to test on a phone.
 
```bash
ngrok http 5000
```
 
Copy the `https://...ngrok-free.app` URL it prints.

## Snapshot metrics

Each successful `POST /api/snapshots` stores the raw capture locally and returns a
`metrics` object. Every requested weight is bounded to `[0, 1]`:

- `energy`: 70% robust acceleration movement plus 30% angular movement;
- `rhythm`: experimental periodic-motion score, gated by physical energy;
- `clusters`: high means concentrated, low means spread out;
- `volume`: normalized mean/p90 microphone RMS envelope;
- `bpm`: music-tempo position between 60 and 180 BPM; `0.5` with zero confidence
  means the tempo could not be estimated;
- `mobility`: accuracy-adjusted GPS speed compared with the previous snapshot from
  the same session;
- `trend`: engagement change versus the previous and historical snapshot average,
  where `0` is falling, `0.5` stable, and `1` rising.

The response also includes confidence values, warnings, and an `estimatedBpm` when
the short audio envelope is sufficiently periodic. Rhythm and BPM are deliberately
labelled estimates: five seconds at roughly 10 samples/second cannot provide
production-grade beat tracking.

Clustering needs contemporaneous GPS snapshots from other sessions. Mobility needs a
recent GPS snapshot from the same session. Missing or inaccurate GPS produces a
neutral `0.5` weight with zero confidence rather than a fabricated conclusion.

Calibration constants live together in `snapshot_metrics.py` and should be tuned
using consented venue captures before production.

## Sensitive-data controls

Raw readings and precise GPS stay in `backend/data.db`, which is Git-ignored. Metric
responses contain no session ID or coordinates and make no external/LLM calls.
Raw and derived GET endpoints require the server-side token:

```bash
curl -H "X-Sensor-Admin-Token: $SENSOR_ADMIN_TOKEN" \
  http://localhost:5000/api/snapshots
```

CORS is same-origin by default. If a separate trusted frontend genuinely needs
browser access, set a comma-delimited allowlist in `SENSOR_CORS_ORIGINS`. Flask debug
mode is off by default; enable it locally only with `FLASK_DEBUG=1` and never expose
the debugger through ngrok.
