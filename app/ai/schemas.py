"""Strict Pydantic schemas for Phase 2 AI disruption parsing and schedule explanation (STEP I).

Enforces `ConfigDict(extra="forbid")` on all AI output structures so any attempt by an LLM
to emit platform assignments, schedule overrides, or validation verdicts is rejected at parse time.
"""

from __future__ import annotations

from typing import Annotated, Literal, Optional, Union
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas import (
    DisruptionInput,
    SolverStatus,
    ValidationStatus,
    format_minutes,
    parse_time_input,
)


class ParsedTrainDelayEvent(BaseModel):
    """Proposed train delay event produced by the NL parser. Forbids any platform fields."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["train_delay"] = "train_delay"
    train_id: str = Field(..., min_length=1)
    delay_minutes: int = Field(..., gt=0, le=1440)


class ParsedPlatformClosureEvent(BaseModel):
    """Proposed platform closure event produced by the NL parser. Forbids any train fields."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["platform_closure"] = "platform_closure"
    platform_id: str = Field(..., min_length=1)
    start_time: str = Field(..., min_length=4)
    end_time: str = Field(..., min_length=4)

    @model_validator(mode="after")
    def validate_closure_times(self) -> "ParsedPlatformClosureEvent":
        start_min = parse_time_input(self.start_time)
        end_min = parse_time_input(self.end_time)
        if start_min >= end_min:
            raise ValueError(
                f"Closure start_time '{self.start_time}' must strictly precede end_time '{self.end_time}'."
            )
        self.start_time = format_minutes(start_min)
        self.end_time = format_minutes(end_min)
        return self


ParsedDisruptionEvent = Annotated[
    Union[ParsedTrainDelayEvent, ParsedPlatformClosureEvent],
    Field(discriminator="type"),
]


class RawLLMParsePayload(BaseModel):
    """Schema used to validate raw JSON output from an external LLM before scenario checks."""

    model_config = ConfigDict(extra="forbid")

    events: list[ParsedDisruptionEvent] = Field(default_factory=list)
    ambiguous: bool = False
    clarification_needed: list[str] = Field(default_factory=list)
    requires_confirmation: Literal[True] = True


class DisruptionParseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(..., min_length=1, max_length=2000)
    prefer_llm: bool = Field(
        default=True,
        description="Use optional external LLM when configured; automatically falls back to deterministic offline parser.",
    )


class DisruptionParseResponse(BaseModel):
    """Unconfirmed structured disruption proposal returned by POST /api/scenarios/{id}/disruptions/parse."""

    model_config = ConfigDict(extra="forbid")

    raw_text: str
    parser_mode: Literal["deterministic_fallback", "llm_assisted"]
    events: list[ParsedDisruptionEvent] = Field(default_factory=list)
    normalized_disruptions: list[DisruptionInput] = Field(default_factory=list)
    requires_confirmation: Literal[True] = True
    applied: Literal[False] = False
    ambiguous: bool = False
    clarification_needed: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class ScheduleExplanationResponse(BaseModel):
    """Grounded, read-only plain-language explanation of a schedule revision."""

    model_config = ConfigDict(extra="forbid")

    scenario_id: str
    version_id: str
    parent_version_id: Optional[str] = None
    explainer_mode: Literal["deterministic_grounded", "llm_grounded"]
    solver_status: SolverStatus
    validation_status: ValidationStatus
    is_complete: bool
    summary: str
    change_explanations: list[str] = Field(default_factory=list)
    unresolved_explanations: list[str] = Field(default_factory=list)
    validation_explanations: list[str] = Field(default_factory=list)
    tradeoff_notes: list[str] = Field(default_factory=list)
    read_only_verified: Literal[True] = True
