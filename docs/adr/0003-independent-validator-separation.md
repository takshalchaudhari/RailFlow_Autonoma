# ADR 0003: Logically Independent Timetable Validator

- **Status**: Accepted

## Context
A scheduling system must never trust the optimizer's status code (`OPTIMAL` or `FEASIBLE`) as the sole proof that a timetable satisfies operational rules.

## Decision
Implement `app/engine/validator.py` with zero imports from `ortools` or `scheduler.py`. It independently inspects any proposed timetable for all 13 hard constraints, chronological platform conflicts, clearance gaps, closures, fixed/departed train locks, dwell preservation, and completeness.

## Consequences
- `solver_status` and `validation_status` are persisted and reported separately.
- Invalid or partial schedules are never marked `VALID` or promoted to `active_version_id`.
