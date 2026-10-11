"""End-to-end verification of Frontend + FastAPI Backend integration (Scenarios A, B, C & Edge Cases)."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

ROOT_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT_DIR / "frontend"


def get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_for_url(url: str, timeout_s: float = 20.0) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            r = httpx.get(url, timeout=1.5)
            if r.status_code == 200:
                return
        except Exception:
            pass
        time.sleep(0.3)
    raise RuntimeError(f"Service at {url} did not become ready within {timeout_s}s")


def main() -> int:
    backend_port = get_free_port()
    frontend_port = get_free_port()
    backend_url = f"http://127.0.0.1:{backend_port}"
    frontend_url = f"http://127.0.0.1:{frontend_port}"

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = os.path.join(tmpdir, "railflow_e2e.db")
        env = os.environ.copy()
        env["RAILFLOW_DB_PATH"] = db_path
        env["VITE_API_BASE_URL"] = backend_url
        env["RAILFLOW_CORS_ORIGINS"] = (
            f"http://localhost:5173,http://127.0.0.1:5173,{frontend_url}"
        )

        backend_proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "app.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(backend_port),
            ],
            cwd=str(ROOT_DIR),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )

        npm_cmd = "npm.cmd" if os.name == "nt" else "npm"
        frontend_proc = subprocess.Popen(
            [
                npm_cmd,
                "run",
                "dev",
                "--",
                "--host",
                "127.0.0.1",
                "--port",
                str(frontend_port),
                "--strictPort",
            ],
            cwd=str(FRONTEND_DIR),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )

        try:
            wait_for_url(f"{backend_url}/health")
            wait_for_url(f"{frontend_url}/")
            print(
                f"[PASS] Backend ({backend_url}) and Frontend Vite Server ({frontend_url}) are live."
            )

            with httpx.Client(
                headers={"Origin": frontend_url},
                timeout=10.0,
            ) as client:
                # Verify Frontend HTML & proxy
                html_res = client.get(f"{frontend_url}/app")
                assert html_res.status_code == 200
                assert "RailFlow" in html_res.text

                proxy_health = client.get(f"{frontend_url}/health")
                assert proxy_health.status_code == 200
                assert proxy_health.json()["status"] == "ok"

                cors_health = client.get(f"{backend_url}/health")
                assert cors_health.status_code == 200
                assert (
                    cors_health.headers.get("access-control-allow-origin")
                    == frontend_url
                )
                print(
                    "[PASS] Frontend /app route, Vite /health proxy, and CORS headers verified."
                )

                # =========================================================
                # SCENARIO A: STANDARD DISRUPTION
                # =========================================================
                scen_a = client.post(
                    f"{backend_url}/api/scenarios/demo?preset=standard&scenario_id=e2e-standard"
                )
                assert scen_a.status_code == 201, scen_a.text
                scen_a_data = scen_a.json()
                v1_id = scen_a_data["active_version_id"]
                assert (
                    scen_a_data["active_schedule_version"]["solver_status"]
                    == "BASELINE"
                )
                assert (
                    scen_a_data["active_schedule_version"]["validation_status"]
                    == "VALID"
                )

                parse_a = client.post(
                    f"{backend_url}/api/scenarios/e2e-standard/disruptions/parse",
                    json={
                        "text": "Delay train T101 by 20 minutes and close platform P2 from 09:20 to 10:00.",
                        "prefer_llm": False,
                    },
                )
                assert parse_a.status_code == 200
                parse_a_data = parse_a.json()
                assert parse_a_data["requires_confirmation"] is True
                assert parse_a_data["applied"] is False
                assert len(parse_a_data["normalized_disruptions"]) == 2

                # Unconfirmed replan must be blocked
                unconfirmed_res = client.post(
                    f"{backend_url}/api/scenarios/e2e-standard/replan",
                    json={
                        "confirmed": False,
                        "baseline_version_id": v1_id,
                        "disruptions": parse_a_data["normalized_disruptions"],
                    },
                )
                assert unconfirmed_res.status_code == 400
                assert (
                    unconfirmed_res.json()["error"]["code"]
                    == "CONFIRMATION_REQUIRED"
                )

                # Confirmed replan
                replan_a = client.post(
                    f"{backend_url}/api/scenarios/e2e-standard/replan",
                    json={
                        "confirmed": True,
                        "baseline_version_id": v1_id,
                        "expected_active_version_id": v1_id,
                        "disruptions": parse_a_data["normalized_disruptions"],
                    },
                )
                assert replan_a.status_code == 201, replan_a.text
                v2_data = replan_a.json()
                v2_id = v2_data["id"]
                assert v2_data["solver_status"] in ("OPTIMAL", "FEASIBLE")
                assert v2_data["validation_status"] == "VALID"
                assert v2_data["is_complete"] is True
                assert v2_data["unresolved_trains"] == []

                # Verify comparison, explanation, and history
                comp_a = client.get(
                    f"{backend_url}/api/schedule-versions/{v1_id}/compare/{v2_id}"
                )
                assert comp_a.status_code == 200
                assert len(comp_a.json()["train_diffs"]) == 4

                exp_a = client.get(
                    f"{backend_url}/api/schedule-versions/{v2_id}/explain"
                )
                assert exp_a.status_code == 200
                assert exp_a.json()["read_only_verified"] is True

                hist_a = client.get(
                    f"{backend_url}/api/scenarios/e2e-standard/schedule-versions"
                )
                assert hist_a.status_code == 200
                assert len(hist_a.json()) == 2
                print(
                    "[PASS] Scenario A (Standard Disruption): Parse -> Confirm -> Replan -> Explain -> Validate -> History."
                )

                # =========================================================
                # SCENARIO B: IMPOSSIBLE FIXED-TRAIN SCENARIO
                # =========================================================
                scen_b = client.post(
                    f"{backend_url}/api/scenarios/demo?preset=impossible&scenario_id=e2e-impossible"
                )
                assert scen_b.status_code == 201
                b_v1_id = scen_b.json()["active_version_id"]

                parse_b = client.post(
                    f"{backend_url}/api/scenarios/e2e-impossible/disruptions/parse",
                    json={"text": "Close platform P1 from 09:00 to 09:30."},
                )
                assert parse_b.status_code == 200

                replan_b = client.post(
                    f"{backend_url}/api/scenarios/e2e-impossible/replan",
                    json={
                        "confirmed": True,
                        "baseline_version_id": b_v1_id,
                        "disruptions": parse_b.json()["normalized_disruptions"],
                        "allow_partial_diagnostic": True,
                    },
                )
                assert replan_b.status_code == 201
                b_v2_data = replan_b.json()
                assert b_v2_data["solver_status"] == "INFEASIBLE"
                assert b_v2_data["validation_status"] in (
                    "PARTIAL",
                    "INVALID",
                    "INFEASIBLE",
                )
                assert b_v2_data["validation_status"] != "VALID"
                assert b_v2_data["is_complete"] is False
                assert "T201" in b_v2_data["unresolved_trains"]

                # Active valid version must remain b_v1_id
                scen_b_after = client.get(
                    f"{backend_url}/api/scenarios/e2e-impossible"
                )
                assert scen_b_after.json()["active_version_id"] == b_v1_id
                print(
                    f"[PASS] Scenario B (Impossible Scenario): Solver {b_v2_data['solver_status']}, Validator {b_v2_data['validation_status']}, T201 unresolved, active version protected."
                )

                # =========================================================
                # SCENARIO C: INVALID MANUAL ASSIGNMENT
                # =========================================================
                bad_assignments = [
                    {
                        "train_id": "T101",
                        "platform_id": "P1",
                        "arrival": "09:00",
                        "departure": "09:20",
                    },
                    {
                        "train_id": "T102",
                        "platform_id": "P1",
                        "arrival": "09:05",
                        "departure": "09:25",
                    },
                    {
                        "train_id": "T103",
                        "platform_id": "P2",
                        "arrival": "09:25",
                        "departure": "09:45",
                    },
                    {
                        "train_id": "T104",
                        "platform_id": "P3",
                        "arrival": "09:40",
                        "departure": "10:00",
                    },
                ]
                strict_manual = client.post(
                    f"{backend_url}/api/scenarios/e2e-standard/manual-assign",
                    json={
                        "baseline_version_id": v2_id,
                        "assignments": bad_assignments,
                        "save_as_diagnostic": False,
                    },
                )
                assert strict_manual.status_code == 422
                err_payload = strict_manual.json()["error"]
                assert err_payload["code"] == "INVALID_MANUAL_ASSIGNMENT"
                codes = {e["code"] for e in err_payload["details"]["errors"]}
                assert "PLATFORM_OVERLAP" in codes

                diag_manual = client.post(
                    f"{backend_url}/api/scenarios/e2e-standard/manual-assign",
                    json={
                        "baseline_version_id": v2_id,
                        "assignments": bad_assignments,
                        "save_as_diagnostic": True,
                    },
                )
                assert diag_manual.status_code == 201
                diag_data = diag_manual.json()
                assert diag_data["solver_status"] == "MANUAL"
                assert diag_data["validation_status"] == "INVALID"
                assert diag_data["is_complete"] is False

                # Ensure active version of e2e-standard remained v2_id
                scen_a_after = client.get(f"{backend_url}/api/scenarios/e2e-standard")
                assert scen_a_after.json()["active_version_id"] == v2_id
                print(
                    "[PASS] Scenario C (Invalid Manual Assignment): Strict 422 rejection + Diagnostic INVALID persistence verified."
                )

                # =========================================================
                # EDGE CASES: STALE BASELINE, DUPLICATE DISRUPTION, 404
                # =========================================================
                stale_res = client.post(
                    f"{backend_url}/api/scenarios/e2e-standard/replan",
                    json={
                        "confirmed": True,
                        "baseline_version_id": v1_id,
                        "expected_active_version_id": v1_id,
                        "disruptions": [
                            {
                                "type": "train_delay",
                                "train_id": "T104",
                                "delay_minutes": 5,
                            }
                        ],
                    },
                )
                assert stale_res.status_code == 409
                assert stale_res.json()["error"]["code"] == "STALE_BASELINE_VERSION"

                dup_res = client.post(
                    f"{backend_url}/api/scenarios/e2e-standard/replan",
                    json={
                        "confirmed": True,
                        "baseline_version_id": v2_id,
                        "expected_active_version_id": v2_id,
                        "disruptions": parse_a_data["normalized_disruptions"],
                    },
                )
                assert dup_res.status_code == 400
                assert dup_res.json()["error"]["code"] == "DUPLICATE_DISRUPTION"

                not_found_res = client.get(
                    f"{backend_url}/api/scenarios/does-not-exist"
                )
                assert not_found_res.status_code == 404
                assert not_found_res.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
                print(
                    "[PASS] Edge Cases (409 STALE_BASELINE_VERSION, 400 DUPLICATE_DISRUPTION, 404 RESOURCE_NOT_FOUND) verified."
                )

            print("\nALL END-TO-END FRONTEND + BACKEND VERIFICATION CHECKS PASSED!")
            return 0
        finally:
            frontend_proc.terminate()
            backend_proc.terminate()
            try:
                frontend_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                frontend_proc.kill()
            try:
                backend_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                backend_proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
