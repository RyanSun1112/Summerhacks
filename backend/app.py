import math
import os
import secrets
from datetime import datetime

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

try:
    from .db import connection_scope, fetch_all, fetch_one, init_db
    from .snapshot_metrics import analyze_snapshot
except ImportError:  # Supports `python app.py` from inside backend/.
    from db import connection_scope, fetch_all, fetch_one, init_db
    from snapshot_metrics import analyze_snapshot

BASE_DIR = os.path.abspath(os.path.dirname(__file__))


def row_to_dict(row):
    return dict(row) if row is not None else None


def optional_float(value):
    if value in (None, ""):
        return None
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError("sensor values must be finite")
    return parsed


def bounded_float(value, low, high):
    parsed = optional_float(value)
    parsed = 0.0 if parsed is None else parsed
    if not low <= parsed <= high:
        raise ValueError("sensor value is outside its plausible range")
    return parsed


def readings_for(snapshot_id):
    return [
        row_to_dict(row)
        for row in fetch_all(
            """
            SELECT * FROM snapshot_readings
            WHERE snapshot_id = ?
            ORDER BY reading_index ASC, id ASC
            """,
            (snapshot_id,),
        )
    ]


def analyze_stored_snapshot(snapshot_id):
    """Analyze locally without returning identifiers, raw readings, or coordinates."""
    snapshot_row = fetch_one("SELECT * FROM snapshots WHERE snapshot_id = ?", (snapshot_id,))
    if snapshot_row is None:
        return None
    snapshot = row_to_dict(snapshot_row)
    readings = readings_for(snapshot_id)

    history = [
        row_to_dict(row)
        for row in fetch_all(
            """
            SELECT * FROM snapshots
            WHERE session_id = ?
              AND snapshot_id != ?
              AND datetime(captured_at) < datetime(?)
            ORDER BY datetime(captured_at) DESC, snapshot_id DESC
            LIMIT 10
            """,
            (snapshot["session_id"], snapshot_id, snapshot["captured_at"]),
        )
    ]
    historical_metrics = [
        analyze_snapshot(item, readings_for(item["snapshot_id"]))["weights"]
        for item in history
    ]

    peer_rows = fetch_all(
        """
        SELECT snapshot_id, session_id, captured_at, lat, lng, gps_accuracy
        FROM snapshots
        WHERE snapshot_id != ?
          AND session_id != ?
          AND lat IS NOT NULL
          AND lng IS NOT NULL
          AND ABS((julianday(captured_at) - julianday(?)) * 86400.0) <= 15
        ORDER BY datetime(captured_at) DESC, snapshot_id DESC
        LIMIT 200
        """,
        (snapshot_id, snapshot["session_id"], snapshot["captured_at"]),
    )
    # Use at most one location per other session so frequent uploaders cannot
    # distort the spatial concentration score.
    peers_by_session = {}
    for row in peer_rows:
        peer = row_to_dict(row)
        peers_by_session.setdefault(peer["session_id"], peer)

    return analyze_snapshot(
        snapshot,
        readings,
        previous_snapshot=history[0] if history else None,
        peer_snapshots=peers_by_session.values(),
        previous_metrics=historical_metrics[0] if historical_metrics else None,
        historical_metrics=historical_metrics[1:],
    )


def create_app():
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = 1_000_000
    allowed_origins = [
        origin.strip()
        for origin in os.getenv("SENSOR_CORS_ORIGINS", "").split(",")
        if origin.strip()
    ]
    if allowed_origins:
        CORS(app, origins=allowed_origins)

    with app.app_context():
        init_db()

    @app.get("/")
    @app.get("/test")
    def test_page():
        return send_from_directory(BASE_DIR, "sensor_test.html")

    @app.post("/api/snapshots")
    def create_snapshot():
        """
        Saves one 5-second capture and returns privacy-preserving derived
        weights. Raw values remain local in the ignored SQLite database.
        """
        data = request.get_json(force=True, silent=True) or {}
        if not isinstance(data, dict):
            return jsonify({"error": "JSON body must be an object"}), 400

        try:
            session_id = str(data.get("session_id") or "unknown").strip()
            snapshot_id = str(
                data.get("snapshot_id") or f"{session_id}-{datetime.utcnow().isoformat()}"
            ).strip()
            captured_at = str(data.get("captured_at") or datetime.utcnow().isoformat()).strip()
            datetime.fromisoformat(captured_at.replace("Z", "+00:00"))
            duration_ms = int(data.get("duration_ms", 5000))
            lat = optional_float(data.get("lat"))
            lng = optional_float(data.get("lng"))
            gps_accuracy = optional_float(data.get("gps_accuracy"))
        except (TypeError, ValueError):
            return jsonify({"error": "snapshot timing/GPS fields are invalid"}), 400
        if not session_id or len(session_id) > 160 or not snapshot_id or len(snapshot_id) > 240:
            return jsonify({"error": "session_id or snapshot_id is invalid"}), 400
        if not 1000 <= duration_ms <= 15000:
            return jsonify({"error": "duration_ms must be between 1000 and 15000"}), 400
        if lat is not None and not -90 <= lat <= 90:
            return jsonify({"error": "lat must be between -90 and 90"}), 400
        if lng is not None and not -180 <= lng <= 180:
            return jsonify({"error": "lng must be between -180 and 180"}), 400
        if gps_accuracy is not None and gps_accuracy < 0:
            return jsonify({"error": "gps_accuracy cannot be negative"}), 400

        readings = data.get("readings") or []
        if not isinstance(readings, list) or len(readings) > 200:
            return jsonify({"error": "readings must be an array of at most 200 samples"}), 400
        normalized_readings = []
        try:
            for index, reading in enumerate(readings):
                if not isinstance(reading, dict):
                    raise ValueError("reading must be an object")
                reading_index = int(reading.get("reading_index", index))
                offset_ms = int(reading.get("offset_ms", 0))
                if reading_index < 0 or not 0 <= offset_ms <= duration_ms + 1000:
                    raise ValueError("reading index/offset is outside its plausible range")
                normalized_readings.append((
                    snapshot_id,
                    reading_index,
                    offset_ms,
                    bounded_float(reading.get("accel_x"), -200, 200),
                    bounded_float(reading.get("accel_y"), -200, 200),
                    bounded_float(reading.get("accel_z"), -200, 200),
                    bounded_float(reading.get("alpha"), -720, 720),
                    bounded_float(reading.get("beta"), -720, 720),
                    bounded_float(reading.get("gamma"), -720, 720),
                    bounded_float(reading.get("audio_level"), 0, 1),
                ))
        except (TypeError, ValueError):
            return jsonify({"error": "one or more sensor readings are invalid"}), 400

        if fetch_one("SELECT 1 FROM snapshots WHERE snapshot_id = ?", (snapshot_id,)):
            return jsonify({"error": "snapshot_id already exists"}), 409

        # Store the snapshot header and all readings in one transaction. A disk
        # or database error cannot leave a header with a partial sensor series.
        with connection_scope() as connection:
            connection.execute(
                """
                INSERT INTO snapshots (
                    snapshot_id, session_id, captured_at, duration_ms, lat, lng, gps_accuracy
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (snapshot_id, session_id, captured_at, duration_ms, lat, lng, gps_accuracy),
            )
            connection.executemany(
                """
                INSERT INTO snapshot_readings (
                    snapshot_id, reading_index, offset_ms,
                    accel_x, accel_y, accel_z,
                    alpha, beta, gamma,
                    audio_level
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                normalized_readings,
            )

        response = {
            "ok": True,
            "snapshot_id": snapshot_id,
            "reading_count": len(normalized_readings),
        }
        try:
            response["metrics"] = analyze_stored_snapshot(snapshot_id)
        except Exception:
            # Raw capture remains successful even if a derived metric fails. Do
            # not echo sensor values or internal exception details to the phone.
            app.logger.exception("snapshot metric analysis failed")
            response["metrics"] = None
            response["metrics_warning"] = "snapshot saved but metric analysis failed"
        return jsonify(response)

    @app.get("/api/snapshots")
    def list_snapshots():
        authorization_error = raw_access_error()
        if authorization_error:
            return authorization_error
        rows = fetch_all(
            """
            SELECT
                s.*,
                COALESCE(r.reading_count, 0) AS reading_count
            FROM snapshots s
            LEFT JOIN (
                SELECT snapshot_id, COUNT(*) AS reading_count
                FROM snapshot_readings
                GROUP BY snapshot_id
            ) r ON r.snapshot_id = s.snapshot_id
            ORDER BY datetime(s.captured_at) DESC, s.snapshot_id DESC
            """
        )
        return jsonify({"snapshots": [row_to_dict(row) for row in rows]})

    @app.get("/api/snapshots/<snapshot_id>")
    def get_snapshot(snapshot_id):
        authorization_error = raw_access_error()
        if authorization_error:
            return authorization_error
        snapshot = fetch_one("SELECT * FROM snapshots WHERE snapshot_id = ?", (snapshot_id,))
        if snapshot is None:
            return jsonify({"error": "snapshot not found"}), 404

        return jsonify({
            "snapshot": row_to_dict(snapshot),
            "readings": readings_for(snapshot_id),
        })

    @app.get("/api/snapshots/<snapshot_id>/metrics")
    def get_snapshot_metrics(snapshot_id):
        authorization_error = raw_access_error()
        if authorization_error:
            return authorization_error
        metrics = analyze_stored_snapshot(snapshot_id)
        if metrics is None:
            return jsonify({"error": "snapshot not found"}), 404
        return jsonify({"metrics": metrics})

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    return app


def raw_access_error():
    """Raw/derived reads are private by default; ingestion remains same-origin."""
    expected = os.getenv("SENSOR_ADMIN_TOKEN")
    supplied = request.headers.get("X-Sensor-Admin-Token", "")
    if not expected or not supplied or not secrets.compare_digest(expected, supplied):
        return jsonify({"error": "sensor admin authorization required"}), 401
    return None


if __name__ == "__main__":
    app = create_app()
    app.run(
        host="0.0.0.0",
        port=5000,
        debug=os.getenv("FLASK_DEBUG") == "1",
    )
