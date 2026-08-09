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
LLM_MAX_ESTIMATED_RUN_COST_USD = 0.50
LLM_OUTPUT_TOKEN_OVERHEAD = 500
LLM_OUTPUT_TOKENS_PER_SONG = 300
LLM_MAX_OUTPUT_TOKENS_PER_REQUEST = 4_000
LLM_INPUT_TOKEN_SAFETY_OVERHEAD = 4_096

# Standard API prices in USD per one million tokens. Unknown/overridden models
# require explicit prices at the CLI so the local budget guard cannot silently
# underestimate them. Update this table when official pricing changes.
MODEL_PRICING_USD_PER_MILLION = {
    "gpt-5-mini": (0.25, 2.00),
    "gpt-5-mini-2025-08-07": (0.25, 2.00),
}

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
    max_estimated_run_cost_usd: float = LLM_MAX_ESTIMATED_RUN_COST_USD
    input_cost_per_million_usd: float = MODEL_PRICING_USD_PER_MILLION[LLM_MODEL][0]
    output_cost_per_million_usd: float = MODEL_PRICING_USD_PER_MILLION[LLM_MODEL][1]
    output_token_overhead: int = LLM_OUTPUT_TOKEN_OVERHEAD
    output_tokens_per_song: int = LLM_OUTPUT_TOKENS_PER_SONG
    max_output_tokens_per_request: int = LLM_MAX_OUTPUT_TOKENS_PER_REQUEST
    input_token_safety_overhead: int = LLM_INPUT_TOKEN_SAFETY_OVERHEAD

    def __post_init__(self) -> None:
        if self.batch_size < 1 or self.batch_size > 20:
            raise ValueError("batch_size must be between 1 and 20")
        if self.concurrency < 1 or self.max_retries < 1:
            raise ValueError("concurrency and max_retries must be positive")
        if self.max_estimated_run_cost_usd <= 0:
            raise ValueError("max_estimated_run_cost_usd must be positive")
        if self.input_cost_per_million_usd < 0 or self.output_cost_per_million_usd < 0:
            raise ValueError("token prices cannot be negative")
        if min(
            self.output_token_overhead,
            self.output_tokens_per_song,
            self.max_output_tokens_per_request,
            self.input_token_safety_overhead,
        ) < 0:
            raise ValueError("token budget settings cannot be negative")


def pricing_for_model(model: str) -> tuple[float, float] | None:
    """Return configured input/output prices per million tokens, if known."""

    return MODEL_PRICING_USD_PER_MILLION.get(model)


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
