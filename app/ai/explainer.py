"""Read-only evidence-based schedule explainer service (STEP I).

Explains schedule changes, optimization trade-offs, unresolved trains, and validation findings
strictly from verified ScheduleVersion data. Never modifies assignments or validation statuses,
and explicitly states when a causal reason is not recorded rather than inventing explanations.
"""

from __future__ import annotations

from typing import Optional

from app.ai.schemas import ScheduleExplanationResponse
from app.schemas import ScheduleVersion


def explain_schedule_version(
    version: ScheduleVersion,
    parent_version: Optional[ScheduleVersion] = None,
) -> ScheduleExplanationResponse:
    """
    Generate a grounded plain-language explanation from a verified ScheduleVersion snapshot.
    Operates strictly on a deep copy so it cannot mutate the input objects.
    """
    ver = version.model_copy(deep=True)
    parent = parent_version.model_copy(deep=True) if parent_version is not None else None

    # 1. Summary
    disr_count = len(ver.applied_disruptions)
    new_disr_count = len(ver.newly_applied_disruptions)
    summary_parts = [
        f"Revision v{ver.version_number} ({ver.id}) was evaluated with solver status "
        f"'{ver.solver_status}' and independent validation status '{ver.validation_status}' "
        f"(complete={ver.is_complete})."
    ]
    if parent is not None:
        summary_parts.append(
            f"Branched from baseline revision v{parent.version_number} ({parent.id}) with "
            f"{new_disr_count} newly applied disruption(s) ({disr_count} cumulative)."
        )
    elif disr_count == 0:
        summary_parts.append("Represents the initial baseline timetable with 0 disruptions applied.")

    # 2. Change explanations grounded in recorded ChangeRecords
    change_explanations: list[str] = []
    recorded_by_train = {c.train_id: c for c in ver.changes}

    for ch in ver.changes:
        if ch.unresolved:
            change_explanations.append(
                f"Train {ch.train_id}: Remains UNRESOLVED (previously on platform "
                f"'{ch.previous_platform or 'unassigned'}' at {ch.previous_arrival_str}-"
                f"{ch.previous_departure_str}). Recorded reason: {ch.reason}"
            )
            continue

        plat_desc = (
            f"moved from platform '{ch.previous_platform}' to '{ch.proposed_platform}'"
            if ch.platform_changed
            else f"retained platform '{ch.proposed_platform}'"
        )
        time_desc = (
            f"retimed from {ch.previous_arrival_str}-{ch.previous_departure_str} to "
            f"{ch.proposed_arrival_str}-{ch.proposed_departure_str} "
            f"(disruption delay: +{ch.disruption_delay_minutes}m, additional solver delay: +{ch.additional_delay_minutes}m)"
            if ch.timing_changed
            else f"kept schedule {ch.proposed_arrival_str}-{ch.proposed_departure_str}"
        )
        reason_text = (
            ch.reason.strip()
            if ch.reason and ch.reason.strip()
            else "Causal reason is unavailable in recorded change metadata."
        )
        change_explanations.append(
            f"Train {ch.train_id}: {plat_desc}; {time_desc}. Reason: {reason_text}"
        )

    # Check if any assignment differs from parent_version without a recorded ChangeRecord
    if parent is not None:
        parent_asn_by_train = {a.train_id: a for a in parent.assignments}
        for asn in ver.assignments:
            p_asn = parent_asn_by_train.get(asn.train_id)
            if p_asn is None:
                continue
            differs = (
                p_asn.platform_id != asn.platform_id
                or p_asn.arrival != asn.arrival
                or p_asn.departure != asn.departure
                or p_asn.unresolved != asn.unresolved
            )
            if differs and asn.train_id not in recorded_by_train:
                change_explanations.append(
                    f"Train {asn.train_id}: Schedule changed from platform '{p_asn.platform_id}' "
                    f"({p_asn.arrival_str}-{p_asn.departure_str}) to platform '{asn.platform_id}' "
                    f"({asn.arrival_str}-{asn.departure_str}), but the specific causal reason is "
                    "unavailable in the recorded change log."
                )

    if not change_explanations:
        if ver.solver_status == "UNKNOWN" and len(ver.assignments) == 0:
            change_explanations.append(
                "No candidate assignments were produced because the solver returned UNKNOWN within the time limit."
            )
        else:
            change_explanations.append(
                "No platform or timing changes were required relative to the baseline timetable."
            )

    # 3. Unresolved train explanations
    unresolved_explanations: list[str] = []
    asn_by_train = {a.train_id: a for a in ver.assignments}
    for tid in ver.unresolved_trains:
        asn = asn_by_train.get(tid)
        if asn and asn.unresolved_reason:
            unresolved_explanations.append(f"Train {tid}: {asn.unresolved_reason}")
        elif tid in recorded_by_train and recorded_by_train[tid].reason:
            unresolved_explanations.append(f"Train {tid}: {recorded_by_train[tid].reason}")
        else:
            unresolved_explanations.append(
                f"Train {tid}: Unresolved in proposed schedule; a more specific reason is unavailable in recorded results."
            )

    # 4. Validation explanations
    validation_explanations: list[str] = []
    if ver.validation_status == "VALID":
        validation_explanations.append(
            "Independent validator verified that all required trains are assigned and all hard constraints "
            "(platform permissions, required platforms, closures, dwell times, and clearance gaps) are satisfied."
        )
    else:
        for err in ver.validation_findings:
            trains_str = f" [trains: {', '.join(err.train_ids)}]" if err.train_ids else ""
            plat_str = f" [platform: {err.platform_id}]" if err.platform_id else ""
            validation_explanations.append(f"[{err.code}]{plat_str}{trains_str}: {err.message}")
        if not validation_explanations:
            validation_explanations.append(
                f"Schedule validation status is '{ver.validation_status}' (complete={ver.is_complete})."
            )

    # 5. Optimization trade-off notes
    tradeoff_notes: list[str] = []
    if ver.objective_metrics is not None:
        m = ver.objective_metrics
        tradeoff_notes.append(
            f"Lexicographic objective metrics: unresolved_trains={m.unresolved_count}, "
            f"total_additional_delay={m.total_additional_delay_minutes} min, "
            f"platform_changes={m.platform_changes_count}, "
            f"unaffected_train_changes={m.unaffected_train_changes_count} "
            f"(solved in {m.solve_time_ms:.1f} ms)."
        )
        if m.is_diagnostic_partial:
            tradeoff_notes.append(
                "Note: Full schedule was proven INFEASIBLE under hard constraints; "
                "this revision displays a partial diagnostic proposal and cannot be marked VALID."
            )
        elif m.platform_changes_count > 0 and m.total_additional_delay_minutes == 0:
            tradeoff_notes.append(
                "Trade-off: The optimizer reassigned platform(s) to avoid incurring additional solver delay "
                "(minimizing delay has higher lexicographic priority than preserving initial platforms)."
            )
        elif m.total_additional_delay_minutes > 0:
            tradeoff_notes.append(
                f"Trade-off: +{m.total_additional_delay_minutes} min of additional solver delay was required "
                "because no zero-delay platform reassignment could satisfy all clearance gaps and closures."
            )
    else:
        tradeoff_notes.append(
            "Objective trade-off metrics are unavailable for this revision (baseline or manual revision)."
        )

    return ScheduleExplanationResponse(
        scenario_id=ver.scenario_id,
        version_id=ver.id,
        parent_version_id=ver.parent_version_id,
        explainer_mode="deterministic_grounded",
        solver_status=ver.solver_status,
        validation_status=ver.validation_status,
        is_complete=ver.is_complete,
        summary=" ".join(summary_parts),
        change_explanations=change_explanations,
        unresolved_explanations=unresolved_explanations,
        validation_explanations=validation_explanations,
        tradeoff_notes=tradeoff_notes,
        read_only_verified=True,
    )
