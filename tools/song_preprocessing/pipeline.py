"""Orchestration for the offline, resumable song preprocessing pipeline."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Sequence

from .audio_features import AudioFeatureExtractor
from .cache import JsonCache, audio_fingerprint, stable_hash
from .config import AnalysisConfig, LLMConfig, NormalizationConfig
from .exporter import export_json
from .llm_annotator import SongAnnotator
from .metadata import load_metadata, match_tracks, scan_audio_files
from .models import AudioFeatures, MatchIssue, RawSongProfile, SongAnnotation, TrackMatch
from .normalization import normalize_library


@dataclass
class PipelineStats:
    discovered: int = 0
    matched: int = 0
    audio_successful: int = 0
    audio_cached: int = 0
    llm_successful: int = 0
    llm_cached: int = 0
    final_profiles: int = 0
    failed: int = 0


@dataclass
class PipelineResult:
    stats: PipelineStats
    output_path: Path | None
    raw_audio_path: Path
    raw_llm_path: Path | None
    report_path: Path


def _chunks(items: Sequence[int], size: int) -> list[list[int]]:
    return [list(items[index : index + size]) for index in range(0, len(items), size)]


class SongPreprocessingPipeline:
    def __init__(
        self,
        *,
        audio_dir: Path,
        metadata_path: Path | None,
        output_path: Path,
        cache_dir: Path,
        annotator: SongAnnotator | None,
        analysis_config: AnalysisConfig | None = None,
        llm_config: LLMConfig | None = None,
        normalization_config: NormalizationConfig | None = None,
        limit: int | None = None,
        skip_llm: bool = False,
        force_llm: bool = False,
        force_audio: bool = False,
    ) -> None:
        self.audio_dir = audio_dir.resolve()
        self.metadata_path = metadata_path
        self.output_path = output_path
        self.cache_dir = cache_dir
        self.annotator = annotator
        self.analysis_config = analysis_config or AnalysisConfig()
        self.llm_config = llm_config or LLMConfig()
        self.normalization_config = normalization_config or NormalizationConfig()
        self.limit = limit
        self.skip_llm = skip_llm
        self.force_llm = force_llm
        self.force_audio = force_audio
        self.audio_cache = JsonCache(cache_dir / "audio")
        self.llm_cache = JsonCache(cache_dir / "annotations")

    def run(self) -> PipelineResult:
        stats = PipelineStats()
        audio_files = scan_audio_files(self.audio_dir)
        if self.limit is not None:
            audio_files = audio_files[: self.limit]
        stats.discovered = len(audio_files)
        if not audio_files:
            raise ValueError(f"no supported audio files found under {self.audio_dir}")

        metadata = load_metadata(self.metadata_path)
        match_report = match_tracks(audio_files, metadata, self.audio_dir)
        stats.matched = len(match_report.matches)
        stats.failed += sum(
            issue.kind in {"ambiguous-match", "duplicate-track-file", "duplicate-resolved-id"}
            for issue in match_report.issues
        )
        for issue in match_report.issues:
            location = f" ({issue.audio_path})" if issue.audio_path else ""
            print(f"WARNING [{issue.kind}]{location}: {issue.message}")

        raw_profiles, extraction_issues = self._extract_audio(match_report.matches, stats)
        match_report.issues.extend(extraction_issues)
        stats.failed += len(extraction_issues)

        raw_audio_path = self.output_path.parent / "rawAudioFeatures.json"
        export_json(
            raw_audio_path,
            [
                {
                    "id": profile.metadata.id,
                    "metadata": profile.metadata.model_dump(mode="json", by_alias=True),
                    "sourceFile": profile.source_file,
                    "audio": profile.audio.model_dump(mode="json", by_alias=True),
                }
                for profile in raw_profiles
            ],
        )
        report_path = self.output_path.parent / "songPreprocessingReport.json"
        self._write_report(report_path, match_report.issues, match_report.unmatched_metadata_ids, stats)

        if self.skip_llm:
            return PipelineResult(stats, None, raw_audio_path, None, report_path)
        if self.annotator is None:
            raise ValueError("an annotator is required unless --skip-llm is used")

        annotation_failures = self._annotate(raw_profiles, stats)
        stats.failed += len(annotation_failures)
        match_report.issues.extend(annotation_failures)

        complete_profiles = [profile for profile in raw_profiles if profile.llm is not None]
        raw_llm_path = self.output_path.parent / "rawLLMAnnotations.json"
        export_json(
            raw_llm_path,
            [
                profile.llm.model_dump(mode="json", by_alias=True)
                for profile in complete_profiles
                if profile.llm is not None
            ],
        )

        final_output: Path | None = None
        if complete_profiles:
            final_profiles = normalize_library(complete_profiles, self.normalization_config)
            export_json(self.output_path, final_profiles)
            stats.final_profiles = len(final_profiles)
            final_output = self.output_path

        self._write_report(report_path, match_report.issues, match_report.unmatched_metadata_ids, stats)
        return PipelineResult(stats, final_output, raw_audio_path, raw_llm_path, report_path)

    def _extract_audio(
        self,
        matches: list[TrackMatch],
        stats: PipelineStats,
    ) -> tuple[list[RawSongProfile], list[MatchIssue]]:
        extractor = AudioFeatureExtractor(self.analysis_config)
        analysis_settings = asdict(self.analysis_config)
        profiles: list[RawSongProfile] = []
        issues: list[MatchIssue] = []
        total = len(matches)

        for index, match in enumerate(matches, start=1):
            label = f"{match.metadata.artist} - {match.metadata.title}"
            print(f"[{index}/{total}] Analyzing: {label}")
            print(f"        metadata \u2713 ({match.match_method})")
            source_file = match.audio_path.relative_to(self.audio_dir).as_posix()
            fingerprint = audio_fingerprint(match.audio_path, analysis_settings)
            cache_identifier = f"{match.metadata.id}:{source_file}"
            audio = None if self.force_audio else self.audio_cache.load(
                cache_identifier, fingerprint, AudioFeatures
            )
            if audio is not None:
                stats.audio_cached += 1
                print("        audio \u2713 (cached)")
            else:
                try:
                    audio = extractor.extract(match.audio_path)
                    self.audio_cache.write(cache_identifier, fingerprint, audio)
                    print("        audio \u2713")
                except Exception as error:
                    stats.failed += 0  # Counted by the caller from the issue list.
                    print(f"        audio \u2717 ({error})")
                    issues.append(
                        MatchIssue(
                            audio_path=match.audio_path,
                            kind="audio-analysis-failed",
                            message=str(error),
                            candidates=[match.metadata.id],
                        )
                    )
                    continue
            stats.audio_successful += 1
            profiles.append(
                RawSongProfile(
                    metadata=match.metadata,
                    audio=audio,
                    source_file=source_file,
                )
            )
        return profiles, issues

    def _llm_fingerprint(self, profile: RawSongProfile) -> str:
        return stable_hash(
            {
                "promptVersion": self.llm_config.prompt_version,
                "model": self.llm_config.model,
                "metadata": profile.metadata.model_dump(mode="json", by_alias=True),
                "audio": profile.audio.model_dump(mode="json", by_alias=True),
            }
        )

    def _annotate(
        self,
        profiles: list[RawSongProfile],
        stats: PipelineStats,
    ) -> list[MatchIssue]:
        pending: list[int] = []
        fingerprints: dict[int, str] = {}
        for index, profile in enumerate(profiles):
            fingerprint = self._llm_fingerprint(profile)
            fingerprints[index] = fingerprint
            cached = None if self.force_llm else self.llm_cache.load(
                profile.metadata.id, fingerprint, SongAnnotation
            )
            if cached is not None:
                profile.llm = cached
                stats.llm_cached += 1
                stats.llm_successful += 1
                print(f"        LLM \u2713 (cached): {profile.metadata.artist} - {profile.metadata.title}")
            else:
                pending.append(index)

        groups = _chunks(pending, self.llm_config.batch_size)
        failures: list[MatchIssue] = []
        if not groups:
            return failures

        def annotate_group(indexes: list[int]) -> tuple[dict[int, SongAnnotation], dict[int, str]]:
            inputs = [(profiles[index].metadata, profiles[index].audio) for index in indexes]
            try:
                annotations = self.annotator.annotate_batch(inputs)  # type: ignore[union-attr]
                return dict(zip(indexes, annotations, strict=True)), {}
            except Exception as batch_error:
                if len(indexes) == 1:
                    return {}, {indexes[0]: str(batch_error)}
                # Isolate a bad song/schema response so one record cannot discard a batch.
                successes: dict[int, SongAnnotation] = {}
                errors: dict[int, str] = {}
                for index in indexes:
                    try:
                        annotation = self.annotator.annotate_batch(  # type: ignore[union-attr]
                            [(profiles[index].metadata, profiles[index].audio)]
                        )[0]
                        successes[index] = annotation
                    except Exception as error:
                        errors[index] = str(error)
                return successes, errors

        completed_groups = 0
        with ThreadPoolExecutor(max_workers=self.llm_config.concurrency) as executor:
            futures = {executor.submit(annotate_group, group): group for group in groups}
            for future in as_completed(futures):
                completed_groups += 1
                successes, errors = future.result()
                print(f"[LLM batch {completed_groups}/{len(groups)}] completed")
                for index, annotation in successes.items():
                    profile = profiles[index]
                    profile.llm = annotation
                    self.llm_cache.write(profile.metadata.id, fingerprints[index], annotation)
                    stats.llm_successful += 1
                    print(f"        LLM \u2713: {profile.metadata.artist} - {profile.metadata.title}")
                for index, message in errors.items():
                    profile = profiles[index]
                    print(f"        LLM \u2717: {profile.metadata.artist} - {profile.metadata.title}: {message}")
                    failures.append(
                        MatchIssue(
                            audio_path=self.audio_dir / profile.source_file,
                            kind="llm-annotation-failed",
                            message=message,
                            candidates=[profile.metadata.id],
                        )
                    )
        return failures

    @staticmethod
    def _write_report(
        path: Path,
        issues: list[MatchIssue],
        unmatched_metadata_ids: list[str],
        stats: PipelineStats,
    ) -> None:
        export_json(
            path,
            {
                "stats": asdict(stats),
                "unmatchedMetadataIds": unmatched_metadata_ids,
                "issues": [
                    {
                        "kind": issue.kind,
                        "audioFile": str(issue.audio_path) if issue.audio_path else None,
                        "message": issue.message,
                        "candidates": issue.candidates,
                    }
                    for issue in issues
                ],
            },
        )
