import json

from tools.song_preprocessing.cache import JsonCache
from tools.song_preprocessing.models import SongAnnotation


def test_cache_round_trip_and_fingerprint_invalidation(tmp_path) -> None:
    cache = JsonCache(tmp_path / "cache")
    value = SongAnnotation(
        song_id="track/unsafe",
        energy=1,
        danceability=2,
        valence=3,
        socialness=4,
        intensity=5,
        description="Cached",
    )
    cache.write(value.song_id, "fingerprint-a", value)
    assert cache.load(value.song_id, "fingerprint-a", SongAnnotation) == value
    assert cache.load(value.song_id, "fingerprint-b", SongAnnotation) is None


def test_malformed_cache_is_treated_as_a_miss(tmp_path) -> None:
    cache = JsonCache(tmp_path)
    path = cache.path_for("track")
    path.write_text(json.dumps({"fingerprint": "ok", "value": {"energy": 20}}), encoding="utf-8")
    assert cache.load("track", "ok", SongAnnotation) is None
