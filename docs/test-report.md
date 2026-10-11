# RailFlow Test & Verification Report

## 1. Defects Discovered During Audit & Fixes Applied

During the verification audit of the existing codebase, **4 actual backend issues** and **frontend integration contract alignments** were identified and fixed with accompanying regression tests:

1. **SQLite Primary Key Crash on Diagnostic Duplicate Train Assignments (`app/database.py`)**:
   - *Issue*: `train_assignments` used `PRIMARY KEY (version_id, train_id)`. While `validate_schedule()` caught duplicate train assignments (`DUPLICATE_TRAIN_ASSIGNMENT`), calling `POST /api/scenarios/{id}/manual-assign` with `save_as_diagnostic=True` and duplicate `train_id` rows raised an unhandled `sqlite3.IntegrityError` on insert.
   - *Fix*: Changed `train_assignments` to use `id INTEGER PRIMARY KEY AUTOINCREMENT` with an index `idx_train_assignments_version_train(version_id, train_id)`, allowing diagnostic candidates with duplicate train assignments to be persisted and freshly revalidated.
   - *Regression Test*: `tests/test_api.py::test_diagnostic_duplicate_train_assignments_persisted_and_revalidated`.

2. **Independent Validator Check on Malformed `applied_disruptions` (`app/engine/validator.py`)**:
   - *Issue*: When `validate_schedule()` was called directly with `applied_disruptions` containing an unknown train ID or a delay targeting a `fixed`/`departed` train, `validator.py` silently ignored unknown trains in delays and added the delay to `effective_arrival` for `fixed`/`departed` trains (which caused a misleading `EARLY_ARRIVAL_VIOLATION` instead of flagging `IMMUTABLE_TRAIN_DELAYED`).
   - *Fix*: Added explicit independent checks in `validator.py` for `UNKNOWN_TRAIN_IN_DISRUPTION`, `INVALID_DISRUPTION_DELAY`, `IMMUTABLE_TRAIN_DELAYED`, and `INVALID_CLOSURE_RANGE`.
   - *Regression Test*: `tests/test_validator.py::test_malformed_applied_disruptions_caught_by_validator`.

3. **Two-Way Logical Equivalence for `perturbed` Variable in CP-SAT (`app/engine/scheduler.py`)**:
   - *Issue*: In `_build_cpsat_model()`, `perturbed` only enforced `perturbed == 0 => (add_delay == 0 and p_changed == 0)`. During Stages A1 and A2 (before `perturbed` entered the Stage A3 objective), the solver could leave `perturbed = 1` when `add_delay == 0` and `p_changed == 0`.
   - *Fix*: Added `has_add_delay` boolean equivalence and `model.add_bool_or([has_add_delay, p_changed]).only_enforce_if(perturbed)` so `perturbed == 1` iff `add_delay >= 1 or p_changed == 1` across every stage.

4. **Overly Permissive Wildcard CORS & Catch-All Exception Sanitization (`app/main.py`)**:
   - *Issue*: `CORSMiddleware` used `allow_origins=["*"]` with `allow_credentials=True`, which violates browser CORS rules for credentialed requests and unnecessarily allows arbitrary external origins.
   - *Fix*: Restricted default CORS origins to standard local development ports (`http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:3000`, `http://127.0.0.1:3000`, `http://localhost:8000`, `http://127.0.0.1:8000`), configurable via `RAILFLOW_CORS_ORIGINS`, and added a sanitized `500 INTERNAL_SERVER_ERROR` handler so stack traces are never leaked.
   - *Regression Test*: `tests/test_api.py::test_openapi_docs_and_cors_configuration`.

5. **Frontend Contract Alignment (`frontend/src/api.ts`, `frontend/src/types.ts`, `frontend/src/pages/DashboardLayout.tsx`)**:
   - *Issue*: The starter frontend in `frontend/` used integer scenario/train IDs, omitted `baseline_version_id` on replan, hardcoded 3 platform labels (`"Platform 1"`, `"Platform 2"`, `"Platform 3"`), had a read-only `Assign` table without backend submission, and only displayed `validation_status` without separate `solver_status` badges or revision history/audit tables.
   - *Fix*: Preserved the existing visual theme, routing (`LandingPage` at `/` and `DashboardLayout` at `/app`), and 5 core areas (`Timetable`, `Assign`, `Disrupt`, `Revised Plan`, `Validate & History`), while wiring `frontend/src/api.ts` (`VITE_API_BASE_URL` defaulting to `http://127.0.0.1:8000`) and `DashboardLayout.tsx` to all 15 verified FastAPI endpoints.

---

## 2. Automated Backend Test Suite Results (`pytest`)

Command executed:
```powershell
python -m pytest -v
```
Result: **63 passed, 0 failed, 0 skipped, 0 errors** in `3.07s`.

| Test File | Passed | Coverage Focus |
| :--- | :---: | :--- |
| `tests/test_schemas.py` | 16 | Time conversion, duplicate IDs, unknown platforms, empty `allowed_platforms`, fixed/departed missing platform, forbidden disruption fields |
| `tests/test_validator.py` | 15 | All 13 independent validator rules + malformed `applied_disruptions` regression test |
| `tests/test_disruptions.py` | 6 | Dwell preservation, unknown IDs, fixed/departed protection, atomic batch validation, duplicate disruption rejection, horizon overflow |
| `tests/test_scheduler.py` | 8 | Baseline scheduling, both chronological orders ($A \prec B$ and $B \prec A$), closures, fixed/departed locks, lexicographic priority ordering, impossible scenario, `UNKNOWN` timeout handling |
| `tests/test_api.py` | 11 | Full REST lifecycle, confirmation gate, immutable revisions, duplicate disruptions, stale baseline (`409`), diagnostic duplicate assignments, SQLite rollback on failure, `/docs` & CORS |
| `tests/test_ai.py` | 7 | AST import boundary verification, offline NL parsing, ambiguity detection, rejection of AI platform assignments, read-only explainer |

---

## 3. Frontend TypeScript & Vite Build Verification

Command executed in `frontend/`:
```powershell
npm run build
```
Result: **Exited with code 0** (`tsc -b && vite build` succeeded in `1.12s` with `0` TypeScript or bundler errors).

---

## 4. End-to-End Frontend + Backend Verification (`scripts/verify_e2e_frontend_backend.py`)

Command executed:
```powershell
python scripts/verify_e2e_frontend_backend.py
```
Result: **Exited with code 0** (`ALL END-TO-END FRONTEND + BACKEND VERIFICATION CHECKS PASSED!`).

- **Frontend Server & Proxy/CORS**:
  - Verified `/app` route serves the React console, Vite `/health` proxy resolves to FastAPI, and CORS `Access-Control-Allow-Origin` headers match the frontend origin.
- **Scenario A (Standard Disruption)**:
  - Seeded standard preset (`v1`, `solver_status = BASELINE`, `validation_status = VALID`).
  - Parsed `"Delay train T101 by 20 minutes and close platform P2 from 09:20 to 10:00."` (`requires_confirmation = True`, `applied = False`).
  - Confirmed and replanned to `v2` (`solver_status = OPTIMAL`, `validation_status = VALID`, `is_complete = True`, `0` unresolved trains).
  - Verified side-by-side comparison (`GET /api/schedule-versions/{v1}/compare/{v2}`), grounded explanation (`GET /api/schedule-versions/{v2}/explain`, `read_only_verified = True`), and revision history (`2` versions).
- **Scenario B (Impossible Scenario)**:
  - Seeded impossible preset (`T201` fixed on required platform `P1`, `09:00–09:20`).
  - Parsed and confirmed `"Close platform P1 from 09:00 to 09:30."`.
  - Replanned to `v2` (`solver_status = INFEASIBLE`, `validation_status = INVALID`, `is_complete = False`, `unresolved_trains = ['T201']`), and verified `scenario.active_version_id` remained on `v1`.
- **Scenario C (Invalid Manual Assignment)**:
  - Submitted conflicting manual assignment (`T102` onto `P1` at `09:05–09:25` overlapping `T101` at `09:00–09:20`):
    - Strict mode (`save_as_diagnostic = False`) rejected with `422 INVALID_MANUAL_ASSIGNMENT` (`PLATFORM_OVERLAP`).
    - Diagnostic mode (`save_as_diagnostic = True`) persisted a revision marked `solver_status = MANUAL`, `validation_status = INVALID` while keeping `active_version_id` on `v2`.
- **Error & Edge Cases**:
  - Unconfirmed replan blocked (`400 CONFIRMATION_REQUIRED`).
  - Stale baseline blocked (`409 STALE_BASELINE_VERSION`).
  - Duplicate disruption blocked (`400 DUPLICATE_DISRUPTION`).
  - Missing scenario returns `404 RESOURCE_NOT_FOUND`.
