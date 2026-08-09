# Event song library

Put legitimately obtained `.mp3`, `.wav`, `.flac`, or `.m4a` files in this
directory before an event. Subdirectories are supported, so organizing files by
artist, album, or crate is fine.

Audio is analyzed in place; the preprocessor does not copy audio into `data/`, its
cache, or an API request. Only commit tracks whose licences permit redistribution;
keep private or commercial event catalogues outside the repository and point
`--audio-dir` and `SONGS_DIR` at that external directory instead.

From the repository root, test five tracks without an API call:

```bash
python preprocess_songs.py --limit 5 --skip-llm
```

Test the complete pipeline with deterministic mock semantic ratings:

```bash
python preprocess_songs.py --limit 5 --mock-llm
```

For real semantic attributes, set `OPENAI_API_KEY` locally and run:

```bash
python preprocess_songs.py --metadata ./data/tracks.json
```

Real runs use a conservative `$0.50` local estimated-cost ceiling by default,
including retry reservations. Start with `--limit 5`; only raise the ceiling
deliberately with `--max-llm-cost-usd`.

The final library is written to `data/songProfiles.json`. Metadata is optional:
embedded tags and filenames are used when no export is supplied. For the most
reliable matching, copy `data/tracks.example.json` to `data/tracks.json` and set
each record's `audioFile` to its path relative to this directory. The working
`data/tracks.json` file is also ignored so a private playlist export is not pushed
accidentally.
