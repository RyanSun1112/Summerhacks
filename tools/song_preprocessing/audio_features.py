"""Understandable, track-at-a-time librosa feature extraction."""

from __future__ import annotations

from pathlib import Path

import librosa
import numpy as np

from .config import AnalysisConfig
from .models import AudioFeatures


def summarize_frames(values: np.ndarray) -> dict[str, float]:
    """Return robust summary statistics for a frame-level feature."""

    flattened = np.asarray(values, dtype=np.float64).reshape(-1)
    flattened = flattened[np.isfinite(flattened)]
    if flattened.size == 0:
        return {"mean": 0.0, "median": 0.0, "p95": 0.0, "max": 0.0, "p10": 0.0}
    return {
        "mean": float(np.mean(flattened)),
        "median": float(np.median(flattened)),
        "p95": float(np.percentile(flattened, 95)),
        "max": float(np.max(flattened)),
        "p10": float(np.percentile(flattened, 10)),
    }


def _mean_finite(values: np.ndarray) -> float:
    flattened = np.asarray(values, dtype=np.float64).reshape(-1)
    flattened = flattened[np.isfinite(flattened)]
    return float(np.mean(flattened)) if flattened.size else 0.0


class AudioFeatureExtractor:
    """Load one file in mono, extract compact objective features, then release it."""

    def __init__(self, config: AnalysisConfig | None = None) -> None:
        self.config = config or AnalysisConfig()

    def extract(self, audio_path: Path) -> AudioFeatures:
        y, sample_rate = librosa.load(
            audio_path,
            sr=self.config.sample_rate,
            mono=True,
            dtype=np.float32,
        )
        if y.size == 0:
            raise ValueError("decoded audio contains no samples")
        duration = float(librosa.get_duration(y=y, sr=sample_rate))
        if duration <= 0:
            raise ValueError("decoded audio has zero duration")

        rms = librosa.feature.rms(
            y=y,
            frame_length=self.config.frame_length,
            hop_length=self.config.hop_length,
        )[0]
        rms_stats = summarize_frames(rms)

        onset_envelope = librosa.onset.onset_strength(
            y=y,
            sr=sample_rate,
            hop_length=self.config.hop_length,
        )
        onset_stats = summarize_frames(onset_envelope)
        onset_frames = librosa.onset.onset_detect(
            onset_envelope=onset_envelope,
            sr=sample_rate,
            hop_length=self.config.hop_length,
            units="frames",
            backtrack=False,
        )

        tempo, beat_frames = librosa.beat.beat_track(
            onset_envelope=onset_envelope,
            sr=sample_rate,
            hop_length=self.config.hop_length,
        )
        tempo_values = np.asarray(tempo, dtype=np.float64).reshape(-1)
        bpm = float(tempo_values[0]) if tempo_values.size and np.isfinite(tempo_values[0]) else 0.0

        centroid = librosa.feature.spectral_centroid(
            y=y, sr=sample_rate, hop_length=self.config.hop_length
        )
        bandwidth = librosa.feature.spectral_bandwidth(
            y=y, sr=sample_rate, hop_length=self.config.hop_length
        )
        rolloff = librosa.feature.spectral_rolloff(
            y=y,
            sr=sample_rate,
            hop_length=self.config.hop_length,
            roll_percent=0.85,
        )
        zcr = librosa.feature.zero_crossing_rate(
            y,
            frame_length=self.config.frame_length,
            hop_length=self.config.hop_length,
        )

        # This is deliberately not LUFS or a mastering DR score. It is the absolute
        # difference between the 95th and 10th percentile frame RMS amplitudes.
        dynamic_range = max(0.0, rms_stats["p95"] - rms_stats["p10"])

        return AudioFeatures(
            bpm=max(0.0, bpm),
            duration_seconds=duration,
            beat_count=int(len(beat_frames)),
            rms_mean=rms_stats["mean"],
            rms_median=rms_stats["median"],
            rms_p95=rms_stats["p95"],
            rms_max=rms_stats["max"],
            onset_strength_mean=onset_stats["mean"],
            onset_strength_median=onset_stats["median"],
            onset_strength_p95=onset_stats["p95"],
            onset_rate=float(len(onset_frames) / duration),
            spectral_centroid_mean=max(0.0, _mean_finite(centroid)),
            spectral_bandwidth_mean=max(0.0, _mean_finite(bandwidth)),
            spectral_rolloff_mean=max(0.0, _mean_finite(rolloff)),
            zero_crossing_rate_mean=max(0.0, _mean_finite(zcr)),
            dynamic_range=dynamic_range,
        )
