import json
import math

import pytest

from backend import db
from backend.app import create_app


def readings(*, motion=0.0, audio_hz=None, audio_amplitude=0.0):
    result = []
    for index in range(51):
        seconds = index / 10
        wave = math.sin(2 * math.pi * 2 * seconds)
        audio = 0.02 + audio_amplitude * (1 + math.sin(2 * math.pi * audio_hz * seconds)) / 2 if audio_hz else 0.0
        result.append({
            "reading_index": index,
            "offset_ms": index * 100,
            "accel_x": motion * wave,
            "accel_y": 0,
            "accel_z": 9.81,
            "alpha": motion * 8 * wave,
            "beta": 0,
            "gamma": 0,
            "audio_level": audio,
        })
    return result


def payload(identifier, session, captured_at, *, lat=43.65, motion=0.0, audio_hz=None, audio_amplitude=0.0):
    return {
        "snapshot_id": identifier,
        "session_id": session,
        "captured_at": captured_at,
        "duration_ms": 5000,
        "lat": lat,
        "lng": -79.38,
        "gps_accuracy": 0,
        "readings": readings(motion=motion, audio_hz=audio_hz, audio_amplitude=audio_amplitude),
    }


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "sensor-test.db"))
    monkeypatch.setenv("SENSOR_ADMIN_TOKEN", "test-admin-token")
    monkeypatch.delenv("SENSOR_CORS_ORIGINS", raising=False)
    app = create_app()
    app.config.update(TESTING=True)
    return app.test_client()


def test_upload_returns_bounded_metrics_without_exposing_raw_location(client):
    response = client.post(
        "/api/snapshots",
        json=payload("snapshot-a", "session-a", "2026-08-08T20:00:00Z", motion=3, audio_hz=2, audio_amplitude=0.12),
    )
    assert response.status_code == 200
    body = response.get_json()
    assert body["ok"] is True
    assert body["reading_count"] == 51
    assert all(0 <= value <= 1 for value in body["metrics"]["weights"].values())
    assert body["metrics"]["estimates"]["estimatedBpm"] == 120
    serialized_metrics = json.dumps(body["metrics"])
    assert "session-a" not in serialized_metrics
    assert "43.65" not in serialized_metrics
    assert "-79.38" not in serialized_metrics


def test_snapshot_reads_require_server_side_admin_token(client):
    client.post(
        "/api/snapshots",
        json=payload("snapshot-a", "session-a", "2026-08-08T20:00:00Z"),
    )
    assert client.get("/api/snapshots").status_code == 401
    assert client.get("/api/snapshots", headers={"X-Sensor-Admin-Token": "wrong"}).status_code == 401
    authorized = client.get(
        "/api/snapshots",
        headers={"X-Sensor-Admin-Token": "test-admin-token"},
    )
    assert authorized.status_code == 200
    assert len(authorized.get_json()["snapshots"]) == 1


def test_invalid_payload_is_rejected_before_any_partial_write(client):
    invalid = payload("bad-snapshot", "session-a", "2026-08-08T20:00:00Z")
    invalid["readings"][10]["accel_x"] = "not-a-number"
    assert client.post("/api/snapshots", json=invalid).status_code == 400
    authorized = client.get(
        "/api/snapshots",
        headers={"X-Sensor-Admin-Token": "test-admin-token"},
    )
    assert authorized.get_json()["snapshots"] == []


def test_metrics_endpoint_uses_previous_and_peer_context(client):
    client.post(
        "/api/snapshots",
        json=payload("a-1", "session-a", "2026-08-08T20:00:00Z"),
    )
    peer = client.post(
        "/api/snapshots",
        json=payload("b-1", "session-b", "2026-08-08T20:00:05Z", lat=43.650005),
    ).get_json()["metrics"]
    assert peer["weights"]["clusters"] > 0.9

    rising = client.post(
        "/api/snapshots",
        json=payload(
            "a-2",
            "session-a",
            "2026-08-08T20:00:10Z",
            lat=43.6502,
            motion=3,
            audio_hz=2,
            audio_amplitude=0.12,
        ),
    ).get_json()["metrics"]
    assert rising["weights"]["mobility"] > 0.9
    assert rising["weights"]["trend"] > 0.5

    response = client.get(
        "/api/snapshots/a-2/metrics",
        headers={"X-Sensor-Admin-Token": "test-admin-token"},
    )
    assert response.status_code == 200
    metrics_text = json.dumps(response.get_json()["metrics"])
    assert "session-a" not in metrics_text
    assert "lat" not in metrics_text
    assert "lng" not in metrics_text


def test_cors_is_same_origin_by_default(client):
    response = client.get("/api/health", headers={"Origin": "https://untrusted.example"})
    assert "Access-Control-Allow-Origin" not in response.headers
