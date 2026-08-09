"""Privacy-preserving metrics derived from one five-second sensor snapshot.

The functions in this module operate only on in-memory numerical readings. They do
not log identifiers or coordinates, make network calls, or persist derived data.
Calibration values are intentionally centralized: phone sensors, mounting/holding
style, venue acoustics, and GPS quality vary enough that these defaults should be
tuned with consented venue recordings before production use.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Sequence


@dataclass(frozen=True)
class MetricConfig:
    minimum_samples: int = 12
    motion_quiet_mps2: float = 0.15
    motion_active_mps2: float = 3.0
    rotation_quiet_dps: float = 3.0
    rotation_active_dps: float = 120.0
    volume_quiet_rms: float = 0.005
    volume_loud_rms: float = 0.18
    rhythm_min_bpm: float = 45.0
    rhythm_max_bpm: float = 210.0
    audio_min_bpm: float = 60.0
    audio_max_bpm: float = 180.0
    minimum_periodicity: float = 0.20
    strong_periodicity: float = 0.75
    clustering_tight_m: float = 3.0
    clustering_spread_m: float = 30.0
    maximum_gps_accuracy_m: float = 50.0
    mobility_stationary_mps: float = 0.10
    mobility_full_mps: float = 1.50
    maximum_mobility_gap_seconds: float = 120.0
    trend_full_scale: float = 0.25


DEFAULT_CONFIG = MetricConfig()


def clamp01(value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    return max(0.0, min(1.0, float(value)))


def _record_value(record: Mapping[str, Any] | Any, key: str, default: Any = None) -> Any:
    try:
        if hasattr(record, "get"):
            return record.get(key, default)
        return record[key]
    except (KeyError, IndexError, TypeError):
        return default


def _number(record: Mapping[str, Any] | Any, key: str, default: float = 0.0) -> float:
    try:
        value = float(_record_value(record, key, default))
        return value if math.isfinite(value) else default
    except (TypeError, ValueError):
        return default


def _normalize(value: float, low: float, high: float) -> float:
    if high <= low:
        raise ValueError("normalization high bound must exceed low bound")
    return clamp01((value - low) / (high - low))


def _rms(values: Sequence[float]) -> float:
    return math.sqrt(sum(value * value for value in values) / len(values)) if values else 0.0


def _percentile(values: Sequence[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = clamp01(fraction) * (len(ordered) - 1)
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return ordered[lower]
    amount = position - lower
    return ordered[lower] * (1 - amount) + ordered[upper] * amount


def _robust_level(values: Sequence[float]) -> float:
    """Combine RMS and p90 while capping isolated p95+ sensor spikes."""
    if not values:
        return 0.0
    cap = _percentile(values, 0.95)
    winsorized = [min(abs(value), cap) for value in values]
    return 0.65 * _rms(winsorized) + 0.35 * _percentile(winsorized, 0.90)


def _sorted_readings(readings: Iterable[Mapping[str, Any] | Any]) -> list[Mapping[str, Any] | Any]:
    return sorted(readings, key=lambda reading: _number(reading, "offset_ms"))


def _sample_quality(readings: Sequence[Mapping[str, Any] | Any], config: MetricConfig) -> float:
    if len(readings) < 2:
        return 0.0
    duration_ms = max(0.0, _number(readings[-1], "offset_ms") - _number(readings[0], "offset_ms"))
    count_quality = min(1.0, len(readings) / max(config.minimum_samples * 2, 1))
    duration_quality = min(1.0, duration_ms / 4000.0)
    return clamp01(count_quality * duration_quality)


def _wrapped_angle_delta(current: float, previous: float) -> float:
    return (current - previous + 180.0) % 360.0 - 180.0


def _motion_and_rotation(
    readings: Sequence[Mapping[str, Any] | Any],
    config: MetricConfig,
) -> tuple[float, float, list[float], list[float]]:
    if not readings:
        return 0.0, 0.0, [], []

    axes = {
        name: [_number(reading, name) for reading in readings]
        for name in ("accel_x", "accel_y", "accel_z")
    }
    centers = {name: statistics.median(values) for name, values in axes.items()}
    motion_series = [
        math.sqrt(sum((axes[name][index] - centers[name]) ** 2 for name in axes))
        for index in range(len(readings))
    ]

    angular_speeds: list[float] = [0.0]
    for previous, current in zip(readings, readings[1:]):
        elapsed = (_number(current, "offset_ms") - _number(previous, "offset_ms")) / 1000.0
        if elapsed <= 0:
            angular_speeds.append(0.0)
            continue
        deltas = [
            _wrapped_angle_delta(_number(current, field), _number(previous, field))
            for field in ("alpha", "beta", "gamma")
        ]
        angular_speeds.append(math.sqrt(sum(delta * delta for delta in deltas)) / elapsed)

    motion_score = _normalize(
        _robust_level(motion_series),
        config.motion_quiet_mps2,
        config.motion_active_mps2,
    )
    rotation_score = _normalize(
        _robust_level(angular_speeds),
        config.rotation_quiet_dps,
        config.rotation_active_dps,
    )
    return motion_score, rotation_score, motion_series, angular_speeds


def energy_weight(
    readings: Iterable[Mapping[str, Any] | Any],
    config: MetricConfig = DEFAULT_CONFIG,
) -> float:
    """Physical energy: 70% acceleration movement plus 30% angular movement."""
    ordered = _sorted_readings(readings)
    motion, rotation, _, _ = _motion_and_rotation(ordered, config)
    return clamp01(0.70 * motion + 0.30 * rotation)


def _median_sample_interval_seconds(readings: Sequence[Mapping[str, Any] | Any]) -> float | None:
    intervals = [
        (_number(current, "offset_ms") - _number(previous, "offset_ms")) / 1000.0
        for previous, current in zip(readings, readings[1:])
    ]
    valid = [interval for interval in intervals if 0.02 <= interval <= 1.0]
    return statistics.median(valid) if valid else None


def _periodicity(
    signal: Sequence[float],
    sample_interval: float | None,
    minimum_bpm: float,
    maximum_bpm: float,
    config: MetricConfig,
) -> tuple[float, float | None, float]:
    if sample_interval is None or len(signal) < config.minimum_samples:
        return 0.0, None, 0.0
    centered = [value - statistics.mean(signal) for value in signal]
    variance = sum(value * value for value in centered)
    if variance <= 1e-10:
        return 0.0, None, 0.0

    minimum_lag = max(1, int(round(60.0 / (maximum_bpm * sample_interval))))
    maximum_lag = min(len(centered) // 2, int(round(60.0 / (minimum_bpm * sample_interval))))
    candidates: list[tuple[float, int]] = []
    for lag in range(minimum_lag, maximum_lag + 1):
        left = centered[lag:]
        right = centered[:-lag]
        denominator = math.sqrt(
            sum(value * value for value in left) * sum(value * value for value in right)
        )
        if denominator > 1e-10:
            candidates.append((sum(a * b for a, b in zip(left, right)) / denominator, lag))
    if not candidates:
        return 0.0, None, 0.0

    correlation, lag = max(candidates, key=lambda item: (item[0], -item[1]))
    score = _normalize(correlation, config.minimum_periodicity, config.strong_periodicity)
    estimated_bpm = 60.0 / (lag * sample_interval) if score > 0 else None
    coverage = clamp01((len(signal) * sample_interval) / 5.0)
    confidence = clamp01(score * coverage)
    return score, estimated_bpm, confidence


def _principal_activity_signal(readings: Sequence[Mapping[str, Any] | Any]) -> list[float]:
    if not readings:
        return []
    signals: list[list[float]] = []
    for field in ("accel_x", "accel_y", "accel_z"):
        values = [_number(reading, field) for reading in readings]
        center = statistics.median(values)
        signals.append([(value - center) / 3.0 for value in values])
    for field in ("alpha", "beta", "gamma"):
        values = [_number(reading, field) for reading in readings]
        unwrapped = [values[0]]
        for value in values[1:]:
            unwrapped.append(unwrapped[-1] + _wrapped_angle_delta(value, unwrapped[-1]))
        center = statistics.median(unwrapped)
        signals.append([(value - center) / 45.0 for value in unwrapped])
    return max(signals, key=_rms)


def _rhythm_estimate(
    readings: Sequence[Mapping[str, Any] | Any],
    config: MetricConfig,
) -> tuple[float, float | None, float]:
    periodicity, movement_bpm, confidence = _periodicity(
        _principal_activity_signal(readings),
        _median_sample_interval_seconds(readings),
        config.rhythm_min_bpm,
        config.rhythm_max_bpm,
        config,
    )
    # A perfectly periodic stationary sensor is not dancing; require measurable
    # physical energy before accepting the periodicity as rhythmic engagement.
    activity_gate = _normalize(energy_weight(readings, config), 0.05, 0.35)
    score = clamp01(periodicity * activity_gate)
    return score, movement_bpm if score > 0 else None, clamp01(confidence * activity_gate)


def rhythm_weight(
    readings: Iterable[Mapping[str, Any] | Any],
    config: MetricConfig = DEFAULT_CONFIG,
) -> float:
    """Experimental dancing proxy based on periodic motion plus an energy gate."""
    score, _, _ = _rhythm_estimate(_sorted_readings(readings), config)
    return score


def _volume_estimate(
    readings: Sequence[Mapping[str, Any] | Any],
    config: MetricConfig,
) -> tuple[float, float]:
    levels = [max(0.0, _number(reading, "audio_level")) for reading in readings]
    if not levels or max(levels) <= 0:
        return 0.0, 0.0
    level = 0.65 * statistics.mean(levels) + 0.35 * _percentile(levels, 0.90)
    return _normalize(level, config.volume_quiet_rms, config.volume_loud_rms), _sample_quality(readings, config)


def volume_weight(
    readings: Iterable[Mapping[str, Any] | Any],
    config: MetricConfig = DEFAULT_CONFIG,
) -> float:
    score, _ = _volume_estimate(_sorted_readings(readings), config)
    return score


def _bpm_estimate(
    readings: Sequence[Mapping[str, Any] | Any],
    config: MetricConfig,
) -> tuple[float, float | None, float]:
    levels = [_number(reading, "audio_level") for reading in readings]
    periodicity, estimated_bpm, confidence = _periodicity(
        levels,
        _median_sample_interval_seconds(readings),
        config.audio_min_bpm,
        config.audio_max_bpm,
        config,
    )
    if estimated_bpm is None or periodicity <= 0:
        return 0.5, None, 0.0
    weight = _normalize(estimated_bpm, config.audio_min_bpm, config.audio_max_bpm)
    return weight, estimated_bpm, confidence


def bpm_weight(
    readings: Iterable[Mapping[str, Any] | Any],
    config: MetricConfig = DEFAULT_CONFIG,
) -> float:
    """Normalized music-tempo estimate; 0.5 means unknown when confidence is zero."""
    score, _, _ = _bpm_estimate(_sorted_readings(readings), config)
    return score


def _timestamp(record: Mapping[str, Any] | Any) -> float | None:
    value = _record_value(record, "captured_at")
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except ValueError:
        return None


def _valid_location(record: Mapping[str, Any] | Any, config: MetricConfig) -> tuple[float, float, float] | None:
    lat = _record_value(record, "lat")
    lng = _record_value(record, "lng")
    try:
        latitude = float(lat)
        longitude = float(lng)
        accuracy = max(0.0, float(_record_value(record, "gps_accuracy", 0.0) or 0.0))
    except (TypeError, ValueError):
        return None
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        return None
    if accuracy > config.maximum_gps_accuracy_m:
        return None
    return latitude, longitude, accuracy


def _distance_meters(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    lat1, lng1, _ = a
    lat2, lng2, _ = b
    radius = 6_371_000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lng2 - lng1)
    haversine = (
        math.sin(delta_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2) ** 2
    )
    return radius * 2 * math.atan2(math.sqrt(haversine), math.sqrt(max(0.0, 1 - haversine)))


def _clustering_estimate(
    snapshot: Mapping[str, Any] | Any,
    peer_snapshots: Iterable[Mapping[str, Any] | Any],
    config: MetricConfig,
) -> tuple[float, float, int]:
    current_location = _valid_location(snapshot, config)
    if current_location is None:
        return 0.5, 0.0, 0
    locations = [current_location]
    locations.extend(
        location
        for location in (_valid_location(peer, config) for peer in peer_snapshots)
        if location is not None
    )
    if len(locations) < 2:
        return 0.5, 0.0, len(locations)
    separations = []
    for index, first in enumerate(locations):
        for second in locations[index + 1 :]:
            # GPS error can look like movement/spread. Subtract the larger stated
            # uncertainty so uncertain fixes cannot manufacture dispersion.
            separations.append(max(0.0, _distance_meters(first, second) - max(first[2], second[2])))
    spread = statistics.median(separations)
    score = 1.0 - _normalize(spread, config.clustering_tight_m, config.clustering_spread_m)
    median_accuracy = statistics.median(location[2] for location in locations)
    count_confidence = min(1.0, (len(locations) - 1) / 4.0)
    accuracy_confidence = 1.0 - _normalize(median_accuracy, 5.0, config.maximum_gps_accuracy_m)
    return clamp01(score), clamp01(count_confidence * accuracy_confidence), len(locations)


def clustering_weight(
    snapshot: Mapping[str, Any] | Any,
    peer_snapshots: Iterable[Mapping[str, Any] | Any],
    config: MetricConfig = DEFAULT_CONFIG,
) -> float:
    """High means spatially concentrated; 0.5 means unavailable/unknown."""
    score, _, _ = _clustering_estimate(snapshot, peer_snapshots, config)
    return score


def _mobility_estimate(
    snapshot: Mapping[str, Any] | Any,
    previous_snapshot: Mapping[str, Any] | Any | None,
    config: MetricConfig,
) -> tuple[float, float, float | None]:
    current = _valid_location(snapshot, config)
    previous = _valid_location(previous_snapshot, config) if previous_snapshot is not None else None
    current_time = _timestamp(snapshot)
    previous_time = _timestamp(previous_snapshot) if previous_snapshot is not None else None
    if current is None or previous is None or current_time is None or previous_time is None:
        return 0.5, 0.0, None
    elapsed = abs(current_time - previous_time)
    if elapsed <= 0 or elapsed > config.maximum_mobility_gap_seconds:
        return 0.5, 0.0, None
    displacement = max(0.0, _distance_meters(current, previous) - max(current[2], previous[2]))
    speed = displacement / elapsed
    score = _normalize(speed, config.mobility_stationary_mps, config.mobility_full_mps)
    accuracy_confidence = 1.0 - _normalize(max(current[2], previous[2]), 5.0, config.maximum_gps_accuracy_m)
    time_confidence = 1.0 - 0.5 * _normalize(elapsed, 5.0, config.maximum_mobility_gap_seconds)
    return score, clamp01(accuracy_confidence * time_confidence), speed


def mobility_weight(
    snapshot: Mapping[str, Any] | Any,
    previous_snapshot: Mapping[str, Any] | Any | None,
    config: MetricConfig = DEFAULT_CONFIG,
) -> float:
    """High means relocating; 0.5 means unavailable/unknown."""
    score, _, _ = _mobility_estimate(snapshot, previous_snapshot, config)
    return score


def _engagement(metrics: Mapping[str, float]) -> float:
    values = [metrics.get(field) for field in ("energy", "rhythm", "volume")]
    valid = [float(value) for value in values if value is not None and math.isfinite(float(value))]
    return statistics.mean(valid) if valid else 0.5


def trend_weight(
    current_metrics: Mapping[str, float],
    previous_metrics: Mapping[str, float] | None = None,
    historical_metrics: Iterable[Mapping[str, float]] = (),
    config: MetricConfig = DEFAULT_CONFIG,
) -> float:
    """Map engagement change versus previous/baseline to 0=falling, .5=stable, 1=rising."""
    history = list(historical_metrics)
    if previous_metrics is None and not history:
        return 0.5
    current = _engagement(current_metrics)
    deltas = []
    weights = []
    if previous_metrics is not None:
        deltas.append(current - _engagement(previous_metrics))
        weights.append(0.65)
    if history:
        baseline = statistics.mean(_engagement(item) for item in history)
        deltas.append(current - baseline)
        weights.append(0.35 if previous_metrics is not None else 1.0)
    delta = sum(value * weight for value, weight in zip(deltas, weights)) / sum(weights)
    return clamp01(0.5 + delta / (2 * config.trend_full_scale))


def analyze_snapshot(
    snapshot: Mapping[str, Any] | Any,
    readings: Iterable[Mapping[str, Any] | Any],
    *,
    previous_snapshot: Mapping[str, Any] | Any | None = None,
    peer_snapshots: Iterable[Mapping[str, Any] | Any] = (),
    previous_metrics: Mapping[str, float] | None = None,
    historical_metrics: Iterable[Mapping[str, float]] = (),
    config: MetricConfig = DEFAULT_CONFIG,
) -> dict[str, Any]:
    """Return bounded weights and non-identifying quality metadata for one snapshot."""
    ordered = _sorted_readings(readings)
    motion, rotation, _, _ = _motion_and_rotation(ordered, config)
    energy = clamp01(0.70 * motion + 0.30 * rotation)
    rhythm, movement_bpm, rhythm_confidence = _rhythm_estimate(ordered, config)
    volume, volume_confidence = _volume_estimate(ordered, config)
    bpm, estimated_bpm, bpm_confidence = _bpm_estimate(ordered, config)
    clustering, clustering_confidence, peer_count = _clustering_estimate(
        snapshot, peer_snapshots, config
    )
    mobility, mobility_confidence, speed = _mobility_estimate(snapshot, previous_snapshot, config)
    weights = {
        "energy": energy,
        "rhythm": rhythm,
        "clusters": clustering,
        "volume": volume,
        "bpm": bpm,
        "mobility": mobility,
    }
    history = list(historical_metrics)
    weights["trend"] = trend_weight(weights, previous_metrics, history, config)

    sample_quality = _sample_quality(ordered, config)
    warnings = []
    if len(ordered) < config.minimum_samples:
        warnings.append("insufficient sensor samples")
    if volume_confidence == 0:
        warnings.append("audio unavailable or silent; BPM is unknown")
    if clustering_confidence == 0:
        warnings.append("clustering needs at least one accurate peer GPS snapshot")
    if mobility_confidence == 0:
        warnings.append("mobility needs a recent accurate GPS snapshot from the same session")
    if previous_metrics is None and not history:
        warnings.append("trend needs previous or historical metrics")

    return {
        "weights": {key: round(clamp01(value), 6) for key, value in weights.items()},
        "estimates": {
            "estimatedBpm": round(estimated_bpm, 2) if estimated_bpm is not None else None,
            "movementBpm": round(movement_bpm, 2) if movement_bpm is not None else None,
            "mobilityMetersPerSecond": round(speed, 3) if speed is not None else None,
        },
        "confidence": {
            "energy": round(sample_quality, 6),
            "rhythm": round(rhythm_confidence, 6),
            "clusters": round(clustering_confidence, 6),
            "volume": round(volume_confidence, 6),
            "bpm": round(bpm_confidence, 6),
            "mobility": round(mobility_confidence, 6),
            "trend": 1.0 if previous_metrics is not None or history else 0.0,
        },
        "context": {
            "sampleCount": len(ordered),
            "locationCount": peer_count,
        },
        "warnings": warnings,
    }
