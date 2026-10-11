# RailFlow Frontend & REST API Integration Contract

- **Base URL (Local Development)**: `http://127.0.0.1:8000`
- **Swagger UI**: `http://127.0.0.1:8000/docs`
- **OpenAPI Schema**: `http://127.0.0.1:8000/openapi.json`
- **CORS Allowed Origins** (configurable via `RAILFLOW_CORS_ORIGINS`):
  - `http://localhost:5173`, `http://127.0.0.1:5173` (Vite default)
  - `http://localhost:3000`, `http://127.0.0.1:3000` (React/Next dev port)
  - `http://localhost:8000`, `http://127.0.0.1:8000`

---

## 1. Frontend State & Status Handling Rules

### Solver Status vs. Independent Validation Status
The frontend **must** display `solver_status` and `validation_status` as separate badges and **never** infer validity from HTTP `200`/`201` alone:

| Field | Possible Values | Frontend UI Handling |
| :--- | :--- | :--- |
| `solver_status` | `BASELINE`, `MANUAL`, `OPTIMAL`, `FEASIBLE`, `INFEASIBLE`, `UNKNOWN` | Indicates how the candidate was produced. `FEASIBLE` is not proven optimal; `UNKNOWN` means the solver timed out before proving feasibility or infeasibility. |
| `validation_status` | `VALID`, `INVALID`, `PARTIAL`, `INFEASIBLE`, `UNKNOWN` | The **authoritative** verdict from `app/engine/validator.py`. Only `VALID` (`is_complete: true`) may be styled as an accepted operational timetable. |
| `is_complete` | `true`, `false` | `false` whenever any train is in `unresolved_trains` or validation is not `VALID`. |

### Handling Loading States, Unresolved Trains, and Failed Replanning
1. **Loading States**:
   - During `POST /api/scenarios/{id}/replan`, disable the confirm button and display a spinner (`solver_time_limit_seconds` defaults to `5.0`s; typical solve time is `< 50` ms).
2. **Unresolved Trains (`PARTIAL` / `INFEASIBLE`)**:
   - When `solver_status == "INFEASIBLE"` and `allow_partial_diagnostic: true`, the response (`201 Created`) contains a diagnostic partial candidate where unschedulable trains have `unresolved: true`, `platform_id: null`, and a specific `unresolved_reason`.
   - Render unresolved trains in a dedicated warning tray with their `unresolved_reason`, and keep the station's active valid schedule indicator pointed at `scenario.active_version_id` (the backend never promotes a non-`VALID` revision to `active_version_id`).
3. **Solver Timeout (`UNKNOWN`)**:
   - When `solver_status == "UNKNOWN"`, `assignments` is `[]` and `validation_status == "UNKNOWN"`. Display a timeout banner prompting the operator to increase `solver_time_limit_seconds` or simplify disruptions; never display "Infeasible".
4. **Rejected Requests (`400`, `404`, `409`, `422`)**:
   - Parse `response.error.code`, `response.error.message`, and `response.error.details`.
   - On `409 STALE_BASELINE_VERSION`, refresh the scenario (`GET /api/scenarios/{id}`) so the operator branches from the latest `active_version_id`.

---

## 2. Endpoints & Payload Examples

### 2.1 Health Check
`GET /health` $\rightarrow$ `200 OK`
```json
{
  "status": "ok",
  "service": "RailFlow",
  "version": "1.0.0",
  "ai_platform_assignment_forbidden": true,
  "scheduler_engine": "ortools-cp-sat",
  "independent_validator": true
}
```

### 2.2 Seed Demonstration Scenario
`POST /api/scenarios/demo?preset=standard&scenario_id=demo-standard` $\rightarrow$ `201 Created`
- Query parameters:
  - `preset`: `"standard"` (Section 16 3-platform, 4-train scenario) or `"impossible"` (fixed train on `P1` conflict scenario).
  - `scenario_id`: optional custom ID.

### 2.3 Create Custom Scenario
`POST /api/scenarios` $\rightarrow$ `201 Created`
```json
{
  "id": "custom-station-1",
  "name": "Central Station Morning Peak",
  "station": { "id": "STN-01", "name": "Central Station", "timezone": "UTC" },
  "default_min_gap_minutes": 10,
  "platforms": [
    { "id": "P1", "station_id": "STN-01", "min_gap_minutes": 10 },
    { "id": "P2", "station_id": "STN-01" },
    { "id": "P3", "station_id": "STN-01" }
  ],
  "trains": [
    { "id": "T101", "arrival": "09:00", "departure": "09:20", "platform_id": "P1" },
    { "id": "T102", "arrival": "09:30", "departure": "09:50", "platform_id": "P1" },
    { "id": "T103", "arrival": "09:25", "departure": "09:45", "platform_id": "P2", "allowed_platforms": ["P2", "P3"] },
    { "id": "T104", "arrival": "09:40", "departure": "10:00", "platform_id": "P3", "fixed": false, "departed": false }
  ]
}
```

### 2.4 Parse Natural-Language Disruption (Phase 2 — Proposal Only)
`POST /api/scenarios/{scenario_id}/disruptions/parse` $\rightarrow$ `200 OK`

**Request**:
```json
{
  "text": "Delay train T101 by 20 minutes and close platform P2 from 09:20 to 10:00.",
  "prefer_llm": true
}
```

**Response**:
```json
{
  "raw_text": "Delay train T101 by 20 minutes and close platform P2 from 09:20 to 10:00.",
  "parser_mode": "deterministic_fallback",
  "events": [
    { "type": "train_delay", "train_id": "T101", "delay_minutes": 20 },
    { "type": "platform_closure", "platform_id": "P2", "start_time": "09:20", "end_time": "10:00" }
  ],
  "normalized_disruptions": [
    {
      "id": null,
      "type": "train_delay",
      "target_id": "T101",
      "train_id": "T101",
      "platform_id": null,
      "delay_minutes": 20,
      "start": null,
      "end": null,
      "start_time": null,
      "end_time": null
    },
    {
      "id": null,
      "type": "platform_closure",
      "target_id": "P2",
      "train_id": null,
      "platform_id": "P2",
      "delay_minutes": null,
      "start": 560,
      "end": 600,
      "start_time": null,
      "end_time": null
    }
  ],
  "requires_confirmation": true,
  "applied": false,
  "ambiguous": false,
  "clarification_needed": [],
  "warnings": []
}
```

### 2.5 Apply Confirmed Disruptions & Replan
`POST /api/scenarios/{scenario_id}/replan` $\rightarrow$ `201 Created`

**Request**:
```json
{
  "confirmed": true,
  "baseline_version_id": "ver-32af033af2",
  "expected_active_version_id": "ver-32af033af2",
  "disruptions": [
    { "type": "train_delay", "train_id": "T101", "delay_minutes": 20 },
    { "type": "platform_closure", "platform_id": "P2", "start": "09:20", "end": "10:00" }
  ],
  "solver_time_limit_seconds": 5.0,
  "max_additional_delay_minutes": 180,
  "allow_partial_diagnostic": true
}
```

**Response (`ScheduleVersion`)**:
```json
{
  "id": "ver-60420ad152",
  "scenario_id": "demo-standard",
  "version_number": 2,
  "parent_version_id": "ver-32af033af2",
  "solver_status": "OPTIMAL",
  "validation_status": "VALID",
  "is_complete": true,
  "created_at": "2026-10-11T07:25:00+00:00",
  "assignments": [
    {
      "train_id": "T101",
      "platform_id": "P1",
      "arrival": 560,
      "departure": 580,
      "arrival_str": "09:20",
      "departure_str": "09:40",
      "baseline_arrival": 540,
      "baseline_departure": 560,
      "effective_arrival": 560,
      "effective_departure": 580,
      "disruption_delay_minutes": 20,
      "additional_delay_minutes": 0,
      "total_delay_minutes": 20,
      "fixed": false,
      "departed": false,
      "unresolved": false,
      "unresolved_reason": null
    }
  ],
  "changes": [
    {
      "train_id": "T101",
      "previous_platform": "P1",
      "proposed_platform": "P1",
      "previous_arrival": 540,
      "previous_departure": 560,
      "proposed_arrival": 560,
      "proposed_departure": 580,
      "previous_arrival_str": "09:00",
      "previous_departure_str": "09:20",
      "proposed_arrival_str": "09:20",
      "proposed_departure_str": "09:40",
      "disruption_delay_minutes": 20,
      "additional_delay_minutes": 0,
      "platform_changed": false,
      "timing_changed": true,
      "unresolved": false,
      "reason": "Delayed by 20 min (from 09:00-09:20 to 09:20-09:40) due to applied train delay disruption (disr-719903ed).",
      "associated_disruption_ids": ["disr-719903ed"]
    }
  ],
  "applied_disruptions": [...],
  "newly_applied_disruptions": [...],
  "validation_findings": [],
  "unresolved_trains": [],
  "objective_metrics": {
    "unresolved_count": 0,
    "total_additional_delay_minutes": 35,
    "platform_changes_count": 1,
    "unaffected_train_changes_count": 2,
    "solve_time_ms": 14.2,
    "is_diagnostic_partial": false
  }
}
```

### 2.6 Manual Assignment Validation
`POST /api/scenarios/{scenario_id}/manual-assign`
- When `save_as_diagnostic: false` (default) and the proposal violates any constraint, returns `422 Unprocessable Entity` with `error.code == "INVALID_MANUAL_ASSIGNMENT"` and `error.details.errors` containing the exact `ValidationErrorItem` list.
- When `save_as_diagnostic: true`, saves the proposal as a diagnostic revision (`solver_status: "MANUAL"`, `validation_status: "INVALID"` or `"PARTIAL"`) without promoting it to `active_version_id`.

### 2.7 Independent Revalidation, Comparison, Explanation & Audit
- `POST /api/schedule-versions/{version_id}/validate` $\rightarrow$ `200 OK` (`ValidationRun` freshly recalculated from stored assignments and scenario rules).
- `GET /api/schedule-versions/{base_version_id}/compare/{target_version_id}` $\rightarrow$ `200 OK` (side-by-side train diffs and recorded changes).
- `GET /api/schedule-versions/{version_id}/explain` $\rightarrow$ `200 OK` (`ScheduleExplanationResponse` with `summary`, `change_explanations`, `unresolved_explanations`, `validation_explanations`, `tradeoff_notes`, `read_only_verified: true`).
- `GET /api/scenarios/{scenario_id}/audit-events` $\rightarrow$ `200 OK` (chronological `AuditEvent` array).

---

## 3. Structured Error Format
All error responses (`400`, `404`, `409`, `422`, `500`) follow a uniform JSON structure:
```json
{
  "error": {
    "code": "PLATFORM_CONFLICT",
    "message": "Human-readable explanation of the failure.",
    "details": {}
  }
}
```
