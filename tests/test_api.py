"""Integration tests for FastAPI REST endpoints, SQLite persistence, and revision safety (STEP G & H)."""

import os
import sqlite3
from fastapi.testclient import TestClient
import pytest

from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_file = tmp_path / "test_railflow.db"
    monkeypatch.setenv("RAILFLOW_DB_PATH", str(db_file))
    with TestClient(app) as test_client:
        yield test_client


def test_health_endpoint(client: TestClient):
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert data["ai_platform_assignment_forbidden"] is True


def test_create_and_read_demo_scenario(client: TestClient):
    res = client.post("/api/scenarios/demo?preset=standard&scenario_id=demo-1")
    assert res.status_code == 201
    scen = res.json()
    assert scen["id"] == "demo-1"
    assert len(scen["platforms"]) == 3
    assert len(scen["trains"]) == 4
    assert scen["latest_version_number"] == 1
    assert scen["active_schedule_version"]["validation_status"] == "VALID"
    assert scen["active_schedule_version"]["is_complete"] is True

    get_res = client.get("/api/scenarios/demo-1")
    assert get_res.status_code == 200
    assert get_res.json()["active_version_id"] == scen["active_version_id"]


def test_unknown_resources_return_404(client: TestClient):
    assert client.get("/api/scenarios/nonexistent").status_code == 404
    assert client.get("/api/schedule-versions/ver-nonexistent").status_code == 404
    assert client.post("/api/schedule-versions/ver-nonexistent/validate").status_code == 404


def test_replan_without_confirmation_rejected(client: TestClient):
    scen = client.post("/api/scenarios/demo?preset=standard").json()
    v1_id = scen["active_version_id"]

    res = client.post(
        f"/api/scenarios/{scen['id']}/replan",
        json={
            "confirmed": False,
            "baseline_version_id": v1_id,
            "disruptions": [{"type": "train_delay", "train_id": "T101", "delay_minutes": 20}],
        },
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "CONFIRMATION_REQUIRED"

    # Verify no new revision was created
    versions = client.get(f"/api/scenarios/{scen['id']}/schedule-versions").json()
    assert len(versions) == 1


def test_replan_creates_immutable_revision_and_preserves_baseline(client: TestClient):
    scen = client.post("/api/scenarios/demo?preset=standard").json()
    scen_id = scen["id"]
    v1_id = scen["active_version_id"]
    v1_before = client.get(f"/api/schedule-versions/{v1_id}").json()

    replan_res = client.post(
        f"/api/scenarios/{scen_id}/replan",
        json={
            "confirmed": True,
            "baseline_version_id": v1_id,
            "disruptions": [
                {"type": "train_delay", "train_id": "T101", "delay_minutes": 20},
                {"type": "platform_closure", "platform_id": "P2", "start": "09:20", "end": "10:00"},
            ],
        },
    )
    assert replan_res.status_code == 201
    v2 = replan_res.json()
    assert v2["id"] != v1_id
    assert v2["parent_version_id"] == v1_id
    assert v2["version_number"] == 2
    assert v2["solver_status"] == "OPTIMAL"
    assert v2["validation_status"] == "VALID"
    assert v2["is_complete"] is True
    assert len(v2["applied_disruptions"]) == 2
    assert len(v2["changes"]) >= 2

    # Verify v1 was not mutated
    v1_after = client.get(f"/api/schedule-versions/{v1_id}").json()
    assert v1_after == v1_before

    # Compare v1 and v2
    cmp_res = client.get(f"/api/schedule-versions/{v1_id}/compare/{v2['id']}")
    assert cmp_res.status_code == 200
    assert len(cmp_res.json()["train_diffs"]) == 4


def test_duplicate_disruption_and_stale_baseline_rejected(client: TestClient):
    scen = client.post("/api/scenarios/demo?preset=standard").json()
    scen_id = scen["id"]
    v1_id = scen["active_version_id"]

    v2 = client.post(
        f"/api/scenarios/{scen_id}/replan",
        json={
            "confirmed": True,
            "baseline_version_id": v1_id,
            "disruptions": [{"id": "d-1", "type": "train_delay", "train_id": "T101", "delay_minutes": 20}],
        },
    ).json()

    # 1. Attempting to re-apply the same disruption on top of v2 is rejected
    dup_res = client.post(
        f"/api/scenarios/{scen_id}/replan",
        json={
            "confirmed": True,
            "baseline_version_id": v2["id"],
            "disruptions": [{"type": "train_delay", "train_id": "T101", "delay_minutes": 20}],
        },
    )
    assert dup_res.status_code == 400
    assert dup_res.json()["error"]["code"] == "DUPLICATE_DISRUPTION"

    # 2. Stale optimistic concurrency check: passing expected_active_version_id=v1_id when v2 is active
    stale_res = client.post(
        f"/api/scenarios/{scen_id}/replan",
        json={
            "confirmed": True,
            "baseline_version_id": v1_id,
            "expected_active_version_id": v1_id,
            "disruptions": [{"type": "train_delay", "train_id": "T102", "delay_minutes": 10}],
        },
    )
    assert stale_res.status_code == 409
    assert stale_res.json()["error"]["code"] == "STALE_BASELINE_VERSION"


def test_impossible_scenario_never_marked_valid_or_promoted(client: TestClient):
    scen = client.post("/api/scenarios/demo?preset=impossible").json()
    scen_id = scen["id"]
    v1_id = scen["active_version_id"]

    # Close P1 during fixed train T201's occupancy [09:00, 09:20)
    res = client.post(
        f"/api/scenarios/{scen_id}/replan",
        json={
            "confirmed": True,
            "baseline_version_id": v1_id,
            "disruptions": [
                {"type": "platform_closure", "platform_id": "P1", "start": "08:50", "end": "09:30"}
            ],
        },
    )
    assert res.status_code == 201
    v2 = res.json()
    assert v2["solver_status"] == "INFEASIBLE"
    assert v2["validation_status"] != "VALID"
    assert v2["is_complete"] is False
    assert "T201" in v2["unresolved_trains"]

    # Scenario active_version_id must remain v1_id because v2 is not VALID
    scen_after = client.get(f"/api/scenarios/{scen_id}").json()
    assert scen_after["active_version_id"] == v1_id
    assert scen_after["latest_version_number"] == 2


def test_manual_assignment_and_independent_revalidation(client: TestClient):
    scen = client.post("/api/scenarios/demo?preset=standard").json()
    scen_id = scen["id"]
    v1_id = scen["active_version_id"]

    # Construct a deliberately invalid candidate: put T102 at 09:10-09:30 on P1 (overlapping T101 09:00-09:20)
    bad_assignments = [
        {"train_id": "T101", "platform_id": "P1", "arrival": "09:00", "departure": "09:20"},
        {"train_id": "T102", "platform_id": "P1", "arrival": "09:25", "departure": "09:45"},  # 5m gap < 10m
        {"train_id": "T103", "platform_id": "P2", "arrival": "09:25", "departure": "09:45"},
        {"train_id": "T104", "platform_id": "P3", "arrival": "09:40", "departure": "10:00"},
    ]

    # Without save_as_diagnostic, invalid manual proposal is rejected with 422
    rej_res = client.post(
        f"/api/scenarios/{scen_id}/manual-assign",
        json={
            "baseline_version_id": v1_id,
            "assignments": bad_assignments,
            "save_as_diagnostic": False,
        },
    )
    assert rej_res.status_code == 422
    assert rej_res.json()["error"]["code"] == "INVALID_MANUAL_ASSIGNMENT"

    # With save_as_diagnostic=True, it is saved as INVALID for diagnostic inspection and not promoted
    diag_res = client.post(
        f"/api/scenarios/{scen_id}/manual-assign",
        json={
            "baseline_version_id": v1_id,
            "assignments": bad_assignments,
            "save_as_diagnostic": True,
        },
    )
    assert diag_res.status_code == 201
    v_diag = diag_res.json()
    assert v_diag["solver_status"] == "MANUAL"
    assert v_diag["validation_status"] == "INVALID"
    assert v_diag["is_complete"] is False

    # Verify /validate endpoint recalculates freshly from stored data
    db_path = os.environ["RAILFLOW_DB_PATH"]
    conn = sqlite3.connect(db_path)
    # Tamper with v1 in SQLite to move T103 onto P1 (colliding with T102 [09:30, 09:50))
    conn.execute(
        "UPDATE train_assignments SET platform_id = 'P1' WHERE version_id = ? AND train_id = 'T103'",
        (v1_id,),
    )
    conn.commit()
    conn.close()

    reval_res = client.post(f"/api/schedule-versions/{v1_id}/validate")
    assert reval_res.status_code == 200
    reval_data = reval_res.json()
    assert reval_data["validation_status"] == "INVALID"
    assert any(e["code"] == "PLATFORM_OVERLAP" for e in reval_data["errors"])


def test_diagnostic_duplicate_train_assignments_persisted_and_revalidated(client: TestClient):
    """Regression test: saving a diagnostic manual candidate with duplicate train_id rows succeeds and revalidates."""
    scen = client.post("/api/scenarios/demo?preset=standard").json()
    scen_id = scen["id"]
    v1_id = scen["active_version_id"]

    dup_assignments = [
        {"train_id": "T101", "platform_id": "P1", "arrival": "09:00", "departure": "09:20"},
        {"train_id": "T101", "platform_id": "P2", "arrival": "09:00", "departure": "09:20"},
        {"train_id": "T102", "platform_id": "P1", "arrival": "09:30", "departure": "09:50"},
        {"train_id": "T103", "platform_id": "P2", "arrival": "09:25", "departure": "09:45"},
        {"train_id": "T104", "platform_id": "P3", "arrival": "09:40", "departure": "10:00"},
    ]
    diag_res = client.post(
        f"/api/scenarios/{scen_id}/manual-assign",
        json={
            "baseline_version_id": v1_id,
            "assignments": dup_assignments,
            "save_as_diagnostic": True,
        },
    )
    assert diag_res.status_code == 201
    v_diag = diag_res.json()
    assert v_diag["validation_status"] == "INVALID"
    assert any(e["code"] == "DUPLICATE_TRAIN_ASSIGNMENT" for e in v_diag["validation_findings"])

    # Calling /validate on v_diag must still detect DUPLICATE_TRAIN_ASSIGNMENT
    reval = client.post(f"/api/schedule-versions/{v_diag['id']}/validate").json()
    assert reval["validation_status"] == "INVALID"
    assert any(e["code"] == "DUPLICATE_TRAIN_ASSIGNMENT" for e in reval["errors"])


def test_failed_replan_rolls_back_without_partial_rows(client: TestClient):
    """Verify failed replan leaves zero partial/orphan rows in SQLite tables."""
    scen = client.post("/api/scenarios/demo?preset=standard").json()
    scen_id = scen["id"]
    v1_id = scen["active_version_id"]
    db_path = os.environ["RAILFLOW_DB_PATH"]

    def _table_counts() -> dict[str, int]:
        conn = sqlite3.connect(db_path)
        tables = [
            "schedule_versions",
            "train_assignments",
            "disruptions",
            "revision_changes",
            "validation_runs",
        ]
        counts = {
            t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            for t in tables
        }
        conn.close()
        return counts

    before = _table_counts()
    # Submit a batch with one valid delay and one invalid delay (unknown train T999)
    fail_res = client.post(
        f"/api/scenarios/{scen_id}/replan",
        json={
            "confirmed": True,
            "baseline_version_id": v1_id,
            "disruptions": [
                {"type": "train_delay", "train_id": "T101", "delay_minutes": 15},
                {"type": "train_delay", "train_id": "T999", "delay_minutes": 10},
            ],
        },
    )
    assert fail_res.status_code == 400
    after = _table_counts()
    assert after == before


def test_openapi_docs_and_cors_configuration(client: TestClient):
    """Verify Swagger /docs, /openapi.json, and explicit CORS origin handling."""
    docs_res = client.get("/docs")
    assert docs_res.status_code == 200

    openapi_res = client.get("/openapi.json")
    assert openapi_res.status_code == 200
    paths = openapi_res.json()["paths"]
    expected_paths = {
        "/health",
        "/api/scenarios",
        "/api/scenarios/demo",
        "/api/scenarios/{scenario_id}",
        "/api/scenarios/{scenario_id}/disruptions/parse",
        "/api/scenarios/{scenario_id}/replan",
        "/api/scenarios/{scenario_id}/manual-assign",
        "/api/scenarios/{scenario_id}/schedule-versions",
        "/api/schedule-versions/{version_id}",
        "/api/schedule-versions/{version_id}/validate",
        "/api/schedule-versions/{version_id}/validation-runs",
        "/api/schedule-versions/{base_version_id}/compare/{target_version_id}",
        "/api/schedule-versions/{version_id}/explain",
        "/api/scenarios/{scenario_id}/audit-events",
    }
    assert expected_paths.issubset(set(paths.keys()))

    # Allowed local frontend origin receives Access-Control-Allow-Origin
    cors_ok = client.options(
        "/api/scenarios",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert cors_ok.headers.get("access-control-allow-origin") == "http://localhost:5173"

    # Arbitrary untrusted origin does not receive Access-Control-Allow-Origin
    cors_deny = client.options(
        "/api/scenarios",
        headers={
            "Origin": "https://untrusted.example.com",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert "access-control-allow-origin" not in cors_deny.headers


def test_voice_operator_status_and_grounded_commands(client: TestClient) -> None:
    """Verify ElevenLabs voice status, TTS unconfigured guard, and grounded voice commands."""
    status_res = client.get("/api/voice/status")
    assert status_res.status_code == 200
    status_data = status_res.json()
    assert status_data["ai_platform_assignment_forbidden"] is True
    assert isinstance(status_data["voices"], list)
    assert len(status_data["voices"]) >= 1

    # Without ELEVENLABS_API_KEY, TTS returns 503 honestly instead of faking audio
    tts_res = client.post("/api/voice/tts", json={"text": "Test dispatch readout"})
    if not status_data["configured"]:
        assert tts_res.status_code == 503
        assert tts_res.json()["error"]["code"] == "VOICE_SERVICE_UNAVAILABLE"

    # Seed scenario and test grounded voice commands
    scen_res = client.post("/api/scenarios/demo?preset=standard&scenario_id=voice-test")
    assert scen_res.status_code == 201

    # 1. Operational query
    q_res = client.post(
        "/api/scenarios/voice-test/voice-command",
        json={"utterance": "Summarize the next thirty minutes", "sim_clock": 550},
    )
    assert q_res.status_code == 200
    q_data = q_res.json()
    assert q_data["intent"] == "window_summary"
    assert q_data["requires_confirmation"] is False
    assert "T101" in q_data["reply_text"]

    # 2. Voice disruption utterance -> produces unconfirmed draft without modifying active schedule
    d_res = client.post(
        "/api/scenarios/voice-test/voice-command",
        json={
            "utterance": "Delay T101 by twenty minutes and close platform P2 from 09:20 to 10:00.",
            "sim_clock": 550,
        },
    )
    assert d_res.status_code == 200
    d_data = d_res.json()
    assert d_data["intent"] == "disruption_draft"
    assert d_data["requires_confirmation"] is True
    assert len(d_data["draft_events"]) == 2
    assert len(d_data["normalized_disruptions"]) == 2

    # Active schedule version remains v1 (unmodified by unconfirmed voice draft)
    versions_res = client.get("/api/scenarios/voice-test/schedule-versions")
    assert len(versions_res.json()) == 1

    # 3. Ambiguous disruption utterance -> returns clarification_needed without raw ver-* hashes
    ambig_res = client.post(
        "/api/scenarios/voice-test/voice-command",
        json={"utterance": "Delay T101", "sim_clock": 550},
    )
    assert ambig_res.status_code == 200
    ambig_data = ambig_res.json()
    assert ambig_data["intent"] == "clarification_needed"
    assert ambig_data["requires_confirmation"] is False
    assert "ver-" not in ambig_data["reply_text"]
    assert "T101" in ambig_data["reply_text"]


def test_parse_to_replan_roundtrip_preserves_start_end_time_strings(client: TestClient) -> None:
    """
    Regression test for HTTP 422 replanning bug:
    Verify that parsing 'Delay T101 by 20 minutes. Close platform P2 from 09:20 to 10:00.'
    preserves canonical start_time/end_time strings on normalized_disruptions and succeeds
    when submitted to /replan.
    """
    scen = client.post("/api/scenarios/demo?preset=standard").json()
    scen_id = scen["id"]
    v1_id = scen["active_version_id"]

    parse_res = client.post(
        f"/api/scenarios/{scen_id}/disruptions/parse",
        json={"text": "Delay T101 by 20 minutes. Close platform P2 from 09:20 to 10:00."},
    )
    assert parse_res.status_code == 200
    parsed_body = parse_res.json()
    norm = parsed_body["normalized_disruptions"]
    assert len(norm) == 2

    delay_item = next(d for d in norm if d["type"] == "train_delay")
    closure_item = next(d for d in norm if d["type"] == "platform_closure")
    assert delay_item["train_id"] == "T101"
    assert delay_item["delay_minutes"] == 20
    assert closure_item["platform_id"] == "P2"
    assert closure_item["start_time"] == "09:20"
    assert closure_item["end_time"] == "10:00"
    assert closure_item["start"] == 560
    assert closure_item["end"] == 600

    # Round-trip normalized_disruptions directly into /replan
    replan_res = client.post(
        f"/api/scenarios/{scen_id}/replan",
        json={
            "confirmed": True,
            "baseline_version_id": v1_id,
            "expected_active_version_id": v1_id,
            "disruptions": norm,
        },
    )
    assert replan_res.status_code == 201
    v2 = replan_res.json()
    assert v2["version_number"] == 2
    assert v2["solver_status"] in ("OPTIMAL", "FEASIBLE")
    assert v2["validation_status"] == "VALID"
    t101 = next(a for a in v2["assignments"] if a["train_id"] == "T101")
    assert t101["platform_id"] == "P1"
    assert t101["arrival_str"] == "09:20"
    assert t101["departure_str"] == "09:40"


def test_replan_422_error_includes_human_readable_field_details(client: TestClient) -> None:
    """Verify HTTP 422 INVALID_INPUT_SCHEMA includes specific field error details in error.message."""
    scen = client.post("/api/scenarios/demo?preset=standard").json()
    scen_id = scen["id"]
    v1_id = scen["active_version_id"]

    bad_res = client.post(
        f"/api/scenarios/{scen_id}/replan",
        json={
            "confirmed": True,
            "baseline_version_id": v1_id,
            "disruptions": [
                {
                    "type": "platform_closure",
                    "platform_id": "P2",
                    "start_time": "10:30",
                    "end_time": "09:20",
                }
            ],
        },
    )
    assert bad_res.status_code == 422
    err = bad_res.json()["error"]
    assert err["code"] == "INVALID_INPUT_SCHEMA"
    assert "end" in err["message"].lower() or "start" in err["message"].lower()
    assert isinstance(err["details"], list) and len(err["details"]) >= 1



