from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from tools.song_preprocessing.config import LLMConfig
from tools.song_preprocessing.llm_annotator import (
    LLMBudgetExceeded,
    OpenAISongAnnotator,
    SYSTEM_PROMPT,
    validate_annotation_batch,
)
from tools.song_preprocessing.models import (
    AudioFeatures,
    FinalSongProfile,
    SongAnnotation,
    SongAnnotationBatch,
    TrackMetadata,
)


def annotation(identifier: str, value: int = 50) -> SongAnnotation:
    return SongAnnotation(
        song_id=identifier,
        energy=value,
        danceability=value,
        valence=value,
        socialness=value,
        intensity=value,
        description="A valid description",
    )


def song_input(identifier: str = "song") -> tuple[TrackMetadata, AudioFeatures]:
    return (
        TrackMetadata(id=identifier, title="Title", artist="Artist"),
        AudioFeatures(
            bpm=120,
            duration_seconds=180,
            beat_count=360,
            rms_mean=0.1,
            rms_median=0.09,
            rms_p95=0.2,
            rms_max=0.3,
            onset_strength_mean=1.0,
            onset_strength_median=0.8,
            onset_strength_p95=2.0,
            onset_rate=2.0,
            spectral_centroid_mean=2500,
            spectral_bandwidth_mean=3000,
            spectral_rolloff_mean=6000,
            zero_crossing_rate_mean=0.08,
            dynamic_range=0.12,
        ),
    )


class FakeResponses:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def parse(self, **request):
        self.calls.append(request)
        song_id = request["input"][1]["content"].split('"songId":"', 1)[1].split('"', 1)[0]
        return SimpleNamespace(output_parsed=SongAnnotationBatch(songs=[annotation(song_id)]))


def test_annotation_schema_rejects_out_of_range_values() -> None:
    with pytest.raises(ValidationError):
        annotation("song", 101)


def test_batch_validation_requires_exact_ids_and_preserves_request_order() -> None:
    batch = SongAnnotationBatch(songs=[annotation("b"), annotation("a")])
    ordered = validate_annotation_batch(batch, ["a", "b"])
    assert [item.song_id for item in ordered] == ["a", "b"]
    with pytest.raises(ValueError):
        validate_annotation_batch(batch, ["a", "c"])


def test_prompt_contains_absolute_scoring_guardrails() -> None:
    assert "DO NOT rank or normalize" in SYSTEM_PROMPT
    assert "Do not calculate this as 100 minus energy" in SYSTEM_PROMPT
    assert "Do not equate BPM with danceability" in SYSTEM_PROMPT


def test_final_output_schema_rejects_non_normalized_value() -> None:
    with pytest.raises(ValidationError):
        FinalSongProfile.model_validate(
            {
                "id": "x",
                "title": "Title",
                "artist": "Artist",
                "bpm": 120,
                "energy": 1.1,
                "danceability": 0.5,
                "valence": 0.5,
                "socialness": 0.5,
                "intensity": 0.5,
                "normalizedAudio": {
                    "rmsMean": 0.5,
                    "onsetStrengthMean": 0.5,
                    "onsetRate": 0.5,
                    "spectralBrightness": 0.5,
                    "dynamicRange": 0.5,
                },
                "raw": {},
            }
        )


def test_openai_annotator_caps_output_and_reserves_only_a_small_ceiling() -> None:
    responses = FakeResponses()
    client = SimpleNamespace(responses=responses)
    config = LLMConfig(max_retries=1, max_estimated_run_cost_usd=0.50)
    annotator = OpenAISongAnnotator(config, client=client)

    result = annotator.annotate_batch([song_input()])

    assert result[0].song_id == "song"
    assert responses.calls[0]["max_output_tokens"] == 800
    assert 0 < annotator.reserved_cost_usd < 0.01


def test_cost_guard_blocks_before_any_api_request() -> None:
    responses = FakeResponses()
    client = SimpleNamespace(responses=responses)
    config = LLMConfig(max_retries=1, max_estimated_run_cost_usd=0.000001)
    annotator = OpenAISongAnnotator(config, client=client)

    with pytest.raises(LLMBudgetExceeded, match="stopped the request"):
        annotator.annotate_batch([song_input()])

    assert responses.calls == []
    assert annotator.reserved_cost_usd == 0
