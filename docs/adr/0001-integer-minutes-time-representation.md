# ADR 0001: Integer Minutes from Midnight Time Representation

- **Status**: Accepted

## Context
Railway scheduling requires exact interval comparisons (`[arrival, departure)`) and clearance gap arithmetic inside Google OR-Tools CP-SAT. Floating-point or timezone-aware `datetime` objects inside solver constraints introduce rounding or DST ambiguity.

## Decision
Use integer minutes from midnight in the single service-day horizon `[0, 1440]` (`00:00` = `0`, `09:00` = `540`, `24:00` = `1440`) for all scheduling and validation math. Convert `"HH:MM"` strings only at the API input/output boundary.

## Consequences
- CP-SAT constraints use exact integer arithmetic.
- Overnight wrapping past `24:00` (`1440`) is explicitly rejected rather than silently wrapped.
