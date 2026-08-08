"""Small validated, atomic JSON caches for expensive pipeline stages."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError


ModelT = TypeVar("ModelT", bound=BaseModel)


def stable_hash(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def cache_key(identifier: str) -> str:
    readable = "".join(character if character.isalnum() or character in "-_" else "-" for character in identifier)
    readable = readable.strip("-")[:48] or "song"
    return f"{readable}-{stable_hash(identifier)[:12]}"


def audio_fingerprint(audio_path: Path, analysis_settings: dict[str, Any]) -> str:
    stat = audio_path.stat()
    return stable_hash(
        {
            "path": str(audio_path.resolve()),
            "size": stat.st_size,
            "mtimeNs": stat.st_mtime_ns,
            "analysis": analysis_settings,
        }
    )


class JsonCache:
    def __init__(self, directory: Path) -> None:
        self.directory = directory

    def path_for(self, identifier: str) -> Path:
        return self.directory / f"{cache_key(identifier)}.json"

    def load(self, identifier: str, fingerprint: str, model: type[ModelT]) -> ModelT | None:
        path = self.path_for(identifier)
        try:
            with path.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
            if payload.get("fingerprint") != fingerprint:
                return None
            return model.model_validate(payload["value"])
        except (OSError, json.JSONDecodeError, KeyError, TypeError, ValidationError):
            return None

    def write(self, identifier: str, fingerprint: str, value: BaseModel) -> Path:
        self.directory.mkdir(parents=True, exist_ok=True)
        destination = self.path_for(identifier)
        payload = {
            "fingerprint": fingerprint,
            "value": value.model_dump(mode="json", by_alias=True),
        }
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{destination.name}.", suffix=".tmp", dir=self.directory
        )
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, destination)
        finally:
            if temporary_path.exists():
                temporary_path.unlink()
        return destination
