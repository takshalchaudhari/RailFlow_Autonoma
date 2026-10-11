"""Unit tests for disruption validation and effective baseline calculation (STEP E)."""

import pytest

from app.engine.disruptions import DisruptionValidationError, validate_and_apply_disruptions
from app.schemas import DisruptionInput, Platform, Train


def _sample_scenario():
    platforms = [
        Platform(id="P1", station_id="S1"),
        Platform(id="P2", station_id="S1"),
    ]
    trains = [
        Train(id="T101", arrival="09:00", departure="09:20", platform_id="P1"),
        Train(id="T102", arrival="09:30", departure="09:50", platform_id="P2", fixed=True),
        Train(id="T103", arrival="08:00", departure="08:20", platform_id="P1", departed=True),
    ]
    return platforms, trains


def test_normal_delay_shifts_arrival_and_departure_preserving_dwell():
    platforms, trains = _sample_scenario()
    orig_arrival = trains[0].arrival
    orig_departure = trains[0].departure

    state = validate_and_apply_disruptions(
        trains=trains,
        platforms=platforms,
        baseline_disruptions=[],
        new_disruptions=[DisruptionInput(type="train_delay", train_id="T101", delay_minutes=20)],
    )

    spec = state.effective_trains["T101"]
    assert spec.effective_arrival == 560  # 09:20
    assert spec.effective_departure == 580  # 09:40
    assert spec.dwell_minutes == 20
    assert "T101" in state.directly_affected_train_ids
    # Ensure original train object was not mutated
    assert trains[0].arrival == orig_arrival
    assert trains[0].departure == orig_departure


def test_unknown_train_and_unknown_platform_rejected():
    platforms, trains = _sample_scenario()

    with pytest.raises(DisruptionValidationError) as exc_train:
        validate_and_apply_disruptions(
            trains=trains,
            platforms=platforms,
            baseline_disruptions=[],
            new_disruptions=[DisruptionInput(type="train_delay", train_id="T999", delay_minutes=15)],
        )
    assert exc_train.value.code == "UNKNOWN_TRAIN"

    with pytest.raises(DisruptionValidationError) as exc_plat:
        validate_and_apply_disruptions(
            trains=trains,
            platforms=platforms,
            baseline_disruptions=[],
            new_disruptions=[
                DisruptionInput(type="platform_closure", platform_id="P99", start="09:00", end="10:00")
            ],
        )
    assert exc_plat.value.code == "UNKNOWN_PLATFORM"


def test_fixed_or_departed_trains_cannot_be_retimed():
    platforms, trains = _sample_scenario()

    with pytest.raises(DisruptionValidationError) as exc_fixed:
        validate_and_apply_disruptions(
            trains=trains,
            platforms=platforms,
            baseline_disruptions=[],
            new_disruptions=[DisruptionInput(type="train_delay", train_id="T102", delay_minutes=10)],
        )
    assert exc_fixed.value.code == "FIXED_TRAIN_IMMUTABLE"

    with pytest.raises(DisruptionValidationError) as exc_dep:
        validate_and_apply_disruptions(
            trains=trains,
            platforms=platforms,
            baseline_disruptions=[],
            new_disruptions=[DisruptionInput(type="train_delay", train_id="T103", delay_minutes=10)],
        )
    assert exc_dep.value.code == "DEPARTED_TRAIN_IMMUTABLE"


def test_batch_validation_is_atomic():
    platforms, trains = _sample_scenario()
    # Valid first event + invalid second event must reject the whole batch
    with pytest.raises(DisruptionValidationError) as exc_info:
        validate_and_apply_disruptions(
            trains=trains,
            platforms=platforms,
            baseline_disruptions=[],
            new_disruptions=[
                DisruptionInput(type="train_delay", train_id="T101", delay_minutes=15),
                DisruptionInput(type="train_delay", train_id="T102", delay_minutes=10),  # T102 is fixed
            ],
        )
    assert exc_info.value.code == "FIXED_TRAIN_IMMUTABLE"


def test_duplicate_disruption_reapplication_prevented():
    platforms, trains = _sample_scenario()
    first_state = validate_and_apply_disruptions(
        trains=trains,
        platforms=platforms,
        baseline_disruptions=[],
        new_disruptions=[
            DisruptionInput(id="d-101", type="train_delay", train_id="T101", delay_minutes=20)
        ],
    )

    # Attempting to re-apply the same disruption (either by ID or by semantic signature) on top of first_state
    with pytest.raises(DisruptionValidationError) as exc_dup_sig:
        validate_and_apply_disruptions(
            trains=trains,
            platforms=platforms,
            baseline_disruptions=first_state.cumulative_disruptions,
            new_disruptions=[DisruptionInput(type="train_delay", train_id="T101", delay_minutes=20)],
        )
    assert exc_dup_sig.value.code == "DUPLICATE_DISRUPTION"

    with pytest.raises(DisruptionValidationError) as exc_dup_id:
        validate_and_apply_disruptions(
            trains=trains,
            platforms=platforms,
            baseline_disruptions=first_state.cumulative_disruptions,
            new_disruptions=[
                DisruptionInput(id="d-101", type="platform_closure", platform_id="P1", start="11:00", end="12:00")
            ],
        )
    assert exc_dup_id.value.code == "DUPLICATE_DISRUPTION"


def test_delay_exceeding_service_horizon_rejected():
    platforms, trains = _sample_scenario()
    with pytest.raises(DisruptionValidationError) as exc_horizon:
        validate_and_apply_disruptions(
            trains=trains,
            platforms=platforms,
            baseline_disruptions=[],
            new_disruptions=[DisruptionInput(type="train_delay", train_id="T101", delay_minutes=900)],
        )
    assert exc_horizon.value.code == "HORIZON_EXCEEDED"
