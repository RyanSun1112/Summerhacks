# Pulse adaptive DJ

This repository includes an offline song preprocessing utility. It turns ordinary,
locally accessible audio files plus optional playlist metadata into a compact,
normalized `songProfiles.json` database. The venue-time DJ/rules engine reads that
file; it does not load audio with librosa and does not call an LLM.

The utility does **not** access Spotify's encrypted/offline cache. A Spotify JSON
export is only a metadata source. Audio must be a legitimate local `.wav`, `.mp3`,
`.flac`, or `.m4a` file that the installed audio backend can decode.

## Setup

Python 3.10 or newer is recommended:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

On Windows PowerShell, activate with `.venv\Scripts\Activate.ps1`. Some operating
systems need FFmpeg installed for formats (especially `.m4a`) not supported by the
system `libsndfile`; decoding support depends on the local audio backend.

For real semantic annotation, put the key in the environment or an uncommitted
`.env` file:

```bash
export OPENAI_API_KEY="..."
```

The OpenAI provider uses the Responses API with a Pydantic structured-output schema.
The model, batch size, concurrency, retry policy, and prompt version are centralized
in `tools/song_preprocessing/config.py`.

## Inputs

Point `--audio-dir` at any directory; scanning is recursive and deterministic.
Audio is read in place and is never copied into this repository or sent to the LLM.

Metadata is optional and may be JSON or CSV. The simple JSON format is:

```json
[
  {
    "id": "spotify-or-local-id",
    "title": "Song Name",
    "artist": "Artist Name",
    "album": "Album",
    "year": 2024,
    "genres": ["house", "dance"],
    "audioFile": "Artist - Song Name.mp3"
  }
]
```

`audioFile` is optional but recommended. Common Spotify export shapes such as
`{"tracks":{"items":[{"track":{...}}]}}` are also accepted; Spotify remains
optional. CSV columns may use the same names, with genres comma- or semicolon-separated.

Matching is conservative, in this order:

1. Explicit `audioFile`/`localFile`/`filename`/`path`, then a filename exactly equal
   to a track ID.
2. Embedded track ID or exact embedded title + artist (read with Mutagen).
3. Exact normalized `Artist - Title` or `Title - Artist` filename comparison.

Matching normalization folds case and accents, removes punctuation/extra spaces,
`feat.`/`ft.` suffixes, track-number prefixes, and parenthetical/bracketed version
text. Multiple candidates are never guessed: the file is skipped and recorded in
`songPreprocessingReport.json`. Unmatched audio is processed using embedded tags or
an `Artist - Title.ext` filename fallback and gets a stable `local-...` ID.

## Run

Test audio analysis on five tracks without using API credits:

```bash
python preprocess_songs.py \
  --audio-dir ./songs \
  --metadata ./tracks.json \
  --limit 5 \
  --skip-llm
```

This writes `data/rawAudioFeatures.json` and a report, but deliberately does not
overwrite/create a semantically incomplete `songProfiles.json`.

Run a no-cost end-to-end smoke test with clearly labelled mock ratings:

```bash
python preprocess_songs.py --audio-dir ./songs --metadata ./tracks.json --limit 5 --mock-llm
```

Process the complete library with OpenAI annotation:

```bash
python preprocess_songs.py \
  --audio-dir ./songs \
  --metadata ./tracks.json \
  --output ./data/songProfiles.json
```

Resume is automatic. To intentionally ignore successful semantic cache entries:

```bash
python preprocess_songs.py --audio-dir ./songs --metadata ./tracks.json --force
```

Use `--force-audio` only when librosa settings or source material need deliberate
re-analysis. Other useful controls are `--model`, `--llm-batch-size` (1–20),
`--llm-concurrency`, `--cache-dir`, and `--energy-strategy llm|hybrid`.

## Analysis and outputs

For each track, librosa loads a mono 22.05 kHz waveform and calculates:

- actual BPM and beat count;
- RMS mean, median, 95th percentile, and maximum (amplitude/loudness evidence);
- onset-strength mean, median, and 95th percentile (attack/percussive evidence);
- detected onsets per second (rhythmic attack density);
- mean spectral centroid (brightness), bandwidth (spectral spread), and 85% rolloff;
- mean zero-crossing rate (noisiness/high-frequency activity proxy);
- dynamic range approximation: frame RMS 95th percentile minus frame RMS 10th percentile.

The LLM receives only metadata and these numbers—not a waveform, audio bytes, or a
local file path. It independently scores energy, danceability, valence, socialness,
and intensity from 0–100 using the absolute rubric in
`tools/song_preprocessing/llm_annotator.py`. The prompt explicitly prohibits ranking
or normalizing within an API batch and tells the model to prefer supplied evidence
over remembered or invented measurements.

Successful annotations are validated (required IDs, unique results, integer 0–100
scores, bounded description) and saved individually beneath
`cache/song_preprocessing/annotations/`. Their fingerprint includes metadata, raw
audio features, model, and prompt version. Audio features have a separate cache
fingerprinted by file path, size, modification time, and analysis settings. Writes
are atomic, so reruns safely resume after interruption.

After annotation, the utility min/max-normalizes each semantic metric across every
successfully completed track:

```text
(raw - library_min) / (library_max - library_min)
```

If all values are equal, each becomes `0.5`. Raw 0–100 semantic ratings and raw
librosa measurements remain unchanged under `raw`. Selected objective metrics are
also independently normalized under `normalizedAudio`. BPM always remains an actual
float. Default energy is normalized LLM energy; `--energy-strategy hybrid` applies
the experiment-friendly weights in `config.py` and then normalizes that blend.

Generated files beside `--output` are:

- `songProfiles.json`: live-ready normalized profiles;
- `rawAudioFeatures.json`: objective analysis and resolved metadata;
- `rawLLMAnnotations.json`: validated raw semantic annotations;
- `songPreprocessingReport.json`: counts, ambiguities, unmatched metadata, and failures.

Failures for one track are logged and processing continues. Only tracks with both
successful audio analysis and a valid semantic annotation enter final normalization.

## Live SongRanker integration

Load `data/songProfiles.json` once when the rules engine starts and index it by `id`.
The live ranker can compare crowd energy with `profile.energy`, add danceability or
socialness according to venue mode, and constrain by actual `profile.bpm`. It should
read only the final top-level 0–1 values during selection; `raw` and
`normalizedAudio` are retained for diagnostics and future ranker experiments. No
preprocessing package needs to be imported by the live Node/Express service.

## Tests

```bash
pytest
```

The test suite uses synthetic audio only; no commercial tracks are stored here.
