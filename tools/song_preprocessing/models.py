"""Validated data models shared by every preprocessing stage."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


def to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class PipelineModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class TrackMetadata(PipelineModel):
    id: str
    title: str
    artist: str
    album: str | None = None
    year: int | None = None
    genres: list[str] = Field(default_factory=list)
    audio_file: str | None = Field(default=None, exclude=True)
    spotify_uri: str | None = Field(default=None, exclude=True)

    @field_validator("id", "title", "artist")
    @classmethod
    def nonempty_required_text(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("must not be empty")
        return cleaned

    @field_validator("genres", mode="before")
    @classmethod
    def normalize_genres(cls, value: Any) -> list[str]:
        if value is None or value == "":
            return []
        if isinstance(value, str):
            delimiter = ";" if ";" in value else ","
            value = value.split(delimiter)
        if not isinstance(value, (list, tuple, set)):
            raise ValueError("genres must be a list or delimited string")
        seen: set[str] = set()
        result: list[str] = []
        for item in value:
            genre = str(item).strip()
            if genre and genre.casefold() not in seen:
                seen.add(genre.casefold())
                result.append(genre)
        return result

    @field_validator("year", mode="before")
    @classmethod
    def parse_year(cls, value: Any) -> int | None:
        if value is None or value == "":
            return None
        text = str(value).strip()
        if len(text) >= 4 and text[:4].isdigit():
            return int(text[:4])
        raise ValueError(f"invalid year: {value!r}")


class AudioFeatures(PipelineModel):
    bpm: float = Field(ge=0)
    duration_seconds: float = Field(ge=0)
    beat_count: int = Field(ge=0)
    rms_mean: float = Field(ge=0)
    rms_median: float = Field(ge=0)
    rms_p95: float = Field(ge=0)
    rms_max: float = Field(ge=0)
    onset_strength_mean: float = Field(ge=0)
    onset_strength_median: float = Field(ge=0)
    onset_strength_p95: float = Field(ge=0)
    onset_rate: float = Field(ge=0)
    spectral_centroid_mean: float = Field(ge=0)
    spectral_bandwidth_mean: float = Field(ge=0)
    spectral_rolloff_mean: float = Field(ge=0)
    zero_crossing_rate_mean: float = Field(ge=0)
    dynamic_range: float = Field(ge=0)


class SongAnnotation(PipelineModel):
    song_id: str
    energy: int = Field(ge=0, le=100)
    danceability: int = Field(ge=0, le=100)
    valence: int = Field(ge=0, le=100)
    socialness: int = Field(ge=0, le=100)
    intensity: int = Field(ge=0, le=100)
    description: str = Field(min_length=1, max_length=500)


class SongAnnotationBatch(PipelineModel):
    songs: list[SongAnnotation] = Field(min_length=1)

    @field_validator("songs")
    @classmethod
    def unique_song_ids(cls, songs: list[SongAnnotation]) -> list[SongAnnotation]:
        ids = [song.song_id for song in songs]
        if len(ids) != len(set(ids)):
            raise ValueError("songId values must be unique")
        return songs


class RawSongProfile(PipelineModel):
    metadata: TrackMetadata
    audio: AudioFeatures
    source_file: str
    llm: SongAnnotation | None = None


class NormalizedAudioFeatures(PipelineModel):
    rms_mean: float = Field(ge=0, le=1)
    onset_strength_mean: float = Field(ge=0, le=1)
    onset_rate: float = Field(ge=0, le=1)
    spectral_brightness: float = Field(ge=0, le=1)
    dynamic_range: float = Field(ge=0, le=1)


class RawProfileValues(PipelineModel):
    llm: SongAnnotation
    audio: AudioFeatures


class FinalSongProfile(PipelineModel):
    id: str
    title: str
    artist: str
    album: str | None = None
    year: int | None = None
    genres: list[str] = Field(default_factory=list)

    @field_validator("year", mode="before")
    @classmethod
    def plausible_year(cls, value: Any) -> int | None:
        # Mirror the Node selector's validator (lib/dj/models.js): a year must
        # be a plausible integer or absent. Real-world ID3 tags produced 1002,
        # 7002 and 2 from old netlabel MP3s, and the selector refused the
        # whole library over them — better to drop the field than the song.
        if value is None or value == "":
            return None
        try:
            year = int(str(value).strip()[:4])
        except (TypeError, ValueError):
            return None
        return year if 1800 <= year <= 3000 else None
    bpm: float = Field(ge=0)
    energy: float = Field(ge=0, le=1)
    danceability: float = Field(ge=0, le=1)
    valence: float = Field(ge=0, le=1)
    socialness: float = Field(ge=0, le=1)
    intensity: float = Field(ge=0, le=1)
    normalized_audio: NormalizedAudioFeatures
    raw: RawProfileValues


class TrackMatch(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    audio_path: Path
    metadata: TrackMetadata
    match_method: str


class MatchIssue(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    audio_path: Path | None = None
    kind: str
    message: str
    candidates: list[str] = Field(default_factory=list)


class MatchReport(BaseModel):
    matches: list[TrackMatch] = Field(default_factory=list)
    issues: list[MatchIssue] = Field(default_factory=list)
    unmatched_metadata_ids: list[str] = Field(default_factory=list)
