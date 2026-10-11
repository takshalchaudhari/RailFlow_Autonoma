"""Unit and integration tests for Phase 2 AI middleware, offline parser, explainer, and safety boundaries (STEP I)."""

import ast
from pathlib import Path
from fastapi.testclient import TestClient
import pytest

from app.ai.explainer import explain_schedule_version
from app.ai.fallback_parser import ForbiddenAIParsingError
from app.ai.parser import parse_natural_language_disruption, validate_ai_proposal_against_scenario
from app.main import app
from app.schemas import Platform, Train


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_file = tmp_path / "test_ai_railflow.db"
    monkeypatch.setenv("RAILFLOW_DB_PATH", str(db_file))
    monkeypatch.setenv("RAILFLOW_LLM_PROVIDER", "none")
    with TestClient(app) as test_client:
        yield test_client


def _scenario_entities():
    platforms = [
        Platform(id="P1", station_id="S1"),
        Platform(id="P2", station_id="S1"),
        Platform(id="P3", station_id="S1"),
    ]
    trains = [
        Train(id="T101", arrival="09:00", departure="09:20", platform_id="P1"),
        Train(id="T102", arrival="09:30", departure="09:50", platform_id="P1"),
        Train(id="T103", arrival="09:25", departure="09:45", platform_id="P2"),
        Train(id="T104", arrival="09:40", departure="10:00", platform_id="P3", fixed=True),
    ]
    return platforms, trains


def test_architectural_boundary_ai_modules_cannot_import_scheduler_or_validator():
    """Verify via AST inspection that app/ai/* modules have zero imports from scheduler, validator, or DB writes."""
    ai_dir = Path(__file__).resolve().parent.parent / "app" / "ai"
    forbidden_modules = {
        "app.engine.scheduler",
        "app.engine.validator",
        "app.database",
        "app.services.scenario_service",
        "app.services.revision_service",
        "ortools",
    }
    for py_file in ai_dir.glob("*.py"):
        tree = ast.parse(py_file.read_text(encoding="utf-8"), filename=str(py_file))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    for bad in forbidden_modules:
                        assert not alias.name.startswith(bad), (
                            f"{py_file.name} imports forbidden module '{alias.name}'"
                        )
            elif isinstance(node, ast.ImportFrom) and node.module:
                for bad in forbidden_modules:
                    assert not node.module.startswith(bad), (
                        f"{py_file.name} imports from forbidden module '{node.module}'"
                    )


def test_offline_parsing_single_and_compound_commands():
    platforms, trains = _scenario_entities()

    # Single delay
    res1 = parse_natural_language_disruption("Delay train T103 by 15 minutes.", trains, platforms)
    assert res1.parser_mode == "deterministic_fallback"
    assert res1.requires_confirmation is True
    assert res1.applied is False
    assert res1.ambiguous is False
    assert len(res1.events) == 1
    assert res1.events[0].model_dump() == {
        "type": "train_delay",
        "train_id": "T103",
        "delay_minutes": 15,
    }

    # Single closure
    res2 = parse_natural_language_disruption("Close platform P2 from 09:30 to 10:20.", trains, platforms)
    assert res2.ambiguous is False
    assert len(res2.events) == 1
    assert res2.events[0].model_dump() == {
        "type": "platform_closure",
        "platform_id": "P2",
        "start_time": "09:30",
        "end_time": "10:20",
    }

    # Compound delay + closure from Section 13 specification
    res3 = parse_natural_language_disruption(
        "Train T103 is delayed by 20 minutes and platform P2 is closed from 09:30 to 10:20.",
        trains,
        platforms,
    )
    assert res3.ambiguous is False
    assert res3.requires_confirmation is True
    assert [e.model_dump() for e in res3.events] == [
        {"type": "train_delay", "train_id": "T103", "delay_minutes": 20},
        {"type": "platform_closure", "platform_id": "P2", "start_time": "09:30", "end_time": "10:20"},
    ]


def test_unknown_ids_and_immutable_trains_rejected_by_parser():
    platforms, trains = _scenario_entities()

    with pytest.raises(ForbiddenAIParsingError) as exc_train:
        parse_natural_language_disruption("Delay train T999 by 20 minutes.", trains, platforms)
    assert exc_train.value.code == "UNKNOWN_TRAIN"

    with pytest.raises(ForbiddenAIParsingError) as exc_plat:
        parse_natural_language_disruption("Close platform P99 from 09:00 to 10:00.", trains, platforms)
    assert exc_plat.value.code == "UNKNOWN_PLATFORM"

    # T104 is fixed
    with pytest.raises(ForbiddenAIParsingError) as exc_fixed:
        parse_natural_language_disruption("Delay train T104 by 15 minutes.", trains, platforms)
    assert exc_fixed.value.code == "FIXED_TRAIN_IMMUTABLE"


def test_ambiguous_input_requires_clarification():
    platforms, trains = _scenario_entities()

    # Missing delay duration
    res_no_mins = parse_natural_language_disruption("Train T101 is delayed.", trains, platforms)
    assert res_no_mins.ambiguous is True
    assert len(res_no_mins.clarification_needed) >= 1
    assert res_no_mins.events == []

    # Missing closure end time
    res_no_times = parse_natural_language_disruption("Close platform P2.", trains, platforms)
    assert res_no_times.ambiguous is True
    assert len(res_no_times.clarification_needed) >= 1
    assert res_no_times.events == []


def test_ai_output_containing_platform_assignments_rejected():
    platforms, trains = _scenario_entities()

    # 1. Natural language attempting to assign platform
    with pytest.raises(ForbiddenAIParsingError) as exc_nl:
        parse_natural_language_disruption("Assign train T101 to platform P3.", trains, platforms)
    assert exc_nl.value.code == "AI_PLATFORM_ASSIGNMENT_FORBIDDEN"

    # 2. Raw LLM JSON attempting to include platform_id inside a train_delay event
    with pytest.raises(ForbiddenAIParsingError) as exc_ev:
        validate_ai_proposal_against_scenario(
            raw_payload={
                "events": [
                    {
                        "type": "train_delay",
                        "train_id": "T101",
                        "delay_minutes": 20,
                        "platform_id": "P3",
                    }
                ],
                "requires_confirmation": True,
            },
            trains=trains,
            platforms=platforms,
        )
    assert exc_ev.value.code == "AI_PLATFORM_ASSIGNMENT_FORBIDDEN"

    # 3. Raw LLM JSON attempting to return top-level assignments or set requires_confirmation=False
    with pytest.raises(ForbiddenAIParsingError) as exc_top:
        validate_ai_proposal_against_scenario(
            raw_payload={
                "events": [{"type": "train_delay", "train_id": "T101", "delay_minutes": 20}],
                "assignments": [{"train_id": "T101", "platform_id": "P3"}],
                "requires_confirmation": True,
            },
            trains=trains,
            platforms=platforms,
        )
    assert exc_top.value.code == "AI_PLATFORM_ASSIGNMENT_FORBIDDEN"

    with pytest.raises(ForbiddenAIParsingError) as exc_conf:
        validate_ai_proposal_against_scenario(
            raw_payload={
                "events": [{"type": "train_delay", "train_id": "T101", "delay_minutes": 20}],
                "requires_confirmation": False,
            },
            trains=trains,
            platforms=platforms,
        )
    assert exc_conf.value.code == "CONFIRMATION_BYPASS_FORBIDDEN"


def test_parse_endpoint_does_not_apply_disruptions_and_explainer_is_read_only(client: TestClient):
    scen = client.post("/api/scenarios/demo?preset=standard").json()
    scen_id = scen["id"]
    v1_id = scen["active_version_id"]

    # Call /disruptions/parse
    parse_res = client.post(
        f"/api/scenarios/{scen_id}/disruptions/parse",
        json={
            "text": "Delay train T101 by 20 minutes and close platform P2 from 09:20 to 10:00.",
        },
    )
    assert parse_res.status_code == 200
    parsed = parse_res.json()
    assert parsed["requires_confirmation"] is True
    assert parsed["applied"] is False
    assert len(parsed["normalized_disruptions"]) == 2

    # Verify parsing did NOT create a new schedule revision
    versions_before = client.get(f"/api/scenarios/{scen_id}/schedule-versions").json()
    assert len(versions_before) == 1

    # Now operator confirms and calls /replan with the normalized disruptions
    replan_res = client.post(
        f"/api/scenarios/{scen_id}/replan",
        json={
            "confirmed": True,
            "baseline_version_id": v1_id,
            "disruptions": parsed["normalized_disruptions"],
        },
    )
    assert replan_res.status_code == 201
    v2 = replan_res.json()

    # Call /explain on v2 and verify it cannot mutate v2 and grounds explanations in recorded data
    explain_res = client.get(f"/api/schedule-versions/{v2['id']}/explain")
    assert explain_res.status_code == 200
    exp = explain_res.json()
    assert exp["read_only_verified"] is True
    assert exp["solver_status"] == "OPTIMAL"
    assert exp["validation_status"] == "VALID"
    assert len(exp["change_explanations"]) >= 2

    v2_after_explain = client.get(f"/api/schedule-versions/{v2['id']}").json()
    assert v2_after_explain == v2


def test_explainer_reports_unavailable_reason_when_change_unrecorded():
    """Verify explainer never invents causal claims when a change has no recorded reason."""
    from app.schemas import ScheduleVersion, TrainAssignment

    v1 = ScheduleVersion(
        id="ver-1",
        scenario_id="scen-1",
        version_number=1,
        parent_version_id=None,
        solver_status="BASELINE",
        validation_status="VALID",
        is_complete=True,
        created_at="2026-10-11T00:00:00Z",
        assignments=[
            TrainAssignment(
                train_id="T101",
                platform_id="P1",
                arrival=540,
                departure=560,
                arrival_str="09:00",
                departure_str="09:20",
                baseline_arrival=540,
                baseline_departure=560,
                effective_arrival=540,
                effective_departure=560,
            )
        ],
        changes=[],
        applied_disruptions=[],
        validation_findings=[],
    )
    # v2 moved T101 to P2 but has an empty changes list (no recorded reason)
    v2 = v1.model_copy(
        update={
            "id": "ver-2",
            "version_number": 2,
            "parent_version_id": "ver-1",
            "assignments": [
                v1.assignments[0].model_copy(update={"platform_id": "P2"})
            ],
            "changes": [],
        },
        deep=True,
    )
    explanation = explain_schedule_version(v2, v1)
    assert any(
        "specific causal reason is unavailable" in line
        for line in explanation.change_explanations
    )
