"""Audit trail persistence and query service (STEP F)."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import sqlite3
from typing import Any, Optional
import uuid

from app.database import db_transaction
from app.schemas import AuditEvent


def record_audit_event(
    conn: sqlite3.Connection,
    actor: str,
    action: str,
    details: dict[str, Any],
    scenario_id: Optional[str] = None,
    version_id: Optional[str] = None,
) -> AuditEvent:
    """Insert an immutable audit event within an active SQLite transaction."""
    event = AuditEvent(
        id=f"aud-{uuid.uuid4().hex[:10]}",
        scenario_id=scenario_id,
        version_id=version_id,
        actor=actor,
        action=action,
        details=details,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )
    conn.execute(
        """
        INSERT INTO audit_events (id, scenario_id, version_id, actor, action, details_json, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event.id,
            event.scenario_id,
            event.version_id,
            event.actor,
            event.action,
            json.dumps(event.details),
            event.timestamp,
        ),
    )
    return event


def list_audit_events(
    scenario_id: Optional[str] = None,
    db_path: Optional[str] = None,
) -> list[AuditEvent]:
    """Retrieve audit events ordered chronologically."""
    with db_transaction(db_path) as conn:
        if scenario_id:
            rows = conn.execute(
                """
                SELECT id, scenario_id, version_id, actor, action, details_json, timestamp
                FROM audit_events
                WHERE scenario_id = ?
                ORDER BY timestamp ASC, rowid ASC
                """,
                (scenario_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, scenario_id, version_id, actor, action, details_json, timestamp
                FROM audit_events
                ORDER BY timestamp ASC, rowid ASC
                """
            ).fetchall()

    return [
        AuditEvent(
            id=row["id"],
            scenario_id=row["scenario_id"],
            version_id=row["version_id"],
            actor=row["actor"],
            action=row["action"],
            details=json.loads(row["details_json"]),
            timestamp=row["timestamp"],
        )
        for row in rows
    ]
