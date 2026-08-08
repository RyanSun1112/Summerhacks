import json

from tools.song_preprocessing.metadata import load_metadata, match_tracks, normalize_match_text


def test_match_normalization_removes_common_version_noise() -> None:
    assert normalize_match_text("Caf\u00e9 Song (Radio Edit) feat. Guest") == "cafe song"


def test_loads_spotify_style_json(tmp_path) -> None:
    path = tmp_path / "tracks.json"
    path.write_text(
        json.dumps(
            {
                "tracks": {
                    "items": [
                        {
                            "track": {
                                "id": "abc",
                                "name": "Pulse",
                                "artists": [{"name": "DJ Test"}],
                                "album": {"name": "Night", "release_date": "2024-03-01"},
                            }
                        }
                    ]
                }
            }
        ),
        encoding="utf-8",
    )
    tracks = load_metadata(path)
    assert tracks[0].artist == "DJ Test"
    assert tracks[0].title == "Pulse"
    assert tracks[0].year == 2024


def test_explicit_file_mapping_wins(tmp_path) -> None:
    audio = tmp_path / "unrelated.wav"
    audio.write_bytes(b"")
    metadata_path = tmp_path / "tracks.json"
    metadata_path.write_text(
        json.dumps([{"id": "1", "title": "Song", "artist": "Artist", "audioFile": "unrelated.wav"}]),
        encoding="utf-8",
    )
    report = match_tracks([audio], load_metadata(metadata_path), tmp_path)
    assert report.matches[0].metadata.id == "1"
    assert report.matches[0].match_method == "explicit-file"


def test_filename_match_ignores_featured_artist_suffix(tmp_path) -> None:
    audio = tmp_path / "Artist - Song.wav"
    audio.write_bytes(b"")
    metadata_path = tmp_path / "tracks.json"
    metadata_path.write_text(
        json.dumps([{"id": "1", "title": "Song (Radio Edit)", "artist": "Artist feat. Guest"}]),
        encoding="utf-8",
    )
    report = match_tracks([audio], load_metadata(metadata_path), tmp_path)
    assert report.matches[0].metadata.id == "1"
    assert report.matches[0].match_method == "filename-title-artist"


def test_ambiguous_filename_is_reported_not_guessed(tmp_path) -> None:
    audio = tmp_path / "Artist - Song.wav"
    audio.write_bytes(b"")
    metadata_path = tmp_path / "tracks.json"
    metadata_path.write_text(
        json.dumps(
            [
                {"id": "1", "title": "Song", "artist": "Artist"},
                {"id": "2", "title": "Song", "artist": "Artist"},
            ]
        ),
        encoding="utf-8",
    )
    report = match_tracks([audio], load_metadata(metadata_path), tmp_path)
    assert not report.matches
    assert any(issue.kind == "ambiguous-match" for issue in report.issues)
