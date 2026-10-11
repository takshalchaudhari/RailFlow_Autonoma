"""Logically independent timetable validator (STEP C).

This module has ZERO dependency on Google OR-Tools or app/engine/scheduler.py.
It independently inspects any proposed timetable against the scenario definition and active disruptions.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
import uuid

from app.schemas import (
    DisruptionRecord,
    Platform,
    SERVICE_DAY_END,
    SERVICE_DAY_START,
    SolverStatus,
    Train,
    TrainAssignment,
    ValidationErrorItem,
    ValidationRun,
    ValidationStatus,
    format_minutes,
)


def validate_schedule(
    trains: list[Train],
    platforms: list[Platform],
    default_min_gap_minutes: int,
    assignments: list[TrainAssignment],
    applied_disruptions: Optional[list[DisruptionRecord]] = None,
    solver_status: Optional[SolverStatus] = None,
    version_id: str = "unpersisted",
    claimed_validation_status: Optional[ValidationStatus] = None,
) -> ValidationRun:
    """
    Independently validate a candidate timetable against all hard constraints.

    Checks performed:
    1. No duplicate train assignment records.
    2. All required scenario trains are represented.
    3. No unknown train IDs appear.
    4. Every unresolved train is explicitly identified; incomplete timetables are never VALID.
    5. Every assigned platform exists in the scenario.
    6. Permitted platform restrictions (allowed_platforms) are respected.
    7. Mandatory platform restrictions (required_platform) are honored.
    8. Arrival strictly precedes departure within [00:00, 24:00].
    9. Fixed and departed trains retain their original platform and times.
    10. Normal replanning never moves a train earlier than its effective post-disruption arrival.
    11. Dwell time is preserved relative to the baseline train definition.
    12. Platform closures [start, end) are respected.
    13. Chronological platform occupancy and clearance gaps are respected for all train pairs.
    """
    disruptions = applied_disruptions or []
    errors: list[ValidationErrorItem] = []
    hard_violation_count = 0
    unresolved_train_ids: list[str] = []

    trains_by_id: dict[str, Train] = {t.id: t for t in trains}
    platforms_by_id: dict[str, Platform] = {p.id: p for p in platforms}

    # Precompute cumulative train delays and platform closures from applied_disruptions
    delay_by_train: dict[str, int] = {t.id: 0 for t in trains}
    closures_by_platform: dict[str, list[DisruptionRecord]] = {p.id: [] for p in platforms}

    for d in disruptions:
        if d.type == "train_delay":
            tid = d.train_id or d.target_id
            if tid not in trains_by_id:
                errors.append(
                    ValidationErrorItem(
                        code="UNKNOWN_TRAIN_IN_DISRUPTION",
                        train_ids=[tid] if tid else [],
                        message=f"Applied disruption '{d.id}' references unknown train '{tid}'.",
                        rule="known_train_reference",
                    )
                )
                hard_violation_count += 1
            elif d.delay_minutes is None or d.delay_minutes <= 0:
                errors.append(
                    ValidationErrorItem(
                        code="INVALID_DISRUPTION_DELAY",
                        train_ids=[tid],
                        message=f"Applied disruption '{d.id}' on train '{tid}' has non-positive delay.",
                        rule="valid_disruption_delay",
                    )
                )
                hard_violation_count += 1
            elif trains_by_id[tid].fixed or trains_by_id[tid].departed:
                errors.append(
                    ValidationErrorItem(
                        code="IMMUTABLE_TRAIN_DELAYED",
                        train_ids=[tid],
                        message=(
                            f"Applied disruption '{d.id}' attempts to delay fixed or departed train '{tid}'."
                        ),
                        rule="fixed_and_departed_immutability",
                    )
                )
                hard_violation_count += 1
            else:
                delay_by_train[tid] += d.delay_minutes
        elif d.type == "platform_closure":
            pid = d.platform_id or d.target_id
            if pid not in closures_by_platform:
                errors.append(
                    ValidationErrorItem(
                        code="UNKNOWN_PLATFORM_IN_CLOSURE",
                        platform_id=pid,
                        message=f"Applied closure '{d.id}' references unknown platform '{pid}'.",
                        rule="platform_exists",
                    )
                )
                hard_violation_count += 1
            elif (
                d.start is None
                or d.end is None
                or d.start < SERVICE_DAY_START
                or d.end > SERVICE_DAY_END
                or d.start >= d.end
            ):
                errors.append(
                    ValidationErrorItem(
                        code="INVALID_CLOSURE_RANGE",
                        platform_id=pid,
                        time_interval=(d.start or 0, d.end or 0),
                        message=f"Applied closure '{d.id}' on platform '{pid}' has invalid time range.",
                        rule="valid_closure_interval",
                    )
                )
                hard_violation_count += 1
            else:
                closures_by_platform[pid].append(d)

    # Check 1 & 3: Inspect assignments for duplicates and unknown trains
    seen_train_ids: set[str] = set()
    assignments_by_train: dict[str, TrainAssignment] = {}

    for asn in assignments:
        if asn.train_id in seen_train_ids:
            errors.append(
                ValidationErrorItem(
                    code="DUPLICATE_TRAIN_ASSIGNMENT",
                    train_ids=[asn.train_id],
                    platform_id=asn.platform_id,
                    message=f"Train '{asn.train_id}' appears multiple times in the proposed timetable.",
                    rule="single_assignment_per_train",
                )
            )
            hard_violation_count += 1
            continue
        seen_train_ids.add(asn.train_id)

        if asn.train_id not in trains_by_id:
            errors.append(
                ValidationErrorItem(
                    code="UNKNOWN_TRAIN",
                    train_ids=[asn.train_id],
                    platform_id=asn.platform_id,
                    message=f"Proposed timetable contains unknown train '{asn.train_id}'.",
                    rule="known_train_reference",
                )
            )
            hard_violation_count += 1
            continue

        assignments_by_train[asn.train_id] = asn

    # Check 2: All required trains are represented
    for t in trains:
        if t.id not in assignments_by_train:
            errors.append(
                ValidationErrorItem(
                    code="MISSING_TRAIN",
                    train_ids=[t.id],
                    message=f"Required train '{t.id}' is missing from the proposed timetable.",
                    rule="all_trains_represented",
                )
            )
            hard_violation_count += 1

    # Per-train checks (Checks 4 through 12)
    resolved_by_platform: dict[str, list[TrainAssignment]] = {p.id: [] for p in platforms}

    for tid, asn in assignments_by_train.items():
        train = trains_by_id[tid]
        effective_arr = train.arrival + delay_by_train[tid]
        effective_dep = train.departure + delay_by_train[tid]
        expected_dwell = train.departure - train.arrival

        # Check 8: Valid arrival/departure ordering and service horizon
        if (
            asn.arrival < SERVICE_DAY_START
            or asn.departure > SERVICE_DAY_END
            or asn.arrival >= asn.departure
        ):
            errors.append(
                ValidationErrorItem(
                    code="INVALID_TIME_RANGE",
                    train_ids=[tid],
                    platform_id=asn.platform_id,
                    time_interval=(asn.arrival, asn.departure),
                    message=(
                        f"Train '{tid}' has invalid time range [{asn.arrival}, {asn.departure}) "
                        f"({format_minutes(asn.arrival)}-{format_minutes(asn.departure)}). "
                        "Arrival must strictly precede departure within [00:00, 24:00]."
                    ),
                    rule="arrival_precedes_departure",
                )
            )
            hard_violation_count += 1

        # Check 11: Dwell time preserved
        actual_dwell = asn.departure - asn.arrival
        if actual_dwell != expected_dwell:
            errors.append(
                ValidationErrorItem(
                    code="DWELL_TIME_CHANGED",
                    train_ids=[tid],
                    platform_id=asn.platform_id,
                    time_interval=(asn.arrival, asn.departure),
                    message=(
                        f"Train '{tid}' dwell time changed from {expected_dwell} min to {actual_dwell} min."
                    ),
                    rule="preserve_dwell_time",
                )
            )
            hard_violation_count += 1

        # Check 10: Cannot move earlier than effective baseline
        if asn.arrival < effective_arr:
            errors.append(
                ValidationErrorItem(
                    code="EARLY_ARRIVAL_VIOLATION",
                    train_ids=[tid],
                    platform_id=asn.platform_id,
                    time_interval=(asn.arrival, asn.departure),
                    message=(
                        f"Train '{tid}' scheduled arrival ({format_minutes(asn.arrival)}) is earlier than "
                        f"its effective baseline arrival ({format_minutes(effective_arr)})."
                    ),
                    rule="no_early_departure_or_arrival",
                )
            )
            hard_violation_count += 1

        # Check 9: Fixed and departed train immutability
        if train.fixed:
            if (
                asn.unresolved
                or asn.platform_id != train.platform_id
                or asn.arrival != train.arrival
                or asn.departure != train.departure
            ):
                errors.append(
                    ValidationErrorItem(
                        code="FIXED_TRAIN_MODIFIED",
                        train_ids=[tid],
                        platform_id=asn.platform_id,
                        time_interval=(asn.arrival, asn.departure),
                        message=(
                            f"Operationally fixed train '{tid}' must remain at platform '{train.platform_id}' "
                            f"from {format_minutes(train.arrival)} to {format_minutes(train.departure)}."
                        ),
                        rule="fixed_train_immutability",
                    )
                )
                hard_violation_count += 1

        if train.departed:
            if (
                asn.unresolved
                or asn.platform_id != train.platform_id
                or asn.arrival != train.arrival
                or asn.departure != train.departure
            ):
                errors.append(
                    ValidationErrorItem(
                        code="DEPARTED_TRAIN_MODIFIED",
                        train_ids=[tid],
                        platform_id=asn.platform_id,
                        time_interval=(asn.arrival, asn.departure),
                        message=(
                            f"Already-departed train '{tid}' must remain at platform '{train.platform_id}' "
                            f"from {format_minutes(train.arrival)} to {format_minutes(train.departure)}."
                        ),
                        rule="departed_train_immutability",
                    )
                )
                hard_violation_count += 1

        # Check 4: Unresolved state consistency
        if asn.unresolved and asn.platform_id is not None:
            errors.append(
                ValidationErrorItem(
                    code="INCONSISTENT_UNRESOLVED_STATE",
                    train_ids=[tid],
                    platform_id=asn.platform_id,
                    message=(
                        f"Train '{tid}' is marked unresolved=True but also carries platform_id='{asn.platform_id}'."
                    ),
                    rule="unresolved_representation",
                )
            )
            hard_violation_count += 1

        if asn.unresolved or asn.platform_id is None:
            unresolved_train_ids.append(tid)
            errors.append(
                ValidationErrorItem(
                    code="UNRESOLVED_TRAIN",
                    train_ids=[tid],
                    time_interval=(asn.arrival, asn.departure),
                    message=(
                        asn.unresolved_reason
                        or f"Train '{tid}' has no assigned platform in this schedule proposal."
                    ),
                    rule="complete_schedule_required",
                )
            )
            continue

        pid = asn.platform_id
        # Check 5: Assigned platform exists
        if pid not in platforms_by_id:
            errors.append(
                ValidationErrorItem(
                    code="UNKNOWN_PLATFORM",
                    train_ids=[tid],
                    platform_id=pid,
                    time_interval=(asn.arrival, asn.departure),
                    message=f"Train '{tid}' is assigned to unknown platform '{pid}'.",
                    rule="platform_exists",
                )
            )
            hard_violation_count += 1
            continue

        # Check 6: Allowed platforms restriction
        if train.allowed_platforms is not None and pid not in train.allowed_platforms:
            errors.append(
                ValidationErrorItem(
                    code="UNAUTHORIZED_PLATFORM",
                    train_ids=[tid],
                    platform_id=pid,
                    time_interval=(asn.arrival, asn.departure),
                    message=(
                        f"Train '{tid}' is assigned to platform '{pid}', which is not in its "
                        f"allowed_platforms {train.allowed_platforms}."
                    ),
                    rule="allowed_platforms",
                )
            )
            hard_violation_count += 1

        # Check 7: Required platform restriction
        if train.required_platform is not None and pid != train.required_platform:
            errors.append(
                ValidationErrorItem(
                    code="REQUIRED_PLATFORM_VIOLATION",
                    train_ids=[tid],
                    platform_id=pid,
                    time_interval=(asn.arrival, asn.departure),
                    message=(
                        f"Train '{tid}' requires platform '{train.required_platform}' "
                        f"but was assigned to '{pid}'."
                    ),
                    rule="required_platform",
                )
            )
            hard_violation_count += 1

        # Check 12: Platform closures [start, end)
        for closure in closures_by_platform.get(pid, []):
            if closure.start is not None and closure.end is not None:
                # Half-open intervals [asn.arrival, asn.departure) and [closure.start, closure.end) overlap
                # iff asn.arrival < closure.end and asn.departure > closure.start
                if asn.arrival < closure.end and asn.departure > closure.start:
                    errors.append(
                        ValidationErrorItem(
                            code="PLATFORM_CLOSURE_CONFLICT",
                            platform_id=pid,
                            train_ids=[tid],
                            time_interval=(asn.arrival, asn.departure),
                            message=(
                                f"Train '{tid}' occupies platform '{pid}' during closure "
                                f"[{format_minutes(closure.start)}, {format_minutes(closure.end)})."
                            ),
                            rule="platform_closure",
                        )
                    )
                    hard_violation_count += 1

        resolved_by_platform[pid].append(asn)

    # Check 13: Chronological platform occupancy and clearance gaps
    for pid, plat_assignments in resolved_by_platform.items():
        if len(plat_assignments) < 2:
            continue
        platform_obj = platforms_by_id[pid]
        gap = (
            platform_obj.min_gap_minutes
            if platform_obj.min_gap_minutes is not None
            else default_min_gap_minutes
        )
        # Sort chronologically by (arrival, departure, train_id)
        sorted_asns = sorted(
            plat_assignments,
            key=lambda a: (a.arrival, a.departure, a.train_id),
        )
        # Compare all pairs on the platform so overlapping trains spanning multiple slots are caught
        n = len(sorted_asns)
        for i in range(n):
            a = sorted_asns[i]
            for j in range(i + 1, n):
                b = sorted_asns[j]
                if b.arrival < a.departure:
                    errors.append(
                        ValidationErrorItem(
                            code="PLATFORM_OVERLAP",
                            platform_id=pid,
                            train_ids=[a.train_id, b.train_id],
                            required_gap_minutes=gap,
                            actual_gap_minutes=b.arrival - a.departure,
                            time_interval=(b.arrival, min(a.departure, b.departure)),
                            message=(
                                f"Trains '{a.train_id}' ({format_minutes(a.arrival)}-{format_minutes(a.departure)}) "
                                f"and '{b.train_id}' ({format_minutes(b.arrival)}-{format_minutes(b.departure)}) "
                                f"overlap on platform '{pid}'."
                            ),
                            rule="platform_occupancy_exclusivity",
                        )
                    )
                    hard_violation_count += 1
                elif b.arrival < a.departure + gap:
                    errors.append(
                        ValidationErrorItem(
                            code="PLATFORM_CONFLICT",
                            platform_id=pid,
                            train_ids=[a.train_id, b.train_id],
                            required_gap_minutes=gap,
                            actual_gap_minutes=b.arrival - a.departure,
                            time_interval=(a.departure, b.arrival),
                            message="Required clearance gap is violated.",
                            rule="platform_clearance_gap",
                        )
                    )
                    hard_violation_count += 1

    # Check if caller falsely claimed VALID on an incomplete schedule
    is_complete = (
        len(unresolved_train_ids) == 0
        and len(assignments_by_train) == len(trains)
        and len(trains) > 0
    )
    if claimed_validation_status == "VALID" and not is_complete:
        errors.append(
            ValidationErrorItem(
                code="INCOMPLETE_SCHEDULE_CLAIMED_VALID",
                train_ids=list(unresolved_train_ids),
                message="An incomplete timetable with unresolved or missing trains cannot be marked VALID.",
                rule="complete_schedule_required",
            )
        )
        hard_violation_count += 1

    # Determine final independent validation status
    if len(assignments) == 0 and len(trains) > 0:
        if solver_status == "INFEASIBLE":
            status: ValidationStatus = "INFEASIBLE"
        elif solver_status == "UNKNOWN":
            status = "UNKNOWN"
        else:
            status = "INVALID"
    elif hard_violation_count > 0:
        status = "INVALID"
    elif not is_complete:
        status = "PARTIAL"
    else:
        status = "VALID"

    return ValidationRun(
        id=f"val-{uuid.uuid4().hex[:10]}",
        version_id=version_id,
        validation_status=status,
        is_complete=is_complete and (status == "VALID"),
        errors=errors,
        unresolved_train_ids=unresolved_train_ids,
        validated_at=datetime.now(timezone.utc).isoformat(),
    )
