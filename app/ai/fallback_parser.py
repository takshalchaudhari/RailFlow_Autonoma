"""Deterministic offline natural-language disruption parser (STEP I).

Parses common single and compound disruption statements without requiring an LLM or API key.
Detects ambiguity, missing parameters, and forbidden platform-assignment commands.
"""

from __future__ import annotations

import re

from app.ai.schemas import (
    ParsedDisruptionEvent,
    ParsedPlatformClosureEvent,
    ParsedTrainDelayEvent,
    RawLLMParsePayload,
)
from app.schemas import format_minutes, parse_time_input

# Detect attempts to command platform assignments via natural language
_FORBIDDEN_ASSIGNMENT_PATTERNS = [
    re.compile(
        r"\b(?:assign|move|reroute|switch|put|allocate|schedule)\b.*\b(?:to|on|onto)\s+platform\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bplatform\s+[A-Za-z0-9_-]+\s+for\s+train\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:assign|move|reroute|switch|put|allocate)\s+train\s+[A-Za-z0-9_-]+\s+(?:to|on|onto)\s+[A-Za-z0-9_-]+",
        re.IGNORECASE,
    ),
]

# Match full train delay clauses, e.g.:
# "Train T103 is delayed by 20 minutes"
# "Delay train T103 by 15 minutes"
# "T101 delayed 20 mins"
_TRAIN_DELAY_FULL_PATTERNS = [
    re.compile(
        r"\b(?:delay\s+)?(?:train\s+)?(?P<train_id>[A-Za-z]+\d+[A-Za-z0-9_-]*)\s+"
        r"(?:is\s+)?(?:delayed|late)\s+(?:by\s+)?(?P<minutes>-?\d+)\s*(?:minutes?|mins?|m)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bdelay\s+(?:train\s+)?(?P<train_id>[A-Za-z]+\d+[A-Za-z0-9_-]*)\s+"
        r"(?:by\s+|for\s+)?(?P<minutes>-?\d+)\s*(?:minutes?|mins?|m)\b",
        re.IGNORECASE,
    ),
]

# Match full platform closure clauses, e.g.:
# "platform P2 is closed from 09:30 to 10:20"
# "close platform P2 from 09:30 to 10:20"
# "P2 closed 09:30-10:20"
_PLATFORM_CLOSURE_FULL_PATTERNS = [
    re.compile(
        r"\b(?:close\s+)?(?:platform\s+)?(?P<platform_id>P\d+[A-Za-z0-9_-]*)\s+"
        r"(?:is\s+)?(?:closed|unavailable|blocked)\s+"
        r"(?:from\s+|between\s+)?(?P<start>\d{1,2}:\d{2})\s*(?:to|until|and|-|–)\s*(?P<end>\d{1,2}:\d{2})",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bclose\s+(?:platform\s+)?(?P<platform_id>[A-Za-z0-9_-]+)\s+"
        r"(?:from\s+|between\s+)?(?P<start>\d{1,2}:\d{2})\s*(?:to|until|and|-|–)\s*(?P<end>\d{1,2}:\d{2})",
        re.IGNORECASE,
    ),
    re.compile(
        r"\bplatform\s+(?P<platform_id>[A-Za-z0-9_-]+)\s+(?:is\s+)?(?:closed|unavailable|blocked)\s+"
        r"(?:from\s+|between\s+)?(?P<start>\d{1,2}:\d{2})\s*(?:to|until|and|-|–)\s*(?P<end>\d{1,2}:\d{2})",
        re.IGNORECASE,
    ),
]


class ForbiddenAIParsingError(Exception):
    """Raised when input or AI output attempts to specify platform assignments or bypass constraints."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _normalize_hhmm(raw: str) -> str:
    """Normalize '9:30' or '09:30' if valid, or raise ValueError."""
    parts = raw.strip().split(":")
    if len(parts) == 2 and len(parts[0]) == 1 and parts[0].isdigit():
        raw = f"0{parts[0]}:{parts[1]}"
    minutes = parse_time_input(raw)
    return format_minutes(minutes)


def parse_disruption_text_offline(text: str) -> RawLLMParsePayload:
    """
    Deterministically parse natural-language disruption text into structured events.
    Never invents missing times or IDs; sets `ambiguous=True` with `clarification_needed` when incomplete.
    """
    cleaned = text.strip()
    if not cleaned:
        return RawLLMParsePayload(
            events=[],
            ambiguous=True,
            clarification_needed=["Disruption text is empty. Please describe the train delay or platform closure."],
        )

    for pattern in _FORBIDDEN_ASSIGNMENT_PATTERNS:
        if pattern.search(cleaned):
            raise ForbiddenAIParsingError(
                code="AI_PLATFORM_ASSIGNMENT_FORBIDDEN",
                message=(
                    "AI/natural-language parser is forbidden from assigning or moving platforms. "
                    "Only train delays and platform closures may be parsed."
                ),
            )

    # Split compound statements by ';', ' and ', ' & ', or sentence boundaries while preserving clauses
    clauses = [
        c.strip(" .,;")
        for c in re.split(
            r"(?:;|\band\b|\balso\b|\bplus\b|(?<=[a-zA-Z0-9])\.\s+)",
            cleaned,
            flags=re.IGNORECASE,
        )
        if c.strip(" .,;")
    ]

    events: list[ParsedDisruptionEvent] = []
    clarifications: list[str] = []
    ambiguous = False

    for clause in clauses:
        matched = False

        # Try full train delay match
        for pat in _TRAIN_DELAY_FULL_PATTERNS:
            m = pat.search(clause)
            if m:
                tid = m.group("train_id").upper()
                mins = int(m.group("minutes"))
                if mins <= 0:
                    ambiguous = True
                    clarifications.append(
                        f"Delay for train '{tid}' must be a positive integer number of minutes (got {mins})."
                    )
                else:
                    events.append(ParsedTrainDelayEvent(train_id=tid, delay_minutes=mins))
                matched = True
                break

        if matched:
            continue

        # Try full platform closure match
        for pat in _PLATFORM_CLOSURE_FULL_PATTERNS:
            m = pat.search(clause)
            if m:
                pid = m.group("platform_id").upper()
                raw_start = m.group("start")
                raw_end = m.group("end")
                try:
                    norm_start = _normalize_hhmm(raw_start)
                    norm_end = _normalize_hhmm(raw_end)
                    events.append(
                        ParsedPlatformClosureEvent(
                            platform_id=pid,
                            start_time=norm_start,
                            end_time=norm_end,
                        )
                    )
                except ValueError as exc:
                    ambiguous = True
                    clarifications.append(f"Invalid closure time range for platform '{pid}': {exc}")
                matched = True
                break

        if matched:
            continue

        # Diagnose why the clause was ambiguous or incomplete
        lower_c = clause.lower()
        if any(w in lower_c for w in ("delay", "delayed", "late")):
            train_match = re.search(r"\b(?:train\s+)?([A-Za-z]+\d+[A-Za-z0-9_-]*)\b", clause)
            min_match = re.search(r"\b(\d+)\s*(?:minutes?|mins?|m)\b", clause, re.IGNORECASE)
            ambiguous = True
            if train_match and not min_match:
                clarifications.append(
                    f"Ambiguous delay for train '{train_match.group(1).upper()}': "
                    "please specify the exact delay in integer minutes (e.g., 'by 20 minutes')."
                )
            elif min_match and not train_match:
                clarifications.append(
                    f"Ambiguous delay of {min_match.group(1)} minutes: please specify the target train ID (e.g., 'T101')."
                )
            else:
                clarifications.append(
                    f"Could not parse train delay clause '{clause}'. Specify both train ID and delay minutes."
                )
        elif any(w in lower_c for w in ("close", "closed", "closure", "unavailable", "blocked")):
            plat_match = re.search(r"\b(?:platform\s+)?(P\d+[A-Za-z0-9_-]*)\b", clause, re.IGNORECASE)
            times_found = re.findall(r"\b\d{1,2}:\d{2}\b", clause)
            ambiguous = True
            if plat_match and len(times_found) < 2:
                clarifications.append(
                    f"Ambiguous closure for platform '{plat_match.group(1).upper()}': "
                    "please specify both start and end times in HH:MM format (e.g., 'from 09:30 to 10:20')."
                )
            elif len(times_found) >= 2 and not plat_match:
                clarifications.append(
                    "Ambiguous platform closure: please specify the platform ID (e.g., 'platform P2')."
                )
            else:
                clarifications.append(
                    f"Could not parse platform closure clause '{clause}'. Specify platform ID, start time, and end time."
                )
        else:
            ambiguous = True
            clarifications.append(
                f"Unrecognized or ambiguous disruption clause: '{clause}'. "
                "Supported events are train delays and platform closures."
            )

    return RawLLMParsePayload(
        events=events,
        ambiguous=ambiguous,
        clarification_needed=clarifications,
        requires_confirmation=True,
    )
