# RailFlow Architecture

## Overview
RailFlow is a deterministic railway station disruption and platform conflict simulator built for **VORTEXA 3.0 | P-03 | Domain 6: Public Systems & Civic Technology**.

```mermaid
flowchart TD
    Operator["Frontend / Operator Console"]
    API["FastAPI REST API (app/main.py)"]
    AI_PARSE["AI / Offline Disruption Parser (app/ai/parser.py)"]
    AI_EXP["Read-Only Explainer (app/ai/explainer.py)"]
    SCEN["Scenario & Revision Services (app/services/*)"]
    DISR["Disruption Processor (app/engine/disruptions.py)"]
    SCHED["OR-Tools CP-SAT Scheduler (app/engine/scheduler.py)"]
    VAL["Independent Validator (app/engine/validator.py)"]
    DB[("SQLite Immutable Store (app/database.py)")]

    Operator -->|POST /disruptions/parse| API
    API --> AI_PARSE
    AI_PARSE -.->|Unconfirmed Events Proposal| Operator
    Operator -->|POST /replan (confirmed=True)| API
    API --> SCEN
    SCEN --> DISR
    DISR --> SCHED
    SCHED -->|Candidate Timetable| VAL
    VAL -->|ValidationRun| SCEN
    SCEN -->|Atomic Transaction| DB
    DB -->|Immutable ScheduleVersion| AI_EXP
    AI_EXP -->|Grounded Plain-Language Summary| API
```

## Module Responsibilities & Strict Safety Boundaries

1. **`app/schemas.py`**:
   - Defines all domain models (`Station`, `Platform`, `Train`, `DisruptionInput`, `DisruptionRecord`, `TrainAssignment`, `ChangeRecord`, `ValidationErrorItem`, `ValidationRun`, `ScheduleVersion`, `AuditEvent`) using Pydantic v2 with `ConfigDict(extra="forbid")`.
   - Converts between `"HH:MM"` display strings and integer minutes from midnight `[0, 1440]`.

2. **`app/engine/disruptions.py`**:
   - Atomically validates incoming disruption batches against the scenario and selected baseline revision (`baseline_version_id`).
   - Prevents duplicate re-application of already-applied disruptions (`DUPLICATE_DISRUPTION`), rejects attempts to retime `fixed` or `departed` trains, preserves dwell times, and enforces the `[00:00, 24:00]` service-day horizon.

3. **`app/engine/scheduler.py`**:
   - The **only** component authorized to compute automated platform assignments during replanning.
   - Uses Google OR-Tools CP-SAT with reified pairwise sequencing (`only_enforce_if`), platform closure avoidance, platform permission locks, and exact sequential lexicographic optimization stages.

4. **`app/engine/validator.py`**:
   - Logically independent timetable validator with zero imports from `ortools` or `scheduler.py`.
   - Independently inspects every proposed schedule for all 13 hard rules, chronological platform occupancy, clearance gaps, closures, dwell time preservation, and completeness.

5. **`app/ai/*` (`schemas.py`, `fallback_parser.py`, `parser.py`, `explainer.py`)**:
   - **Architectural Enforcement**: `app/ai` has zero imports from `app.engine.scheduler`, `app.engine.validator`, `app.database`, or `app.services`. This is enforced by AST inspection in `tests/test_ai.py`.
   - **Proposal-Only Parsing**: Converts natural language into structured `train_delay` and `platform_closure` proposals with `requires_confirmation=True` and `applied=False`. Any payload containing `platform_id` on a train delay, `assignments`, or schedule overrides is rejected with `AI_PLATFORM_ASSIGNMENT_FORBIDDEN`.
   - **Read-Only Explanation**: Generates plain-language explanations strictly from deep-copied `ScheduleVersion` records and never invents unrecorded causal reasons.
