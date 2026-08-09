# Deployed demo catalogue

Place only redistribution-safe demo audio in this directory. The deployed
Node server automatically prefers `data/songs/` when it contains audio and serves its
audio through `/songs/`.

Build exact profile-to-file mappings from the repository root:

```bash
python preprocess_songs.py \
  --audio-dir ./data/songs \
  --metadata ./data/tracks.json \
  --output ./data/songProfiles.json
```

Omit `--metadata` when filenames or embedded tags are sufficient. Every new
profile includes an `audioFile` path relative to this folder, so Auto-DJ does
not have to guess which file belongs to a song.

GitHub rejects individual files over 100 MB. Keep the demo catalogue small and
do not add tracks unless their licence permits redistribution.
