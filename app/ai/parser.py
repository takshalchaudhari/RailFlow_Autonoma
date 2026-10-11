"""AI disruption parser and safeguard enforcement layer (STEP I).

Validates all AI and fallback parser outputs against the active scenario's trains and platforms.
Strictly rejects any AI output that attempts to assign platforms, inject schedule overrides,
reference non-existent entities, or bypass operator confirmation.
"""

from __future__ import annotations

import json
import os
from typing import Any, Literal, Optional
from urllib import request as urllib_request
from pydantic import ValidationError

from app.ai.fallback_parser import ForbiddenAIParsingError, parse_disruption_text_offline
from app.ai.schemas import (
    DisruptionParseResponse,
    ParsedPlatformClosureEvent,
    ParsedTrainDelayEvent,
    RawLLMParsePayload,
)
from app.schemas import DisruptionInput, Platform, Train

_FORBIDDEN_KEYS = {
    "assignments",
    "platform_assignments",
    "proposed_platform",
    "assigned_platform",
    "schedule",
    "timetable",
    "override_validation",
    "validation_status",
    "solver_status",
}


def validate_ai_proposal_against_scenario(
    raw_payload: dict[str, Any] | RawLLMParsePayload,
    trains: list[Train],
    platforms: list[Platform],
    raw_text: str = "",
    parser_mode: Literal["deterministic_fallback", "llm_assisted"] = "deterministic_fallback",
) -> DisruptionParseResponse:
    """
    Validate a raw LLM or fallback parse payload against the scenario and strict AI safety rules.
    Raises ForbiddenAIParsingError on any boundary violation, unknown entity, or contradictory event.
    """
    if isinstance(raw_payload, dict):
        # 1. Check top-level keys for forbidden schedule/assignment fields
        illegal_top = set(raw_payload.keys()) & _FORBIDDEN_KEYS
        if illegal_top:
            raise ForbiddenAIParsingError(
                code="AI_PLATFORM_ASSIGNMENT_FORBIDDEN",
                message=(
                    f"AI output contains forbidden schedule/assignment fields: {sorted(illegal_top)}. "
                    "AI is strictly prohibited from assigning platforms or modifying timetables."
                ),
            )
        # 2. Check event-level keys for forbidden platform assignment fields on train delays
        raw_events = raw_payload.get("events", [])
        if isinstance(raw_events, list):
            for ev in raw_events:
                if isinstance(ev, dict):
                    ev_illegal = set(ev.keys()) & _FORBIDDEN_KEYS
                    if ev_illegal:
                        raise ForbiddenAIParsingError(
                            code="AI_PLATFORM_ASSIGNMENT_FORBIDDEN",
                            message=(
                                f"AI event contains forbidden assignment fields: {sorted(ev_illegal)}."
                            ),
                        )
                    if ev.get("type") == "train_delay" and "platform_id" in ev:
                        raise ForbiddenAIParsingError(
                            code="AI_PLATFORM_ASSIGNMENT_FORBIDDEN",
                            message="AI train_delay event cannot include 'platform_id' (platform assignment by AI is forbidden).",
                        )
        if raw_payload.get("requires_confirmation") is False:
            raise ForbiddenAIParsingError(
                code="CONFIRMATION_BYPASS_FORBIDDEN",
                message="AI output attempted to set requires_confirmation=False. Operator confirmation is mandatory.",
            )

        try:
            parsed_model = RawLLMParsePayload.model_validate(raw_payload)
        except ValidationError as exc:
            raise ForbiddenAIParsingError(
                code="INVALID_AI_SCHEMA",
                message=f"AI output failed strict schema validation: {exc}",
            ) from exc
    else:
        parsed_model = raw_payload

    trains_by_id = {t.id: t for t in trains}
    platforms_by_id = {p.id: p for p in platforms}

    seen_delayed_trains: dict[str, int] = {}
    normalized: list[DisruptionInput] = []

    for ev in parsed_model.events:
        if isinstance(ev, ParsedTrainDelayEvent):
            if ev.train_id not in trains_by_id:
                raise ForbiddenAIParsingError(
                    code="UNKNOWN_TRAIN",
                    message=f"Parsed disruption references unknown train '{ev.train_id}'.",
                )
            train_obj = trains_by_id[ev.train_id]
            if train_obj.fixed:
                raise ForbiddenAIParsingError(
                    code="FIXED_TRAIN_IMMUTABLE",
                    message=f"Parsed disruption attempts to delay operationally fixed train '{ev.train_id}'.",
                )
            if train_obj.departed:
                raise ForbiddenAIParsingError(
                    code="DEPARTED_TRAIN_IMMUTABLE",
                    message=f"Parsed disruption attempts to delay already-departed train '{ev.train_id}'.",
                )
            if ev.train_id in seen_delayed_trains:
                raise ForbiddenAIParsingError(
                    code="CONTRADICTORY_DISRUPTION_INPUT",
                    message=(
                        f"Contradictory or duplicate delay events parsed for train '{ev.train_id}' "
                        f"({seen_delayed_trains[ev.train_id]} min vs {ev.delay_minutes} min)."
                    ),
                )
            seen_delayed_trains[ev.train_id] = ev.delay_minutes
            normalized.append(
                DisruptionInput(
                    type="train_delay",
                    train_id=ev.train_id,
                    delay_minutes=ev.delay_minutes,
                )
            )

        elif isinstance(ev, ParsedPlatformClosureEvent):
            if ev.platform_id not in platforms_by_id:
                raise ForbiddenAIParsingError(
                    code="UNKNOWN_PLATFORM",
                    message=f"Parsed disruption references unknown platform '{ev.platform_id}'.",
                )
            normalized.append(
                DisruptionInput(
                    type="platform_closure",
                    platform_id=ev.platform_id,
                    start=ev.start_time,
                    end=ev.end_time,
                )
            )

    warnings: list[str] = []
    if parsed_model.ambiguous:
        warnings.append(
            "Input contains ambiguous or incomplete clauses; review clarification_needed before confirming."
        )

    return DisruptionParseResponse(
        raw_text=raw_text,
        parser_mode=parser_mode,
        events=parsed_model.events,
        normalized_disruptions=normalized,
        requires_confirmation=True,
        applied=False,
        ambiguous=parsed_model.ambiguous,
        clarification_needed=parsed_model.clarification_needed,
        warnings=warnings,
    )


def _get_env_or_dotenv(var_name: str, default: str = "") -> str:
    val = os.environ.get(var_name, "").strip()
    if val:
        return val
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env")
    if os.path.isfile(env_path):
        try:
            with open(env_path, "r", encoding="utf-8") as fh:
                for raw_line in fh:
                    line = raw_line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    if k.strip() == var_name:
                        return v.strip().strip('"').strip("'")
        except OSError:
            pass
    return default


def _is_external_llm_configured() -> bool:
    provider = _get_env_or_dotenv("RAILFLOW_LLM_PROVIDER", "none").lower()
    api_key = _get_env_or_dotenv("RAILFLOW_LLM_API_KEY", "")
    if provider in ("", "none", "disabled", "offline"):
        return False
    if not api_key or api_key.startswith("your_"):
        return False
    return True


def _call_optional_llm_parser(
    text: str,
    trains: list[Train],
    platforms: list[Platform],
) -> Optional[dict[str, Any]]:
    """
    Optional external LLM call using standard library urllib (no mandatory paid SDK dependency).
    Never logs credentials. Returns None if unavailable so the deterministic parser handles the request.
    """
    if not _is_external_llm_configured():
        return None

    api_key = _get_env_or_dotenv("RAILFLOW_LLM_API_KEY", "")
    base_url = _get_env_or_dotenv("RAILFLOW_LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model_name = _get_env_or_dotenv("RAILFLOW_LLM_MODEL", "gpt-4o-mini")

    known_trains = [t.id for t in trains]
    known_platforms = [p.id for p in platforms]
    system_prompt = (
        "You are a strict railway disruption parser. Convert the user's text into JSON matching "
        '{"events": [...], "ambiguous": bool, "clarification_needed": [...], "requires_confirmation": true}. '
        "Allowed event types: 'train_delay' (fields: type, train_id, delay_minutes) and "
        "'platform_closure' (fields: type, platform_id, start_time, end_time in HH:MM). "
        f"Known trains: {known_trains}. Known platforms: {known_platforms}. "
        "NEVER assign platforms to trains."
    )

    body = json.dumps(
        {
            "model": model_name,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.0,
        }
    ).encode("utf-8")

    req = urllib_request.Request(
        f"{base_url}/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib_request.urlopen(req, timeout=4.0) as resp:
            resp_data = json.loads(resp.read().decode("utf-8"))
            content = resp_data["choices"][0]["message"]["content"]
            return json.loads(content)
    except Exception:
        return None


def parse_natural_language_disruption(
    text: str,
    trains: list[Train],
    platforms: list[Platform],
    prefer_llm: bool = True,
) -> DisruptionParseResponse:
    """
    Parse natural-language disruption text into a validated, unconfirmed proposal.
    Uses optional LLM only if configured and requested; otherwise uses the deterministic fallback parser.
    """
    if prefer_llm and _is_external_llm_configured():
        raw_llm = _call_optional_llm_parser(text, trains, platforms)
        if raw_llm is not None:
            return validate_ai_proposal_against_scenario(
                raw_payload=raw_llm,
                trains=trains,
                platforms=platforms,
                raw_text=text,
                parser_mode="llm_assisted",
            )

    offline_payload = parse_disruption_text_offline(text)
    return validate_ai_proposal_against_scenario(
        raw_payload=offline_payload,
        trains=trains,
        platforms=platforms,
        raw_text=text,
        parser_mode="deterministic_fallback",
    )
