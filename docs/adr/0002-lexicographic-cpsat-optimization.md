# ADR 0002: Sequential Lexicographic CP-SAT Optimization

- **Status**: Accepted

## Context
Weighted-sum objectives risk allowing a combination of lower-priority terms (such as multiple platform changes) to outweigh higher-priority goals (such as resolving all trains or minimizing additional delay).

## Decision
Execute sequential CP-SAT optimization stages where each stage locks the optimal objective value of the previous stage before optimizing the next priority:
1. Complete schedule feasibility (`unresolved == 0`) + minimize total additional delay.
2. Minimize platform changes.
3. Minimize perturbations to unaffected future trains.

Only after Stage 1 proves `cp_model.INFEASIBLE` (never on `UNKNOWN`) does the engine run a partial diagnostic pass to minimize unresolved trains.

## Consequences
- Mathematical priority ordering is guaranteed and verified by automated tests.
- Solver timeouts (`UNKNOWN`) never falsely trigger infeasibility claims.
