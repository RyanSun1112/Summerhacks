# Offline song preprocessing

This utility converts ordinary local `.wav`, `.mp3`, `.flac`, or `.m4a` files and
optional JSON/CSV track metadata into a stable, live-ready `data/songProfiles.json`.
It never accesses Spotify's encrypted cache, copies audio into the repository, or
sends waveforms to an LLM.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Set `OPENAI_API_KEY` in the environment or an uncommitted `.env` only when using real
semantic annotation.

The default provider is `gpt-5-mini`. A conservative local budget guard reserves the
maximum estimated cost of every attempted request (including retries) before sending
it and stops at `$0.50` per run. This is a stop ceiling, not a spending target: only
uncached requests that are actually sent can incur provider charges. Requests also
have an output-token ceiling. Override the run guard intentionally with
`--max-llm-cost-usd`, and use `--limit 5` for the first paid test. Provider billing
remains authoritative, so also configure a low project/account budget in the OpenAI
Platform.

## Run

Place legitimate local audio files under `songs/`. This directory is the default
event library, is scanned recursively, and is ignored by Git. The checked-in
`data/tracks.example.json` shows the optional metadata format; copy it to
`data/tracks.json` and replace the example values when an export is available.

Analyze five songs without API calls:

```bash
python preprocess_songs.py --metadata ./data/tracks.json --limit 5 --skip-llm
```

Run a no-cost end-to-end test with clearly labelled mock annotations:

```bash
python preprocess_songs.py --metadata ./data/tracks.json --limit 5 --mock-llm
```

Process the complete library:

```bash
python preprocess_songs.py \
  --metadata ./data/tracks.json \
  --output ./data/songProfiles.json
```

Omit `--metadata` when no export is available. The scanner then builds local IDs
and uses embedded tags first, followed by normalized `Artist - Title` filenames.
Use `--audio-dir /another/local/path` when keeping the audio outside the repository.

The directory scan is recursive. Metadata matching prefers an explicit local filename
or track ID, then embedded tags, then normalized artist/title filenames. Ambiguous
matches are skipped and reported rather than guessed.

## Analysis and resumption

Librosa retains actual BPM plus compact RMS, onset, spectral, zero-crossing, and
dynamic-range measurements. The optional OpenAI provider receives only those numbers
and track metadata, returning validated raw 0–100 energy, danceability, valence,
socialness, and intensity annotations. No audio or local path is sent.

Audio analysis and successful annotations have separate atomic caches under
`cache/song_preprocessing/`. After all successful tracks are ready, semantic metrics
are min/max normalized across that library to `[0, 1]`; raw ratings, measurements, and
actual BPM remain available for debugging.

Generated files are:

- `data/songProfiles.json` — normalized database consumed by the DJ selector;
- `data/rawAudioFeatures.json` — objective analysis;
- `data/rawLLMAnnotations.json` — raw validated semantic ratings;
- `data/songPreprocessingReport.json` — matching and failure diagnostics.

Use `--force` to repeat LLM annotation and `--force-audio` to repeat librosa analysis.
Run the synthetic, no-network test suite with `pytest`.
