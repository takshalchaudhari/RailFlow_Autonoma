"""Scenario lifecycle, revision-safe replanning, manual assignment safety, and demo seeding (STEP F)."""

from __future__ import annotations

from datetime import datetime, timezone
import json
from typing import Any, Callable, Optional
import uuid

from ortools.sat.python import cp_model

from app.database import db_transaction
from app.engine.disruptions import (
    DisruptionValidationError,
    compute_effective_state_from_records,
    validate_and_apply_disruptions,
)
from app.engine.scheduler import solve_schedule
from app.engine.validator import validate_schedule
from app.schemas import (
    ChangeRecord,
    DisruptionInput,
    ManualAssignRequest,
    Platform,
    ReplanRequest,
    ScenarioCreateRequest,
    ScenarioResponse,
    ScheduleVersion,
    SolverStatus,
    Station,
    Train,
    TrainAssignment,
    format_minutes,
)
from app.services.audit_service import record_audit_event
from app.services.revision_service import (
    ResourceNotFoundError,
    load_scenario_domain_objects,
    load_schedule_version_from_conn,
    save_schedule_version,
)


class WorkflowError(Exception):
    """Structured workflow/domain error mapped to 400, 409, or 422 HTTP responses."""

    def __init__(
        self,
        code: str,
        message: str,
        status_code: int = 400,
        details: Optional[dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}


def create_scenario(
    req: ScenarioCreateRequest,
    db_path: Optional[str] = None,
) -> ScenarioResponse:
    """Create a scenario, construct its initial baseline revision (v1), and independently validate it."""
    scenario_id = req.id or f"scen-{uuid.uuid4().hex[:8]}"
    scenario_name = req.name or f"{req.station.name} Simulation"
    now_iso = datetime.now(timezone.utc).isoformat()
    v1_id = f"ver-{uuid.uuid4().hex[:10]}"

    # Construct initial baseline assignments
    any_unassigned = any(t.platform_id is None for t in req.trains)
    if req.solve_initial_if_unassigned and any_unassigned:
        eff_state = compute_effective_state_from_records(req.trains, req.platforms, [])
        sched_res = solve_schedule(
            trains=req.trains,
            platforms=req.platforms,
            default_min_gap_minutes=req.default_min_gap_minutes,
            effective_state=eff_state,
        )
        initial_assignments = sched_res.assignments
        initial_solver_status: SolverStatus = sched_res.solver_status
        initial_metrics = sched_res.objective_metrics
        initial_unresolved = sched_res.unresolved_trains
    else:
        initial_assignments = [
            TrainAssignment(
                train_id=t.id,
                platform_id=t.platform_id,
                arrival=t.arrival,
                departure=t.departure,
                arrival_str=format_minutes(t.arrival),
                departure_str=format_minutes(t.departure),
                baseline_arrival=t.arrival,
                baseline_departure=t.departure,
                effective_arrival=t.arrival,
                effective_departure=t.departure,
                disruption_delay_minutes=0,
                additional_delay_minutes=0,
                total_delay_minutes=0,
                fixed=t.fixed,
                departed=t.departed,
                unresolved=t.platform_id is None,
                unresolved_reason=(
                    f"Train '{t.id}' has no initial platform assignment in baseline definition."
                    if t.platform_id is None
                    else None
                ),
            )
            for t in req.trains
        ]
        initial_solver_status = "BASELINE"
        initial_metrics = None
        initial_unresolved = [t.id for t in req.trains if t.platform_id is None]

    # Independently validate initial timetable
    val_run = validate_schedule(
        trains=req.trains,
        platforms=req.platforms,
        default_min_gap_minutes=req.default_min_gap_minutes,
        assignments=initial_assignments,
        applied_disruptions=[],
        solver_status=initial_solver_status,
        version_id=v1_id,
    )

    v1 = ScheduleVersion(
        id=v1_id,
        scenario_id=scenario_id,
        version_number=1,
        parent_version_id=None,
        solver_status=initial_solver_status,
        validation_status=val_run.validation_status,
        is_complete=val_run.is_complete,
        created_at=now_iso,
        assignments=initial_assignments,
        changes=[],
        applied_disruptions=[],
        newly_applied_disruptions=[],
        validation_findings=val_run.errors,
        unresolved_trains=val_run.unresolved_train_ids or initial_unresolved,
        objective_metrics=initial_metrics,
    )

    with db_transaction(db_path) as conn:
        existing = conn.execute("SELECT id FROM scenarios WHERE id = ?", (scenario_id,)).fetchone()
        if existing is not None:
            raise WorkflowError(
                code="DUPLICATE_SCENARIO_ID",
                message=f"Scenario with ID '{scenario_id}' already exists.",
                status_code=409,
            )

        conn.execute(
            """
            INSERT INTO scenarios (
                id, name, description, station_json, default_min_gap_minutes,
                active_version_id, latest_version_number, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                scenario_id,
                scenario_name,
                req.description,
                req.station.model_dump_json(),
                req.default_min_gap_minutes,
                v1_id,
                1,
                now_iso,
            ),
        )

        for idx, p in enumerate(req.platforms):
            conn.execute(
                """
                INSERT INTO platforms (scenario_id, id, station_id, min_gap_minutes, sort_order)
                VALUES (?, ?, ?, ?, ?)
                """,
                (scenario_id, p.id, p.station_id or req.station.id, p.min_gap_minutes, idx),
            )

        for idx, t in enumerate(req.trains):
            conn.execute(
                """
                INSERT INTO trains (
                    scenario_id, id, arrival, departure, platform_id,
                    allowed_platforms_json, required_platform, fixed, departed, sort_order
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    scenario_id,
                    t.id,
                    t.arrival,
                    t.departure,
                    t.platform_id,
                    json.dumps(t.allowed_platforms) if t.allowed_platforms is not None else None,
                    t.required_platform,
                    1 if t.fixed else 0,
                    1 if t.departed else 0,
                    idx,
                ),
            )

        save_schedule_version(conn, v1, val_run)

        record_audit_event(
            conn=conn,
            actor="operator",
            action="CREATE_SCENARIO",
            scenario_id=scenario_id,
            version_id=v1_id,
            details={
                "scenario_name": scenario_name,
                "platform_count": len(req.platforms),
                "train_count": len(req.trains),
                "initial_validation_status": val_run.validation_status,
            },
        )

    return ScenarioResponse(
        id=scenario_id,
        name=scenario_name,
        description=req.description,
        station=req.station,
        default_min_gap_minutes=req.default_min_gap_minutes,
        platforms=req.platforms,
        trains=req.trains,
        active_version_id=v1_id,
        latest_version_number=1,
        created_at=now_iso,
        active_schedule_version=v1,
    )


def get_scenario(scenario_id: str, db_path: Optional[str] = None) -> ScenarioResponse:
    """Retrieve a scenario along with its current active schedule version."""
    with db_transaction(db_path) as conn:
        scen_meta, platforms, trains = load_scenario_domain_objects(conn, scenario_id)
        station = Station.model_validate_json(scen_meta["station_json"])
        active_ver_id = scen_meta["active_version_id"]
        active_ver = (
            load_schedule_version_from_conn(conn, active_ver_id) if active_ver_id else None
        )

        return ScenarioResponse(
            id=scen_meta["id"],
            name=scen_meta["name"],
            description=scen_meta["description"],
            station=station,
            default_min_gap_minutes=scen_meta["default_min_gap_minutes"],
            platforms=platforms,
            trains=trains,
            active_version_id=active_ver_id,
            latest_version_number=scen_meta["latest_version_number"],
            created_at=scen_meta["created_at"],
            active_schedule_version=active_ver,
        )


def list_scenarios(db_path: Optional[str] = None) -> list[ScenarioResponse]:
    """List all scenarios in the database."""
    with db_transaction(db_path) as conn:
        rows = conn.execute("SELECT id FROM scenarios ORDER BY created_at ASC, rowid ASC").fetchall()
    return [get_scenario(r["id"], db_path=db_path) for r in rows]


def replan_scenario(
    scenario_id: str,
    req: ReplanRequest,
    db_path: Optional[str] = None,
    custom_solve_hook: Optional[Callable[[cp_model.CpSolver, cp_model.CpModel], int]] = None,
) -> ScheduleVersion:
    """
    Apply newly confirmed disruptions to an explicit baseline revision, run the CP-SAT scheduler,
    independently validate any candidate, and persist an immutable new revision.
    """
    if not req.confirmed:
        raise WorkflowError(
            code="CONFIRMATION_REQUIRED",
            message="Operator confirmation (confirmed=True) is required before replanning.",
            status_code=400,
        )

    with db_transaction(db_path) as conn:
        scen_meta, platforms, trains = load_scenario_domain_objects(conn, scenario_id)

        # Verify optimistic concurrency / stale baseline if expected_active_version_id is specified
        if (
            req.expected_active_version_id is not None
            and req.expected_active_version_id != scen_meta["active_version_id"]
        ):
            raise WorkflowError(
                code="STALE_BASELINE_VERSION",
                message=(
                    f"Stale baseline conflict: expected active version '{req.expected_active_version_id}', "
                    f"but current active version is '{scen_meta['active_version_id']}'."
                ),
                status_code=409,
                details={
                    "expected_active_version_id": req.expected_active_version_id,
                    "actual_active_version_id": scen_meta["active_version_id"],
                },
            )

        # Load explicit baseline revision and verify it belongs to this scenario
        try:
            baseline_ver = load_schedule_version_from_conn(conn, req.baseline_version_id)
        except ResourceNotFoundError as exc:
            raise ResourceNotFoundError("BaselineScheduleVersion", req.baseline_version_id) from exc

        if baseline_ver.scenario_id != scenario_id:
            raise WorkflowError(
                code="BASELINE_SCENARIO_MISMATCH",
                message=(
                    f"Baseline version '{req.baseline_version_id}' belongs to scenario "
                    f"'{baseline_ver.scenario_id}', not '{scenario_id}'."
                ),
                status_code=400,
            )

        new_version_id = f"ver-{uuid.uuid4().hex[:10]}"
        next_version_number = int(scen_meta["latest_version_number"]) + 1

        # Validate and apply disruptions atomically against baseline_ver.applied_disruptions
        try:
            effective_state = validate_and_apply_disruptions(
                trains=trains,
                platforms=platforms,
                baseline_disruptions=baseline_ver.applied_disruptions,
                new_disruptions=req.disruptions,
                source_version_id=new_version_id,
            )
        except DisruptionValidationError as exc:
            raise WorkflowError(
                code=exc.code,
                message=exc.message,
                status_code=400,
                details={"target_id": exc.target_id, **exc.details},
            ) from exc

        # Run deterministic CP-SAT scheduler
        sched_result = solve_schedule(
            trains=trains,
            platforms=platforms,
            default_min_gap_minutes=scen_meta["default_min_gap_minutes"],
            effective_state=effective_state,
            baseline_assignments=baseline_ver.assignments,
            solver_time_limit_seconds=req.solver_time_limit_seconds,
            max_additional_delay_minutes=req.max_additional_delay_minutes,
            allow_partial_diagnostic=req.allow_partial_diagnostic,
            custom_solve_hook=custom_solve_hook,
        )

        # Run independent validator on the candidate timetable
        val_run = validate_schedule(
            trains=trains,
            platforms=platforms,
            default_min_gap_minutes=scen_meta["default_min_gap_minutes"],
            assignments=sched_result.assignments,
            applied_disruptions=effective_state.cumulative_disruptions,
            solver_status=sched_result.solver_status,
            version_id=new_version_id,
        )

        # Never mark a schedule VALID if the solver did not find a complete feasible solution
        effective_val_status = val_run.validation_status
        if sched_result.solver_status in ("INFEASIBLE", "UNKNOWN") and effective_val_status == "VALID":
            effective_val_status = "INVALID"

        is_complete = (
            effective_val_status == "VALID"
            and val_run.is_complete
            and len(sched_result.unresolved_trains) == 0
        )

        now_iso = datetime.now(timezone.utc).isoformat()
        new_version = ScheduleVersion(
            id=new_version_id,
            scenario_id=scenario_id,
            version_number=next_version_number,
            parent_version_id=baseline_ver.id,
            solver_status=sched_result.solver_status,
            validation_status=effective_val_status,
            is_complete=is_complete,
            created_at=now_iso,
            assignments=sched_result.assignments,
            changes=sched_result.changes,
            applied_disruptions=effective_state.cumulative_disruptions,
            newly_applied_disruptions=effective_state.newly_applied_records,
            validation_findings=val_run.errors,
            unresolved_trains=sched_result.unresolved_trains or val_run.unresolved_train_ids,
            objective_metrics=sched_result.objective_metrics,
        )

        save_schedule_version(conn, new_version, val_run)

        # Only promote active_version_id when the new revision is independently VALID
        new_active_id = (
            new_version_id
            if effective_val_status == "VALID"
            else scen_meta["active_version_id"]
        )
        conn.execute(
            """
            UPDATE scenarios
            SET active_version_id = ?, latest_version_number = ?
            WHERE id = ?
            """,
            (new_active_id, next_version_number, scenario_id),
        )

        record_audit_event(
            conn=conn,
            actor="scheduler_engine",
            action="REPLAN_SCENARIO",
            scenario_id=scenario_id,
            version_id=new_version_id,
            details={
                "baseline_version_id": baseline_ver.id,
                "version_number": next_version_number,
                "new_disruptions_count": len(effective_state.newly_applied_records),
                "solver_status": new_version.solver_status,
                "validation_status": new_version.validation_status,
                "is_complete": new_version.is_complete,
                "promoted_to_active": effective_val_status == "VALID",
            },
        )

        return new_version


def apply_manual_assignments(
    scenario_id: str,
    req: ManualAssignRequest,
    db_path: Optional[str] = None,
) -> ScheduleVersion:
    """
    Validate manual assignment proposals through the independent validator.
    Invalid proposals are rejected with 422 unless save_as_diagnostic=True, in which case
    they are saved as a diagnostic revision with validation_status=INVALID/PARTIAL (never VALID)
    and never promoted to active_version_id.
    """
    with db_transaction(db_path) as conn:
        scen_meta, platforms, trains = load_scenario_domain_objects(conn, scenario_id)
        try:
            baseline_ver = load_schedule_version_from_conn(conn, req.baseline_version_id)
        except ResourceNotFoundError as exc:
            raise ResourceNotFoundError("BaselineScheduleVersion", req.baseline_version_id) from exc

        if baseline_ver.scenario_id != scenario_id:
            raise WorkflowError(
                code="BASELINE_SCENARIO_MISMATCH",
                message=f"Baseline version '{req.baseline_version_id}' does not belong to scenario '{scenario_id}'.",
                status_code=400,
            )

        trains_by_id = {t.id: t for t in trains}
        base_asn_by_train = {a.train_id: a for a in baseline_ver.assignments}
        eff_state = compute_effective_state_from_records(
            trains, platforms, baseline_ver.applied_disruptions
        )

        candidate_assignments: list[TrainAssignment] = []
        changes: list[ChangeRecord] = []

        for item in req.assignments:
            t = trains_by_id.get(item.train_id)
            spec = eff_state.effective_trains.get(item.train_id)
            prev_asn = base_asn_by_train.get(item.train_id)

            base_arr = t.arrival if t else item.arrival
            base_dep = t.departure if t else item.departure
            eff_arr = spec.effective_arrival if spec else item.arrival
            eff_dep = spec.effective_departure if spec else item.departure
            disr_delay = spec.disruption_delay_minutes if spec else 0
            add_delay = max(0, item.arrival - eff_arr)

            candidate_assignments.append(
                TrainAssignment(
                    train_id=item.train_id,
                    platform_id=item.platform_id,
                    arrival=item.arrival,
                    departure=item.departure,
                    arrival_str=format_minutes(item.arrival),
                    departure_str=format_minutes(item.departure),
                    baseline_arrival=base_arr,
                    baseline_departure=base_dep,
                    effective_arrival=eff_arr,
                    effective_departure=eff_dep,
                    disruption_delay_minutes=disr_delay,
                    additional_delay_minutes=add_delay,
                    total_delay_minutes=disr_delay + add_delay,
                    fixed=t.fixed if t else False,
                    departed=t.departed if t else False,
                    unresolved=item.platform_id is None,
                    unresolved_reason=(
                        "Left unassigned in manual proposal." if item.platform_id is None else None
                    ),
                )
            )

            prev_pid = prev_asn.platform_id if prev_asn else (t.platform_id if t else None)
            prev_a = prev_asn.arrival if prev_asn else base_arr
            prev_d = prev_asn.departure if prev_asn else base_dep
            if item.platform_id != prev_pid or item.arrival != prev_a or item.departure != prev_d:
                changes.append(
                    ChangeRecord(
                        train_id=item.train_id,
                        previous_platform=prev_pid,
                        proposed_platform=item.platform_id,
                        previous_arrival=prev_a,
                        previous_departure=prev_d,
                        proposed_arrival=item.arrival,
                        proposed_departure=item.departure,
                        previous_arrival_str=format_minutes(prev_a),
                        previous_departure_str=format_minutes(prev_d),
                        proposed_arrival_str=format_minutes(item.arrival),
                        proposed_departure_str=format_minutes(item.departure),
                        disruption_delay_minutes=disr_delay,
                        additional_delay_minutes=add_delay,
                        platform_changed=item.platform_id != prev_pid,
                        timing_changed=(item.arrival != prev_a or item.departure != prev_d),
                        unresolved=item.platform_id is None,
                        reason=req.reason,
                        associated_disruption_ids=[],
                    )
                )

        new_version_id = f"ver-{uuid.uuid4().hex[:10]}"
        val_run = validate_schedule(
            trains=trains,
            platforms=platforms,
            default_min_gap_minutes=scen_meta["default_min_gap_minutes"],
            assignments=candidate_assignments,
            applied_disruptions=baseline_ver.applied_disruptions,
            solver_status="MANUAL",
            version_id=new_version_id,
        )

        if val_run.validation_status != "VALID" and not req.save_as_diagnostic:
            raise WorkflowError(
                code="INVALID_MANUAL_ASSIGNMENT",
                message=(
                    f"Proposed manual timetable failed independent validation with status "
                    f"'{val_run.validation_status}'."
                ),
                status_code=422,
                details={
                    "validation_status": val_run.validation_status,
                    "is_complete": val_run.is_complete,
                    "errors": [e.model_dump() for e in val_run.errors],
                },
            )

        next_version_number = int(scen_meta["latest_version_number"]) + 1
        now_iso = datetime.now(timezone.utc).isoformat()

        new_version = ScheduleVersion(
            id=new_version_id,
            scenario_id=scenario_id,
            version_number=next_version_number,
            parent_version_id=baseline_ver.id,
            solver_status="MANUAL",
            validation_status=val_run.validation_status,
            is_complete=val_run.is_complete,
            created_at=now_iso,
            assignments=candidate_assignments,
            changes=changes,
            applied_disruptions=baseline_ver.applied_disruptions,
            newly_applied_disruptions=[],
            validation_findings=val_run.errors,
            unresolved_trains=val_run.unresolved_train_ids,
            objective_metrics=None,
        )

        save_schedule_version(conn, new_version, val_run)

        new_active_id = (
            new_version_id
            if val_run.validation_status == "VALID"
            else scen_meta["active_version_id"]
        )
        conn.execute(
            """
            UPDATE scenarios
            SET active_version_id = ?, latest_version_number = ?
            WHERE id = ?
            """,
            (new_active_id, next_version_number, scenario_id),
        )

        record_audit_event(
            conn=conn,
            actor="operator_manual",
            action="MANUAL_ASSIGNMENT",
            scenario_id=scenario_id,
            version_id=new_version_id,
            details={
                "baseline_version_id": baseline_ver.id,
                "validation_status": val_run.validation_status,
                "save_as_diagnostic": req.save_as_diagnostic,
                "error_count": len(val_run.errors),
            },
        )
        return new_version


def compare_revisions(
    base_version_id: str,
    target_version_id: str,
    db_path: Optional[str] = None,
) -> dict[str, Any]:
    """Compare two schedule versions side by side and compute train-by-train differences."""
    with db_transaction(db_path) as conn:
        base_ver = load_schedule_version_from_conn(conn, base_version_id)
        target_ver = load_schedule_version_from_conn(conn, target_version_id)

    if base_ver.scenario_id != target_ver.scenario_id:
        raise WorkflowError(
            code="SCENARIO_MISMATCH",
            message="Cannot compare schedule versions from different scenarios.",
            status_code=400,
        )

    base_by_train = {a.train_id: a for a in base_ver.assignments}
    target_by_train = {a.train_id: a for a in target_ver.assignments}
    all_train_ids = sorted(set(base_by_train.keys()) | set(target_by_train.keys()))

    diffs: list[dict[str, Any]] = []
    for tid in all_train_ids:
        b = base_by_train.get(tid)
        t = target_by_train.get(tid)
        plat_changed = (b.platform_id if b else None) != (t.platform_id if t else None)
        time_changed = (
            (b.arrival if b else None) != (t.arrival if t else None)
            or (b.departure if b else None) != (t.departure if t else None)
        )
        diffs.append(
            {
                "train_id": tid,
                "base_platform": b.platform_id if b else None,
                "target_platform": t.platform_id if t else None,
                "base_arrival_str": b.arrival_str if b else None,
                "base_departure_str": b.departure_str if b else None,
                "target_arrival_str": t.arrival_str if t else None,
                "target_departure_str": t.departure_str if t else None,
                "platform_changed": plat_changed,
                "timing_changed": time_changed,
                "disruption_delay_minutes": t.disruption_delay_minutes if t else 0,
                "additional_delay_minutes": t.additional_delay_minutes if t else 0,
                "unresolved": t.unresolved if t else True,
            }
        )

    return {
        "scenario_id": base_ver.scenario_id,
        "base_version_id": base_ver.id,
        "base_version_number": base_ver.version_number,
        "base_validation_status": base_ver.validation_status,
        "target_version_id": target_ver.id,
        "target_version_number": target_ver.version_number,
        "target_solver_status": target_ver.solver_status,
        "target_validation_status": target_ver.validation_status,
        "target_is_complete": target_ver.is_complete,
        "train_diffs": diffs,
        "recorded_changes": [c.model_dump() for c in target_ver.changes],
    }


def build_standard_demo_request(scenario_id: Optional[str] = None) -> ScenarioCreateRequest:
    """Section 16 Demonstration Scenario: 3 platforms, 10-minute clearance gap, T101..T104."""
    return ScenarioCreateRequest(
        id=scenario_id,
        name="Vortexa Central Station — Standard Disruption Demo",
        description=(
            "3 platforms (P1, P2, P3) with 10-minute clearance gap and 4 baseline trains "
            "(T101..T104). Ready for testing T101 +20m delay and P2 closure [09:20, 10:00)."
        ),
        station=Station(id="STN-VX01", name="Vortexa Central", timezone="UTC"),
        default_min_gap_minutes=10,
        platforms=[
            Platform(id="P1", station_id="STN-VX01"),
            Platform(id="P2", station_id="STN-VX01"),
            Platform(id="P3", station_id="STN-VX01"),
        ],
        trains=[
            Train(id="T101", arrival="09:00", departure="09:20", platform_id="P1"),
            Train(id="T102", arrival="09:30", departure="09:50", platform_id="P1"),
            Train(id="T103", arrival="09:25", departure="09:45", platform_id="P2"),
            Train(id="T104", arrival="09:40", departure="10:00", platform_id="P3"),
        ],
    )


def build_impossible_demo_request(scenario_id: Optional[str] = None) -> ScenarioCreateRequest:
    """Section 16 Impossible Scenario: fixed train on P1 where P1 will be closed during occupancy."""
    return ScenarioCreateRequest(
        id=scenario_id,
        name="Vortexa Central — Impossible Fixed-Train Scenario",
        description=(
            "Train T201 is operationally fixed to required platform P1 (09:00-09:20). "
            "Closing P1 during [08:50, 09:30) creates an impossible hard-constraint conflict."
        ),
        station=Station(id="STN-VX02", name="Vortexa Annex", timezone="UTC"),
        default_min_gap_minutes=10,
        platforms=[
            Platform(id="P1", station_id="STN-VX02"),
            Platform(id="P2", station_id="STN-VX02"),
        ],
        trains=[
            Train(
                id="T201",
                arrival="09:00",
                departure="09:20",
                platform_id="P1",
                required_platform="P1",
                fixed=True,
            ),
            Train(id="T202", arrival="09:30", departure="09:50", platform_id="P2"),
        ],
    )
