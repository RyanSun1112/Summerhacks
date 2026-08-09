"""Provider-isolated semantic annotation with strict structured output."""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Protocol, Sequence

from .config import LLMConfig
from .models import AudioFeatures, SongAnnotation, SongAnnotationBatch, TrackMetadata


SYSTEM_PROMPT = """You are rating songs for an adaptive venue DJ catalog.

Judge each song independently according to this absolute rubric.
DO NOT rank or normalize songs relative to the songs included in this request.

Return integer ratings from 0 to 100:

ENERGY — Perceived musical and physical energy: drive, percussion, density,
momentum, loudness impression, tempo, and physical excitement. 0 is extremely
calm/subdued, 50 is moderate, and 100 is peak-energy/intense.

DANCEABILITY — How naturally the track encourages sustained rhythmic body
movement: groove, beat clarity, rhythmic regularity, suitable tempo, and
bass/percussion drive. 0 is extremely difficult or uninviting to dance to; 100
is an extremely strong dance-floor groove. Do not equate BPM with danceability.

VALENCE — Perceived emotional positivity/brightness. 0 is extremely dark,
somber, or tense; 50 is neutral/mixed; 100 is extremely bright, euphoric, and
positive.

SOCIALNESS — Suitability while people are primarily talking, mingling, and
socializing rather than intensely dancing. 0 is attention-demanding,
overwhelming, or a peak dance-floor track; 100 is highly compatible with relaxed
social interaction. Do not calculate this as 100 minus energy; an energetic song
can still work socially.

INTENSITY — How forceful, aggressive, dramatic, or commanding the track feels.
This differs from energy: a track can be energetic but playful, or moderately
paced but extremely intense. 0 is extremely gentle/non-demanding; 100 is
extremely forceful/intense.

Use your semantic knowledge if you recognize a track AND use the supplied
objective audio evidence. Never invent factual audio measurements or contradict
the supplied measurements. If unfamiliar with a song, rely primarily on its
metadata, genres, year, and librosa features. Keep each description concise and
evidence-grounded. Return exactly one result for every supplied songId."""


SongInput = tuple[TrackMetadata, AudioFeatures]


class LLMBudgetExceeded(RuntimeError):
    """Raised before a request that would exceed the configured local ceiling."""


class SongAnnotator(Protocol):
    def annotate_batch(self, songs: Sequence[SongInput]) -> list[SongAnnotation]: ...


def annotation_payload(metadata: TrackMetadata, audio: AudioFeatures) -> dict[str, object]:
    """Compact evidence sent to a provider; it never contains audio or a file path."""

    return {
        "songId": metadata.id,
        "title": metadata.title,
        "artist": metadata.artist,
        "album": metadata.album,
        "year": metadata.year,
        "genres": metadata.genres,
        "audioAnalysis": audio.model_dump(mode="json", by_alias=True),
    }


def validate_annotation_batch(
    batch: SongAnnotationBatch,
    expected_ids: Sequence[str],
) -> list[SongAnnotation]:
    by_id = {annotation.song_id: annotation for annotation in batch.songs}
    expected = list(expected_ids)
    missing = [song_id for song_id in expected if song_id not in by_id]
    unexpected = [song_id for song_id in by_id if song_id not in set(expected)]
    if missing or unexpected or len(batch.songs) != len(expected):
        raise ValueError(
            f"annotation IDs do not match request (missing={missing}, unexpected={unexpected})"
        )
    return [by_id[song_id] for song_id in expected]


class OpenAISongAnnotator:
    """OpenAI Responses API provider using Pydantic Structured Outputs."""

    def __init__(self, config: LLMConfig | None = None, client: object | None = None) -> None:
        self.config = config or LLMConfig()
        if client is None:
            if not os.getenv("OPENAI_API_KEY"):
                raise ValueError(
                    "OPENAI_API_KEY is not set; export it, add it to .env, or use --skip-llm"
                )
            from openai import OpenAI

            client = OpenAI()
        self.client = client
        self._budget_lock = threading.Lock()
        self._reserved_cost_usd = 0.0

    @property
    def reserved_cost_usd(self) -> float:
        """Conservative request reservations, not the provider's final invoice."""

        with self._budget_lock:
            return self._reserved_cost_usd

    def _max_output_tokens(self, song_count: int) -> int:
        requested = self.config.output_token_overhead + (
            self.config.output_tokens_per_song * song_count
        )
        return min(self.config.max_output_tokens_per_request, requested)

    def _request_cost_upper_bound(self, input_text: str, max_output_tokens: int) -> float:
        # UTF-8 byte count is intentionally much more conservative than the usual
        # ~4-characters-per-token estimate. The additional overhead covers SDK
        # framing and the Structured Outputs schema that is not in input_text.
        estimated_input_tokens = (
            len(input_text.encode("utf-8")) + self.config.input_token_safety_overhead
        )
        return (
            estimated_input_tokens * self.config.input_cost_per_million_usd
            + max_output_tokens * self.config.output_cost_per_million_usd
        ) / 1_000_000

    def _reserve_request(self, estimated_cost_usd: float) -> None:
        with self._budget_lock:
            projected = self._reserved_cost_usd + estimated_cost_usd
            if projected > self.config.max_estimated_run_cost_usd + 1e-12:
                raise LLMBudgetExceeded(
                    "local LLM cost guard stopped the request: conservative estimated "
                    f"spend would exceed ${self.config.max_estimated_run_cost_usd:.2f}; "
                    "rerun cached work or intentionally raise --max-llm-cost-usd"
                )
            self._reserved_cost_usd = projected

    def annotate_batch(self, songs: Sequence[SongInput]) -> list[SongAnnotation]:
        if not songs:
            return []
        expected_ids = [metadata.id for metadata, _ in songs]
        user_payload = [annotation_payload(metadata, audio) for metadata, audio in songs]
        user_content = "Rate these songs using the absolute rubric:\n" + json.dumps(
            user_payload, ensure_ascii=False, separators=(",", ":")
        )
        max_output_tokens = self._max_output_tokens(len(songs))
        request: dict[str, object] = {
            "model": self.config.model,
            "input": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            "text_format": SongAnnotationBatch,
            "max_output_tokens": max_output_tokens,
        }
        if self.config.reasoning_effort:
            request["reasoning"] = {"effort": self.config.reasoning_effort}

        last_error: Exception | None = None
        for attempt in range(self.config.max_retries):
            try:
                self._reserve_request(
                    self._request_cost_upper_bound(
                        SYSTEM_PROMPT + "\n" + user_content,
                        max_output_tokens,
                    )
                )
                response = self.client.responses.parse(**request)  # type: ignore[attr-defined]
                parsed = response.output_parsed
                if parsed is None:
                    raise ValueError("model returned no parsed structured output")
                batch = (
                    parsed
                    if isinstance(parsed, SongAnnotationBatch)
                    else SongAnnotationBatch.model_validate(parsed)
                )
                return validate_annotation_batch(batch, expected_ids)
            except LLMBudgetExceeded:
                raise
            except Exception as error:
                last_error = error
                if attempt + 1 < self.config.max_retries:
                    time.sleep(self.config.retry_base_seconds * (2**attempt))
        assert last_error is not None
        raise RuntimeError(
            f"OpenAI annotation failed after {self.config.max_retries} attempts: {last_error}"
        ) from last_error


class MockSongAnnotator:
    """Deterministic, non-semantic annotator for integration tests and CLI smoke runs."""

    def annotate_batch(self, songs: Sequence[SongInput]) -> list[SongAnnotation]:
        results: list[SongAnnotation] = []
        for metadata, audio in songs:
            tempo_component = max(0.0, min(1.0, (audio.bpm - 60.0) / 120.0))
            attack_component = max(0.0, min(1.0, audio.onset_rate / 4.0))
            energy = round(100 * (0.55 * tempo_component + 0.45 * attack_component))
            danceability = round(100 * (0.35 + 0.65 * attack_component))
            intensity = round(100 * (0.65 * tempo_component + 0.35 * attack_component))
            results.append(
                SongAnnotation(
                    song_id=metadata.id,
                    energy=energy,
                    danceability=danceability,
                    valence=50,
                    socialness=max(0, min(100, 75 - round(intensity * 0.4))),
                    intensity=intensity,
                    description="Mock annotation for local pipeline testing; not an LLM semantic rating.",
                )
            )
        return results
