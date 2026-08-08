import numpy as np
import pytest
import soundfile as sf

from tools.song_preprocessing.audio_features import AudioFeatureExtractor, summarize_frames


def test_frame_summary_uses_percentiles() -> None:
    summary = summarize_frames(np.array([0, 1, 2, 100], dtype=float))
    assert summary["median"] == 1.5
    assert summary["p95"] < summary["max"]


def test_extracts_features_from_synthetic_waveform(tmp_path) -> None:
    sample_rate = 22_050
    seconds = 3
    times = np.arange(sample_rate * seconds) / sample_rate
    waveform = (0.15 * np.sin(2 * np.pi * 440 * times)).astype(np.float32)
    waveform[:: sample_rate // 2] += 0.8
    path = tmp_path / "synthetic.wav"
    sf.write(path, waveform, sample_rate)

    features = AudioFeatureExtractor().extract(path)
    assert features.duration_seconds == pytest.approx(seconds, rel=0.01)
    assert features.rms_mean > 0
    assert features.spectral_centroid_mean > 0
    assert features.dynamic_range >= 0
