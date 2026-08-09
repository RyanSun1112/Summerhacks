from tools.song_preprocessing.config import NormalizationConfig
from tools.song_preprocessing.models import AudioFeatures, RawSongProfile, SongAnnotation, TrackMetadata
from tools.song_preprocessing.normalization import min_max_normalize, normalize_library


def audio(rms: float, onset: float) -> AudioFeatures:
    return AudioFeatures(
        bpm=120,
        duration_seconds=60,
        beat_count=120,
        rms_mean=rms,
        rms_median=rms,
        rms_p95=rms + 0.1,
        rms_max=rms + 0.2,
        onset_strength_mean=onset,
        onset_strength_median=onset,
        onset_strength_p95=onset + 0.1,
        onset_rate=onset,
        spectral_centroid_mean=1000 + onset,
        spectral_bandwidth_mean=2000,
        spectral_rolloff_mean=4000,
        zero_crossing_rate_mean=0.05,
        dynamic_range=0.1,
    )


def profile(identifier: str, score: int, rms: float, onset: float) -> RawSongProfile:
    return RawSongProfile(
        metadata=TrackMetadata(id=identifier, title=identifier, artist="Artist"),
        audio=audio(rms, onset),
        source_file=f"{identifier}.wav",
        llm=SongAnnotation(
            song_id=identifier,
            energy=score,
            danceability=score,
            valence=score,
            socialness=score,
            intensity=score,
            description="Validated test annotation",
        ),
    )


def test_min_max_normalize_spans_library() -> None:
    assert min_max_normalize([24, 67, 91]) == [0.0, 43 / 67, 1.0]


def test_min_max_normalize_equal_values_are_neutral() -> None:
    assert min_max_normalize([7, 7, 7]) == [0.5, 0.5, 0.5]


def test_final_output_preserves_raw_values_and_bounds_normalized_values() -> None:
    result = normalize_library([profile("low", 20, 0.1, 1), profile("high", 90, 0.3, 3)])
    assert result[0]["energy"] == 0.0
    assert result[1]["energy"] == 1.0
    assert result[0]["audioFile"] == "low.wav"
    assert result[1]["raw"]["llm"]["energy"] == 90
    assert result[1]["raw"]["audio"]["rmsMean"] == 0.3
    assert all(0 <= song["normalizedAudio"]["rmsMean"] <= 1 for song in result)


def test_hybrid_energy_is_configurable() -> None:
    profiles = [profile("a", 90, 0.1, 1), profile("b", 20, 0.5, 4)]
    result = normalize_library(
        profiles,
        NormalizationConfig(
            energy_strategy="hybrid",
            hybrid_energy_weights={"llm": 0.1, "rms_mean": 0.9},
        ),
    )
    assert result[0]["energy"] == 0.0
    assert result[1]["energy"] == 1.0
