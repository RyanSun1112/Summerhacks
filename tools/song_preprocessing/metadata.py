"""Metadata ingestion, embedded-tag reading, and conservative file matching."""

from __future__ import annotations

import csv
import hashlib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any, Iterable

from .config import SUPPORTED_AUDIO_EXTENSIONS
from .models import MatchIssue, MatchReport, TrackMatch, TrackMetadata


_BRACKETED = re.compile(r"\s*[\[(].*?[\])]\s*")
_FEATURING = re.compile(r"\b(?:feat(?:uring)?|ft)\.?\s+.*$", re.IGNORECASE)
_TRACK_NUMBER = re.compile(r"^\s*\d{1,3}[\s._-]+")
_NON_ALNUM = re.compile(r"[^\w]+", re.UNICODE)
_MULTISPACE = re.compile(r"\s+")


def scan_audio_files(
    audio_dir: Path,
    extensions: Iterable[str] = SUPPORTED_AUDIO_EXTENSIONS,
) -> list[Path]:
    """Return supported audio files recursively in deterministic order."""

    if not audio_dir.is_dir():
        raise ValueError(f"audio directory does not exist: {audio_dir}")
    allowed = {extension.casefold() for extension in extensions}
    return sorted(
        (
            path
            for path in audio_dir.rglob("*")
            if path.is_file() and path.suffix.casefold() in allowed
        ),
        key=lambda path: path.as_posix().casefold(),
    )


def normalize_match_text(value: str) -> str:
    """Normalize a title/artist/file fragment for conservative exact matching."""

    value = unicodedata.normalize("NFKD", value)
    value = "".join(character for character in value if not unicodedata.combining(character))
    value = _BRACKETED.sub(" ", value)
    value = _FEATURING.sub(" ", value)
    value = _NON_ALNUM.sub(" ", value.casefold())
    return _MULTISPACE.sub(" ", value).strip()


def _first(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping and mapping[key] not in (None, ""):
            return mapping[key]
    return None


def _artist_text(value: Any) -> str:
    if isinstance(value, list):
        names = [
            str(item.get("name", "")).strip() if isinstance(item, dict) else str(item).strip()
            for item in value
        ]
        return ", ".join(name for name in names if name)
    if isinstance(value, dict):
        return str(value.get("name", "")).strip()
    return str(value or "").strip()


def _unwrap_metadata_records(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        records = payload
    elif isinstance(payload, dict):
        records = payload.get("items") or payload.get("tracks") or payload.get("songs")
        if isinstance(records, dict):
            records = records.get("items")
        if records is None:
            records = [payload]
    else:
        raise ValueError("metadata JSON must be a list or object")
    if not isinstance(records, list):
        raise ValueError("metadata JSON does not contain a track list")

    result: list[dict[str, Any]] = []
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("every metadata entry must be an object")
        # Spotify playlist exports commonly wrap each item in {"track": {...}}.
        nested = record.get("track")
        result.append(nested if isinstance(nested, dict) else record)
    return result


def _record_to_metadata(record: dict[str, Any], row_number: int) -> TrackMetadata:
    album_value = record.get("album")
    album_name = album_value.get("name") if isinstance(album_value, dict) else album_value
    release_date = _first(record, "year", "releaseYear", "release_date", "releaseDate")
    if release_date is None and isinstance(album_value, dict):
        release_date = _first(album_value, "release_date", "releaseDate", "year")

    genres = _first(record, "genres", "genre") or []
    if not genres and isinstance(album_value, dict):
        genres = album_value.get("genres") or []

    track_id = _first(record, "id", "trackId", "track_id", "spotifyId", "spotify_id")
    spotify_uri = _first(record, "spotifyUri", "spotify_uri", "uri")
    if track_id is None and isinstance(spotify_uri, str) and spotify_uri.startswith("spotify:track:"):
        track_id = spotify_uri.rsplit(":", 1)[-1]
    if track_id is None:
        identity = f"{_artist_text(record.get('artists') or record.get('artist'))}|{record.get('title') or record.get('name')}"
        track_id = "metadata-" + hashlib.sha1(identity.encode("utf-8")).hexdigest()[:12]

    return TrackMetadata(
        id=str(track_id),
        title=str(_first(record, "title", "name") or f"Unknown track {row_number}"),
        artist=_artist_text(_first(record, "artist", "artists")) or "Unknown artist",
        album=str(album_name).strip() if album_name not in (None, "") else None,
        year=release_date,
        genres=genres,
        audio_file=_first(
            record,
            "audioFile",
            "audio_file",
            "localFile",
            "local_file",
            "filename",
            "file",
            "path",
        ),
        spotify_uri=str(spotify_uri) if spotify_uri else None,
    )


def load_metadata(metadata_path: Path | None) -> list[TrackMetadata]:
    """Load normalized records from local JSON or CSV; Spotify is not required."""

    if metadata_path is None:
        return []
    if not metadata_path.is_file():
        raise ValueError(f"metadata file does not exist: {metadata_path}")

    suffix = metadata_path.suffix.casefold()
    if suffix == ".json":
        with metadata_path.open("r", encoding="utf-8") as handle:
            records = _unwrap_metadata_records(json.load(handle))
    elif suffix == ".csv":
        with metadata_path.open("r", encoding="utf-8-sig", newline="") as handle:
            records = list(csv.DictReader(handle))
    else:
        raise ValueError("metadata must be a .json or .csv file")
    return [_record_to_metadata(record, index) for index, record in enumerate(records, start=1)]


def read_embedded_metadata(audio_path: Path) -> dict[str, Any]:
    """Read common tags without making tags a hard requirement for matching."""

    try:
        from mutagen import File as MutagenFile

        tagged = MutagenFile(audio_path, easy=True)
    except Exception:
        return {}
    if tagged is None or not getattr(tagged, "tags", None):
        return {}

    def tag(*names: str) -> str | None:
        for name in names:
            values = tagged.tags.get(name)
            if values:
                return str(values[0]).strip()
        return None

    genres: list[str] = []
    for value in tagged.tags.get("genre", []):
        genres.extend(piece.strip() for piece in re.split(r"[;,]", str(value)) if piece.strip())
    return {
        "id": tag("musicbrainz_trackid", "spotify_id", "spotifyid"),
        "title": tag("title"),
        "artist": tag("artist", "albumartist"),
        "album": tag("album"),
        "year": tag("date", "year"),
        "genres": genres,
    }


def _filename_artist_title(path: Path) -> tuple[str | None, str]:
    stem = _TRACK_NUMBER.sub("", path.stem).strip()
    parts = re.split(r"\s+-\s+", stem, maxsplit=1)
    if len(parts) == 2:
        return parts[0].strip() or None, parts[1].strip() or stem
    return None, stem


def _local_metadata(audio_path: Path, audio_dir: Path, tags: dict[str, Any]) -> TrackMetadata:
    filename_artist, filename_title = _filename_artist_title(audio_path)
    relative = audio_path.relative_to(audio_dir).as_posix()
    local_id = "local-" + hashlib.sha1(relative.casefold().encode("utf-8")).hexdigest()[:12]
    return TrackMetadata(
        id=str(tags.get("id") or local_id),
        title=str(tags.get("title") or filename_title),
        artist=str(tags.get("artist") or filename_artist or "Unknown artist"),
        album=tags.get("album"),
        year=tags.get("year"),
        genres=tags.get("genres") or [],
    )


def _metadata_identity(track: TrackMetadata) -> str:
    return " ".join(
        part for part in (normalize_match_text(track.artist), normalize_match_text(track.title)) if part
    )


def _candidate_indexes(
    audio_path: Path,
    audio_dir: Path,
    metadata: list[TrackMetadata],
    tags: dict[str, Any],
) -> list[tuple[str, list[int]]]:
    relative = audio_path.relative_to(audio_dir).as_posix().casefold()
    basename = audio_path.name.casefold()
    clean_stem = _TRACK_NUMBER.sub("", audio_path.stem)
    stem_key = normalize_match_text(clean_stem)
    filename_artist, filename_title = _filename_artist_title(audio_path)
    filename_keys = {stem_key}
    if filename_artist:
        artist_key = normalize_match_text(filename_artist)
        title_key = normalize_match_text(filename_title)
        filename_keys.update({f"{artist_key} {title_key}".strip(), f"{title_key} {artist_key}".strip()})

    explicit = [
        index
        for index, track in enumerate(metadata)
        if track.audio_file
        and (
            Path(track.audio_file).as_posix().casefold() == relative
            or Path(track.audio_file).name.casefold() == basename
        )
    ]
    id_matches = [
        index
        for index, track in enumerate(metadata)
        if normalize_match_text(track.id) == stem_key
    ]

    tag_id = normalize_match_text(str(tags.get("id") or ""))
    embedded_id = [
        index for index, track in enumerate(metadata) if tag_id and normalize_match_text(track.id) == tag_id
    ]
    tag_title = tags.get("title")
    tag_artist = tags.get("artist")
    tag_identity = (
        f"{normalize_match_text(str(tag_artist))} {normalize_match_text(str(tag_title))}".strip()
        if tag_title and tag_artist
        else ""
    )
    embedded_names = [
        index
        for index, track in enumerate(metadata)
        if tag_identity and _metadata_identity(track) == tag_identity
    ]

    filename = [
        index
        for index, track in enumerate(metadata)
        if filename_keys
        and filename_keys.intersection(
            {
                _metadata_identity(track),
                f"{normalize_match_text(track.title)} {normalize_match_text(track.artist)}".strip(),
            }
        )
    ]
    return [
        ("explicit-file", explicit),
        ("filename-id", id_matches),
        ("embedded-id", embedded_id),
        ("embedded-title-artist", embedded_names),
        ("filename-title-artist", filename),
    ]


def match_tracks(
    audio_paths: Iterable[Path],
    metadata: list[TrackMetadata],
    audio_dir: Path,
) -> MatchReport:
    """Match local files to external metadata, refusing ambiguous assignments."""

    report = MatchReport()
    used_indexes: set[int] = set()
    seen_ids: set[str] = set()

    id_counts: dict[str, int] = {}
    for track in metadata:
        id_counts[track.id] = id_counts.get(track.id, 0) + 1
    for track_id, count in id_counts.items():
        if count > 1:
            report.issues.append(
                MatchIssue(
                    kind="duplicate-metadata-id",
                    message=f"metadata ID {track_id!r} appears {count} times",
                    candidates=[track_id],
                )
            )

    for audio_path in audio_paths:
        tags = read_embedded_metadata(audio_path)
        selected: tuple[str, int] | None = None
        ambiguous = False
        for method, candidates in _candidate_indexes(audio_path, audio_dir, metadata, tags):
            if not candidates:
                continue
            if len(candidates) > 1:
                report.issues.append(
                    MatchIssue(
                        audio_path=audio_path,
                        kind="ambiguous-match",
                        message=f"{method} produced multiple metadata candidates; file skipped",
                        candidates=[metadata[index].id for index in candidates],
                    )
                )
                ambiguous = True
                break
            selected = (method, candidates[0])
            break

        if ambiguous:
            continue
        if selected:
            method, index = selected
            if index in used_indexes:
                report.issues.append(
                    MatchIssue(
                        audio_path=audio_path,
                        kind="duplicate-track-file",
                        message=f"metadata track {metadata[index].id!r} already matched another file; file skipped",
                        candidates=[metadata[index].id],
                    )
                )
                continue
            track = metadata[index]
            used_indexes.add(index)
        else:
            method = "embedded-or-filename-fallback"
            track = _local_metadata(audio_path, audio_dir, tags)
            if metadata:
                report.issues.append(
                    MatchIssue(
                        audio_path=audio_path,
                        kind="unmatched-audio",
                        message="no supplied metadata matched; using embedded tags/filename",
                    )
                )

        if track.id in seen_ids:
            report.issues.append(
                MatchIssue(
                    audio_path=audio_path,
                    kind="duplicate-resolved-id",
                    message=f"resolved track ID {track.id!r} is not unique; file skipped",
                    candidates=[track.id],
                )
            )
            continue
        seen_ids.add(track.id)
        report.matches.append(TrackMatch(audio_path=audio_path, metadata=track, match_method=method))

    report.unmatched_metadata_ids = [
        track.id for index, track in enumerate(metadata) if index not in used_indexes
    ]
    return report
