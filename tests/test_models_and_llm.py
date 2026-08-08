import pytest
from pydantic import ValidationError

from tools.song_preprocessing.llm_annotator import SYSTEM_PROMPT, validate_annotation_batch
from tools.song_preprocessing.models import FinalSongProfile, SongAnnotation, SongAnnotationBatch


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
