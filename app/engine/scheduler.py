"""Deterministic constraint-based railway scheduler using Google OR-Tools CP-SAT (STEP D).

Enforces all hard constraints with reified CP-SAT constraints (no AI, no greedy heuristics)
and executes sequential lexicographic optimization:
  1. Satisfy all hard constraints.
  2. Minimize unresolved trains (0 in complete schedules; minimized only in post-infeasibility diagnostic mode).
  3. Minimize total additional solver-induced delay.
  4. Minimize platform changes relative to the baseline revision.
  5. Minimize perturbations to trains not directly targeted by disruptions.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import time
from typing import Callable, Optional

from ortools.sat.python import cp_model

from app.engine.disruptions import EffectiveDisruptionState, EffectiveTrainSpec
from app.schemas import (
    ChangeRecord,
    DisruptionRecord,
    ObjectiveMetrics,
    Platform,
    SERVICE_DAY_END,
    SERVICE_DAY_START,
    SolverStatus,
    Train,
    TrainAssignment,
    format_minutes,
)


@dataclass
class SchedulerResult:
    """Output produced by the deterministic CP-SAT scheduler."""

    solver_status: SolverStatus
    assignments: list[TrainAssignment] = field(default_factory=list)
    changes: list[ChangeRecord] = field(default_factory=list)
    unresolved_trains: list[str] = field(default_factory=list)
    objective_metrics: ObjectiveMetrics = field(default_factory=ObjectiveMetrics)


@dataclass
class _ModelBundle:
    model: cp_model.CpModel
    assign_vars: dict[tuple[str, str], cp_model.IntVar]
    unresolved_vars: dict[str, cp_model.IntVar]
    add_delay_vars: dict[str, cp_model.IntVar]
    arr_vars: dict[str, cp_model.IntVar]
    dep_vars: dict[str, cp_model.IntVar]
    plat_changed_vars: dict[str, cp_model.IntVar]
    unaffected_perturbed_vars: dict[str, cp_model.IntVar]


def _build_cpsat_model(
    trains: list[Train],
    platforms: list[Platform],
    default_min_gap_minutes: int,
    effective_state: EffectiveDisruptionState,
    reference_platforms: dict[str, Optional[str]],
    max_additional_delay_minutes: int,
    allow_unresolved: bool,
) -> _ModelBundle:
    """Construct the CP-SAT constraint model for either complete or partial-diagnostic scheduling."""
    model = cp_model.CpModel()
    platform_ids = [p.id for p in platforms]
    gap_by_platform = {
        p.id: (p.min_gap_minutes if p.min_gap_minutes is not None else default_min_gap_minutes)
        for p in platforms
    }

    assign_vars: dict[tuple[str, str], cp_model.IntVar] = {}
    unresolved_vars: dict[str, cp_model.IntVar] = {}
    add_delay_vars: dict[str, cp_model.IntVar] = {}
    arr_vars: dict[str, cp_model.IntVar] = {}
    dep_vars: dict[str, cp_model.IntVar] = {}
    plat_changed_vars: dict[str, cp_model.IntVar] = {}
    unaffected_perturbed_vars: dict[str, cp_model.IntVar] = {}

    for t in trains:
        tid = t.id
        spec: EffectiveTrainSpec = effective_state.effective_trains[tid]
        eff_arr = spec.effective_arrival
        eff_dep = spec.effective_departure

        # Unresolved indicator variable
        unres = model.new_bool_var(f"unresolved_{tid}")
        if not allow_unresolved:
            model.add(unres == 0)
        unresolved_vars[tid] = unres

        # Platform assignment boolean variables
        t_assign_vars: list[cp_model.IntVar] = []
        for pid in platform_ids:
            avar = model.new_bool_var(f"assign_{tid}_{pid}")
            assign_vars[(tid, pid)] = avar
            t_assign_vars.append(avar)

            # Enforce allowed_platforms hard constraint
            if t.allowed_platforms is not None and pid not in t.allowed_platforms:
                model.add(avar == 0)

            # Enforce required_platform hard constraint
            if t.required_platform is not None and pid != t.required_platform:
                model.add(avar == 0)

            # Enforce fixed and departed platform lock
            if (t.fixed or t.departed) and pid != t.platform_id:
                model.add(avar == 0)

        # Exact partition: each train is assigned to exactly one platform OR is unresolved
        model.add(sum(t_assign_vars) + unres == 1)

        # Timing and additional delay bounds
        if t.fixed or t.departed:
            max_add_i = 0
        else:
            horizon_slack = max(0, SERVICE_DAY_END - eff_dep)
            max_add_i = min(max_additional_delay_minutes, horizon_slack)

        # If effective times are already outside the horizon, train cannot be resolved
        if eff_arr < SERVICE_DAY_START or eff_dep > SERVICE_DAY_END or eff_arr >= eff_dep:
            model.add(unres == 1)
            max_add_i = 0

        add_delay = model.new_int_var(0, max_add_i, f"add_delay_{tid}")
        arr = model.new_int_var(SERVICE_DAY_START, SERVICE_DAY_END, f"arr_{tid}")
        dep = model.new_int_var(SERVICE_DAY_START, SERVICE_DAY_END, f"dep_{tid}")

        add_delay_vars[tid] = add_delay
        arr_vars[tid] = arr
        dep_vars[tid] = dep

        if SERVICE_DAY_START <= eff_arr < eff_dep <= SERVICE_DAY_END:
            model.add(arr == eff_arr + add_delay).only_enforce_if(unres.Not())
            model.add(dep == eff_dep + add_delay).only_enforce_if(unres.Not())
        clamped_arr = min(SERVICE_DAY_END, max(SERVICE_DAY_START, eff_arr))
        clamped_dep = min(SERVICE_DAY_END, max(SERVICE_DAY_START, eff_dep))
        model.add(add_delay == 0).only_enforce_if(unres)
        model.add(arr == clamped_arr).only_enforce_if(unres)
        model.add(dep == clamped_dep).only_enforce_if(unres)

        # Platform closure constraints: for each closure [c.start, c.end) on platform pid
        for pid in platform_ids:
            avar = assign_vars[(tid, pid)]
            for c_idx, closure in enumerate(effective_state.closures_by_platform.get(pid, [])):
                if closure.start is None or closure.end is None:
                    continue
                before_c = model.new_bool_var(f"before_closure_{tid}_{pid}_{c_idx}")
                # If assigned to pid, train must either depart <= closure.start OR arrive >= closure.end
                model.add(dep <= closure.start).only_enforce_if([avar, before_c])
                model.add(arr >= closure.end).only_enforce_if([avar, before_c.Not()])

        # Platform change indicator relative to reference (baseline) platform
        ref_pid = reference_platforms.get(tid, t.platform_id)
        p_changed = model.new_bool_var(f"plat_changed_{tid}")
        if ref_pid is not None and ref_pid in platform_ids:
            # If resolved and assigned to ref_pid, p_changed == 0; if assigned elsewhere, p_changed == 1
            model.add(p_changed == 0).only_enforce_if(assign_vars[(tid, ref_pid)])
            model.add(p_changed == 1).only_enforce_if([unres.Not(), assign_vars[(tid, ref_pid)].Not()])
            model.add(p_changed == 0).only_enforce_if(unres)
        else:
            model.add(p_changed == 0)
        plat_changed_vars[tid] = p_changed

        # Perturbation indicator for trains not directly affected by disruptions
        if tid not in effective_state.directly_affected_train_ids:
            perturbed = model.new_bool_var(f"perturbed_{tid}")
            has_add_delay = model.new_bool_var(f"has_add_delay_{tid}")
            model.add(add_delay == 0).only_enforce_if(has_add_delay.Not())
            model.add(add_delay >= 1).only_enforce_if(has_add_delay)
            model.add(add_delay == 0).only_enforce_if(perturbed.Not())
            model.add(p_changed == 0).only_enforce_if(perturbed.Not())
            model.add_bool_or([has_add_delay, p_changed]).only_enforce_if(perturbed)
            unaffected_perturbed_vars[tid] = perturbed

    # Pairwise platform occupancy and clearance gap constraints for all unordered train pairs
    n_trains = len(trains)
    for i in range(n_trains):
        ti = trains[i]
        tid_i = ti.id
        arr_i = arr_vars[tid_i]
        dep_i = dep_vars[tid_i]

        for j in range(i + 1, n_trains):
            tj = trains[j]
            tid_j = tj.id
            arr_j = arr_vars[tid_j]
            dep_j = dep_vars[tid_j]

            for pid in platform_ids:
                gap = gap_by_platform[pid]
                avar_i = assign_vars[(tid_i, pid)]
                avar_j = assign_vars[(tid_j, pid)]

                i_before_j = model.new_bool_var(f"seq_{tid_i}_before_{tid_j}_on_{pid}")
                # If both ti and tj are assigned to pid:
                # i_before_j == 1 => arr_j >= dep_i + gap
                # i_before_j == 0 => arr_i >= dep_j + gap
                model.add(arr_j >= dep_i + gap).only_enforce_if([avar_i, avar_j, i_before_j])
                model.add(arr_i >= dep_j + gap).only_enforce_if([avar_i, avar_j, i_before_j.Not()])

    return _ModelBundle(
        model=model,
        assign_vars=assign_vars,
        unresolved_vars=unresolved_vars,
        add_delay_vars=add_delay_vars,
        arr_vars=arr_vars,
        dep_vars=dep_vars,
        plat_changed_vars=plat_changed_vars,
        unaffected_perturbed_vars=unaffected_perturbed_vars,
    )


def _extract_snapshot(
    solver: cp_model.CpSolver,
    bundle: _ModelBundle,
    trains: list[Train],
    platforms: list[Platform],
) -> dict[str, dict]:
    """Capture variable values from a solved CP-SAT instance."""
    platform_ids = [p.id for p in platforms]
    snapshot: dict[str, dict] = {}
    for t in trains:
        tid = t.id
        unres = bool(solver.value(bundle.unresolved_vars[tid]))
        chosen_pid: Optional[str] = None
        if not unres:
            for pid in platform_ids:
                if solver.value(bundle.assign_vars[(tid, pid)]) == 1:
                    chosen_pid = pid
                    break
        snapshot[tid] = {
            "unresolved": unres,
            "platform_id": chosen_pid,
            "add_delay": int(solver.value(bundle.add_delay_vars[tid])),
            "arrival": int(solver.value(bundle.arr_vars[tid])),
            "departure": int(solver.value(bundle.dep_vars[tid])),
            "plat_changed": int(solver.value(bundle.plat_changed_vars[tid])),
            "perturbed": (
                int(solver.value(bundle.unaffected_perturbed_vars[tid]))
                if tid in bundle.unaffected_perturbed_vars
                else 0
            ),
        }
    return snapshot


def _apply_hints_from_snapshot(
    bundle: _ModelBundle,
    snapshot: dict[str, dict],
    platforms: list[Platform],
) -> None:
    """Warm-start the next lexicographic stage with the incumbent solution."""
    bundle.model.clear_hints()
    platform_ids = [p.id for p in platforms]
    for tid, data in snapshot.items():
        bundle.model.add_hint(bundle.unresolved_vars[tid], 1 if data["unresolved"] else 0)
        for pid in platform_ids:
            bundle.model.add_hint(
                bundle.assign_vars[(tid, pid)],
                1 if data["platform_id"] == pid else 0,
            )
        bundle.model.add_hint(bundle.add_delay_vars[tid], data["add_delay"])
        bundle.model.add_hint(bundle.arr_vars[tid], data["arrival"])
        bundle.model.add_hint(bundle.dep_vars[tid], data["departure"])
        bundle.model.add_hint(bundle.plat_changed_vars[tid], data["plat_changed"])
        if tid in bundle.unaffected_perturbed_vars:
            bundle.model.add_hint(bundle.unaffected_perturbed_vars[tid], data["perturbed"])


def _diagnose_unresolved_reason(
    train: Train,
    spec: EffectiveTrainSpec,
    platforms: list[Platform],
    effective_state: EffectiveDisruptionState,
    snapshot: dict[str, dict],
    default_min_gap_minutes: int,
) -> tuple[str, list[str]]:
    """Produce a grounded, specific explanation for why a train could not be scheduled."""
    assoc_ids = list(spec.associated_disruption_ids)
    eff_arr = spec.effective_arrival
    eff_dep = spec.effective_departure

    if eff_arr < SERVICE_DAY_START or eff_dep > SERVICE_DAY_END:
        return (
            f"Train '{train.id}' effective window ({format_minutes(eff_arr)}-{format_minutes(eff_dep)}) "
            "exceeds the service-day horizon [00:00, 24:00].",
            assoc_ids,
        )

    if train.fixed or train.departed:
        status_label = "fixed" if train.fixed else "already-departed"
        pid = train.platform_id or "unassigned"
        for c in effective_state.closures_by_platform.get(pid, []):
            if c.start is not None and c.end is not None and eff_arr < c.end and eff_dep > c.start:
                if c.id not in assoc_ids:
                    assoc_ids.append(c.id)
                return (
                    f"Train '{train.id}' is operationally {status_label} on platform '{pid}' "
                    f"({format_minutes(eff_arr)}-{format_minutes(eff_dep)}), which is closed from "
                    f"{format_minutes(c.start)} to {format_minutes(c.end)} (disruption '{c.id}'), "
                    "and cannot be retimed or reassigned.",
                    assoc_ids,
                )
        return (
            f"Train '{train.id}' is operationally {status_label} on platform '{pid}' "
            f"({format_minutes(eff_arr)}-{format_minutes(eff_dep)}) and conflicts with another "
            "immutable constraint on that platform.",
            assoc_ids,
        )

    if train.required_platform is not None:
        req_p = train.required_platform
        for c in effective_state.closures_by_platform.get(req_p, []):
            if c.start is not None and c.end is not None and eff_arr < c.end and eff_dep > c.start:
                if c.id not in assoc_ids:
                    assoc_ids.append(c.id)
                return (
                    f"Train '{train.id}' requires platform '{req_p}', which has closure "
                    f"[{format_minutes(c.start)}, {format_minutes(c.end)}) (disruption '{c.id}'), "
                    "and cannot be delayed within the allowed maximum additional delay.",
                    assoc_ids,
                )
        return (
            f"Train '{train.id}' requires platform '{req_p}', but no conflict-free slot exists "
            "within the allowed additional delay horizon.",
            assoc_ids,
        )

    permitted = (
        train.allowed_platforms
        if train.allowed_platforms is not None
        else [p.id for p in platforms]
    )
    for pid in permitted:
        for c in effective_state.closures_by_platform.get(pid, []):
            if c.id not in assoc_ids:
                assoc_ids.append(c.id)
    return (
        f"No feasible slot exists for train '{train.id}' across permitted platforms {permitted} "
        f"that satisfies clearance gaps ({default_min_gap_minutes} min), active closures, "
        "and maximum additional delay bounds.",
        assoc_ids,
    )


def _build_change_reason(
    train: Train,
    spec: EffectiveTrainSpec,
    prev_platform: Optional[str],
    prev_arr: int,
    prev_dep: int,
    prop_platform: Optional[str],
    prop_arr: int,
    prop_dep: int,
    add_delay: int,
    effective_state: EffectiveDisruptionState,
    snapshot: dict[str, dict],
    platforms_by_id: dict[str, Platform],
    default_min_gap_minutes: int,
) -> tuple[str, list[str]]:
    """Construct an evidence-based change reason referencing the actual disruptions and conflicts."""
    reasons: list[str] = []
    assoc_ids: list[str] = list(spec.associated_disruption_ids)

    if spec.disruption_delay_minutes > 0:
        reasons.append(
            f"Delayed by {spec.disruption_delay_minutes} min (from {format_minutes(train.arrival)}-"
            f"{format_minutes(train.departure)} to {format_minutes(spec.effective_arrival)}-"
            f"{format_minutes(spec.effective_departure)}) due to applied train delay disruption"
            + (f" ({', '.join(spec.associated_disruption_ids)})" if spec.associated_disruption_ids else "")
            + "."
        )

    if prev_platform != prop_platform and prop_platform is not None:
        # Check if previous platform had an overlapping closure
        closure_hit: Optional[DisruptionRecord] = None
        if prev_platform:
            for c in effective_state.closures_by_platform.get(prev_platform, []):
                if (
                    c.start is not None
                    and c.end is not None
                    and spec.effective_arrival < c.end
                    and spec.effective_departure > c.start
                ):
                    closure_hit = c
                    if c.id not in assoc_ids:
                        assoc_ids.append(c.id)
                    break

        if closure_hit is not None and closure_hit.start is not None and closure_hit.end is not None:
            reasons.append(
                f"Reassigned from platform '{prev_platform}' to '{prop_platform}' because "
                f"platform '{prev_platform}' is closed from {format_minutes(closure_hit.start)} "
                f"to {format_minutes(closure_hit.end)} (disruption '{closure_hit.id}')."
            )
        elif prev_platform is not None:
            # Find which train occupies prev_platform near spec's effective window
            gap = (
                platforms_by_id[prev_platform].min_gap_minutes
                if prev_platform in platforms_by_id
                and platforms_by_id[prev_platform].min_gap_minutes is not None
                else default_min_gap_minutes
            )
            conflicting_trains: list[str] = []
            for other_tid, other_data in snapshot.items():
                if other_tid == train.id or other_data["unresolved"]:
                    continue
                if other_data["platform_id"] == prev_platform:
                    o_arr = other_data["arrival"]
                    o_dep = other_data["departure"]
                    if spec.effective_arrival < o_dep + gap and o_arr < spec.effective_departure + gap:
                        conflicting_trains.append(other_tid)
                        for d_id in effective_state.effective_trains[other_tid].associated_disruption_ids:
                            if d_id not in assoc_ids:
                                assoc_ids.append(d_id)
            if conflicting_trains:
                reasons.append(
                    f"Reassigned from platform '{prev_platform}' to '{prop_platform}' to resolve "
                    f"occupancy/clearance conflict ({gap} min required gap) with train(s) "
                    f"{', '.join(sorted(conflicting_trains))} on '{prev_platform}'."
                )
            else:
                reasons.append(
                    f"Reassigned from platform '{prev_platform}' to '{prop_platform}' for "
                    "station-wide conflict resolution."
                )
        else:
            reasons.append(f"Assigned to platform '{prop_platform}' by optimization engine.")

    if add_delay > 0 and prop_platform is not None:
        gap = (
            platforms_by_id[prop_platform].min_gap_minutes
            if prop_platform in platforms_by_id
            and platforms_by_id[prop_platform].min_gap_minutes is not None
            else default_min_gap_minutes
        )
        # Check if held for a closure ending at prop_arr or a preceding train on prop_platform
        preceding_trains: list[str] = []
        for other_tid, other_data in snapshot.items():
            if other_tid == train.id or other_data["unresolved"]:
                continue
            if other_data["platform_id"] == prop_platform and other_data["departure"] <= prop_arr:
                if other_data["departure"] + gap >= spec.effective_arrival:
                    preceding_trains.append(other_tid)
                    for d_id in effective_state.effective_trains[other_tid].associated_disruption_ids:
                        if d_id not in assoc_ids:
                            assoc_ids.append(d_id)

        closure_wait: Optional[DisruptionRecord] = None
        for c in effective_state.closures_by_platform.get(prop_platform, []):
            if c.start is not None and c.end is not None and spec.effective_arrival < c.end <= prop_arr:
                closure_wait = c
                if c.id not in assoc_ids:
                    assoc_ids.append(c.id)
                break

        if preceding_trains:
            reasons.append(
                f"Held for +{add_delay} min additional solver delay (to {format_minutes(prop_arr)}-"
                f"{format_minutes(prop_dep)}) on platform '{prop_platform}' to satisfy the "
                f"{gap}-min clearance gap after train(s) {', '.join(sorted(preceding_trains))}."
            )
        elif closure_wait is not None and closure_wait.end is not None:
            reasons.append(
                f"Held for +{add_delay} min additional solver delay on platform '{prop_platform}' "
                f"until platform closure '{closure_wait.id}' ends at {format_minutes(closure_wait.end)}."
            )
        else:
            reasons.append(
                f"Held for +{add_delay} min additional solver delay (to {format_minutes(prop_arr)}-"
                f"{format_minutes(prop_dep)}) to maintain conflict-free platform spacing."
            )

    if not reasons:
        reasons.append("Schedule adjusted during optimization.")

    return " ".join(reasons), assoc_ids


def solve_schedule(
    trains: list[Train],
    platforms: list[Platform],
    default_min_gap_minutes: int,
    effective_state: EffectiveDisruptionState,
    baseline_assignments: Optional[list[TrainAssignment]] = None,
    solver_time_limit_seconds: float = 5.0,
    max_additional_delay_minutes: int = 180,
    allow_partial_diagnostic: bool = True,
    custom_solve_hook: Optional[Callable[[cp_model.CpSolver, cp_model.CpModel], int]] = None,
) -> SchedulerResult:
    """
    Run the deterministic OR-Tools CP-SAT optimization engine with exact lexicographic priorities.

    Honest outcome handling:
    - If Stage 1 returns OPTIMAL or FEASIBLE, refines through Stages 2 and 3 while preserving
      the best verified complete solution.
    - If Stage 1 returns UNKNOWN (e.g., timeout before proving feasibility or infeasibility),
      returns solver_status='UNKNOWN' with no fabricated assignments and does NOT run partial diagnostic.
    - Only if Stage 1 proves INFEASIBLE (cp_model.INFEASIBLE) and allow_partial_diagnostic=True,
      solves the partial diagnostic model to identify which trains can be scheduled and why
      unresolved trains cannot be accommodated, while keeping solver_status='INFEASIBLE'.
    """
    start_wall = time.perf_counter()
    platforms_by_id = {p.id: p for p in platforms}

    # Build reference maps from the baseline revision assignments (or initial train definitions)
    ref_platforms: dict[str, Optional[str]] = {}
    ref_arrivals: dict[str, int] = {}
    ref_departures: dict[str, int] = {}
    if baseline_assignments:
        for ba in baseline_assignments:
            ref_platforms[ba.train_id] = ba.platform_id
            ref_arrivals[ba.train_id] = ba.arrival
            ref_departures[ba.train_id] = ba.departure
    for t in trains:
        if t.id not in ref_platforms:
            ref_platforms[t.id] = t.platform_id
        if t.id not in ref_arrivals:
            ref_arrivals[t.id] = t.arrival
        if t.id not in ref_departures:
            ref_departures[t.id] = t.departure

    def _invoke_solver(solver: cp_model.CpSolver, model: cp_model.CpModel) -> int:
        if custom_solve_hook is not None:
            return custom_solve_hook(solver, model)
        return solver.solve(model)

    # =========================================================================
    # PHASE A: Complete Schedule Optimization (unresolved == 0 for all trains)
    # =========================================================================
    bundle = _build_cpsat_model(
        trains=trains,
        platforms=platforms,
        default_min_gap_minutes=default_min_gap_minutes,
        effective_state=effective_state,
        reference_platforms=ref_platforms,
        max_additional_delay_minutes=max_additional_delay_minutes,
        allow_unresolved=False,
    )

    total_add_delay_expr = sum(bundle.add_delay_vars.values())
    total_plat_changes_expr = sum(bundle.plat_changed_vars.values())
    total_unaffected_expr = (
        sum(bundle.unaffected_perturbed_vars.values())
        if bundle.unaffected_perturbed_vars
        else 0
    )

    # Stage A1: Minimize total additional solver-induced delay
    bundle.model.minimize(total_add_delay_expr)
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(0.05, solver_time_limit_seconds * 0.5)
    solver.parameters.num_search_workers = 1  # Deterministic single-worker execution

    status_a1 = _invoke_solver(solver, bundle.model)

    if status_a1 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        best_snapshot = _extract_snapshot(solver, bundle, trains, platforms)
        overall_optimal = status_a1 == cp_model.OPTIMAL
        best_delay = sum(d["add_delay"] for d in best_snapshot.values())

        # Stage A2: Lock optimal additional delay and minimize platform changes
        bundle.model.add(total_add_delay_expr <= best_delay)
        bundle.model.minimize(total_plat_changes_expr)
        _apply_hints_from_snapshot(bundle, best_snapshot, platforms)

        elapsed = time.perf_counter() - start_wall
        rem = max(0.05, solver_time_limit_seconds - elapsed)
        solver.parameters.max_time_in_seconds = max(0.05, rem * 0.6)
        status_a2 = _invoke_solver(solver, bundle.model)

        if status_a2 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            best_snapshot = _extract_snapshot(solver, bundle, trains, platforms)
            if status_a2 != cp_model.OPTIMAL:
                overall_optimal = False
            best_plat_changes = sum(d["plat_changed"] for d in best_snapshot.values())

            # Stage A3: Lock platform changes and minimize unaffected train perturbations
            if bundle.unaffected_perturbed_vars:
                bundle.model.add(total_plat_changes_expr <= best_plat_changes)
                bundle.model.minimize(total_unaffected_expr)
                _apply_hints_from_snapshot(bundle, best_snapshot, platforms)

                elapsed = time.perf_counter() - start_wall
                rem = max(0.05, solver_time_limit_seconds - elapsed)
                solver.parameters.max_time_in_seconds = rem
                status_a3 = _invoke_solver(solver, bundle.model)

                if status_a3 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                    best_snapshot = _extract_snapshot(solver, bundle, trains, platforms)
                    if status_a3 != cp_model.OPTIMAL:
                        overall_optimal = False
                else:
                    overall_optimal = False
        else:
            overall_optimal = False

        final_status: SolverStatus = "OPTIMAL" if overall_optimal else "FEASIBLE"
        return _materialize_result(
            solver_status=final_status,
            snapshot=best_snapshot,
            trains=trains,
            platforms=platforms,
            platforms_by_id=platforms_by_id,
            default_min_gap_minutes=default_min_gap_minutes,
            effective_state=effective_state,
            ref_platforms=ref_platforms,
            ref_arrivals=ref_arrivals,
            ref_departures=ref_departures,
            solve_time_ms=(time.perf_counter() - start_wall) * 1000.0,
            is_diagnostic_partial=False,
        )

    # Honest handling of UNKNOWN: never claim INFEASIBLE or run partial diagnostic on timeout/UNKNOWN
    if status_a1 != cp_model.INFEASIBLE:
        return SchedulerResult(
            solver_status="UNKNOWN",
            assignments=[],
            changes=[],
            unresolved_trains=[],
            objective_metrics=ObjectiveMetrics(
                solve_time_ms=(time.perf_counter() - start_wall) * 1000.0,
                is_diagnostic_partial=False,
            ),
        )

    # =========================================================================
    # PHASE B: Proven INFEASIBLE -> Optional Partial Diagnostic Schedule
    # =========================================================================
    if not allow_partial_diagnostic:
        return SchedulerResult(
            solver_status="INFEASIBLE",
            assignments=[],
            changes=[],
            unresolved_trains=[t.id for t in trains],
            objective_metrics=ObjectiveMetrics(
                unresolved_count=len(trains),
                solve_time_ms=(time.perf_counter() - start_wall) * 1000.0,
                is_diagnostic_partial=False,
            ),
        )

    diag_bundle = _build_cpsat_model(
        trains=trains,
        platforms=platforms,
        default_min_gap_minutes=default_min_gap_minutes,
        effective_state=effective_state,
        reference_platforms=ref_platforms,
        max_additional_delay_minutes=max_additional_delay_minutes,
        allow_unresolved=True,
    )

    total_unres_expr = sum(diag_bundle.unresolved_vars.values())
    diag_delay_expr = sum(diag_bundle.add_delay_vars.values())
    diag_plat_expr = sum(diag_bundle.plat_changed_vars.values())

    diag_bundle.model.minimize(total_unres_expr)
    diag_solver = cp_model.CpSolver()
    diag_solver.parameters.max_time_in_seconds = max(0.05, solver_time_limit_seconds * 0.4)
    diag_solver.parameters.num_search_workers = 1

    status_b1 = _invoke_solver(diag_solver, diag_bundle.model)
    if status_b1 not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return SchedulerResult(
            solver_status="INFEASIBLE",
            assignments=[],
            changes=[],
            unresolved_trains=[t.id for t in trains],
            objective_metrics=ObjectiveMetrics(
                unresolved_count=len(trains),
                solve_time_ms=(time.perf_counter() - start_wall) * 1000.0,
                is_diagnostic_partial=True,
            ),
        )

    diag_snapshot = _extract_snapshot(diag_solver, diag_bundle, trains, platforms)
    min_unres = sum(1 for d in diag_snapshot.values() if d["unresolved"])

    # Stage B2: Lock minimum unresolved count, minimize additional delay
    diag_bundle.model.add(total_unres_expr <= min_unres)
    diag_bundle.model.minimize(diag_delay_expr)
    _apply_hints_from_snapshot(diag_bundle, diag_snapshot, platforms)
    status_b2 = _invoke_solver(diag_solver, diag_bundle.model)
    if status_b2 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        diag_snapshot = _extract_snapshot(diag_solver, diag_bundle, trains, platforms)
        min_delay = sum(d["add_delay"] for d in diag_snapshot.values())

        # Stage B3: Lock additional delay, minimize platform changes
        diag_bundle.model.add(diag_delay_expr <= min_delay)
        diag_bundle.model.minimize(diag_plat_expr)
        _apply_hints_from_snapshot(diag_bundle, diag_snapshot, platforms)
        status_b3 = _invoke_solver(diag_solver, diag_bundle.model)
        if status_b3 in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            diag_snapshot = _extract_snapshot(diag_solver, diag_bundle, trains, platforms)

    # Note: solver_status remains "INFEASIBLE" because the complete problem was proven INFEASIBLE
    return _materialize_result(
        solver_status="INFEASIBLE",
        snapshot=diag_snapshot,
        trains=trains,
        platforms=platforms,
        platforms_by_id=platforms_by_id,
        default_min_gap_minutes=default_min_gap_minutes,
        effective_state=effective_state,
        ref_platforms=ref_platforms,
        ref_arrivals=ref_arrivals,
        ref_departures=ref_departures,
        solve_time_ms=(time.perf_counter() - start_wall) * 1000.0,
        is_diagnostic_partial=True,
    )


def _materialize_result(
    solver_status: SolverStatus,
    snapshot: dict[str, dict],
    trains: list[Train],
    platforms: list[Platform],
    platforms_by_id: dict[str, Platform],
    default_min_gap_minutes: int,
    effective_state: EffectiveDisruptionState,
    ref_platforms: dict[str, Optional[str]],
    ref_arrivals: dict[str, int],
    ref_departures: dict[str, int],
    solve_time_ms: float,
    is_diagnostic_partial: bool,
) -> SchedulerResult:
    """Convert a CP-SAT variable snapshot into typed TrainAssignments, ChangeRecords, and metrics."""
    assignments: list[TrainAssignment] = []
    changes: list[ChangeRecord] = []
    unresolved_trains: list[str] = []

    for t in trains:
        tid = t.id
        spec = effective_state.effective_trains[tid]
        data = snapshot[tid]
        unres: bool = data["unresolved"]
        prop_pid: Optional[str] = data["platform_id"]
        prop_arr: int = data["arrival"]
        prop_dep: int = data["departure"]
        add_delay: int = data["add_delay"]

        prev_pid = ref_platforms.get(tid, t.platform_id)
        prev_arr = ref_arrivals.get(tid, t.arrival)
        prev_dep = ref_departures.get(tid, t.departure)

        unres_reason: Optional[str] = None
        unres_assoc_ids: list[str] = []
        if unres:
            unresolved_trains.append(tid)
            unres_reason, unres_assoc_ids = _diagnose_unresolved_reason(
                train=t,
                spec=spec,
                platforms=platforms,
                effective_state=effective_state,
                snapshot=snapshot,
                default_min_gap_minutes=default_min_gap_minutes,
            )

        assignments.append(
            TrainAssignment(
                train_id=tid,
                platform_id=prop_pid,
                arrival=prop_arr,
                departure=prop_dep,
                arrival_str=format_minutes(prop_arr),
                departure_str=format_minutes(prop_dep),
                baseline_arrival=t.arrival,
                baseline_departure=t.departure,
                effective_arrival=spec.effective_arrival,
                effective_departure=spec.effective_departure,
                disruption_delay_minutes=spec.disruption_delay_minutes,
                additional_delay_minutes=add_delay,
                total_delay_minutes=spec.disruption_delay_minutes + add_delay,
                fixed=t.fixed,
                departed=t.departed,
                unresolved=unres,
                unresolved_reason=unres_reason,
            )
        )

        platform_changed = (not unres) and (prop_pid != prev_pid)
        timing_changed = (prop_arr != prev_arr) or (prop_dep != prev_dep)

        if unres:
            changes.append(
                ChangeRecord(
                    train_id=tid,
                    previous_platform=prev_pid,
                    proposed_platform=None,
                    previous_arrival=prev_arr,
                    previous_departure=prev_dep,
                    proposed_arrival=prop_arr,
                    proposed_departure=prop_dep,
                    previous_arrival_str=format_minutes(prev_arr),
                    previous_departure_str=format_minutes(prev_dep),
                    proposed_arrival_str=format_minutes(prop_arr),
                    proposed_departure_str=format_minutes(prop_dep),
                    disruption_delay_minutes=spec.disruption_delay_minutes,
                    additional_delay_minutes=add_delay,
                    platform_changed=True,
                    timing_changed=timing_changed,
                    unresolved=True,
                    reason=unres_reason or f"Train '{tid}' could not be assigned a valid platform.",
                    associated_disruption_ids=unres_assoc_ids,
                )
            )
        elif platform_changed or timing_changed:
            reason_str, assoc_ids = _build_change_reason(
                train=t,
                spec=spec,
                prev_platform=prev_pid,
                prev_arr=prev_arr,
                prev_dep=prev_dep,
                prop_platform=prop_pid,
                prop_arr=prop_arr,
                prop_dep=prop_dep,
                add_delay=add_delay,
                effective_state=effective_state,
                snapshot=snapshot,
                platforms_by_id=platforms_by_id,
                default_min_gap_minutes=default_min_gap_minutes,
            )
            changes.append(
                ChangeRecord(
                    train_id=tid,
                    previous_platform=prev_pid,
                    proposed_platform=prop_pid,
                    previous_arrival=prev_arr,
                    previous_departure=prev_dep,
                    proposed_arrival=prop_arr,
                    proposed_departure=prop_dep,
                    previous_arrival_str=format_minutes(prev_arr),
                    previous_departure_str=format_minutes(prev_dep),
                    proposed_arrival_str=format_minutes(prop_arr),
                    proposed_departure_str=format_minutes(prop_dep),
                    disruption_delay_minutes=spec.disruption_delay_minutes,
                    additional_delay_minutes=add_delay,
                    platform_changed=platform_changed,
                    timing_changed=timing_changed,
                    unresolved=False,
                    reason=reason_str,
                    associated_disruption_ids=assoc_ids,
                )
            )

    metrics = ObjectiveMetrics(
        unresolved_count=len(unresolved_trains),
        total_additional_delay_minutes=sum(d["add_delay"] for d in snapshot.values()),
        platform_changes_count=sum(d["plat_changed"] for d in snapshot.values()),
        unaffected_train_changes_count=sum(d["perturbed"] for d in snapshot.values()),
        solve_time_ms=round(solve_time_ms, 2),
        is_diagnostic_partial=is_diagnostic_partial,
    )

    return SchedulerResult(
        solver_status=solver_status,
        assignments=assignments,
        changes=changes,
        unresolved_trains=unresolved_trains,
        objective_metrics=metrics,
    )
