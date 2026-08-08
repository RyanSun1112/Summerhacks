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

## Run

Analyze five songs without API calls:

```bash
python preprocess_songs.py --audio-dir ./songs --metadata ./tracks.json --limit 5 --skip-llm
```

Run a no-cost end-to-end test with clearly labelled mock annotations:

```bash
python preprocess_songs.py --audio-dir ./songs --metadata ./tracks.json --limit 5 --mock-llm
```

Process the complete library:

```bash
python preprocess_songs.py \
  --audio-dir ./songs \
  --metadata ./tracks.json \
  --output ./data/songProfiles.json
```

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
