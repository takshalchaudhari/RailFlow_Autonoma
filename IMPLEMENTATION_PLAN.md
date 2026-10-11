# RailFlow: Master Implementation Plan

## 1. Existing Project Assessment
- **Workspace Location**: `c:\Users\Dell\Desktop\rail`
- **Initial State**: Empty directory (`Get-ChildItem -Force` returned 0 items; `git status` confirmed not yet initialized as a Git repository). No existing backend or frontend files were present.
- **Environment**:
  - Python `3.12.10`
  - `fastapi 0.111.0`, `pydantic 2.13.4`, `ortools 9.15.6755`, `httpx 0.27.0`, `uvicorn 0.52.4`, `pytest 9.1.1`
- **Frontend Ownership**: A teammate owns the frontend and visual design. Per specification and review instructions, this implementation does **not** overwrite or scaffold a competing frontend application; instead, it delivers the complete, verified backend (`app/`), comprehensive automated test suite (`tests/`), and a thoroughly documented REST/OpenAPI contract (`docs/api-contract.md`) for seamless frontend integration across the five UI areas (*Timetable*, *Assign*, *Disrupt*, *Revised Plan*, and *Validate*).

---

## 2. Explicit Domain Semantics & Invariants

To eliminate ambiguity across the schema, scheduler, validator, and API layers, the following rules are enforced everywhere:

1. **Time Representation & Service Horizon**:
   - All internal scheduling and validation calculations use integer minutes from midnight in the single-day service horizon `[0, 1440]` (`00:00` = `0`, `09:00` = `540`, `24:00` = `1440`).
   - API inputs accept either integer minutes (`540`) or `"HH:MM"` strings (`"09:00"`). API outputs provide both integer minutes and `"HH:MM"` strings.
   - Every train and closure must satisfy `0 <= start < end <= 1440`. Overnight wrapping across midnight is explicitly rejected.

2. **Half-Open Occupancy & Platform Clearance Gaps**:
   - Each assigned train occupies its platform over `[arrival, departure)`.
   - Platform clearance gap `gap = platform.min_gap_minutes` (if specified on the `Platform`) else `scenario.default_min_gap_minutes`.
   - For any two distinct trains $A$ and $B$ assigned to the same platform $p$, either:
     $$\text{arrival}_B \ge \text{departure}_A + \text{gap}_p \quad \text{OR} \quad \text{arrival}_A \ge \text{departure}_B + \text{gap}_p$$
   - Neither train ID ordering nor input array ordering is assumed to match chronological order. Both chronological orderings ($A \prec B$ and $B \prec A$) are explicitly modeled and tested.

3. **`allowed_platforms` and `required_platform` Semantics**:
   - `allowed_platforms = None`: Unrestricted across all platforms in the scenario (unless `required_platform` is set).
   - `allowed_platforms = []` (empty list): **Zero permitted platforms** — explicitly rejected at schema validation as an impossible platform domain (`EMPTY_ALLOWED_PLATFORMS`), preventing silent ambiguity between "none allowed" and "all allowed".
   - `allowed_platforms = ["P1", "P2"]`: Train may only be assigned to platforms in that list.
   - `required_platform = "P1"`: Train must be assigned to `"P1"` (if resolved). If `allowed_platforms` is also provided and does not contain `required_platform`, schema validation rejects the contradicting definition.

4. **`fixed` and `departed` Train Semantics**:
   - A train marked `fixed=True` or `departed=True` **must** have a valid initial `platform_id` in the scenario definition; a fixed or departed train with `platform_id=None` is rejected at schema validation.
   - Both `fixed` and `departed` trains are locked to their baseline `platform_id`, `arrival`, and `departure` during replanning, and cannot be targeted by `train_delay` disruptions.

5. **Baseline Schedule Validation**:
   - When a scenario is created (`POST /api/scenarios`), Revision `v1` (`version_number = 1`, `parent_version_id = None`) is constructed from the initial train assignments and immediately evaluated by the **independent validator** (`app/engine/validator.py`).
   - If all trains have initial platforms and satisfy all hard constraints, `validation_status` is `VALID`. If any train lacks an initial `platform_id` (and has no hard constraint violations), `validation_status` is `PARTIAL` (`is_complete = False`). If the baseline violates any constraint, `validation_status` is `INVALID`.

6. **Revision-Safe Replanning & Duplicate/Stale Disruption Protection**:
   - Every `/replan` request must explicitly provide `baseline_version_id` and `confirmed = True`.
   - If `baseline_version_id` does not exist for the scenario, return `404`.
   - If `expected_latest_version_id` is provided (or if `require_latest_baseline=True`, default `False` to allow branching from historical revisions when intentional, while rejecting stale optimistic concurrency when `expected_active_version_id` mismatches the scenario's current head), return `409 Conflict` (`STALE_BASELINE_VERSION`).
   - Disruptions carry deterministic signatures and optional client-supplied `id`s. A replan request inherits the cumulative disruptions already applied along its ancestor chain (`baseline_version.applied_disruptions`) and applies **only** the newly confirmed disruptions in the request.
   - If a request attempts to re-apply a disruption ID or identical disruption signature already active in `baseline_version_id`, or if the request itself contains duplicate disruptions for the same train/closure, it is rejected with `400 Bad Request` (`DUPLICATE_DISRUPTION`) rather than double-delaying a train.

7. **Solver Outcomes vs. Independent Validation Outcomes**:
   - `solver_status` (`BASELINE`, `MANUAL`, `OPTIMAL`, `FEASIBLE`, `INFEASIBLE`, `UNKNOWN`) and `validation_status` (`VALID`, `INVALID`, `PARTIAL`, `INFEASIBLE`, `UNKNOWN`) are stored and returned as distinct fields.
   - **Lexicographic CP-SAT Stages**:
     - **Stage 1 (Complete Feasibility + Min Delay)**: Require all trains assigned (`unresolved[i] == 0`) and minimize total additional solver delay $\sum_i \text{add\_delay}_i$.
     - **Stage 2 (Min Platform Changes)**: Lock $\sum_i \text{add\_delay}_i \le D^*$, minimize platform changes $\sum_i \mathbb{I}(\text{platform}_i \ne \text{baseline\_platform}_i)$.
     - **Stage 3 (Min Unaffected Train Perturbations)**: Lock delay $D^*$ and platform changes $P^*$, minimize perturbations (any time or platform change) to trains not directly targeted by disruptions.
   - **Honest Outcome Handling**:
     - If Stage 1 returns `OPTIMAL` or `FEASIBLE`, proceed through Stages 2–3 (allocating remaining time budget while always preserving the best incumbent valid solution if a subsequent stage hits `UNKNOWN`).
     - If Stage 1 returns `UNKNOWN` (e.g., timeout before proving feasibility or infeasibility), immediately return `solver_status = UNKNOWN`, `validation_status = UNKNOWN`, `assignments = []`, and **do not** run partial diagnostic scheduling or claim `INFEASIBLE`.
     - **Only** if Stage 1 proves `INFEASIBLE` (`cp_model.INFEASIBLE`), if `allow_partial_diagnostic=True` (default `True` for diagnostic visibility), run the partial diagnostic CP-SAT model where `unresolved[i] in {0, 1}` is minimized first, then additional delay, then platform changes. Even when a partial diagnostic schedule is produced, the revision's `solver_status` remains `INFEASIBLE` (for the full problem), `is_complete = False`, and `validation_status` is `PARTIAL` (or `INFEASIBLE` if 0 trains can be scheduled), **never** `VALID`.

8. **Safe Manual Assignments**:
   - `POST /api/scenarios/{scenario_id}/manual-assign` validates proposed manual platform/time assignments through `validator.py`.
   - By default (`allow_invalid_diagnostic=False`), an invalid or incomplete proposal is rejected (`422` / `400` with full structured validation findings) without replacing the active valid revision. When `save_as_diagnostic=True`, it is persisted as an immutable diagnostic revision explicitly marked `validation_status = INVALID` or `PARTIAL` (`solver_status = MANUAL`) so the UI can inspect the validation failure in revision history without ever marking it `VALID`.

---

## 3. Architecture & Module Responsibilities

- `app/schemas.py`: Strict Pydantic v2 domain models, time conversion utilities, and API request/response contracts.
- `app/engine/validator.py`: Logically independent timetable validator (`validate_schedule`). Zero dependency on `ortools` or `scheduler.py`.
- `app/engine/disruptions.py`: Atomic validation and application of `train_delay` and `platform_closure` disruptions against a baseline revision, with duplicate-application protection.
- `app/engine/scheduler.py`: OR-Tools CP-SAT constraint engine with reified pairwise sequencing, closure avoidance, lexicographic multi-stage optimization, and structured change reason generation.
- `app/database.py`: SQLite persistence layer with foreign keys, atomic transactions, and immutable parent-linked revision storage.
- `app/services/scenario_service.py`, `revision_service.py`, `audit_service.py`: Application orchestration, concurrency/stale-baseline checks, demo presets, and audit trail recording.
- `app/ai/schemas.py`, `fallback_parser.py`, `parser.py`, `explainer.py`: Strict read/proposal-only AI boundary. `ConfigDict(extra="forbid")` blocks any AI-generated platform assignment fields.
- `app/main.py`: FastAPI REST endpoints and structured error handlers.

---

## 4. Implementation Phases & Verification Order
1. **Step B**: Domain schemas, time representation, and schema unit tests (`tests/test_schemas.py`).
2. **Step C**: Independent validator and direct invalid-candidate unit tests (`tests/test_validator.py`).
3. **Step D & E**: Disruption processor and CP-SAT scheduler, plus unit tests (`tests/test_disruptions.py`, `tests/test_scheduler.py`).
4. **Step F & G**: SQLite database, scenario/revision/audit services, FastAPI endpoints, and API/persistence tests (`tests/test_api.py`).
5. **Step I**: AI middleware (`fallback_parser.py`, `parser.py`, `explainer.py`, `schemas.py`) and AI boundary tests (`tests/test_ai.py`).
6. **Step K**: Documentation (`README.md`, `docs/*`), live FastAPI server execution, and end-to-end verification of the demo scenario, impossible scenario, and invalid candidate check.
