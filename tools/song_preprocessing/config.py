"""Central configuration for offline song analysis."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


SUPPORTED_AUDIO_EXTENSIONS = frozenset({".wav", ".mp3", ".flac", ".m4a"})
ANALYSIS_SAMPLE_RATE = 22_050
FRAME_LENGTH = 2_048
HOP_LENGTH = 512

# A small, economical model is the default for a few hundred compact records.
# Change this after evaluating annotations on a representative sample.
LLM_MODEL = "gpt-5-mini"
LLM_BATCH_SIZE = 10
LLM_CONCURRENCY = 2
LLM_MAX_RETRIES = 3
LLM_RETRY_BASE_SECONDS = 1.0
LLM_PROMPT_VERSION = "song-rubric-v1"

DEFAULT_CACHE_DIRECTORY = Path("cache/song_preprocessing")
DEFAULT_OUTPUT_PATH = Path("data/songProfiles.json")

SEMANTIC_FIELDS = (
    "energy",
    "danceability",
    "valence",
    "socialness",
    "intensity",
)

OBJECTIVE_NORMALIZATION_FIELDS = (
    "rms_mean",
    "onset_strength_mean",
    "onset_rate",
    "spectral_centroid_mean",
    "dynamic_range",
)

# Hybrid energy is experimental. Each input is library-normalized before blending,
# and the blend is min/max-normalized once more. Weights need not sum to one; the
# normalizer below handles that safely.
DEFAULT_HYBRID_ENERGY_WEIGHTS = {
    "llm": 0.60,
    "rms_mean": 0.15,
    "onset_strength_mean": 0.10,
    "onset_rate": 0.10,
    "spectral_centroid_mean": 0.05,
}


@dataclass(frozen=True)
class AnalysisConfig:
    sample_rate: int = ANALYSIS_SAMPLE_RATE
    frame_length: int = FRAME_LENGTH
    hop_length: int = HOP_LENGTH


@dataclass(frozen=True)
class LLMConfig:
    model: str = LLM_MODEL
    batch_size: int = LLM_BATCH_SIZE
    concurrency: int = LLM_CONCURRENCY
    max_retries: int = LLM_MAX_RETRIES
    retry_base_seconds: float = LLM_RETRY_BASE_SECONDS
    prompt_version: str = LLM_PROMPT_VERSION
    reasoning_effort: str | None = "low"


@dataclass(frozen=True)
class NormalizationConfig:
    energy_strategy: str = "llm"
    hybrid_energy_weights: dict[str, float] = field(
        default_factory=lambda: dict(DEFAULT_HYBRID_ENERGY_WEIGHTS)
    )

    def __post_init__(self) -> None:
        if self.energy_strategy not in {"llm", "hybrid"}:
            raise ValueError("energy_strategy must be 'llm' or 'hybrid'")
        if not self.hybrid_energy_weights or any(
            weight < 0 for weight in self.hybrid_energy_weights.values()
        ):
            raise ValueError("hybrid energy weights must be non-negative")
        if sum(self.hybrid_energy_weights.values()) <= 0:
            raise ValueError("at least one hybrid energy weight must be positive")
