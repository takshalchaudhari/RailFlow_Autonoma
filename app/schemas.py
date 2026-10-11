"""Domain models, time utilities, and API schemas for RailFlow."""

from __future__ import annotations

import re
from typing import Annotated, Any, Literal, Optional
from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    computed_field,
    model_validator,
)

SERVICE_DAY_START = 0
SERVICE_DAY_END = 1440  # 24:00 in integer minutes from midnight

_TIME_STR_PATTERN = re.compile(r"^(\d{2}):(\d{2})$")


def parse_time_input(value: Any) -> int:
    """Parse an integer minute value [0, 1440] or 'HH:MM' string into integer minutes from midnight."""
    if isinstance(value, bool):
        raise ValueError("Boolean value is not a valid time.")
    if isinstance(value, int):
        if value < SERVICE_DAY_START or value > SERVICE_DAY_END:
            raise ValueError(
                f"Time in minutes ({value}) must be within service day horizon [{SERVICE_DAY_START}, {SERVICE_DAY_END}]."
            )
        return value
    if isinstance(value, str):
        stripped = value.strip()
        match = _TIME_STR_PATTERN.match(stripped)
        if not match:
            raise ValueError(
                f"Invalid time format '{value}'. Expected 'HH:MM' (e.g., '09:00') or integer minutes [0, 1440]."
            )
        hours = int(match.group(1))
        minutes = int(match.group(2))
        if hours == 24 and minutes == 0:
            return SERVICE_DAY_END
        if hours < 0 or hours > 23 or minutes < 0 or minutes > 59:
            raise ValueError(
                f"Invalid time '{value}'. Hours must be 00..23 and minutes 00..59 (or 24:00)."
            )
        return hours * 60 + minutes
    raise ValueError(
        f"Unsupported time representation '{value}' (type {type(value).__name__}). Use integer minutes or 'HH:MM'."
    )


def format_minutes(minutes: int) -> str:
    """Format integer minutes from midnight into 'HH:MM' string."""
    if minutes < 0:
        sign = "-"
        abs_m = abs(minutes)
        return f"{sign}{abs_m // 60:02d}:{abs_m % 60:02d}"
    hours = minutes // 60
    mins = minutes % 60
    return f"{hours:02d}:{mins:02d}"


TimeMinutes = Annotated[int, BeforeValidator(parse_time_input)]

SolverStatus = Literal[
    "BASELINE",
    "MANUAL",
    "OPTIMAL",
    "FEASIBLE",
    "INFEASIBLE",
    "UNKNOWN",
]

ValidationStatus = Literal[
    "VALID",
    "INVALID",
    "PARTIAL",
    "INFEASIBLE",
    "UNKNOWN",
]

DisruptionType = Literal["train_delay", "platform_closure"]
ConfirmationStatus = Literal["proposed", "confirmed", "rejected"]
ApplicationStatus = Literal["pending", "applied", "rejected"]


class Station(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(..., min_length=1, description="Unique station identifier")
    name: str = Field(..., min_length=1, description="Human-readable station name")
    timezone: str = Field(default="UTC", min_length=1, description="IANA timezone for display")


class Platform(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(..., min_length=1, description="Unique platform identifier (e.g. P1)")
    station_id: Optional[str] = Field(default=None, description="Owning station ID")
    min_gap_minutes: Optional[int] = Field(
        default=None,
        ge=0,
        le=240,
        description="Platform-specific clearance gap in minutes; overrides scenario default when set",
    )


class Train(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(..., min_length=1, description="Unique train identifier (e.g. T101)")
    arrival: TimeMinutes = Field(..., description="Scheduled arrival in minutes from midnight or HH:MM")
    departure: TimeMinutes = Field(..., description="Scheduled departure in minutes from midnight or HH:MM")
    platform_id: Optional[str] = Field(
        default=None,
        description="Initial assigned platform ID, or None if initially unassigned",
    )
    allowed_platforms: Optional[list[str]] = Field(
        default=None,
        description="Explicit list of permitted platform IDs. None means any platform is permitted.",
    )
    required_platform: Optional[str] = Field(
        default=None,
        description="Mandatory platform ID required for this train, if any",
    )
    fixed: bool = Field(
        default=False,
        description="If True, train cannot be retimed or moved to another platform",
    )
    departed: bool = Field(
        default=False,
        description="If True, train has already departed and cannot be retimed or moved",
    )

    @computed_field
    @property
    def arrival_str(self) -> str:
        return format_minutes(self.arrival)

    @computed_field
    @property
    def departure_str(self) -> str:
        return format_minutes(self.departure)

    @computed_field
    @property
    def dwell_minutes(self) -> int:
        return self.departure - self.arrival

    @model_validator(mode="after")
    def validate_train_invariants(self) -> "Train":
        if self.arrival >= self.departure:
            raise ValueError(
                f"Train '{self.id}': arrival ({self.arrival} / {format_minutes(self.arrival)}) "
                f"must strictly precede departure ({self.departure} / {format_minutes(self.departure)})."
            )
        if self.allowed_platforms is not None:
            if len(self.allowed_platforms) == 0:
                raise ValueError(
                    f"Train '{self.id}': allowed_platforms cannot be an empty list (no permitted platforms). "
                    "Omit allowed_platforms or set to null if unrestricted."
                )
            if len(set(self.allowed_platforms)) != len(self.allowed_platforms):
                raise ValueError(
                    f"Train '{self.id}': allowed_platforms contains duplicate platform IDs."
                )
        if self.required_platform is not None and self.allowed_platforms is not None:
            if self.required_platform not in self.allowed_platforms:
                raise ValueError(
                    f"Train '{self.id}': required_platform '{self.required_platform}' is not present "
                    f"in allowed_platforms {self.allowed_platforms}."
                )
        if self.platform_id is not None:
            if self.required_platform is not None and self.platform_id != self.required_platform:
                raise ValueError(
                    f"Train '{self.id}': initial platform_id '{self.platform_id}' conflicts with "
                    f"required_platform '{self.required_platform}'."
                )
            if self.allowed_platforms is not None and self.platform_id not in self.allowed_platforms:
                raise ValueError(
                    f"Train '{self.id}': initial platform_id '{self.platform_id}' is not in "
                    f"allowed_platforms {self.allowed_platforms}."
                )
        if (self.fixed or self.departed) and self.platform_id is None:
            raise ValueError(
                f"Train '{self.id}': fixed or departed trains must have an initial platform_id assigned."
            )
        return self


class ScenarioCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Optional[str] = Field(default=None, description="Optional scenario ID")
    name: Optional[str] = Field(default=None, description="Optional scenario label")
    description: Optional[str] = Field(default=None, description="Optional scenario description")
    station: Station
    default_min_gap_minutes: int = Field(
        default=10,
        ge=0,
        le=240,
        description="Default minimum clearance gap between trains on the same platform",
    )
    platforms: list[Platform] = Field(..., min_length=1)
    trains: list[Train] = Field(..., min_length=1)
    solve_initial_if_unassigned: bool = Field(
        default=False,
        description="If True and some trains lack initial platform_id, run CP-SAT to compute initial baseline",
    )

    @model_validator(mode="after")
    def validate_scenario_references(self) -> "ScenarioCreateRequest":
        platform_ids: list[str] = [p.id for p in self.platforms]
        if len(set(platform_ids)) != len(platform_ids):
            raise ValueError("Duplicate platform IDs are not allowed in a scenario.")
        platform_set = set(platform_ids)

        for p in self.platforms:
            if p.station_id is None:
                p.station_id = self.station.id
            elif p.station_id != self.station.id:
                raise ValueError(
                    f"Platform '{p.id}' station_id '{p.station_id}' does not match station '{self.station.id}'."
                )

        train_ids: list[str] = [t.id for t in self.trains]
        if len(set(train_ids)) != len(train_ids):
            raise ValueError("Duplicate train IDs are not allowed in a scenario.")

        for t in self.trains:
            if t.platform_id is not None and t.platform_id not in platform_set:
                raise ValueError(
                    f"Train '{t.id}' references unknown initial platform_id '{t.platform_id}'."
                )
            if t.required_platform is not None and t.required_platform not in platform_set:
                raise ValueError(
                    f"Train '{t.id}' references unknown required_platform '{t.required_platform}'."
                )
            if t.allowed_platforms is not None:
                unknown = [pid for pid in t.allowed_platforms if pid not in platform_set]
                if unknown:
                    raise ValueError(
                        f"Train '{t.id}' allowed_platforms contains unknown platform ID(s): {unknown}."
                    )
        return self


class DisruptionInput(BaseModel):
    """Structured disruption input for manual or confirmed replanning."""

    model_config = ConfigDict(extra="forbid")

    id: Optional[str] = Field(default=None, description="Optional client-provided disruption ID")
    type: DisruptionType
    target_id: Optional[str] = Field(
        default=None,
        description="Target entity ID (train_id for train_delay, platform_id for platform_closure)",
    )
    train_id: Optional[str] = Field(default=None, description="Train ID for train_delay")
    platform_id: Optional[str] = Field(default=None, description="Platform ID for platform_closure")
    delay_minutes: Optional[int] = Field(default=None, description="Delay in integer minutes (> 0)")
    start: Optional[TimeMinutes] = Field(default=None, description="Closure start in minutes or HH:MM")
    end: Optional[TimeMinutes] = Field(default=None, description="Closure end in minutes or HH:MM")
    start_time: Optional[str] = Field(default=None, description="Alias for start in HH:MM format")
    end_time: Optional[str] = Field(default=None, description="Alias for end in HH:MM format")

    @model_validator(mode="after")
    def validate_disruption_fields(self) -> "DisruptionInput":
        # Normalize start_time / end_time aliases if provided
        parsed_start_time: Optional[int] = (
            parse_time_input(self.start_time) if self.start_time is not None else None
        )
        parsed_end_time: Optional[int] = (
            parse_time_input(self.end_time) if self.end_time is not None else None
        )

        if self.start is None and parsed_start_time is not None:
            self.start = parsed_start_time
        elif (
            self.start is not None
            and parsed_start_time is not None
            and self.start != parsed_start_time
        ):
            raise ValueError("Conflicting 'start' and 'start_time' values in disruption input.")

        if self.end is None and parsed_end_time is not None:
            self.end = parsed_end_time
        elif (
            self.end is not None
            and parsed_end_time is not None
            and self.end != parsed_end_time
        ):
            raise ValueError("Conflicting 'end' and 'end_time' values in disruption input.")

        if self.type == "train_delay":
            self.start_time = None
            self.end_time = None
            if self.platform_id is not None:
                raise ValueError(
                    "train_delay event cannot specify 'platform_id' (platform assignment via disruption is forbidden)."
                )
            if self.start is not None or self.end is not None:
                raise ValueError("train_delay event cannot specify closure 'start' or 'end' fields.")
            resolved_train = self.train_id or self.target_id
            if not resolved_train:
                raise ValueError("train_delay event requires 'train_id' or 'target_id'.")
            if self.train_id and self.target_id and self.train_id != self.target_id:
                raise ValueError(
                    f"Conflicting train_id '{self.train_id}' and target_id '{self.target_id}'."
                )
            if self.delay_minutes is None:
                raise ValueError("train_delay event requires 'delay_minutes'.")
            if self.delay_minutes <= 0 or self.delay_minutes > SERVICE_DAY_END:
                raise ValueError("delay_minutes must be a positive integer within (0, 1440].")
            self.train_id = resolved_train
            self.target_id = resolved_train

        elif self.type == "platform_closure":
            if self.train_id is not None:
                raise ValueError("platform_closure event cannot specify 'train_id'.")
            if self.delay_minutes is not None:
                raise ValueError("platform_closure event cannot specify 'delay_minutes'.")
            resolved_platform = self.platform_id or self.target_id
            if not resolved_platform:
                raise ValueError("platform_closure event requires 'platform_id' or 'target_id'.")
            if self.platform_id and self.target_id and self.platform_id != self.target_id:
                raise ValueError(
                    f"Conflicting platform_id '{self.platform_id}' and target_id '{self.target_id}'."
                )
            if self.start is None or self.end is None:
                raise ValueError("platform_closure event requires both 'start' and 'end' times.")
            if self.start >= self.end:
                raise ValueError(
                    f"platform_closure 'start' ({self.start} / {format_minutes(self.start)}) "
                    f"must strictly precede 'end' ({self.end} / {format_minutes(self.end)})."
                )
            self.platform_id = resolved_platform
            self.target_id = resolved_platform
            self.start_time = format_minutes(self.start)
            self.end_time = format_minutes(self.end)

        return self

    def signature(self) -> str:
        """Canonical semantic signature to detect duplicate disruptions."""
        if self.type == "train_delay":
            return f"train_delay:{self.target_id}:{self.delay_minutes}"
        return f"platform_closure:{self.target_id}:{self.start}:{self.end}"


class DisruptionRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    type: DisruptionType
    target_id: str
    train_id: Optional[str] = None
    platform_id: Optional[str] = None
    delay_minutes: Optional[int] = None
    start: Optional[int] = None
    end: Optional[int] = None
    start_str: Optional[str] = None
    end_str: Optional[str] = None
    confirmation_status: ConfirmationStatus = "confirmed"
    application_status: ApplicationStatus = "applied"
    source_version_id: Optional[str] = None
    created_at: str

    def signature(self) -> str:
        if self.type == "train_delay":
            return f"train_delay:{self.target_id}:{self.delay_minutes}"
        return f"platform_closure:{self.target_id}:{self.start}:{self.end}"


class TrainAssignment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    train_id: str
    platform_id: Optional[str] = None
    arrival: int
    departure: int
    arrival_str: str
    departure_str: str
    baseline_arrival: int
    baseline_departure: int
    effective_arrival: int
    effective_departure: int
    disruption_delay_minutes: int = 0
    additional_delay_minutes: int = 0
    total_delay_minutes: int = 0
    fixed: bool = False
    departed: bool = False
    unresolved: bool = False
    unresolved_reason: Optional[str] = None


class ChangeRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    train_id: str
    previous_platform: Optional[str] = None
    proposed_platform: Optional[str] = None
    previous_arrival: int
    previous_departure: int
    proposed_arrival: int
    proposed_departure: int
    previous_arrival_str: str
    previous_departure_str: str
    proposed_arrival_str: str
    proposed_departure_str: str
    disruption_delay_minutes: int = 0
    additional_delay_minutes: int = 0
    platform_changed: bool = False
    timing_changed: bool = False
    unresolved: bool = False
    reason: str
    associated_disruption_ids: list[str] = Field(default_factory=list)


class ValidationErrorItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    message: str
    platform_id: Optional[str] = None
    train_ids: list[str] = Field(default_factory=list)
    required_gap_minutes: Optional[int] = None
    actual_gap_minutes: Optional[int] = None
    time_interval: Optional[tuple[int, int]] = None
    rule: Optional[str] = None


class ValidationRun(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    version_id: str
    validation_status: ValidationStatus
    is_complete: bool
    errors: list[ValidationErrorItem] = Field(default_factory=list)
    unresolved_train_ids: list[str] = Field(default_factory=list)
    validated_at: str


class ObjectiveMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid")

    unresolved_count: int = 0
    total_additional_delay_minutes: int = 0
    platform_changes_count: int = 0
    unaffected_train_changes_count: int = 0
    solve_time_ms: float = 0.0
    is_diagnostic_partial: bool = False


class ScheduleVersion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    scenario_id: str
    version_number: int
    parent_version_id: Optional[str] = None
    solver_status: SolverStatus
    validation_status: ValidationStatus
    is_complete: bool
    created_at: str
    assignments: list[TrainAssignment]
    changes: list[ChangeRecord]
    applied_disruptions: list[DisruptionRecord]
    newly_applied_disruptions: list[DisruptionRecord] = Field(default_factory=list)
    validation_findings: list[ValidationErrorItem]
    unresolved_trains: list[str] = Field(default_factory=list)
    objective_metrics: Optional[ObjectiveMetrics] = None


class ScenarioResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    description: Optional[str] = None
    station: Station
    default_min_gap_minutes: int
    platforms: list[Platform]
    trains: list[Train]
    active_version_id: str
    latest_version_number: int
    created_at: str
    active_schedule_version: Optional[ScheduleVersion] = None


class ReplanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirmed: bool = Field(
        ...,
        description="Operator confirmation flag. Must be True for replanning to proceed.",
    )
    baseline_version_id: str = Field(
        ...,
        min_length=1,
        description="Explicit baseline schedule version ID to branch from.",
    )
    expected_active_version_id: Optional[str] = Field(
        default=None,
        description="Optional optimistic-concurrency check against the scenario's current active_version_id.",
    )
    disruptions: list[DisruptionInput] = Field(..., min_length=1)
    solver_time_limit_seconds: float = Field(default=5.0, gt=0.0, le=60.0)
    max_additional_delay_minutes: int = Field(default=180, ge=0, le=720)
    allow_partial_diagnostic: bool = Field(
        default=True,
        description="If True and full problem is proven INFEASIBLE, produce a diagnostic PARTIAL candidate.",
    )


class ManualAssignmentItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    train_id: str = Field(..., min_length=1)
    platform_id: Optional[str] = None
    arrival: TimeMinutes
    departure: TimeMinutes


class ManualAssignRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    baseline_version_id: str = Field(..., min_length=1)
    assignments: list[ManualAssignmentItem] = Field(..., min_length=1)
    save_as_diagnostic: bool = Field(
        default=False,
        description="If True, persist invalid/partial manual candidates as diagnostic revisions (never marked VALID).",
    )
    reason: str = Field(default="Operator manual assignment proposal")


class AuditEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    scenario_id: Optional[str] = None
    version_id: Optional[str] = None
    actor: str
    action: str
    details: dict[str, Any]
    timestamp: str
