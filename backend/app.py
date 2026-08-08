import os
from datetime import datetime

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

from db import execute, fetch_all, fetch_one, init_db

BASE_DIR = os.path.abspath(os.path.dirname(__file__))


def row_to_dict(row):
    return dict(row) if row is not None else None


def optional_float(value):
    if value in (None, ""):
        return None
    return float(value)


def create_app():
    app = Flask(__name__)
    CORS(app)

    with app.app_context():
        init_db()

    @app.get("/")
    @app.get("/test")
    def test_page():
        return send_from_directory(BASE_DIR, "sensor_test.html")

    @app.post("/api/snapshots")
    def create_snapshot():
        """
        Saves one 5-second capture: a snapshot row (session, timing, GPS)
        plus one row per sample in snapshot_readings. No scoring — raw
        sensor values only.
        """
        data = request.get_json(force=True, silent=True) or {}

        session_id = data.get("session_id") or "unknown"
        snapshot_id = data.get("snapshot_id") or f"{session_id}-{datetime.utcnow().isoformat()}"
        captured_at = data.get("captured_at") or datetime.utcnow().isoformat()
        duration_ms = int(data.get("duration_ms", 5000))
        lat = optional_float(data.get("lat"))
        lng = optional_float(data.get("lng"))
        gps_accuracy = optional_float(data.get("gps_accuracy"))
        readings = data.get("readings") or []

        execute(
            """
            INSERT INTO snapshots (
                snapshot_id, session_id, captured_at, duration_ms, lat, lng, gps_accuracy
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (snapshot_id, session_id, captured_at, duration_ms, lat, lng, gps_accuracy),
        )

        for index, reading in enumerate(readings):
            execute(
                """
                INSERT INTO snapshot_readings (
                    snapshot_id, reading_index, offset_ms,
                    accel_x, accel_y, accel_z,
                    alpha, beta, gamma,
                    audio_level
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    snapshot_id,
                    int(reading.get("reading_index", index)),
                    int(reading.get("offset_ms", 0)),
                    float(reading.get("accel_x", 0)),
                    float(reading.get("accel_y", 0)),
                    float(reading.get("accel_z", 0)),
                    float(reading.get("alpha", 0)),
                    float(reading.get("beta", 0)),
                    float(reading.get("gamma", 0)),
                    float(reading.get("audio_level", 0)),
                ),
            )

        return jsonify({"ok": True, "snapshot_id": snapshot_id, "reading_count": len(readings)})

    @app.get("/api/snapshots")
    def list_snapshots():
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
        snapshot = fetch_one("SELECT * FROM snapshots WHERE snapshot_id = ?", (snapshot_id,))
        if snapshot is None:
            return jsonify({"error": "snapshot not found"}), 404

        readings = fetch_all(
            """
            SELECT * FROM snapshot_readings
            WHERE snapshot_id = ?
            ORDER BY reading_index ASC, id ASC
            """,
            (snapshot_id,),
        )

        return jsonify({
            "snapshot": row_to_dict(snapshot),
            "readings": [row_to_dict(row) for row in readings],
        })

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    return app


if __name__ == "__main__":
    app = create_app()
    app.run(host="0.0.0.0", port=5000, debug=True)
