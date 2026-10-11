"""Schedule revision persistence, loading, comparison, and independent revalidation service (STEP F)."""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Optional

from app.database import db_transaction
from app.engine.validator import validate_schedule
from app.schemas import (
    ChangeRecord,
    DisruptionRecord,
    ObjectiveMetrics,
    Platform,
    ScheduleVersion,
    SolverStatus,
    Train,
    TrainAssignment,
    ValidationErrorItem,
    ValidationRun,
    ValidationStatus,
    format_minutes,
)
from app.services.audit_service import record_audit_event


class ResourceNotFoundError(Exception):
    """Raised when a requested scenario or schedule version does not exist."""

    def __init__(self, resource_type: str, resource_id: str) -> None:
        super().__init__(f"{resource_type} '{resource_id}' not found.")
        self.resource_type = resource_type
        self.resource_id = resource_id


def save_schedule_version(
    conn: sqlite3.Connection,
    version: ScheduleVersion,
    validation_run: ValidationRun,
) -> None:
    """Persist an immutable ScheduleVersion, its assignments, disruptions, changes, and validation run."""
    newly_applied_ids = {d.id for d in version.newly_applied_disruptions}

    conn.execute(
        """
        INSERT INTO schedule_versions (
            id, scenario_id, version_number, parent_version_id,
            solver_status, validation_status, is_complete, created_at,
            unresolved_trains_json, objective_metrics_json, validation_findings_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            version.id,
            version.scenario_id,
            version.version_number,
            version.parent_version_id,
            version.solver_status,
            version.validation_status,
            1 if version.is_complete else 0,
            version.created_at,
            json.dumps(version.unresolved_trains),
            version.objective_metrics.model_dump_json() if version.objective_metrics else None,
            json.dumps([f.model_dump() for f in version.validation_findings]),
        ),
    )

    for idx, asn in enumerate(version.assignments):
        conn.execute(
            """
            INSERT INTO train_assignments (
                version_id, train_id, platform_id, arrival, departure,
                baseline_arrival, baseline_departure, effective_arrival, effective_departure,
                disruption_delay_minutes, additional_delay_minutes, total_delay_minutes,
                fixed, departed, unresolved, unresolved_reason, sort_order
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                version.id,
                asn.train_id,
                asn.platform_id,
                asn.arrival,
                asn.departure,
                asn.baseline_arrival,
                asn.baseline_departure,
                asn.effective_arrival,
                asn.effective_departure,
                asn.disruption_delay_minutes,
                asn.additional_delay_minutes,
                asn.total_delay_minutes,
                1 if asn.fixed else 0,
                1 if asn.departed else 0,
                1 if asn.unresolved else 0,
                asn.unresolved_reason,
                idx,
            ),
        )

    for idx, d in enumerate(version.applied_disruptions):
        conn.execute(
            """
            INSERT INTO disruptions (
                version_id, id, type, target_id, train_id, platform_id,
                delay_minutes, start_min, end_min, confirmation_status,
                application_status, source_version_id, is_newly_applied,
                created_at, sort_order
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                version.id,
                d.id,
                d.type,
                d.target_id,
                d.train_id,
                d.platform_id,
                d.delay_minutes,
                d.start,
                d.end,
                d.confirmation_status,
                d.application_status,
                d.source_version_id,
                1 if d.id in newly_applied_ids else 0,
                d.created_at,
                idx,
            ),
        )

    for idx, ch in enumerate(version.changes):
        conn.execute(
            """
            INSERT INTO revision_changes (version_id, train_id, change_json, sort_order)
            VALUES (?, ?, ?, ?)
            """,
            (version.id, ch.train_id, ch.model_dump_json(), idx),
        )

    save_validation_run(conn, validation_run)


def save_validation_run(conn: sqlite3.Connection, validation_run: ValidationRun) -> None:
    """Persist an independent validation run record."""
    conn.execute(
        """
        INSERT INTO validation_runs (
            id, version_id, validation_status, is_complete,
            errors_json, unresolved_trains_json, validated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            validation_run.id,
            validation_run.version_id,
            validation_run.validation_status,
            1 if validation_run.is_complete else 0,
            json.dumps([e.model_dump() for e in validation_run.errors]),
            json.dumps(validation_run.unresolved_train_ids),
            validation_run.validated_at,
        ),
    )


def load_schedule_version_from_conn(
    conn: sqlite3.Connection,
    version_id: str,
) -> ScheduleVersion:
    """Load a full ScheduleVersion from an open SQLite connection."""
    row = conn.execute(
        """
        SELECT id, scenario_id, version_number, parent_version_id,
               solver_status, validation_status, is_complete, created_at,
               unresolved_trains_json, objective_metrics_json, validation_findings_json
        FROM schedule_versions
        WHERE id = ?
        """,
        (version_id,),
    ).fetchone()
    if row is None:
        raise ResourceNotFoundError("ScheduleVersion", version_id)

    asn_rows = conn.execute(
        """
        SELECT train_id, platform_id, arrival, departure,
               baseline_arrival, baseline_departure, effective_arrival, effective_departure,
               disruption_delay_minutes, additional_delay_minutes, total_delay_minutes,
               fixed, departed, unresolved, unresolved_reason
        FROM train_assignments
        WHERE version_id = ?
        ORDER BY sort_order ASC
        """,
        (version_id,),
    ).fetchall()

    assignments = [
        TrainAssignment(
            train_id=r["train_id"],
            platform_id=r["platform_id"],
            arrival=r["arrival"],
            departure=r["departure"],
            arrival_str=format_minutes(r["arrival"]),
            departure_str=format_minutes(r["departure"]),
            baseline_arrival=r["baseline_arrival"],
            baseline_departure=r["baseline_departure"],
            effective_arrival=r["effective_arrival"],
            effective_departure=r["effective_departure"],
            disruption_delay_minutes=r["disruption_delay_minutes"],
            additional_delay_minutes=r["additional_delay_minutes"],
            total_delay_minutes=r["total_delay_minutes"],
            fixed=bool(r["fixed"]),
            departed=bool(r["departed"]),
            unresolved=bool(r["unresolved"]),
            unresolved_reason=r["unresolved_reason"],
        )
        for r in asn_rows
    ]

    disr_rows = conn.execute(
        """
        SELECT id, type, target_id, train_id, platform_id,
               delay_minutes, start_min, end_min, confirmation_status,
               application_status, source_version_id, is_newly_applied, created_at
        FROM disruptions
        WHERE version_id = ?
        ORDER BY sort_order ASC
        """,
        (version_id,),
    ).fetchall()

    applied_disruptions: list[DisruptionRecord] = []
    newly_applied_disruptions: list[DisruptionRecord] = []
    for r in disr_rows:
        rec = DisruptionRecord(
            id=r["id"],
            type=r["type"],
            target_id=r["target_id"],
            train_id=r["train_id"],
            platform_id=r["platform_id"],
            delay_minutes=r["delay_minutes"],
            start=r["start_min"],
            end=r["end_min"],
            start_str=format_minutes(r["start_min"]) if r["start_min"] is not None else None,
            end_str=format_minutes(r["end_min"]) if r["end_min"] is not None else None,
            confirmation_status=r["confirmation_status"],
            application_status=r["application_status"],
            source_version_id=r["source_version_id"],
            created_at=r["created_at"],
        )
        applied_disruptions.append(rec)
        if r["is_newly_applied"]:
            newly_applied_disruptions.append(rec)

    change_rows = conn.execute(
        """
        SELECT change_json
        FROM revision_changes
        WHERE version_id = ?
        ORDER BY sort_order ASC
        """,
        (version_id,),
    ).fetchall()
    changes = [ChangeRecord.model_validate_json(r["change_json"]) for r in change_rows]

    findings_raw = json.loads(row["validation_findings_json"])
    findings = [ValidationErrorItem.model_validate(item) for item in findings_raw]
    metrics = (
        ObjectiveMetrics.model_validate_json(row["objective_metrics_json"])
        if row["objective_metrics_json"]
        else None
    )

    return ScheduleVersion(
        id=row["id"],
        scenario_id=row["scenario_id"],
        version_number=row["version_number"],
        parent_version_id=row["parent_version_id"],
        solver_status=row["solver_status"],
        validation_status=row["validation_status"],
        is_complete=bool(row["is_complete"]),
        created_at=row["created_at"],
        assignments=assignments,
        changes=changes,
        applied_disruptions=applied_disruptions,
        newly_applied_disruptions=newly_applied_disruptions,
        validation_findings=findings,
        unresolved_trains=json.loads(row["unresolved_trains_json"]),
        objective_metrics=metrics,
    )


def get_schedule_version(version_id: str, db_path: Optional[str] = None) -> ScheduleVersion:
    """Retrieve a stored ScheduleVersion by ID."""
    with db_transaction(db_path) as conn:
        return load_schedule_version_from_conn(conn, version_id)


def list_schedule_versions(scenario_id: str, db_path: Optional[str] = None) -> list[ScheduleVersion]:
    """List all schedule revisions for a scenario ordered by version_number."""
    with db_transaction(db_path) as conn:
        scen_row = conn.execute("SELECT id FROM scenarios WHERE id = ?", (scenario_id,)).fetchone()
        if scen_row is None:
            raise ResourceNotFoundError("Scenario", scenario_id)

        v_rows = conn.execute(
            """
            SELECT id FROM schedule_versions
            WHERE scenario_id = ?
            ORDER BY version_number ASC
            """,
            (scenario_id,),
        ).fetchall()
        return [load_schedule_version_from_conn(conn, r["id"]) for r in v_rows]


def load_scenario_domain_objects(
    conn: sqlite3.Connection,
    scenario_id: str,
) -> tuple[dict[str, Any], list[Platform], list[Train]]:
    """Load raw scenario row, platforms, and trains for a scenario."""
    scen_row = conn.execute(
        """
        SELECT id, name, description, station_json, default_min_gap_minutes,
               active_version_id, latest_version_number, created_at
        FROM scenarios
        WHERE id = ?
        """,
        (scenario_id,),
    ).fetchone()
    if scen_row is None:
        raise ResourceNotFoundError("Scenario", scenario_id)

    plat_rows = conn.execute(
        """
        SELECT id, station_id, min_gap_minutes
        FROM platforms
        WHERE scenario_id = ?
        ORDER BY sort_order ASC
        """,
        (scenario_id,),
    ).fetchall()
    platforms = [
        Platform(
            id=r["id"],
            station_id=r["station_id"],
            min_gap_minutes=r["min_gap_minutes"],
        )
        for r in plat_rows
    ]

    train_rows = conn.execute(
        """
        SELECT id, arrival, departure, platform_id, allowed_platforms_json,
               required_platform, fixed, departed
        FROM trains
        WHERE scenario_id = ?
        ORDER BY sort_order ASC
        """,
        (scenario_id,),
    ).fetchall()
    trains = [
        Train(
            id=r["id"],
            arrival=r["arrival"],
            departure=r["departure"],
            platform_id=r["platform_id"],
            allowed_platforms=(
                json.loads(r["allowed_platforms_json"])
                if r["allowed_platforms_json"] is not None
                else None
            ),
            required_platform=r["required_platform"],
            fixed=bool(r["fixed"]),
            departed=bool(r["departed"]),
        )
        for r in train_rows
    ]
    return dict(scen_row), platforms, trains


def revalidate_schedule_version(
    version_id: str,
    db_path: Optional[str] = None,
) -> ValidationRun:
    """
    Independently recalculate validation from the stored candidate timetable and scenario constraints.
    Never returns a cached ValidationRun; executes validate_schedule() freshly and stores a new ValidationRun.
    """
    with db_transaction(db_path) as conn:
        version = load_schedule_version_from_conn(conn, version_id)
        scen_meta, platforms, trains = load_scenario_domain_objects(conn, version.scenario_id)

        val_run = validate_schedule(
            trains=trains,
            platforms=platforms,
            default_min_gap_minutes=scen_meta["default_min_gap_minutes"],
            assignments=version.assignments,
            applied_disruptions=version.applied_disruptions,
            solver_status=version.solver_status,
            version_id=version.id,
        )

        # Persist the new validation run and ensure schedule_versions reflects fresh validation
        save_validation_run(conn, val_run)
        conn.execute(
            """
            UPDATE schedule_versions
            SET validation_status = ?, is_complete = ?, validation_findings_json = ?, unresolved_trains_json = ?
            WHERE id = ?
            """,
            (
                val_run.validation_status,
                1 if val_run.is_complete else 0,
                json.dumps([e.model_dump() for e in val_run.errors]),
                json.dumps(val_run.unresolved_train_ids),
                version.id,
            ),
        )

        record_audit_event(
            conn=conn,
            actor="independent_validator",
            action="REVALIDATE_SCHEDULE_VERSION",
            scenario_id=version.scenario_id,
            version_id=version.id,
            details={
                "validation_run_id": val_run.id,
                "validation_status": val_run.validation_status,
                "is_complete": val_run.is_complete,
                "error_count": len(val_run.errors),
            },
        )
        return val_run


def list_validation_runs(version_id: str, db_path: Optional[str] = None) -> list[ValidationRun]:
    """List all independent validation runs executed for a schedule version."""
    with db_transaction(db_path) as conn:
        v_row = conn.execute("SELECT id FROM schedule_versions WHERE id = ?", (version_id,)).fetchone()
        if v_row is None:
            raise ResourceNotFoundError("ScheduleVersion", version_id)
        rows = conn.execute(
            """
            SELECT id, version_id, validation_status, is_complete,
                   errors_json, unresolved_trains_json, validated_at
            FROM validation_runs
            WHERE version_id = ?
            ORDER BY validated_at ASC, rowid ASC
            """,
            (version_id,),
        ).fetchall()
        return [
            ValidationRun(
                id=r["id"],
                version_id=r["version_id"],
                validation_status=r["validation_status"],
                is_complete=bool(r["is_complete"]),
                errors=[ValidationErrorItem.model_validate(e) for e in json.loads(r["errors_json"])],
                unresolved_train_ids=json.loads(r["unresolved_trains_json"]),
                validated_at=r["validated_at"],
            )
            for r in rows
        ]
