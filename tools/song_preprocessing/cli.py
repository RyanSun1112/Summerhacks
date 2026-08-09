"""Command-line entry point for offline song preprocessing."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import (
    DEFAULT_CACHE_DIRECTORY,
    DEFAULT_OUTPUT_PATH,
    AnalysisConfig,
    LLMConfig,
    NormalizationConfig,
    pricing_for_model,
)
from .llm_annotator import MockSongAnnotator, OpenAISongAnnotator
from .pipeline import SongPreprocessingPipeline


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Analyze ordinary local audio files into a live-ready songProfiles.json database."
    )
    parser.add_argument("--audio-dir", type=Path, default=Path("songs"), help="Directory scanned recursively for audio files")
    parser.add_argument("--metadata", type=Path, help="Optional local JSON or CSV track metadata export")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_PATH, help="Final normalized JSON path")
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIRECTORY, help="Resumable audio/LLM cache directory")
    parser.add_argument("--limit", type=int, help="Analyze only the first N discovered files")
    parser.add_argument("--skip-llm", action="store_true", help="Extract/export audio features without API calls or final profiles")
    parser.add_argument("--mock-llm", action="store_true", help="Use deterministic fake ratings for a no-cost end-to-end smoke test")
    parser.add_argument("--force", action="store_true", help="Ignore successful LLM cache entries and re-annotate")
    parser.add_argument("--force-audio", action="store_true", help="Ignore cached librosa features and re-analyze audio")
    parser.add_argument("--model", default=LLMConfig().model, help="OpenAI model name")
    parser.add_argument("--llm-batch-size", type=int, default=LLMConfig().batch_size)
    parser.add_argument("--llm-concurrency", type=int, default=LLMConfig().concurrency)
    parser.add_argument(
        "--max-llm-cost-usd",
        type=float,
        default=LLMConfig().max_estimated_run_cost_usd,
        help="Conservative local ceiling for estimated API spend in this run (default: $0.50)",
    )
    parser.add_argument(
        "--llm-input-cost-per-million",
        type=float,
        help="Required with an unknown --model; use its current standard input-token price",
    )
    parser.add_argument(
        "--llm-output-cost-per-million",
        type=float,
        help="Required with an unknown --model; use its current standard output-token price",
    )
    parser.add_argument("--energy-strategy", choices=("llm", "hybrid"), default="llm")
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:
        pass

    parser = build_parser()
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be at least 1")
    if args.llm_batch_size < 1 or args.llm_batch_size > 20:
        parser.error("--llm-batch-size must be between 1 and 20")
    if args.llm_concurrency < 1:
        parser.error("--llm-concurrency must be at least 1")
    if args.max_llm_cost_usd <= 0:
        parser.error("--max-llm-cost-usd must be positive")
    if args.skip_llm and args.mock_llm:
        parser.error("--skip-llm and --mock-llm cannot be used together")

    configured_prices = pricing_for_model(args.model)
    supplied_prices = (args.llm_input_cost_per_million, args.llm_output_cost_per_million)
    if any(price is not None and price < 0 for price in supplied_prices):
        parser.error("LLM token prices cannot be negative")
    if configured_prices is None and not all(price is not None for price in supplied_prices):
        parser.error(
            "unknown --model pricing; provide both --llm-input-cost-per-million "
            "and --llm-output-cost-per-million"
        )
    input_price, output_price = configured_prices or supplied_prices

    llm_config = LLMConfig(
        model=args.model,
        batch_size=args.llm_batch_size,
        concurrency=args.llm_concurrency,
        max_estimated_run_cost_usd=args.max_llm_cost_usd,
        input_cost_per_million_usd=float(input_price),
        output_cost_per_million_usd=float(output_price),
    )
    try:
        annotator = None
        if args.mock_llm:
            annotator = MockSongAnnotator()
        elif not args.skip_llm:
            print(
                "LLM cost guard: conservative estimated spend is capped at "
                f"${llm_config.max_estimated_run_cost_usd:.2f} for this run."
            )
            annotator = OpenAISongAnnotator(llm_config)

        result = SongPreprocessingPipeline(
            audio_dir=args.audio_dir,
            metadata_path=args.metadata,
            output_path=args.output,
            cache_dir=args.cache_dir,
            annotator=annotator,
            analysis_config=AnalysisConfig(),
            llm_config=llm_config,
            normalization_config=NormalizationConfig(energy_strategy=args.energy_strategy),
            limit=args.limit,
            skip_llm=args.skip_llm,
            force_llm=args.force,
            force_audio=args.force_audio,
        ).run()
    except (ValueError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2

    stats = result.stats
    print("\nSummary")
    print(f"Discovered: {stats.discovered}")
    print(f"Audio successful: {stats.audio_successful}")
    print(f"Audio cached: {stats.audio_cached}")
    if not args.skip_llm:
        print(f"LLM successful: {stats.llm_successful}")
        print(f"LLM cached: {stats.llm_cached}")
        print(f"Final profiles: {stats.final_profiles}")
    print(f"Failed: {stats.failed}")
    if isinstance(annotator, OpenAISongAnnotator):
        print(
            "Conservative API cost reserved: "
            f"${annotator.reserved_cost_usd:.4f} "
            f"(stop ceiling: ${llm_config.max_estimated_run_cost_usd:.2f}; "
            "actual provider charge is normally lower)"
        )
    print("\nOutput:")
    if result.output_path:
        print(result.output_path)
    print(result.raw_audio_path)
    if result.raw_llm_path:
        print(result.raw_llm_path)
    print(result.report_path)
    return 1 if stats.failed else 0
