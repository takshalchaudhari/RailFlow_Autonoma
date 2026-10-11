"""Unit tests for the OR-Tools CP-SAT deterministic scheduler (STEP D)."""

from ortools.sat.python import cp_model

from app.engine.disruptions import compute_effective_state_from_records, validate_and_apply_disruptions
from app.engine.scheduler import solve_schedule
from app.engine.validator import validate_schedule
from app.schemas import DisruptionInput, Platform, Train


def _demo_scenario():
    platforms = [
        Platform(id="P1", station_id="S1"),
        Platform(id="P2", station_id="S1"),
        Platform(id="P3", station_id="S1"),
    ]
    trains = [
        Train(id="T101", arrival="09:00", departure="09:20", platform_id="P1"),
        Train(id="T102", arrival="09:30", departure="09:50", platform_id="P1"),
        Train(id="T103", arrival="09:25", departure="09:45", platform_id="P2"),
        Train(id="T104", arrival="09:40", departure="10:00", platform_id="P3"),
    ]
    return platforms, trains


def test_valid_baseline_scheduled_with_zero_changes():
    platforms, trains = _demo_scenario()
    state = compute_effective_state_from_records(trains, platforms, [])
    result = solve_schedule(trains, platforms, 10, state)

    assert result.solver_status == "OPTIMAL"
    assert result.unresolved_trains == []
    assert result.objective_metrics.total_additional_delay_minutes == 0
    assert result.objective_metrics.platform_changes_count == 0
    assert result.changes == []

    val = validate_schedule(trains, platforms, 10, result.assignments)
    assert val.validation_status == "VALID"


def test_both_chronological_orders_on_same_platform_verified():
    """Verify pairwise sequencing works whether A precedes B or B precedes A regardless of input/ID order."""
    platforms = [Platform(id="P1", station_id="S1")]

    # Case 1: T_LATE listed first in input array, T_EARLY listed second
    trains_order_1 = [
        Train(id="T900", arrival="10:00", departure="10:20", platform_id="P1"),
        Train(id="T100", arrival="09:00", departure="09:20", platform_id="P1"),
    ]
    # Delay T100 by 35 minutes -> effective [09:35, 09:55). With 10m gap, T900 must be pushed to 10:05.
    state_1 = validate_and_apply_disruptions(
        trains=trains_order_1,
        platforms=platforms,
        baseline_disruptions=[],
        new_disruptions=[DisruptionInput(type="train_delay", train_id="T100", delay_minutes=35)],
    )
    res_1 = solve_schedule(trains_order_1, platforms, 10, state_1)
    assert res_1.solver_status == "OPTIMAL"
    by_id_1 = {a.train_id: a for a in res_1.assignments}
    assert by_id_1["T100"].arrival == 575 and by_id_1["T100"].departure == 595
    assert by_id_1["T900"].arrival == 605 and by_id_1["T900"].departure == 625
    assert validate_schedule(
        trains_order_1, platforms, 10, res_1.assignments, state_1.cumulative_disruptions
    ).validation_status == "VALID"

    # Case 2: T100 delayed by 75m -> effective [10:15, 10:35), so T900 [10:00, 10:20) precedes T100!
    # T900 stays at [10:00, 10:20) and T100 is held +15m to [10:30, 10:50) (10m gap after T900's 10:20 departure).
    state_2 = validate_and_apply_disruptions(
        trains=trains_order_1,
        platforms=platforms,
        baseline_disruptions=[],
        new_disruptions=[DisruptionInput(type="train_delay", train_id="T100", delay_minutes=75)],
    )
    res_2 = solve_schedule(trains_order_1, platforms, 10, state_2)
    assert res_2.solver_status == "OPTIMAL"
    by_id_2 = {a.train_id: a for a in res_2.assignments}
    assert by_id_2["T900"].arrival == 600 and by_id_2["T900"].departure == 620
    assert by_id_2["T100"].arrival == 630 and by_id_2["T100"].departure == 650
    assert validate_schedule(
        trains_order_1, platforms, 10, res_2.assignments, state_2.cumulative_disruptions
    ).validation_status == "VALID"


def test_platform_closure_forces_reassignment_and_respects_restrictions():
    platforms, trains = _demo_scenario()
    # Restrict T103 to allowed_platforms=["P2", "P3"]
    trains[2] = Train(
        id="T103",
        arrival="09:25",
        departure="09:45",
        platform_id="P2",
        allowed_platforms=["P2", "P3"],
    )
    state = validate_and_apply_disruptions(
        trains=trains,
        platforms=platforms,
        baseline_disruptions=[],
        new_disruptions=[
            DisruptionInput(type="platform_closure", platform_id="P2", start="09:20", end="10:00")
        ],
    )
    res = solve_schedule(trains, platforms, 10, state)
    assert res.solver_status == "OPTIMAL"
    by_id = {a.train_id: a for a in res.assignments}
    # T103 cannot use P2 (closed) and cannot use P1 (not in allowed_platforms), so must use P3
    assert by_id["T103"].platform_id == "P3"
    val = validate_schedule(trains, platforms, 10, res.assignments, state.cumulative_disruptions)
    assert val.validation_status == "VALID"


def test_fixed_and_departed_trains_remain_unchanged():
    platforms = [
        Platform(id="P1", station_id="S1"),
        Platform(id="P2", station_id="S1"),
    ]
    trains = [
        Train(id="T_DEP", arrival="08:50", departure="09:10", platform_id="P1", departed=True),
        Train(id="T_FIX", arrival="09:20", departure="09:40", platform_id="P1", fixed=True),
        Train(id="T_FLEX", arrival="09:00", departure="09:20", platform_id="P2"),
    ]
    # Delay T_FLEX by 15m and close P2 from 09:10 to 09:40 -> T_FLEX must move to P1 after T_FIX (09:40 + 10m = 09:50)
    # T_DEP and T_FIX must not move or retime!
    state = validate_and_apply_disruptions(
        trains=trains,
        platforms=platforms,
        baseline_disruptions=[],
        new_disruptions=[
            DisruptionInput(type="train_delay", train_id="T_FLEX", delay_minutes=15),
            DisruptionInput(type="platform_closure", platform_id="P2", start="09:10", end="09:40"),
        ],
    )
    res = solve_schedule(trains, platforms, 10, state)
    assert res.solver_status == "OPTIMAL"
    by_id = {a.train_id: a for a in res.assignments}

    assert by_id["T_DEP"].platform_id == "P1"
    assert by_id["T_DEP"].arrival == 530 and by_id["T_DEP"].departure == 550
    assert by_id["T_FIX"].platform_id == "P1"
    assert by_id["T_FIX"].arrival == 560 and by_id["T_FIX"].departure == 580

    val = validate_schedule(trains, platforms, 10, res.assignments, state.cumulative_disruptions)
    assert val.validation_status == "VALID"


def test_demonstration_scenario_coordinated_replanning():
    """Verify Section 16 demonstration scenario produces an optimal, independently valid schedule."""
    platforms, trains = _demo_scenario()
    state = validate_and_apply_disruptions(
        trains=trains,
        platforms=platforms,
        baseline_disruptions=[],
        new_disruptions=[
            DisruptionInput(type="train_delay", train_id="T101", delay_minutes=20),
            DisruptionInput(type="platform_closure", platform_id="P2", start="09:20", end="10:00"),
        ],
    )
    res = solve_schedule(trains, platforms, 10, state)
    assert res.solver_status == "OPTIMAL"
    assert res.unresolved_trains == []

    val = validate_schedule(trains, platforms, 10, res.assignments, state.cumulative_disruptions)
    assert val.validation_status == "VALID"
    assert val.errors == []

    by_id = {a.train_id: a for a in res.assignments}
    # T103 cannot remain on P2 during [09:20, 10:00) without waiting until 10:00
    assert by_id["T103"].platform_id != "P2" or by_id["T103"].arrival >= 600
    # Every changed train has a recorded ChangeRecord with a non-empty reason
    assert len(res.changes) >= 2
    for ch in res.changes:
        assert ch.reason.strip() != ""


def test_lexicographic_priority_ordering():
    """Verify Priority 3 (min delay) strictly beats Priority 4 (min platform changes),
    and Priority 5 prefers moving already-disrupted trains over unaffected trains."""
    platforms = [
        Platform(id="P1", station_id="S1"),
        Platform(id="P2", station_id="S1"),
    ]
    # T101 and T102 both on P1. T101 delayed by 20m -> [09:20, 09:40), conflicting with T102 [09:30, 09:50).
    # P2 is completely free.
    # Moving one train to P2 incurs 0 additional delay (1 platform change).
    # Keeping both on P1 would incur +20m additional delay (0 platform changes).
    # Furthermore, T101 is the disrupted train while T102 is unaffected:
    # Stage A3 (minimize unaffected train perturbations) must keep unaffected T102 on P1 at 09:30-09:50
    # and move the already-disrupted T101 to P2 at 09:20-09:40!
    trains = [
        Train(id="T101", arrival="09:00", departure="09:20", platform_id="P1"),
        Train(id="T102", arrival="09:30", departure="09:50", platform_id="P1"),
    ]
    state = validate_and_apply_disruptions(
        trains=trains,
        platforms=platforms,
        baseline_disruptions=[],
        new_disruptions=[DisruptionInput(type="train_delay", train_id="T101", delay_minutes=20)],
    )
    res = solve_schedule(trains, platforms, 10, state)
    assert res.solver_status == "OPTIMAL"
    assert res.objective_metrics.total_additional_delay_minutes == 0
    assert res.objective_metrics.platform_changes_count == 1
    assert res.objective_metrics.unaffected_train_changes_count == 0

    by_id = {a.train_id: a for a in res.assignments}
    # Disrupted T101 moves to P2 with 0 additional delay; unaffected T102 is completely untouched on P1!
    assert by_id["T101"].platform_id == "P2"
    assert by_id["T101"].arrival == 560 and by_id["T101"].departure == 580
    assert by_id["T102"].platform_id == "P1"
    assert by_id["T102"].arrival == 570 and by_id["T102"].departure == 590


def test_impossible_scenario_reported_infeasible_and_never_valid():
    """Section 16 Impossible Scenario: fixed train on a closed platform with no permitted alternative."""
    platforms = [
        Platform(id="P1", station_id="S1"),
        Platform(id="P2", station_id="S1"),
    ]
    trains = [
        Train(
            id="T_FIXED",
            arrival="09:00",
            departure="09:20",
            platform_id="P1",
            required_platform="P1",
            fixed=True,
        ),
        Train(id="T_NORMAL", arrival="09:30", departure="09:50", platform_id="P2"),
    ]
    state = validate_and_apply_disruptions(
        trains=trains,
        platforms=platforms,
        baseline_disruptions=[],
        new_disruptions=[
            DisruptionInput(type="platform_closure", platform_id="P1", start="08:50", end="09:30")
        ],
    )
    res = solve_schedule(trains, platforms, 10, state, allow_partial_diagnostic=True)
    assert res.solver_status == "INFEASIBLE"
    assert "T_FIXED" in res.unresolved_trains
    assert res.objective_metrics.is_diagnostic_partial is True

    # Independent validator must reject any schedule where a fixed train is unresolved
    val = validate_schedule(
        trains,
        platforms,
        10,
        res.assignments,
        state.cumulative_disruptions,
        solver_status=res.solver_status,
    )
    assert val.validation_status in ("INVALID", "PARTIAL", "INFEASIBLE")
    assert val.validation_status != "VALID"
    assert val.is_complete is False


def test_solver_timeout_unknown_not_reported_as_infeasible():
    """Verify that if CP-SAT returns UNKNOWN, solver_status is UNKNOWN, assignments are empty,
    and partial diagnostic is NOT executed."""
    platforms, trains = _demo_scenario()
    state = validate_and_apply_disruptions(
        trains=trains,
        platforms=platforms,
        baseline_disruptions=[],
        new_disruptions=[DisruptionInput(type="train_delay", train_id="T101", delay_minutes=20)],
    )

    call_count = 0

    def _simulate_timeout(solver: cp_model.CpSolver, model: cp_model.CpModel) -> int:
        nonlocal call_count
        call_count += 1
        return cp_model.UNKNOWN

    res = solve_schedule(
        trains=trains,
        platforms=platforms,
        default_min_gap_minutes=10,
        effective_state=state,
        allow_partial_diagnostic=True,
        custom_solve_hook=_simulate_timeout,
    )

    assert res.solver_status == "UNKNOWN"
    assert res.assignments == []
    assert res.objective_metrics.is_diagnostic_partial is False
    # Partial diagnostic must NOT have been invoked when Stage A1 returned UNKNOWN
    assert call_count == 1

    val = validate_schedule(
        trains,
        platforms,
        10,
        res.assignments,
        state.cumulative_disruptions,
        solver_status=res.solver_status,
    )
    assert val.validation_status == "UNKNOWN"
    assert val.is_complete is False
