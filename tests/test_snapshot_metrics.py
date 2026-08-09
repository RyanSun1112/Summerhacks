import math
import random

from backend.snapshot_metrics import (
    analyze_snapshot,
    bpm_weight,
    clustering_weight,
    energy_weight,
    mobility_weight,
    rhythm_weight,
    trend_weight,
    volume_weight,
)


def reading_series(*, motion_hz=None, motion_amplitude=0.0, audio_hz=None, audio_amplitude=0.0):
    rows = []
    for index in range(51):
        seconds = index / 10
        motion = motion_amplitude * math.sin(2 * math.pi * motion_hz * seconds) if motion_hz else 0.0
        audio = 0.02 + audio_amplitude * (1 + math.sin(2 * math.pi * audio_hz * seconds)) / 2 if audio_hz else audio_amplitude
        rows.append({
            "reading_index": index,
            "offset_ms": index * 100,
            "accel_x": motion,
            "accel_y": 0.0,
            "accel_z": 9.81,
            "alpha": 20 * math.sin(2 * math.pi * motion_hz * seconds) if motion_hz else 0.0,
            "beta": 0.0,
            "gamma": 0.0,
            "audio_level": audio,
        })
    return rows


def snapshot(*, lat=43.65, lng=-79.38, captured_at="2026-08-08T20:00:05Z", accuracy=0):
    return {
        "lat": lat,
        "lng": lng,
        "captured_at": captured_at,
        "gps_accuracy": accuracy,
    }


def test_energy_combines_motion_and_rotation_and_stays_bounded():
    quiet = reading_series()
    active = reading_series(motion_hz=2.0, motion_amplitude=3.0)
    assert energy_weight(quiet) == 0
    assert 0.5 < energy_weight(active) <= 1


def test_rhythm_rewards_periodic_activity_over_sporadic_motion():
    periodic = reading_series(motion_hz=2.0, motion_amplitude=3.0)
    rng = random.Random(7)
    sporadic = reading_series()
    for row in sporadic:
        row["accel_x"] = rng.uniform(-3, 3)
        row["alpha"] = rng.uniform(-30, 30)
    assert rhythm_weight(periodic) > rhythm_weight(sporadic)
    assert rhythm_weight(periodic) > 0.5


def test_volume_uses_audio_rms_envelope():
    assert volume_weight(reading_series(audio_amplitude=0.0)) == 0
    assert volume_weight(reading_series(audio_amplitude=0.2)) > 0.9


def test_bpm_reports_normalized_weight_and_actual_estimate():
    rows = reading_series(audio_hz=2.0, audio_amplitude=0.12)
    result = analyze_snapshot(snapshot(), rows)
    assert 0 <= bpm_weight(rows) <= 1
    assert result["estimates"]["estimatedBpm"] == 120.0
    assert result["confidence"]["bpm"] > 0.5


def test_clustering_is_high_for_tight_group_and_low_for_spread_group():
    current = snapshot()
    tight = [snapshot(lat=43.650005, lng=-79.380005)]
    spread = [snapshot(lat=43.6505, lng=-79.38)]
    assert clustering_weight(current, tight) > 0.9
    assert clustering_weight(current, spread) < 0.1


def test_clustering_is_neutral_without_peer_context():
    assert clustering_weight(snapshot(), []) == 0.5
    assert clustering_weight({"captured_at": "2026-08-08T20:00:05Z"}, [snapshot()]) == 0.5


def test_mobility_uses_accuracy_adjusted_speed_between_snapshots():
    previous = snapshot(captured_at="2026-08-08T20:00:00Z")
    stationary = snapshot(captured_at="2026-08-08T20:00:05Z")
    moved = snapshot(lat=43.6501, captured_at="2026-08-08T20:00:05Z")
    assert mobility_weight(stationary, previous) == 0
    assert mobility_weight(moved, previous) > 0.9
    assert mobility_weight(stationary, None) == 0.5


def test_trend_compares_previous_and_historical_engagement():
    low = {"energy": 0.2, "rhythm": 0.2, "volume": 0.2}
    high = {"energy": 0.8, "rhythm": 0.8, "volume": 0.8}
    assert trend_weight(high, low, [low]) == 1
    assert trend_weight(low, high, [high]) == 0
    assert trend_weight(high) == 0.5


def test_analysis_returns_only_bounded_weights_and_marks_missing_context():
    result = analyze_snapshot({}, [])
    assert set(result["weights"]) == {
        "energy", "rhythm", "clusters", "volume", "bpm", "mobility", "trend"
    }
    assert all(0 <= value <= 1 for value in result["weights"].values())
    assert result["confidence"]["clusters"] == 0
    assert result["confidence"]["mobility"] == 0
    assert result["estimates"]["estimatedBpm"] is None
    assert result["warnings"]

