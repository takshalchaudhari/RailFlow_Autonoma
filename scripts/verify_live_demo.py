"""Live end-to-end verification script against a running FastAPI/Uvicorn server (Requirement 10)."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time

import httpx


def _get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def main() -> int:
    port = _get_free_port()
    base_url = f"http://127.0.0.1:{port}"
    tmp_db = os.path.join(tempfile.gettempdir(), f"railflow_live_demo_{port}.db")
    if os.path.exists(tmp_db):
        os.remove(tmp_db)

    env = os.environ.copy()
    env["RAILFLOW_DB_PATH"] = tmp_db
    env["RAILFLOW_LLM_PROVIDER"] = "none"

    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        client = httpx.Client(base_url=base_url, timeout=10.0)
        # Wait for server startup
        for _ in range(30):
            try:
                r = client.get("/health")
                if r.status_code == 200:
                    break
            except Exception:
                time.sleep(0.2)
        else:
            raise RuntimeError("FastAPI server failed to start within timeout.")

        print("=== 1. HEALTH CHECK ===")
        print(json.dumps(client.get("/health").json(), indent=2))

        print("\n=== 2. SECTION 16 STANDARD DEMO SCENARIO (BASELINE v1) ===")
        scen_res = client.post("/api/scenarios/demo?preset=standard&scenario_id=demo-live")
        assert scen_res.status_code == 201
        scen = scen_res.json()
        v1_id = scen["active_version_id"]
        print(
            f"Scenario ID: {scen['id']} | Baseline Version: {v1_id} | "
            f"Validation: {scen['active_schedule_version']['validation_status']}"
        )

        print("\n=== 3. NATURAL-LANGUAGE DISRUPTION PARSE (UNCONFIRMED PROPOSAL) ===")
        parse_res = client.post(
            "/api/scenarios/demo-live/disruptions/parse",
            json={
                "text": "Delay train T101 by 20 minutes and close platform P2 from 09:20 to 10:00."
            },
        )
        assert parse_res.status_code == 200
        parsed = parse_res.json()
        print(
            f"Parser Mode: {parsed['parser_mode']} | requires_confirmation={parsed['requires_confirmation']} | "
            f"applied={parsed['applied']} | Events: {json.dumps(parsed['events'])}"
        )

        print("\n=== 4. CONFIRMED REPLAN (REVISION v2) ===")
        replan_res = client.post(
            "/api/scenarios/demo-live/replan",
            json={
                "confirmed": True,
                "baseline_version_id": v1_id,
                "disruptions": parsed["normalized_disruptions"],
            },
        )
        assert replan_res.status_code == 201
        v2 = replan_res.json()
        print(
            f"Revision v{v2['version_number']} ({v2['id']}): "
            f"solver_status={v2['solver_status']} | validation_status={v2['validation_status']} | "
            f"is_complete={v2['is_complete']}"
        )
        for asn in v2["assignments"]:
            print(
                f"  - {asn['train_id']}: platform={asn['platform_id']} "
                f"{asn['arrival_str']}-{asn['departure_str']} "
                f"(disruption_delay=+{asn['disruption_delay_minutes']}m, "
                f"additional_delay=+{asn['additional_delay_minutes']}m)"
            )
        print("Recorded Changes:")
        for ch in v2["changes"]:
            print(f"  * {ch['train_id']}: {ch['reason']}")

        print("\n=== 5. INDEPENDENT REVALIDATION & EXPLANATION OF v2 ===")
        reval = client.post(f"/api/schedule-versions/{v2['id']}/validate").json()
        exp = client.get(f"/api/schedule-versions/{v2['id']}/explain").json()
        print(f"Fresh ValidationRun ({reval['id']}): status={reval['validation_status']} errors={len(reval['errors'])}")
        print(f"Explanation Summary: {exp['summary']}")

        print("\n=== 6. SECTION 16 IMPOSSIBLE SCENARIO (FIXED TRAIN ON CLOSED PLATFORM) ===")
        imp_scen = client.post("/api/scenarios/demo?preset=impossible&scenario_id=demo-impossible").json()
        imp_v1_id = imp_scen["active_version_id"]
        imp_replan = client.post(
            "/api/scenarios/demo-impossible/replan",
            json={
                "confirmed": True,
                "baseline_version_id": imp_v1_id,
                "disruptions": [
                    {"type": "platform_closure", "platform_id": "P1", "start": "08:50", "end": "09:30"}
                ],
            },
        ).json()
        print(
            f"Impossible Replan v{imp_replan['version_number']}: "
            f"solver_status={imp_replan['solver_status']} | "
            f"validation_status={imp_replan['validation_status']} | "
            f"is_complete={imp_replan['is_complete']} | "
            f"unresolved_trains={imp_replan['unresolved_trains']}"
        )

        print("\n=== 7. SECTION 16 DELIBERATELY INVALID CANDIDATE CAUGHT BY VALIDATOR ===")
        bad_manual = client.post(
            "/api/scenarios/demo-live/manual-assign",
            json={
                "baseline_version_id": v1_id,
                "save_as_diagnostic": False,
                "assignments": [
                    {"train_id": "T101", "platform_id": "P1", "arrival": "09:00", "departure": "09:20"},
                    {"train_id": "T102", "platform_id": "P1", "arrival": "09:25", "departure": "09:45"},
                    {"train_id": "T103", "platform_id": "P2", "arrival": "09:25", "departure": "09:45"},
                    {"train_id": "T104", "platform_id": "P3", "arrival": "09:40", "departure": "10:00"},
                ],
            },
        )
        assert bad_manual.status_code == 422
        print(f"Deliberately Invalid Candidate Status Code: {bad_manual.status_code}")
        print(json.dumps(bad_manual.json(), indent=2))

        client.close()
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        if os.path.exists(tmp_db):
            try:
                os.remove(tmp_db)
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
