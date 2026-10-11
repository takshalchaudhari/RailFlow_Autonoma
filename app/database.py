"""SQLite persistence layer with transactional integrity and immutable revision storage (STEP F)."""

from __future__ import annotations

from contextlib import contextmanager
import os
import sqlite3
from typing import Iterator, Optional

DEFAULT_DB_PATH = "railflow.db"

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS scenarios (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    station_json TEXT NOT NULL,
    default_min_gap_minutes INTEGER NOT NULL,
    active_version_id TEXT,
    latest_version_number INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platforms (
    scenario_id TEXT NOT NULL,
    id TEXT NOT NULL,
    station_id TEXT NOT NULL,
    min_gap_minutes INTEGER,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (scenario_id, id),
    FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS trains (
    scenario_id TEXT NOT NULL,
    id TEXT NOT NULL,
    arrival INTEGER NOT NULL,
    departure INTEGER NOT NULL,
    platform_id TEXT,
    allowed_platforms_json TEXT,
    required_platform TEXT,
    fixed INTEGER NOT NULL,
    departed INTEGER NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (scenario_id, id),
    FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schedule_versions (
    id TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL,
    version_number INTEGER NOT NULL,
    parent_version_id TEXT,
    solver_status TEXT NOT NULL,
    validation_status TEXT NOT NULL,
    is_complete INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    unresolved_trains_json TEXT NOT NULL,
    objective_metrics_json TEXT,
    validation_findings_json TEXT NOT NULL,
    FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_version_id) REFERENCES schedule_versions(id)
);

CREATE TABLE IF NOT EXISTS train_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id TEXT NOT NULL,
    train_id TEXT NOT NULL,
    platform_id TEXT,
    arrival INTEGER NOT NULL,
    departure INTEGER NOT NULL,
    baseline_arrival INTEGER NOT NULL,
    baseline_departure INTEGER NOT NULL,
    effective_arrival INTEGER NOT NULL,
    effective_departure INTEGER NOT NULL,
    disruption_delay_minutes INTEGER NOT NULL,
    additional_delay_minutes INTEGER NOT NULL,
    total_delay_minutes INTEGER NOT NULL,
    fixed INTEGER NOT NULL,
    departed INTEGER NOT NULL,
    unresolved INTEGER NOT NULL,
    unresolved_reason TEXT,
    sort_order INTEGER NOT NULL,
    FOREIGN KEY (version_id) REFERENCES schedule_versions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_train_assignments_version_train
    ON train_assignments(version_id, train_id);

CREATE TABLE IF NOT EXISTS disruptions (
    version_id TEXT NOT NULL,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    train_id TEXT,
    platform_id TEXT,
    delay_minutes INTEGER,
    start_min INTEGER,
    end_min INTEGER,
    confirmation_status TEXT NOT NULL,
    application_status TEXT NOT NULL,
    source_version_id TEXT,
    is_newly_applied INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (version_id, id),
    FOREIGN KEY (version_id) REFERENCES schedule_versions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS revision_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id TEXT NOT NULL,
    train_id TEXT NOT NULL,
    change_json TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    FOREIGN KEY (version_id) REFERENCES schedule_versions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS validation_runs (
    id TEXT PRIMARY KEY,
    version_id TEXT NOT NULL,
    validation_status TEXT NOT NULL,
    is_complete INTEGER NOT NULL,
    errors_json TEXT NOT NULL,
    unresolved_trains_json TEXT NOT NULL,
    validated_at TEXT NOT NULL,
    FOREIGN KEY (version_id) REFERENCES schedule_versions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    scenario_id TEXT,
    version_id TEXT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    details_json TEXT NOT NULL,
    timestamp TEXT NOT NULL
);
"""


def get_db_path(explicit_path: Optional[str] = None) -> str:
    """Resolve the active SQLite database path."""
    if explicit_path:
        return explicit_path
    return os.environ.get("RAILFLOW_DB_PATH", DEFAULT_DB_PATH)


def init_db(db_path: Optional[str] = None) -> None:
    """Initialize all SQLite tables if they do not exist."""
    path = get_db_path(db_path)
    conn = sqlite3.connect(path)
    try:
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.executescript(SCHEMA_SQL)
        conn.commit()
    finally:
        conn.close()


@contextmanager
def db_transaction(db_path: Optional[str] = None) -> Iterator[sqlite3.Connection]:
    """Yield a SQLite connection within an atomic transaction (commits on success, rolls back on error)."""
    path = get_db_path(db_path)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
