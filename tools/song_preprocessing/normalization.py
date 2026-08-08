"""Whole-library normalization and configurable semantic/profile assembly."""

from __future__ import annotations

import math
from collections.abc import Iterable

from .config import OBJECTIVE_NORMALIZATION_FIELDS, SEMANTIC_FIELDS, NormalizationConfig
from .models import FinalSongProfile, RawSongProfile


def min_max_normalize(values: Iterable[float], neutral: float = 0.5) -> list[float]:
    """Map finite values linearly to [0, 1], or to neutral when all are equal."""

    numbers = [float(value) for value in values]
    if not numbers:
        return []
    if any(not math.isfinite(value) for value in numbers):
        raise ValueError("normalization values must all be finite")
    minimum = min(numbers)
    maximum = max(numbers)
    if math.isclose(maximum, minimum, rel_tol=0.0, abs_tol=1e-12):
        return [neutral] * len(numbers)
    scale = maximum - minimum
    return [(value - minimum) / scale for value in numbers]


def _rounded_model_dict(model: object) -> dict[str, object]:
    data = model.model_dump(mode="json", by_alias=True)  # type: ignore[attr-defined]
    return {
        key: round(value, 6) if isinstance(value, float) else value
        for key, value in data.items()
    }


def normalize_library(
    raw_profiles: list[RawSongProfile],
    config: NormalizationConfig | None = None,
) -> list[dict[str, object]]:
    """Build live-ready profiles after every raw profile is available."""

    if not raw_profiles:
        return []
    if any(profile.llm is None for profile in raw_profiles):
        raise ValueError("cannot build final profiles while LLM annotations are missing")
    config = config or NormalizationConfig()

    semantic: dict[str, list[float]] = {}
    for field in SEMANTIC_FIELDS:
        semantic[field] = min_max_normalize(
            getattr(profile.llm, field) for profile in raw_profiles if profile.llm is not None
        )

    objective: dict[str, list[float]] = {
        field: min_max_normalize(getattr(profile.audio, field) for profile in raw_profiles)
        for field in OBJECTIVE_NORMALIZATION_FIELDS
    }

    final_energy = semantic["energy"]
    if config.energy_strategy == "hybrid":
        components: list[float] = []
        weight_total = sum(config.hybrid_energy_weights.values())
        for index in range(len(raw_profiles)):
            weighted = 0.0
            for source, weight in config.hybrid_energy_weights.items():
                values = semantic["energy"] if source == "llm" else objective[source]
                weighted += weight * values[index]
            components.append(weighted / weight_total)
        final_energy = min_max_normalize(components)

    profiles: list[dict[str, object]] = []
    for index, raw_profile in enumerate(raw_profiles):
        metadata = raw_profile.metadata
        audio = raw_profile.audio
        annotation = raw_profile.llm
        assert annotation is not None
        normalized_audio = {
            "rmsMean": objective["rms_mean"][index],
            "onsetStrengthMean": objective["onset_strength_mean"][index],
            "onsetRate": objective["onset_rate"][index],
            "spectralBrightness": objective["spectral_centroid_mean"][index],
            "dynamicRange": objective["dynamic_range"][index],
        }
        profile = FinalSongProfile.model_validate(
            {
                "id": metadata.id,
                "title": metadata.title,
                "artist": metadata.artist,
                "album": metadata.album,
                "year": metadata.year,
                "genres": metadata.genres,
                "bpm": round(audio.bpm, 3),
                "energy": round(final_energy[index], 6),
                "danceability": round(semantic["danceability"][index], 6),
                "valence": round(semantic["valence"][index], 6),
                "socialness": round(semantic["socialness"][index], 6),
                "intensity": round(semantic["intensity"][index], 6),
                "normalizedAudio": {
                    key: round(value, 6) for key, value in normalized_audio.items()
                },
                "raw": {
                    "llm": _rounded_model_dict(annotation),
                    "audio": _rounded_model_dict(audio),
                },
            }
        )
        profiles.append(profile.model_dump(mode="json", by_alias=True))
    return profiles
