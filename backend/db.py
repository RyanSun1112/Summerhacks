import os
import sqlite3
from contextlib import contextmanager

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
DB_PATH = os.path.join(BASE_DIR, "data.db")

SCHEMA_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 5000,
        lat REAL,
        lng REAL,
        gps_accuracy REAL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS snapshot_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id TEXT NOT NULL,
        reading_index INTEGER NOT NULL,
        offset_ms INTEGER NOT NULL,
        accel_x REAL NOT NULL,
        accel_y REAL NOT NULL,
        accel_z REAL NOT NULL,
        alpha REAL NOT NULL,
        beta REAL NOT NULL,
        gamma REAL NOT NULL,
        audio_level REAL NOT NULL,
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_readings_snapshot ON snapshot_readings(snapshot_id)",
)


def get_connection():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


@contextmanager
def connection_scope():
    connection = get_connection()
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_db():
    with connection_scope() as connection:
        for statement in SCHEMA_STATEMENTS:
            connection.execute(statement)


def fetch_all(query, params=()):
    with connection_scope() as connection:
        cursor = connection.execute(query, params)
        return cursor.fetchall()


def fetch_one(query, params=()):
    with connection_scope() as connection:
        cursor = connection.execute(query, params)
        return cursor.fetchone()


def execute(query, params=()):
    with connection_scope() as connection:
        cursor = connection.execute(query, params)
        return cursor.lastrowid
