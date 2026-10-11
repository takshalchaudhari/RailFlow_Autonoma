"""Unit tests for the logically independent validator (STEP C)."""

from app.engine.validator import validate_schedule
from app.schemas import (
    DisruptionRecord,
    Platform,
    Train,
    TrainAssignment,
    format_minutes,
)


def _make_assignment(
    train: Train,
    platform_id: str | None = None,
    arrival: int | None = None,
    departure: int | None = None,
    unresolved: bool = False,
) -> TrainAssignment:
    arr = arrival if arrival is not None else train.arrival
    dep = departure if departure is not None else train.departure
    pid = None if unresolved else (platform_id if platform_id is not None else train.platform_id)
    return TrainAssignment(
        train_id=train.id,
        platform_id=pid,
        arrival=arr,
        departure=dep,
        arrival_str=format_minutes(arr),
        departure_str=format_minutes(dep),
        baseline_arrival=train.arrival,
        baseline_departure=train.departure,
        effective_arrival=train.arrival,
        effective_departure=train.departure,
        fixed=train.fixed,
        departed=train.departed,
        unresolved=unresolved,
    )


def _base_scenario():
    platforms = [
        Platform(id="P1", station_id="S1"),
        Platform(id="P2", station_id="S1"),
        Platform(id="P3", station_id="S1"),
    ]
    trains = [
        Train(id="T101", arrival="09:00", departure="09:20", platform_id="P1"),
        Train(id="T102", arrival="09:30", departure="09:50", platform_id="P1"),
    ]
    return platforms, trains


def test_valid_baseline_schedule_passes():
    platforms, trains = _base_scenario()
    assignments = [_make_assignment(t) for t in trains]
    result = validate_schedule(trains, platforms, 10, assignments)
    assert result.validation_status == "VALID"
    assert result.is_complete is True
    assert result.errors == []


def test_overlapping_trains_rejected():
    platforms, trains = _base_scenario()
    # T102 arrives at 09:15 while T101 departs at 09:20 on P1
    assignments = [
        _make_assignment(trains[0], platform_id="P1", arrival=540, departure=560),
        _make_assignment(trains[1], platform_id="P1", arrival=555, departure=575),
    ]
    # Update train[1] baseline so early-arrival doesn't mask overlap test
    trains[1] = Train(id="T102", arrival=555, departure=575, platform_id="P1")
    result = validate_schedule(trains, platforms, 10, assignments)
    assert result.validation_status == "INVALID"
    codes = {e.code for e in result.errors}
    assert "PLATFORM_OVERLAP" in codes


def test_clearance_gap_violation_rejected_with_structured_error():
    platforms, _ = _base_scenario()
    trains = [
        Train(id="T101", arrival="09:00", departure="09:20", platform_id="P1"),
        Train(id="T102", arrival="09:25", departure="09:45", platform_id="P1"),  # Only 5m gap, requires 10m
    ]
    assignments = [_make_assignment(t) for t in trains]
    result = validate_schedule(trains, platforms, 10, assignments)
    assert result.validation_status == "INVALID"
    conflict = next(e for e in result.errors if e.code == "PLATFORM_CONFLICT")
    assert conflict.platform_id == "P1"
    assert conflict.train_ids == ["T101", "T102"]
    assert conflict.required_gap_minutes == 10
    assert conflict.actual_gap_minutes == 5
    assert conflict.message == "Required clearance gap is violated."


def test_reverse_chronological_input_order_clearance_violation_caught():
    platforms, _ = _base_scenario()
    # Train T200 is listed first in input but arrives AFTER T100, and T200 has higher ID
    # Also test when T200 arrives BEFORE T100 on P1
    trains = [
        Train(id="T101", arrival="09:30", departure="09:50", platform_id="P1"),
        Train(id="T102", arrival="09:05", departure="09:25", platform_id="P1"),  # 5m before T101
    ]
    assignments = [_make_assignment(t) for t in trains]
    result = validate_schedule(trains, platforms, 10, assignments)
    assert result.validation_status == "INVALID"
    conflict = next(e for e in result.errors if e.code == "PLATFORM_CONFLICT")
    assert conflict.train_ids == ["T102", "T101"]
    assert conflict.actual_gap_minutes == 5


def test_platform_specific_gap_override_enforced():
    platforms = [
        Platform(id="P1", station_id="S1", min_gap_minutes=15),
        Platform(id="P2", station_id="S1"),
    ]
    trains = [
        Train(id="T101", arrival="09:00", departure="09:20", platform_id="P1"),
        Train(id="T102", arrival="09:30", departure="09:50", platform_id="P1"),  # 10m gap < P1's 15m requirement
    ]
    assignments = [_make_assignment(t) for t in trains]
    result = validate_schedule(trains, platforms, 10, assignments)
    assert result.validation_status == "INVALID"
    conflict = next(e for e in result.errors if e.code == "PLATFORM_CONFLICT")
    assert conflict.required_gap_minutes == 15
    assert conflict.actual_gap_minutes == 10


def test_unknown_platform_rejected():
    platforms, trains = _base_scenario()
    assignments = [
        _make_assignment(trains[0], platform_id="P99"),
        _make_assignment(trains[1], platform_id="P1"),
    ]
    result = validate_schedule(trains, platforms, 10, assignments)
    assert result.validation_status == "INVALID"
    assert any(e.code == "UNKNOWN_PLATFORM" and e.platform_id == "P99" for e in result.errors)


def test_unauthorized_platform_rejected():
    platforms, _ = _base_scenario()
    trains = [
        Train(id="T101", arrival="09:00", departure="09:20", platform_id="P1", allowed_platforms=["P1", "P2"]),
    ]
    assignments = [_make_assignment(trains[0], platform_id="P3")]
    result = validate_schedule(trains, platforms, 10, assignments)
    assert result.validation_status == "INVALID"
    assert any(e.code == "UNAUTHORIZED_PLATFORM" for e in result.errors)


def test_required_platform_violation_rejected():
    platforms, _ = _base_scenario()
    trains = [
        Train(id="T101", arrival="09:00", departure="09:20", platform_id="P1", required_platform="P1"),
    ]
    assignments = [_make_assignment(trains[0], platform_id="P2")]
    result = validate_schedule(trains, platforms, 10, assignments)
    assert result.validation_status == "INVALID"
    assert any(e.code == "REQUIRED_PLATFORM_VIOLATION" for e in result.errors)


def test_closure_overlap_rejected():
    platforms, trains = _base_scenario()
    assignments = [_make_assignment(t) for t in trains]
    closures = [
        DisruptionRecord(
            id="disr-c1",
            type="platform_closure",
            target_id="P1",
            platform_id="P1",
            start=550,  # 09:10
            end=570,    # 09:30 (overlaps T101 [540, 560))
            created_at="2026-10-11T00:00:00Z",
        )
    ]
    result = validate_schedule(trains, platforms, 10, assignments, applied_disruptions=closures)
    assert result.validation_status == "INVALID"
    assert any(e.code == "PLATFORM_CLOSURE_CONFLICT" and "T101" in e.train_ids for e in result.errors)


def test_invalid_times_rejected():
    platforms, trains = _base_scenario()
    assignments = [
        _make_assignment(trains[0], arrival=560, departure=540),  # arrival > departure
        _make_assignment(trains[1]),
    ]
    result = validate_schedule(trains, platforms, 10, assignments)
    assert result.validation_status == "INVALID"
    assert any(e.code == "INVALID_TIME_RANGE" for e in result.errors)


def test_missing_unknown_and_duplicate_trains_rejected():
    platforms, trains = _base_scenario()
    # Missing T102
    res_missing = validate_schedule(trains, platforms, 10, [_make_assignment(trains[0])])
    assert res_missing.validation_status == "INVALID"
    assert any(e.code == "MISSING_TRAIN" and "T102" in e.train_ids for e in res_missing.errors)

    # Unknown train T999
    ghost = Train(id="T999", arrival="10:00", departure="10:20", platform_id="P2")
    res_unknown = validate_schedule(
        trains,
        platforms,
        10,
        [_make_assignment(trains[0]), _make_assignment(trains[1]), _make_assignment(ghost)],
    )
    assert res_unknown.validation_status == "INVALID"
    assert any(e.code == "UNKNOWN_TRAIN" and "T999" in e.train_ids for e in res_unknown.errors)

    # Duplicate train T101
    res_dup = validate_schedule(
        trains,
        platforms,
        10,
        [_make_assignment(trains[0]), _make_assignment(trains[0], platform_id="P2"), _make_assignment(trains[1])],
    )
    assert res_dup.validation_status == "INVALID"
    assert any(e.code == "DUPLICATE_TRAIN_ASSIGNMENT" for e in res_dup.errors)


def test_fixed_and_departed_train_modifications_rejected():
    platforms, _ = _base_scenario()
    t_fixed = Train(id="T101", arrival="09:00", departure="09:20", platform_id="P1", fixed=True)
    t_dep = Train(id="T102", arrival="09:30", departure="09:50", platform_id="P1", departed=True)
    trains = [t_fixed, t_dep]

    # Move fixed train to P2
    res_fixed = validate_schedule(
        trains,
        platforms,
        10,
        [_make_assignment(t_fixed, platform_id="P2"), _make_assignment(t_dep)],
    )
    assert res_fixed.validation_status == "INVALID"
    assert any(e.code == "FIXED_TRAIN_MODIFIED" for e in res_fixed.errors)

    # Retime departed train by +10m
    res_dep = validate_schedule(
        trains,
        platforms,
        10,
        [_make_assignment(t_fixed), _make_assignment(t_dep, arrival=580, departure=600)],
    )
    assert res_dep.validation_status == "INVALID"
    assert any(e.code == "DEPARTED_TRAIN_MODIFIED" for e in res_dep.errors)


def test_dwell_time_changed_and_early_arrival_rejected():
    platforms, trains = _base_scenario()
    # Change dwell time of T101 from 20m to 25m
    res_dwell = validate_schedule(
        trains,
        platforms,
        10,
        [_make_assignment(trains[0], arrival=540, departure=565), _make_assignment(trains[1])],
    )
    assert res_dwell.validation_status == "INVALID"
    assert any(e.code == "DWELL_TIME_CHANGED" for e in res_dwell.errors)

    # Move T101 earlier than baseline (535 < 540)
    res_early = validate_schedule(
        trains,
        platforms,
        10,
        [_make_assignment(trains[0], arrival=535, departure=555), _make_assignment(trains[1])],
    )
    assert res_early.validation_status == "INVALID"
    assert any(e.code == "EARLY_ARRIVAL_VIOLATION" for e in res_early.errors)


def test_incomplete_schedule_marked_partial_and_rejected_if_claimed_valid():
    platforms, trains = _base_scenario()
    assignments = [
        _make_assignment(trains[0]),
        _make_assignment(trains[1], platform_id=None, unresolved=True),
    ]
    res_partial = validate_schedule(trains, platforms, 10, assignments)
    assert res_partial.validation_status == "PARTIAL"
    assert res_partial.is_complete is False
    assert res_partial.unresolved_train_ids == ["T102"]

    # If someone claims a partial schedule is VALID, validator rejects it as INVALID
    res_claimed = validate_schedule(
        trains,
        platforms,
        10,
        assignments,
        claimed_validation_status="VALID",
    )
    assert res_claimed.validation_status == "INVALID"
    assert res_claimed.is_complete is False
    assert any(e.code == "INCOMPLETE_SCHEDULE_CLAIMED_VALID" for e in res_claimed.errors)


def test_malformed_applied_disruptions_caught_by_validator():
    """Regression test: validator independently flags unknown trains, immutable train delays, and bad closures in applied_disruptions."""
    platforms, _ = _base_scenario()
    trains = [
        Train(id="T101", arrival="09:00", departure="09:20", platform_id="P1", fixed=True),
        Train(id="T102", arrival="09:30", departure="09:50", platform_id="P1"),
    ]
    assignments = [_make_assignment(t) for t in trains]
    bad_disruptions = [
        DisruptionRecord(
            id="d-unknown-train",
            type="train_delay",
            target_id="T999",
            train_id="T999",
            delay_minutes=15,
            created_at="2026-10-11T00:00:00Z",
        ),
        DisruptionRecord(
            id="d-fixed-train",
            type="train_delay",
            target_id="T101",
            train_id="T101",
            delay_minutes=15,
            created_at="2026-10-11T00:00:00Z",
        ),
        DisruptionRecord(
            id="d-bad-closure",
            type="platform_closure",
            target_id="P1",
            platform_id="P1",
            start=600,
            end=550,
            created_at="2026-10-11T00:00:00Z",
        ),
    ]
    res = validate_schedule(trains, platforms, 10, assignments, applied_disruptions=bad_disruptions)
    assert res.validation_status == "INVALID"
    codes = {e.code for e in res.errors}
    assert "UNKNOWN_TRAIN_IN_DISRUPTION" in codes
    assert "IMMUTABLE_TRAIN_DELAYED" in codes
    assert "INVALID_CLOSURE_RANGE" in codes
    # Ensure fixed train T101 did not falsely get flagged for EARLY_ARRIVAL_VIOLATION
    assert "EARLY_ARRIVAL_VIOLATION" not in codes

