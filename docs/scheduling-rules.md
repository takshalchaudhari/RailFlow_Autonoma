# RailFlow Scheduling & Validation Rules

## 1. Time & Horizon Semantics
- **Service Horizon**: Single day `[0, 1440]` integer minutes from midnight (`00:00` to `24:00`).
- **Occupancy Interval**: Half-open `[arrival, departure)` with `0 <= arrival < departure <= 1440`.
- **Dwell Time Preservation**: Every train $i$ has baseline dwell time $W_i = \text{departure}_i - \text{arrival}_i$. Both disruption delays and solver-added delays shift arrival and departure equally so $\text{departure}'_i - \text{arrival}'_i = W_i$.

## 2. Hard Constraints (CP-SAT & Independent Validator)
1. **Single Assignment or Explicit Unresolved State**:
   $$\sum_{p \in P} \text{assign}_{i, p} + \text{unresolved}_i = 1$$
2. **Platform Permissions (`allowed_platforms` & `required_platform`)**:
   - `allowed_platforms = None` means any scenario platform is permitted.
   - `allowed_platforms = [...]` restricts $\text{assign}_{i, p} = 0$ for all $p \notin \text{allowed\_platforms}_i$. An empty list `[]` is rejected at schema validation.
   - `required_platform = p^*` enforces $\text{assign}_{i, p} = 0$ for all $p \ne p^*$.
3. **Fixed and Departed Train Locks**:
   - Trains with `fixed=True` or `departed=True` must have an initial `platform_id` and are locked to their baseline platform, arrival, and departure times. They cannot be targeted by `train_delay` disruptions.
4. **Pairwise Platform Occupancy & Clearance Gap**:
   - For platform $p$, clearance gap $G_p = \text{platform.min\_gap\_minutes} \text{ or } \text{scenario.default\_min\_gap\_minutes}$.
   - For every pair of distinct trains $(i, j)$ assigned to platform $p$, boolean ordering variable $\text{seq}_{i, j, p} \in \{0, 1\}$ enforces:
     $$\text{seq}_{i, j, p} = 1 \implies \text{arr}_j \ge \text{dep}_i + G_p$$
     $$\text{seq}_{i, j, p} = 0 \implies \text{arr}_i \ge \text{dep}_j + G_p$$
5. **Platform Closures**:
   - For each closure $[C_{\text{start}}, C_{\text{end}})$ on platform $p$, boolean variable $\text{before}_{i, p, c} \in \{0, 1\}$ enforces:
     $$\text{before}_{i, p, c} = 1 \implies \text{dep}_i \le C_{\text{start}}$$
     $$\text{before}_{i, p, c} = 0 \implies \text{arr}_i \ge C_{\text{end}}$$

## 3. Exact Lexicographic Optimization Priorities
In complete-schedule mode ($\text{unresolved}_i = 0 \;\forall i$):
1. **Stage A1**: Minimize total additional solver delay $D = \sum_i \text{add\_delay}_i$.
2. **Stage A2**: Lock $\sum_i \text{add\_delay}_i \le D^*$ and minimize platform changes $P = \sum_i \mathbb{I}(\text{platform}_i \ne \text{baseline\_platform}_i)$.
3. **Stage A3**: Lock $D^*$ and $P^*$ and minimize perturbations to trains not directly affected by disruptions.

If and only if Stage A1 proves `cp_model.INFEASIBLE` (never on `UNKNOWN`/timeout), diagnostic partial mode minimizes $\sum_i \text{unresolved}_i$ first, then $D$, then $P$, while keeping `solver_status = "INFEASIBLE"` and `validation_status != "VALID"`.
