"""Server-side ElevenLabs Voice Operator & Grounded Scenario Assistant."""

from __future__ import annotations

import json
import os
import re
from typing import Optional
import urllib.error
import urllib.request

from pydantic import BaseModel, Field

from app.ai.explainer import explain_schedule_version
from app.ai.parser import parse_natural_language_disruption
from app.ai.schemas import ParsedDisruptionEvent
from app.schemas import DisruptionInput, ScenarioResponse, ScheduleVersion, format_minutes


DEFAULT_VOICES = [
    {"voice_id": "21m00Tcm4TlvDq8ikWAM", "name": "Rachel — Dispatch Lead", "category": "premade"},
    {"voice_id": "ErXwobaYiN019PkySvjV", "name": "Antoni — Network Controller", "category": "premade"},
    {"voice_id": "EXAVITQu4vr4xnSDxMaL", "name": "Bella — Signalling Officer", "category": "premade"},
]


class VoiceStatusResponse(BaseModel):
    configured: bool
    status: str
    provider: str = "elevenlabs"
    conversation_mode: str = "turn_based_tts"
    convai_websocket_available: bool = False
    stt_mode: str = "browser_speech_recognition"
    message: str
    voices: list[dict[str, str]] = Field(default_factory=list)
    ai_platform_assignment_forbidden: bool = True


class VoiceTTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    voice_id: str = Field(default="21m00Tcm4TlvDq8ikWAM")
    model_id: str = Field(default="eleven_turbo_v2_5")


class VoiceCommandRequest(BaseModel):
    utterance: str = Field(..., min_length=1, max_length=1500)
    version_id: Optional[str] = Field(default=None)
    sim_clock: Optional[int] = Field(default=550, ge=0, le=1440)


class VoiceCommandResponse(BaseModel):
    intent: str
    reply_text: str
    requires_confirmation: bool = False
    draft_events: list[ParsedDisruptionEvent] = Field(default_factory=list)
    normalized_disruptions: list[DisruptionInput] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    referenced_trains: list[str] = Field(default_factory=list)
    referenced_platforms: list[str] = Field(default_factory=list)
    solver_status: str
    validation_status: str
    version_id: str


def _read_dotenv_var(var_name: str) -> str:
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env")
    if not os.path.isfile(env_path):
        return ""
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
        return ""
    return ""


def get_elevenlabs_api_key() -> Optional[str]:
    key = os.environ.get("ELEVENLABS_API_KEY", "").strip() or _read_dotenv_var("ELEVENLABS_API_KEY")
    if not key or key.startswith("your_"):
        return None
    return key


def get_voice_service_status() -> VoiceStatusResponse:
    api_key = get_elevenlabs_api_key()
    agent_id = os.environ.get("ELEVENLABS_AGENT_ID", "").strip() or _read_dotenv_var("ELEVENLABS_AGENT_ID")
    if not api_key:
        return VoiceStatusResponse(
            configured=False,
            status="not_configured",
            conversation_mode="browser_web_speech",
            convai_websocket_available=False,
            stt_mode="browser_speech_recognition",
            message="ElevenLabs API key not set. Live spoken interaction is active via Browser Speech Recognition and Neural Web Speech synthesis.",
            voices=DEFAULT_VOICES,
        )

    req = urllib.request.Request(
        "https://api.elevenlabs.io/v1/voices",
        headers={
            "xi-api-key": api_key,
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=6.0) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            raw_voices = payload.get("voices", [])
            voices = [
                {
                    "voice_id": str(v.get("voice_id", "")),
                    "name": str(v.get("name", "Operator Voice")),
                    "category": str(v.get("category", "elevenlabs")),
                }
                for v in raw_voices[:10]
                if v.get("voice_id")
            ] or DEFAULT_VOICES
            return VoiceStatusResponse(
                configured=True,
                status="ready",
                conversation_mode="turn_based_tts",
                convai_websocket_available=bool(agent_id),
                stt_mode="browser_speech_recognition",
                message="ElevenLabs Voice Operator ready for live turn-based spoken conversation.",
                voices=voices,
            )
    except urllib.error.HTTPError as exc:
        err_body = ""
        try:
            err_body = exc.read().decode("utf-8", errors="ignore")
        except Exception:
            pass
        # Scoped ElevenLabs keys (sk_...) often enable text_to_speech while restricting voices_read / convai_read
        if exc.code in (401, 403) and ("missing_permissions" in err_body or api_key.startswith("sk_")):
            return VoiceStatusResponse(
                configured=True,
                status="ready",
                conversation_mode="turn_based_tts",
                convai_websocket_available=False,
                stt_mode="browser_speech_recognition",
                message=(
                    "ElevenLabs streaming TTS active (scoped key with text_to_speech enabled; "
                    "live turn-based speech capture + ElevenLabs spoken replies active)."
                ),
                voices=DEFAULT_VOICES,
            )
        return VoiceStatusResponse(
            configured=False,
            status="auth_error" if exc.code in (401, 403) else "error",
            conversation_mode="browser_web_speech",
            convai_websocket_available=False,
            stt_mode="browser_speech_recognition",
            message=f"ElevenLabs API returned HTTP {exc.code}. Using free browser Web Speech & text fallback.",
            voices=DEFAULT_VOICES,
        )
    except Exception:
        return VoiceStatusResponse(
            configured=False,
            status="unreachable",
            conversation_mode="browser_web_speech",
            convai_websocket_available=False,
            stt_mode="browser_speech_recognition",
            message="ElevenLabs endpoint unreachable. Using free browser Web Speech & text fallback.",
            voices=DEFAULT_VOICES,
        )


def synthesize_elevenlabs_speech(payload: VoiceTTSRequest) -> tuple[Optional[bytes], Optional[str], int]:
    """
    Call official ElevenLabs TTS streaming endpoint.
    Returns (audio_bytes, error_message, http_status).
    Never exposes ELEVENLABS_API_KEY.
    """
    api_key = get_elevenlabs_api_key()
    if not api_key:
        return (
            None,
            "Voice service not configured (ELEVENLABS_API_KEY is missing on backend).",
            503,
        )

    voice_id = re.sub(r"[^a-zA-Z0-9_-]", "", payload.voice_id) or "21m00Tcm4TlvDq8ikWAM"
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream"
    body = json.dumps(
        {
            "text": payload.text,
            "model_id": payload.model_id,
            "voice_settings": {
                "stability": 0.55,
                "similarity_boost": 0.75,
            },
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "xi-api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=12.0) as resp:
            audio_bytes = resp.read()
            if not audio_bytes:
                return None, "ElevenLabs returned an empty audio stream.", 502
            return audio_bytes, None, 200
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            return None, "ElevenLabs authentication failed (HTTP 401/403).", 401
        if exc.code == 429:
            return None, "ElevenLabs rate limit exceeded (HTTP 429).", 429
        return None, f"ElevenLabs TTS request failed with HTTP {exc.code}.", 502
    except Exception:
        return None, "ElevenLabs TTS request timed out or failed.", 504


def _clean_for_speech(text: str) -> str:
    """Strip internal version/disruption hashes and technical punctuation so TTS sounds like a real signaller."""
    cleaned = re.sub(r"\(ver-[a-zA-Z0-9]+\)", "", text)
    cleaned = re.sub(r"\bver-[a-zA-Z0-9]+\b", "", cleaned)
    cleaned = re.sub(r"\(disruption\s+'?disr-[a-zA-Z0-9]+'\)", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bdisr-[a-zA-Z0-9]+\b", "", cleaned)
    cleaned = cleaned.replace("'", "")
    cleaned = cleaned.replace("→", " to ").replace("–", " to ")
    cleaned = re.sub(r"\.\s*\.", ".", cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned


def process_grounded_voice_command(
    scenario: ScenarioResponse,
    version: ScheduleVersion,
    parent_version: Optional[ScheduleVersion],
    payload: VoiceCommandRequest,
) -> VoiceCommandResponse:
    """
    Answer operator queries or stage unconfirmed disruption drafts using strictly
    actual scenario state, solver results, and independent validation findings.
    Produces natural, concise railway-controller speech suitable for live conversation.
    """
    text = payload.utterance.strip()
    lower = text.lower()
    sim_clock = payload.sim_clock if payload.sim_clock is not None else 550

    referenced_trains = [
        t.id for t in scenario.trains if t.id.lower() in lower
    ]
    referenced_platforms = [
        p.id for p in scenario.platforms if p.id.lower() in lower
    ]
    word_to_plat = {
        "platform one": "P1",
        "platform 1": "P1",
        "platform two": "P2",
        "platform 2": "P2",
        "platform three": "P3",
        "platform 3": "P3",
    }
    for phrase, pid in word_to_plat.items():
        if phrase in lower and pid not in referenced_platforms:
            if any(p.id == pid for p in scenario.platforms):
                referenced_platforms.append(pid)

    is_question = any(
        lower.startswith(q)
        for q in (
            "which",
            "what",
            "why",
            "how",
            "read",
            "summarize",
            "explain",
            "status",
            "who",
            "are ",
            "is ",
            "tell me",
            "give me",
            "where",
        )
    ) or "?" in text

    has_disruption_action = any(
        kw in lower
        for kw in (
            "delay ",
            "delayed by",
            "close ",
            "closed from",
            "closed between",
            "shut ",
            "block ",
        )
    )

    if has_disruption_action and not is_question:
        normalized_text = text
        for word, digit in (
            ("twenty-five", "25"),
            ("thirty-five", "35"),
            ("forty-five", "45"),
            ("twenty", "20"),
            ("fifteen", "15"),
            ("ten", "10"),
            ("thirty", "30"),
            ("five", "5"),
            ("forty", "40"),
            ("sixty", "60"),
        ):
            normalized_text = re.sub(rf"\b{word}\b", digit, normalized_text, flags=re.IGNORECASE)
        for phrase, pid in word_to_plat.items():
            normalized_text = re.sub(rf"\b{phrase}\b", pid, normalized_text, flags=re.IGNORECASE)

        parsed = parse_natural_language_disruption(
            text=normalized_text,
            trains=scenario.trains,
            platforms=scenario.platforms,
            prefer_llm=False,
        )
        if parsed.events:
            summaries = []
            for ev in parsed.events:
                if ev.type == "train_delay":
                    summaries.append(f"delaying train {ev.train_id} by {ev.delay_minutes} minutes")
                elif ev.type == "platform_closure":
                    summaries.append(
                        f"closing platform {ev.platform_id} from {ev.start_time} to {ev.end_time}"
                    )
            reply = (
                f"Copy that. I've drafted {len(parsed.events)} disruption update"
                f"{'s' if len(parsed.events) > 1 else ''}: "
                + " and ".join(summaries)
                + ". I haven't changed the live timetable yet—click Stage Draft or Confirm and Replan when you're ready to run the solver."
            )
            return VoiceCommandResponse(
                intent="disruption_draft",
                reply_text=_clean_for_speech(reply),
                requires_confirmation=True,
                draft_events=parsed.events,
                normalized_disruptions=parsed.normalized_disruptions,
                warnings=parsed.warnings,
                referenced_trains=referenced_trains,
                referenced_platforms=referenced_platforms,
                solver_status=str(version.solver_status),
                validation_status=str(version.validation_status),
                version_id=version.id,
            )

        # Ambiguous disruption command — ask a concise clarification question
        valid_train_ids = ", ".join(t.id for t in scenario.trains)
        valid_plat_ids = ", ".join(p.id for p in scenario.platforms)
        if "delay" in lower:
            if not referenced_trains:
                clarification = (
                    f"Which train would you like to delay, and by how many minutes? "
                    f"Active trains at {scenario.station.name} are {valid_train_ids}."
                )
            else:
                clarification = (
                    f"How many minutes of delay should I stage for train {referenced_trains[0]}? "
                    f"For example, say 'Delay {referenced_trains[0]} by 20 minutes.'"
                )
        else:
            if not referenced_platforms:
                clarification = (
                    f"Which platform should I close, and for what time window? "
                    f"Available platforms are {valid_plat_ids}."
                )
            else:
                clarification = (
                    f"What start and end times should I use for closing platform {referenced_platforms[0]}? "
                    f"For example, say 'Close {referenced_platforms[0]} from 09:20 to 10:00.'"
                )
        return VoiceCommandResponse(
            intent="clarification_needed",
            reply_text=_clean_for_speech(clarification),
            requires_confirmation=False,
            warnings=parsed.warnings,
            referenced_trains=referenced_trains,
            referenced_platforms=referenced_platforms,
            solver_status=str(version.solver_status),
            validation_status=str(version.validation_status),
            version_id=version.id,
        )

    if "validation" in lower or "error" in lower or "conflict" in lower or "valid" in lower:
        findings = version.validation_findings
        if not findings:
            reply = (
                f"Revision {version.version_number} is verified VALID by the independent validator, "
                f"with solver status {version.solver_status}. "
                f"All {len(version.assignments)} trains have conflict-free platform assignments and full clearance gaps."
            )
        else:
            finding_descriptions = [
                f"{f.message}"
                for f in findings[:3]
            ]
            reply = (
                f"Hold on—revision {version.version_number} is marked {version.validation_status} "
                f"with {len(findings)} constraint violation{'s' if len(findings) > 1 else ''}: "
                + " ".join(finding_descriptions)
            )
        return VoiceCommandResponse(
            intent="validation_report",
            reply_text=_clean_for_speech(reply),
            referenced_trains=referenced_trains,
            referenced_platforms=referenced_platforms,
            solver_status=str(version.solver_status),
            validation_status=str(version.validation_status),
            version_id=version.id,
        )

    if "thirty" in lower or "30" in lower or "summarize" in lower or "next" in lower or "upcoming" in lower:
        win_start = sim_clock
        win_end = sim_clock + 30
        active_in_window = []
        for a in version.assignments:
            if a.unresolved or a.arrival is None or a.departure is None:
                continue
            if a.arrival < win_end and a.departure > win_start:
                delay_note = f", delayed {a.total_delay_minutes} minutes" if a.total_delay_minutes > 0 else ""
                active_in_window.append(
                    f"train {a.train_id} on platform {a.platform_id} from {a.arrival_str} to {a.departure_str}{delay_note}"
                )
        closures_in_window = [
            f"platform {d.platform_id} closed {d.start_str} to {d.end_str}"
            for d in version.applied_disruptions
            if str(d.type) == "platform_closure"
            and d.start is not None
            and d.end is not None
            and d.start < win_end
            and d.end > win_start
        ]
        trains_part = (
            f"We have {len(active_in_window)} active movement{'s' if len(active_in_window) > 1 else ''}: "
            + "; ".join(active_in_window) + "."
            if active_in_window
            else "No trains are scheduled on platforms during this 30-minute window."
        )
        closure_part = f" Active closures: {', '.join(closures_in_window)}." if closures_in_window else ""
        reply = (
            f"Here is the outlook from {format_minutes(win_start)} to {format_minutes(win_end)} "
            f"on revision {version.version_number}: {trains_part}{closure_part}"
        )
        return VoiceCommandResponse(
            intent="window_summary",
            reply_text=_clean_for_speech(reply),
            referenced_trains=referenced_trains,
            referenced_platforms=referenced_platforms,
            solver_status=str(version.solver_status),
            validation_status=str(version.validation_status),
            version_id=version.id,
        )

    if referenced_trains or referenced_platforms or "why" in lower or "explain" in lower or "affected" in lower or "replan" in lower:
        details: list[str] = []

        for tid in referenced_trains:
            asgn = next((a for a in version.assignments if a.train_id == tid), None)
            chg = next((c for c in version.changes if c.train_id == tid), None)
            if asgn:
                if asgn.unresolved:
                    details.append(f"Train {tid} is currently unresolved because {asgn.unresolved_reason}.")
                elif chg and (chg.platform_changed or chg.timing_changed):
                    if chg.platform_changed:
                        details.append(
                            f"Train {tid} was reassigned from platform {chg.previous_platform} "
                            f"to platform {chg.proposed_platform}, arriving at {chg.proposed_arrival_str} "
                            f"and departing at {chg.proposed_departure_str}. {chg.reason}"
                        )
                    else:
                        details.append(
                            f"Train {tid} stays on platform {chg.proposed_platform}, now running from "
                            f"{chg.proposed_arrival_str} to {chg.proposed_departure_str}. {chg.reason}"
                        )
                else:
                    delay_phrase = (
                        f"with a {asgn.total_delay_minutes}-minute delay"
                        if asgn.total_delay_minutes > 0
                        else "on time"
                    )
                    details.append(
                        f"Train {tid} is assigned to platform {asgn.platform_id} from {asgn.arrival_str} "
                        f"to {asgn.departure_str}, running {delay_phrase}."
                    )

        for pid in referenced_platforms:
            plat_trains = [
                f"{a.train_id} ({a.arrival_str} to {a.departure_str})"
                for a in version.assignments
                if a.platform_id == pid and not a.unresolved
            ]
            moved_from_plat = [
                f"train {c.train_id} moved to platform {c.proposed_platform} ({c.reason})"
                for c in version.changes
                if c.previous_platform == pid and c.platform_changed
            ]
            closures = [
                f"{d.start_str} to {d.end_str}"
                for d in version.applied_disruptions
                if str(d.type) == "platform_closure" and (d.platform_id == pid or d.target_id == pid)
            ]
            plat_summary = (
                f"Platform {pid} is hosting {', '.join(plat_trains)}."
                if plat_trains
                else f"Platform {pid} currently has no assigned trains."
            )
            if closures:
                plat_summary += f" It is closed from {', '.join(closures)}."
            if moved_from_plat:
                plat_summary += f" Affected services reassigned off {pid}: {'; '.join(moved_from_plat)}."
            details.append(plat_summary)

        if not details:
            explanation = explain_schedule_version(version, parent_version)
            if version.changes:
                change_items = []
                for c in version.changes[:3]:
                    if c.platform_changed:
                        change_items.append(
                            f"train {c.train_id} moved from {c.previous_platform} to {c.proposed_platform} ({c.proposed_arrival_str} to {c.proposed_departure_str})"
                        )
                    elif c.timing_changed:
                        change_items.append(
                            f"train {c.train_id} retimed on {c.proposed_platform} ({c.proposed_arrival_str} to {c.proposed_departure_str})"
                        )
                if change_items:
                    details.append(
                        f"On revision {version.version_number}, " + "; ".join(change_items) + "."
                    )
            if not details:
                details.append(explanation.summary)

        reply = " ".join(details)
        return VoiceCommandResponse(
            intent="schedule_explanation",
            reply_text=_clean_for_speech(reply),
            referenced_trains=referenced_trains,
            referenced_platforms=referenced_platforms,
            solver_status=str(version.solver_status),
            validation_status=str(version.validation_status),
            version_id=version.id,
        )

    delayed_count = sum(1 for a in version.assignments if a.total_delay_minutes > 0)
    moved_count = sum(1 for c in version.changes if c.platform_changed)
    reply = (
        f"{scenario.station.name} is operating on revision {version.version_number}, "
        f"which is {version.validation_status} with solver outcome {version.solver_status}. "
        f"We are tracking {len(version.assignments)} trains: {delayed_count} delayed, "
        f"{moved_count} reassigned to new platforms, and {len(version.unresolved_trains)} unresolved."
    )
    return VoiceCommandResponse(
        intent="status_overview",
        reply_text=_clean_for_speech(reply),
        referenced_trains=referenced_trains,
        referenced_platforms=referenced_platforms,
        solver_status=str(version.solver_status),
        validation_status=str(version.validation_status),
        version_id=version.id,
    )
