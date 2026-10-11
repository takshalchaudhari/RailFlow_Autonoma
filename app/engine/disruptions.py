"""Disruption validation and effective timetable baseline calculation (STEP E)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional
import uuid

from app.schemas import (
    DisruptionInput,
    DisruptionRecord,
    Platform,
    SERVICE_DAY_END,
    SERVICE_DAY_START,
    Train,
    format_minutes,
)


class DisruptionValidationError(Exception):
    """Structured error raised when one or more disruptions are invalid or prohibited."""

    def __init__(
        self,
        code: str,
        message: str,
        target_id: Optional[str] = None,
        details: Optional[dict] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.target_id = target_id
        self.details = details or {}


@dataclass(frozen=True)
class EffectiveTrainSpec:
    """Effective baseline timing for a train after applying cumulative train_delay disruptions."""

    train: Train
    effective_arrival: int
    effective_departure: int
    disruption_delay_minutes: int
    associated_disruption_ids: list[str] = field(default_factory=list)

    @property
    def dwell_minutes(self) -> int:
        return self.effective_departure - self.effective_arrival


@dataclass(frozen=True)
class EffectiveDisruptionState:
    """Immutable result of validating and applying a batch of disruptions to a baseline."""

    newly_applied_records: list[DisruptionRecord]
    cumulative_disruptions: list[DisruptionRecord]
    effective_trains: dict[str, EffectiveTrainSpec]
    closures_by_platform: dict[str, list[DisruptionRecord]]
    directly_affected_train_ids: set[str]


def compute_effective_state_from_records(
    trains: list[Train],
    platforms: list[Platform],
    applied_disruptions: list[DisruptionRecord],
) -> EffectiveDisruptionState:
    """Compute effective train timings and active closures from already-persisted DisruptionRecords."""
    trains_by_id = {t.id: t for t in trains}
    platforms_by_id = {p.id: p for p in platforms}

    delay_by_train: dict[str, int] = {t.id: 0 for t in trains}
    disruption_ids_by_train: dict[str, list[str]] = {t.id: [] for t in trains}
    closures_by_platform: dict[str, list[DisruptionRecord]] = {p.id: [] for p in platforms}

    for rec in applied_disruptions:
        if rec.type == "train_delay":
            tid = rec.train_id or rec.target_id
            if tid not in trains_by_id:
                raise DisruptionValidationError(
                    code="UNKNOWN_TRAIN",
                    message=f"Disruption '{rec.id}' references unknown train '{tid}'.",
                    target_id=tid,
                )
            delay_by_train[tid] += rec.delay_minutes or 0
            disruption_ids_by_train[tid].append(rec.id)
        elif rec.type == "platform_closure":
            pid = rec.platform_id or rec.target_id
            if pid not in platforms_by_id:
                raise DisruptionValidationError(
                    code="UNKNOWN_PLATFORM",
                    message=f"Disruption '{rec.id}' references unknown platform '{pid}'.",
                    target_id=pid,
                )
            closures_by_platform[pid].append(rec)

    effective_trains: dict[str, EffectiveTrainSpec] = {}
    directly_affected: set[str] = set()

    for t in trains:
        d_min = delay_by_train[t.id]
        eff_arr = t.arrival + d_min
        eff_dep = t.departure + d_min
        assoc_ids = list(disruption_ids_by_train[t.id])
        if d_min > 0:
            directly_affected.add(t.id)
        if t.platform_id and t.platform_id in closures_by_platform:
            for c in closures_by_platform[t.platform_id]:
                if c.start is not None and c.end is not None:
                    if eff_arr < c.end and eff_dep > c.start:
                        directly_affected.add(t.id)
                        if c.id not in assoc_ids:
                            assoc_ids.append(c.id)

        effective_trains[t.id] = EffectiveTrainSpec(
            train=t,
            effective_arrival=eff_arr,
            effective_departure=eff_dep,
            disruption_delay_minutes=d_min,
            associated_disruption_ids=assoc_ids,
        )

    return EffectiveDisruptionState(
        newly_applied_records=[],
        cumulative_disruptions=list(applied_disruptions),
        effective_trains=effective_trains,
        closures_by_platform=closures_by_platform,
        directly_affected_train_ids=directly_affected,
    )


def validate_and_apply_disruptions(
    trains: list[Train],
    platforms: list[Platform],
    baseline_disruptions: list[DisruptionRecord],
    new_disruptions: list[DisruptionInput],
    source_version_id: Optional[str] = None,
) -> EffectiveDisruptionState:
    """
    Atomically validate a list of new disruptions against the scenario and baseline revision.
    Never mutates inputs in place. Rejects the entire batch if any single item is invalid.
    """
    if not new_disruptions:
        raise DisruptionValidationError(
            code="EMPTY_DISRUPTION_LIST",
            message="At least one disruption event is required for replanning.",
        )

    trains_by_id = {t.id: t for t in trains}
    platforms_by_id = {p.id: p for p in platforms}

    existing_ids = {d.id for d in baseline_disruptions}
    existing_signatures = {d.signature() for d in baseline_disruptions}

    batch_ids: set[str] = set()
    batch_signatures: set[str] = set()
    batch_delayed_trains: set[str] = set()

    # Pass 1: Validate every event in the batch before creating any records
    for idx, item in enumerate(new_disruptions):
        if item.id is not None:
            if item.id in existing_ids:
                raise DisruptionValidationError(
                    code="DUPLICATE_DISRUPTION",
                    message=(
                        f"Disruption ID '{item.id}' has already been applied in the baseline revision history."
                    ),
                    target_id=item.target_id,
                    details={"disruption_id": item.id, "index": idx},
                )
            if item.id in batch_ids:
                raise DisruptionValidationError(
                    code="DUPLICATE_DISRUPTION",
                    message=f"Duplicate disruption ID '{item.id}' within the same replan request.",
                    target_id=item.target_id,
                    details={"disruption_id": item.id, "index": idx},
                )
            batch_ids.add(item.id)

        sig = item.signature()
        if sig in existing_signatures:
            raise DisruptionValidationError(
                code="DUPLICATE_DISRUPTION",
                message=(
                    f"Disruption '{sig}' has already been applied in the selected baseline revision. "
                    "Reapplying the same disruption to an already-delayed revision is prevented."
                ),
                target_id=item.target_id,
                details={"signature": sig, "index": idx},
            )
        if sig in batch_signatures:
            raise DisruptionValidationError(
                code="DUPLICATE_DISRUPTION",
                message=f"Duplicate disruption '{sig}' within the same replan request.",
                target_id=item.target_id,
                details={"signature": sig, "index": idx},
            )
        batch_signatures.add(sig)

        if item.type == "train_delay":
            tid = item.train_id or item.target_id
            assert tid is not None
            if tid not in trains_by_id:
                raise DisruptionValidationError(
                    code="UNKNOWN_TRAIN",
                    message=f"Train '{tid}' does not exist in this scenario.",
                    target_id=tid,
                    details={"index": idx},
                )
            if tid in batch_delayed_trains:
                raise DisruptionValidationError(
                    code="CONTRADICTORY_TRAIN_DELAY",
                    message=(
                        f"Multiple train_delay events target train '{tid}' in the same replan request. "
                        "Provide a single consolidated delay for each train per revision."
                    ),
                    target_id=tid,
                    details={"index": idx},
                )
            batch_delayed_trains.add(tid)

            train = trains_by_id[tid]
            if train.departed:
                raise DisruptionValidationError(
                    code="DEPARTED_TRAIN_IMMUTABLE",
                    message=f"Train '{tid}' has already departed and cannot be delayed or retimed.",
                    target_id=tid,
                    details={"index": idx},
                )
            if train.fixed:
                raise DisruptionValidationError(
                    code="FIXED_TRAIN_IMMUTABLE",
                    message=f"Train '{tid}' is marked operationally fixed and cannot be delayed or retimed.",
                    target_id=tid,
                    details={"index": idx},
                )

        elif item.type == "platform_closure":
            pid = item.platform_id or item.target_id
            assert pid is not None
            if pid not in platforms_by_id:
                raise DisruptionValidationError(
                    code="UNKNOWN_PLATFORM",
                    message=f"Platform '{pid}' does not exist in this scenario.",
                    target_id=pid,
                    details={"index": idx},
                )
            if item.start is None or item.end is None or item.start >= item.end:
                raise DisruptionValidationError(
                    code="INVALID_CLOSURE_INTERVAL",
                    message=f"Platform closure on '{pid}' must satisfy 0 <= start < end <= 1440.",
                    target_id=pid,
                    details={"index": idx},
                )

    # Pass 2: Build records and verify cumulative timing horizon & dwell preservation
    now_iso = datetime.now(timezone.utc).isoformat()
    newly_applied: list[DisruptionRecord] = []
    for item in new_disruptions:
        rec_id = item.id or f"disr-{uuid.uuid4().hex[:8]}"
        newly_applied.append(
            DisruptionRecord(
                id=rec_id,
                type=item.type,
                target_id=item.target_id or (item.train_id or item.platform_id or ""),
                train_id=item.train_id,
                platform_id=item.platform_id,
                delay_minutes=item.delay_minutes,
                start=item.start,
                end=item.end,
                start_str=format_minutes(item.start) if item.start is not None else None,
                end_str=format_minutes(item.end) if item.end is not None else None,
                confirmation_status="confirmed",
                application_status="applied",
                source_version_id=source_version_id,
                created_at=now_iso,
            )
        )

    cumulative = list(baseline_disruptions) + newly_applied
    state = compute_effective_state_from_records(
        trains=trains,
        platforms=platforms,
        applied_disruptions=cumulative,
    )

    # Verify service-day horizon and dwell preservation for all trains after cumulative delays
    for tid, spec in state.effective_trains.items():
        orig_dwell = spec.train.departure - spec.train.arrival
        new_dwell = spec.effective_departure - spec.effective_arrival
        if new_dwell != orig_dwell:
            raise DisruptionValidationError(
                code="DWELL_TIME_CHANGED",
                message=f"Disruption altered dwell time for train '{tid}' ({orig_dwell} -> {new_dwell}).",
                target_id=tid,
            )
        if (
            spec.effective_arrival < SERVICE_DAY_START
            or spec.effective_departure > SERVICE_DAY_END
            or spec.effective_arrival >= spec.effective_departure
        ):
            raise DisruptionValidationError(
                code="HORIZON_EXCEEDED",
                message=(
                    f"Applying delay of {spec.disruption_delay_minutes} min to train '{tid}' pushes its "
                    f"schedule ({format_minutes(spec.effective_arrival)}-{format_minutes(spec.effective_departure)}) "
                    f"beyond the supported service-day horizon [00:00, 24:00]."
                ),
                target_id=tid,
            )

    return EffectiveDisruptionState(
        newly_applied_records=newly_applied,
        cumulative_disruptions=cumulative,
        effective_trains=state.effective_trains,
        closures_by_platform=state.closures_by_platform,
        directly_affected_train_ids=state.directly_affected_train_ids,
    )
