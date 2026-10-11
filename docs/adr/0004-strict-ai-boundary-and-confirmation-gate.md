# ADR 0004: Strict AI Boundary and Operator Confirmation Gate

- **Status**: Accepted

## Context
AI is permitted to parse natural-language disruption descriptions and explain verified schedule changes, but is strictly prohibited from assigning platforms, relaxing constraints, or deciding schedule validity.

## Decision
Isolate AI logic in `app/ai/*` with zero imports from `scheduler.py`, `validator.py`, `database.py`, or `services/*` (enforced via AST test). Use `ConfigDict(extra="forbid")` on AI schemas so any payload containing `platform_id` on a train delay or `assignments` is rejected (`AI_PLATFORM_ASSIGNMENT_FORBIDDEN`). Require `confirmed=True` on `/replan`.

## Consequences
- AI cannot mutate schedules or assign platforms by construction.
- Full local operation works offline via `app/ai/fallback_parser.py` and `app/ai/explainer.py`.
