# Deterministic-first adaptive DJ selection

This layer selects a next-song recommendation from preprocessed profiles. It does not
analyze audio, implement sensors, or change host playback.

```text
Mock/future CrowdState
        +
data/songProfiles.json
        ↓
deterministic DJ policy → SongTarget
        ↓
weighted ranking + repetition handling
        ↓
top ten candidates
        ↓
optional server-side OpenAI final judge
        ↓
selected song (deterministic fallback always available)
```

## CrowdState contract

Every required value is a finite float in `[0, 1]`. Trends use `0` for strongly
decreasing, `0.5` for stable, and `1` for strongly increasing.

```json
{
  "energy": 0.75,
  "rhythm": 0.84,
  "clustering": 0.78,
  "volume": 0.70,
  "mobility": 0.25,
  "energyTrend": 0.70,
  "rhythmTrend": 0.78,
  "clusteringTrend": 0.55,
  "mobilityTrend": 0.45,
  "volumeTrend": 0.62,
  "currentBpm": 124,
  "timestamp": 1786226400000
}
```

`currentBpm` and `timestamp` are optional. Validation lives in `lib/dj/models.js`.
The later sensor analyzer should emit exactly this object and call the same engine.

## Mock scenarios

`lib/dj/mock-scenarios.js` includes:

- `dancingGrowing`
- `socializing`
- `losingDanceFloor`
- `peakDanceFloor`
- `highMovementLowRhythm`
- `calmSocial`

Run them against a real profile database or fictional example profiles:

```bash
npm run select-song -- --scenario dancingGrowing
npm run select-song -- --scenario socializing --json
npm run select-song -- --scenario peakDanceFloor --current TRACK_ID
```

Recent IDs are most-recent first:

```bash
npm run select-song -- --scenario dancingGrowing --recent ID1,ID2,ID3
```

## DJ policy

`lib/dj/policy.js` deliberately transforms crowd measurements into musical intent;
it does not pretend clustering or mobility are song features. Explicit cases cover:

- rhythmically engaged and rising → modest build;
- movement without rhythm → social/moderate rather than escalation;
- clustered, stationary, low-rhythm room → conversation-friendly;
- clustered high-rhythm room → active dance floor;
- falling energy and rhythm → bounded accessible lift;
- peak saturation → maintain or release, especially after repeated peak songs;
- calm room → pleasant social music.

The result contains energy, danceability, socialness, intensity, valence, a preferred
BPM/window when current tempo exists, an intention, and a policy-case identifier.
Thresholds, adjustment sizes, BPM windows, scoring weights, repetition penalties, and
candidate count are centralized in `lib/dj/config.js`.

## Deterministic scoring

`lib/dj/ranker.js` starts from a normalized match score and subtracts weighted
absolute differences. Default weights are:

| Feature | Weight |
|---|---:|
| Energy | 0.25 |
| Danceability | 0.25 |
| Socialness | 0.15 |
| Intensity | 0.10 |
| Valence | 0.05 |
| BPM | 0.20 |

BPM outside the preferred window receives a small additional penalty, not exclusion.
The current song and tracks in the last six are excluded. An artist used in the last
two receives a moderate penalty, as does a candidate whose semantic profile is nearly
identical to the last song. Every candidate contains readable positive/negative
reasons and component differences. Only the configured top ten continue to AI.

## Optional OpenAI selector

`lib/dj/ai-selector.js` is isolated from the policy and ranker. It sends only:

- validated CrowdState;
- the deterministic SongTarget and intention;
- compact current/recent song metadata;
- compact top-candidate profiles, deterministic scores, and reasons.

It never sends audio, raw preprocessing diagnostics, the entire catalog, or an API
key. The Responses API request uses a strict JSON schema requiring `songId`, `reason`,
and confidence in `[0, 1]`. Local validation additionally requires `songId` to belong
to the supplied candidates.

Enable the optional final judge with a server-side environment variable:

```bash
export OPENAI_API_KEY="..."
npm run select-song -- --scenario dancingGrowing --ai
```

`OPENAI_DJ_MODEL` overrides the default `gpt-5-mini`. If the key/SDK/API is missing,
times out, rate-limits, returns malformed JSON, or chooses an invalid ID,
`lib/dj/engine.js` returns candidate number one and labels the result
`deterministic-fallback`.

## Backend API

The existing Express server loads `data/songProfiles.json` once at boot. For local
demo use only, it falls back to `data/songProfiles.example.json` with a console warning.

```bash
curl localhost:3000/api/dj/scenarios

curl -X POST localhost:3000/api/dj/select \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"dancingGrowing","currentSongId":"example-pulse-rising","recentSongIds":[],"useAI":false}'
```

A caller may provide `crowdState` instead of `scenario`. `useAI` defaults to false.
The endpoint recommends a track but deliberately does not start playback.

To prevent anyone who can reach the public tunnel from spending API credits, HTTP AI
selection additionally requires a server-side `DJ_AI_TOKEN` and matching
`X-DJ-Token` request header. Do not put that token in a public page. Without it, an
AI request returns the normal deterministic fallback. The CLI does not need this
extra token because it runs directly on the trusted host.

## Future feedback record

Every engine response contains a `decisionRecord` with `stateBefore`, selected song
ID, target, and deterministic candidates. A later event logger can add `stateAfter`
without changing the selection interfaces. No learning or reinforcement system is
implemented now.

## Tests

```bash
npm test
pytest
```

Node tests use injected mock AI providers and make no OpenAI requests.
