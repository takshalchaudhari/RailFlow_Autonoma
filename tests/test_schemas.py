"""Unit tests for domain schemas and time representation (STEP B)."""

import pytest
from pydantic import ValidationError

from app.schemas import (
    DisruptionInput,
    Platform,
    ScenarioCreateRequest,
    Station,
    Train,
    format_minutes,
    parse_time_input,
)


def test_time_parsing_and_formatting():
    assert parse_time_input("09:00") == 540
    assert parse_time_input("09:20") == 560
    assert parse_time_input("10:00") == 600
    assert parse_time_input("00:00") == 0
    assert parse_time_input("24:00") == 1440
    assert parse_time_input(540) == 540
    assert format_minutes(540) == "09:00"
    assert format_minutes(560) == "09:20"
    assert format_minutes(1440) == "24:00"


@pytest.mark.parametrize("bad_time", ["9:00", "25:00", "09:60", "-01:00", -5, 1441, True, "noon"])
def test_invalid_time_inputs_rejected(bad_time):
    with pytest.raises(ValueError):
        parse_time_input(bad_time)


def test_duplicate_train_ids_rejected():
    with pytest.raises(ValidationError, match="Duplicate train IDs"):
        ScenarioCreateRequest(
            station=Station(id="S1", name="Central"),
            platforms=[Platform(id="P1")],
            trains=[
                Train(id="T101", arrival="09:00", departure="09:20", platform_id="P1"),
                Train(id="T101", arrival="09:30", departure="09:50", platform_id="P1"),
            ],
        )


def test_duplicate_platform_ids_rejected():
    with pytest.raises(ValidationError, match="Duplicate platform IDs"):
        ScenarioCreateRequest(
            station=Station(id="S1", name="Central"),
            platforms=[Platform(id="P1"), Platform(id="P1")],
            trains=[
                Train(id="T101", arrival="09:00", departure="09:20", platform_id="P1"),
            ],
        )


def test_unknown_platform_references_rejected():
    # Unknown initial platform_id
    with pytest.raises(ValidationError, match="unknown initial platform_id"):
        ScenarioCreateRequest(
            station=Station(id="S1", name="Central"),
            platforms=[Platform(id="P1")],
            trains=[
                Train(id="T101", arrival="09:00", departure="09:20", platform_id="P99"),
            ],
        )
    # Unknown required_platform
    with pytest.raises(ValidationError, match="unknown required_platform"):
        ScenarioCreateRequest(
            station=Station(id="S1", name="Central"),
            platforms=[Platform(id="P1")],
            trains=[
                Train(id="T101", arrival="09:00", departure="09:20", required_platform="P99"),
            ],
        )
    # Unknown allowed_platforms entry
    with pytest.raises(ValidationError, match="allowed_platforms contains unknown platform ID"):
        ScenarioCreateRequest(
            station=Station(id="S1", name="Central"),
            platforms=[Platform(id="P1")],
            trains=[
                Train(id="T101", arrival="09:00", departure="09:20", allowed_platforms=["P1", "P99"]),
            ],
        )


def test_invalid_arrival_departure_ordering_rejected():
    with pytest.raises(ValidationError, match="must strictly precede departure"):
        Train(id="T101", arrival="09:20", departure="09:20", platform_id="P1")
    with pytest.raises(ValidationError, match="must strictly precede departure"):
        Train(id="T101", arrival="09:30", departure="09:20", platform_id="P1")


def test_empty_allowed_platforms_and_contradictions_rejected():
    # Empty allowed_platforms list is explicitly forbidden
    with pytest.raises(ValidationError, match="allowed_platforms cannot be an empty list"):
        Train(id="T101", arrival="09:00", departure="09:20", allowed_platforms=[])

    # required_platform not in allowed_platforms
    with pytest.raises(ValidationError, match="required_platform 'P2' is not present in allowed_platforms"):
        Train(
            id="T101",
            arrival="09:00",
            departure="09:20",
            allowed_platforms=["P1", "P3"],
            required_platform="P2",
        )

    # initial platform_id conflicts with required_platform
    with pytest.raises(ValidationError, match="conflicts with required_platform"):
        Train(
            id="T101",
            arrival="09:00",
            departure="09:20",
            platform_id="P1",
            required_platform="P2",
        )


def test_fixed_or_departed_train_without_platform_rejected():
    with pytest.raises(ValidationError, match="fixed or departed trains must have an initial platform_id"):
        Train(id="T101", arrival="09:00", departure="09:20", fixed=True, platform_id=None)

    with pytest.raises(ValidationError, match="fixed or departed trains must have an initial platform_id"):
        Train(id="T102", arrival="09:00", departure="09:20", departed=True, platform_id=None)


def test_disruption_validation_rules():
    # Invalid closure interval (start >= end)
    with pytest.raises(ValidationError, match="must strictly precede 'end'"):
        DisruptionInput(type="platform_closure", platform_id="P1", start="10:00", end="09:30")

    with pytest.raises(ValidationError, match="must strictly precede 'end'"):
        DisruptionInput(type="platform_closure", platform_id="P1", start="10:00", end="10:00")

    # Missing delay fields
    with pytest.raises(ValidationError, match="requires 'delay_minutes'"):
        DisruptionInput(type="train_delay", train_id="T101")

    with pytest.raises(ValidationError, match="positive integer"):
        DisruptionInput(type="train_delay", train_id="T101", delay_minutes=0)

    # Train delay attempting to specify platform_id
    with pytest.raises(ValidationError, match="cannot specify 'platform_id'"):
        DisruptionInput(type="train_delay", train_id="T101", delay_minutes=15, platform_id="P2")

    # Unsupported extra event fields rejected
    with pytest.raises(ValidationError):
        DisruptionInput(
            type="train_delay",
            train_id="T101",
            delay_minutes=15,
            assigned_platform="P2",  # type: ignore[call-arg]
        )
