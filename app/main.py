"""FastAPI REST API for RailFlow (STEP G)."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, Literal, Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from app.ai.explainer import explain_schedule_version
from app.ai.fallback_parser import ForbiddenAIParsingError
from app.ai.parser import parse_natural_language_disruption
from app.ai.schemas import (
    DisruptionParseRequest,
    DisruptionParseResponse,
    ScheduleExplanationResponse,
)
from app.database import db_transaction, init_db
from app.schemas import (
    AuditEvent,
    ManualAssignRequest,
    ReplanRequest,
    ScenarioCreateRequest,
    ScenarioResponse,
    ScheduleVersion,
    ValidationRun,
)
from app.services.audit_service import list_audit_events, record_audit_event
from app.services.revision_service import (
    ResourceNotFoundError,
    get_schedule_version,
    list_schedule_versions,
    list_validation_runs,
    revalidate_schedule_version,
)
from app.services.scenario_service import (
    WorkflowError,
    apply_manual_assignments,
    build_impossible_demo_request,
    build_standard_demo_request,
    compare_revisions,
    create_scenario,
    get_scenario,
    list_scenarios,
    replan_scenario,
)
from app.services.voice_service import (
    VoiceCommandRequest,
    VoiceCommandResponse,
    VoiceStatusResponse,
    VoiceTTSRequest,
    get_voice_service_status,
    process_grounded_voice_command,
    synthesize_elevenlabs_speech,
)


import os

DEFAULT_CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5180",
    "http://127.0.0.1:5180",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://localhost:8010",
    "http://127.0.0.1:8010",
]


def _get_allowed_origins() -> list[str]:
    raw = os.environ.get("RAILFLOW_CORS_ORIGINS", "").strip()
    if not raw:
        return DEFAULT_CORS_ORIGINS
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="RailFlow API",
    description=(
        "Deterministic railway disruption and platform conflict simulator "
        "(VORTEXA 3.0 | P-03 | Domain 6: Public Systems & Civic Technology)."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_get_allowed_origins(),
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "Accept"],
)


@app.exception_handler(ResourceNotFoundError)
async def handle_not_found(_request: Request, exc: ResourceNotFoundError) -> JSONResponse:
    return JSONResponse(
        status_code=404,
        content={
            "error": {
                "code": "RESOURCE_NOT_FOUND",
                "resource_type": exc.resource_type,
                "resource_id": exc.resource_id,
                "message": str(exc),
            }
        },
    )


@app.exception_handler(WorkflowError)
async def handle_workflow_error(_request: Request, exc: WorkflowError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": {
                "code": exc.code,
                "message": exc.message,
                "details": exc.details,
            }
        },
    )


@app.exception_handler(ForbiddenAIParsingError)
async def handle_forbidden_ai_error(_request: Request, exc: ForbiddenAIParsingError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": exc.code,
                "message": exc.message,
            }
        },
    )


@app.exception_handler(RequestValidationError)
async def handle_validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    sanitized_errors = []
    summaries = []
    for err in exc.errors():
        item = dict(err)
        if "ctx" in item and isinstance(item["ctx"], dict):
            item["ctx"] = {k: str(v) for k, v in item["ctx"].items()}
        sanitized_errors.append(item)
        loc_parts = [str(p) for p in item.get("loc", []) if p != "body"]
        loc_str = ".".join(loc_parts) if loc_parts else "payload"
        msg_str = str(item.get("msg", "Invalid value")).replace("Value error, ", "")
        summaries.append(f"{loc_str}: {msg_str}")
    detail_text = "; ".join(summaries)
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "INVALID_INPUT_SCHEMA",
                "message": (
                    f"Request payload failed schema validation: {detail_text}"
                    if detail_text
                    else "Request payload failed schema validation."
                ),
                "details": sanitized_errors,
            }
        },
    )


@app.exception_handler(Exception)
async def handle_unexpected_exception(_request: Request, _exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "INTERNAL_SERVER_ERROR",
                "message": "An unexpected internal server error occurred.",
                "details": {},
            }
        },
    )


@app.get("/health", tags=["System"])
def health_check() -> dict[str, Any]:
    """Return service health status and architectural safety invariants."""
    return {
        "status": "ok",
        "service": "RailFlow",
        "version": "1.0.0",
        "ai_platform_assignment_forbidden": True,
        "scheduler_engine": "ortools-cp-sat",
        "independent_validator": True,
    }


@app.post("/api/scenarios", response_model=ScenarioResponse, status_code=201, tags=["Scenarios"])
def api_create_scenario(payload: ScenarioCreateRequest) -> ScenarioResponse:
    """Create a station scenario with platforms, trains, timing rules, and initial baseline v1."""
    init_db()
    return create_scenario(payload)


@app.post("/api/scenarios/demo", response_model=ScenarioResponse, status_code=201, tags=["Scenarios"])
def api_create_demo_scenario(
    preset: Literal["standard", "impossible"] = Query(
        default="standard",
        description="Preset scenario type: 'standard' (Section 16 demo) or 'impossible' (fixed train on closed platform).",
    ),
    scenario_id: Optional[str] = Query(default=None),
) -> ScenarioResponse:
    """Seed one of the Section 16 demonstration scenarios."""
    init_db()
    req = (
        build_standard_demo_request(scenario_id)
        if preset == "standard"
        else build_impossible_demo_request(scenario_id)
    )
    return create_scenario(req)


@app.get("/api/scenarios", response_model=list[ScenarioResponse], tags=["Scenarios"])
def api_list_scenarios() -> list[ScenarioResponse]:
    """List all scenarios."""
    init_db()
    return list_scenarios()


@app.get("/api/scenarios/{scenario_id}", response_model=ScenarioResponse, tags=["Scenarios"])
def api_get_scenario(scenario_id: str) -> ScenarioResponse:
    """Return the scenario configuration, baseline data, and current active schedule version."""
    init_db()
    return get_scenario(scenario_id)


@app.post(
    "/api/scenarios/{scenario_id}/disruptions/parse",
    response_model=DisruptionParseResponse,
    tags=["AI Middleware (Phase 2)"],
)
def api_parse_disruption_text(
    scenario_id: str,
    payload: DisruptionParseRequest,
) -> DisruptionParseResponse:
    """
    Parse free-text disruption descriptions into unconfirmed structured event proposals.
    Never applies disruptions automatically and strictly forbids platform assignments.
    """
    init_db()
    scenario = get_scenario(scenario_id)
    result = parse_natural_language_disruption(
        text=payload.text,
        trains=scenario.trains,
        platforms=scenario.platforms,
        prefer_llm=payload.prefer_llm,
    )
    with db_transaction() as conn:
        record_audit_event(
            conn=conn,
            actor="ai_parser",
            action="PARSE_DISRUPTION_TEXT",
            scenario_id=scenario_id,
            details={
                "parser_mode": result.parser_mode,
                "event_count": len(result.events),
                "ambiguous": result.ambiguous,
                "requires_confirmation": result.requires_confirmation,
            },
        )
    return result


@app.post(
    "/api/scenarios/{scenario_id}/replan",
    response_model=ScheduleVersion,
    status_code=201,
    tags=["Scheduling & Replanning"],
)
def api_replan_scenario(scenario_id: str, payload: ReplanRequest) -> ScheduleVersion:
    """
    Apply confirmed disruptions to an explicit baseline revision, run the deterministic CP-SAT
    scheduler, independently validate the resulting timetable, and persist a new ScheduleVersion.
    """
    init_db()
    return replan_scenario(scenario_id, payload)


@app.post(
    "/api/scenarios/{scenario_id}/manual-assign",
    response_model=ScheduleVersion,
    status_code=201,
    tags=["Scheduling & Replanning"],
)
def api_manual_assign(scenario_id: str, payload: ManualAssignRequest) -> ScheduleVersion:
    """
    Validate manual platform/timing assignments via the independent validator.
    Rejects invalid proposals with 422 unless save_as_diagnostic=True.
    """
    init_db()
    return apply_manual_assignments(scenario_id, payload)


@app.get(
    "/api/scenarios/{scenario_id}/schedule-versions",
    response_model=list[ScheduleVersion],
    tags=["Revisions & Validation"],
)
def api_list_schedule_versions(scenario_id: str) -> list[ScheduleVersion]:
    """Return immutable schedule revision history for a scenario."""
    init_db()
    return list_schedule_versions(scenario_id)


@app.get(
    "/api/schedule-versions/{version_id}",
    response_model=ScheduleVersion,
    tags=["Revisions & Validation"],
)
def api_get_schedule_version(version_id: str) -> ScheduleVersion:
    """Return assignments, solver status, validation status, disruptions, and changes for a revision."""
    init_db()
    return get_schedule_version(version_id)


@app.post(
    "/api/schedule-versions/{version_id}/validate",
    response_model=ValidationRun,
    tags=["Revisions & Validation"],
)
def api_revalidate_schedule_version(version_id: str) -> ValidationRun:
    """Recalculate independent validation freshly from the stored candidate and scenario constraints."""
    init_db()
    return revalidate_schedule_version(version_id)


@app.get(
    "/api/schedule-versions/{version_id}/validation-runs",
    response_model=list[ValidationRun],
    tags=["Revisions & Validation"],
)
def api_list_validation_runs(version_id: str) -> list[ValidationRun]:
    """List all independent validation runs recorded for a schedule revision."""
    init_db()
    return list_validation_runs(version_id)


@app.get(
    "/api/schedule-versions/{base_version_id}/compare/{target_version_id}",
    tags=["Revisions & Validation"],
)
def api_compare_schedule_versions(base_version_id: str, target_version_id: str) -> dict[str, Any]:
    """Compare two schedule revisions side by side."""
    init_db()
    return compare_revisions(base_version_id, target_version_id)


@app.get(
    "/api/schedule-versions/{version_id}/explain",
    response_model=ScheduleExplanationResponse,
    tags=["AI Middleware (Phase 2)"],
)
def api_explain_schedule_version(version_id: str) -> ScheduleExplanationResponse:
    """
    Generate a read-only, evidence-based plain-language explanation of a schedule revision.
    Never modifies assignments, solver status, or validation status.
    """
    init_db()
    ver = get_schedule_version(version_id)
    parent = get_schedule_version(ver.parent_version_id) if ver.parent_version_id else None
    return explain_schedule_version(ver, parent)


@app.get(
    "/api/scenarios/{scenario_id}/audit-events",
    response_model=list[AuditEvent],
    tags=["Audit"],
)
def api_list_scenario_audit_events(scenario_id: str) -> list[AuditEvent]:
    """List audit trail events for a scenario."""
    init_db()
    # Ensure scenario exists
    get_scenario(scenario_id)
    return list_audit_events(scenario_id=scenario_id)


@app.get(
    "/api/voice/status",
    response_model=VoiceStatusResponse,
    tags=["Voice Operator (ElevenLabs)"],
)
def api_voice_status() -> VoiceStatusResponse:
    """
    Return server-side ElevenLabs Voice Operator configuration status and available voices.
    Never exposes ELEVENLABS_API_KEY to the browser.
    """
    return get_voice_service_status()


@app.post(
    "/api/voice/tts",
    tags=["Voice Operator (ElevenLabs)"],
)
def api_voice_tts(payload: VoiceTTSRequest) -> Response:
    """
    Synthesize spoken audio using server-side ElevenLabs TTS API.
    Returns 503 if ELEVENLABS_API_KEY is not configured.
    """
    audio_bytes, err_msg, status_code = synthesize_elevenlabs_speech(payload)
    if audio_bytes is None:
        return JSONResponse(
            status_code=status_code,
            content={
                "error": {
                    "code": "VOICE_SERVICE_UNAVAILABLE",
                    "message": err_msg or "Voice synthesis unavailable.",
                }
            },
        )
    return Response(content=audio_bytes, media_type="audio/mpeg")


@app.post(
    "/api/scenarios/{scenario_id}/voice-command",
    response_model=VoiceCommandResponse,
    tags=["Voice Operator (ElevenLabs)"],
)
def api_voice_command(scenario_id: str, payload: VoiceCommandRequest) -> VoiceCommandResponse:
    """
    Process a spoken or typed operator command against actual scenario state.
    - Answers operational queries strictly from verified schedule/validator records.
    - Stages disruption utterances as unconfirmed drafts requiring explicit operator confirmation.
    - Never assigns platforms or marks schedules valid.
    """
    init_db()
    scenario = get_scenario(scenario_id)
    version = (
        get_schedule_version(payload.version_id)
        if payload.version_id
        else scenario.active_schedule_version
    )
    parent = (
        get_schedule_version(version.parent_version_id)
        if version.parent_version_id
        else None
    )
    result = process_grounded_voice_command(scenario, version, parent, payload)
    with db_transaction() as conn:
        record_audit_event(
            conn=conn,
            actor="voice_operator",
            action="VOICE_OPERATOR_COMMAND",
            scenario_id=scenario_id,
            version_id=version.id,
            details={
                "intent": result.intent,
                "utterance": payload.utterance,
                "draft_count": len(result.draft_events),
                "requires_confirmation": result.requires_confirmation,
            },
        )
    return result


# Optional single-process production SPA serving (ideal for 1GB RAM / 1 vCPU VPS deployments)
import os as _os
from fastapi.responses import FileResponse as _FileResponse
from fastapi.staticfiles import StaticFiles as _StaticFiles

_FRONTEND_DIST = _os.path.join(
    _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))),
    "frontend",
    "dist",
)
_FRONTEND_INDEX = _os.path.join(_FRONTEND_DIST, "index.html")
_FRONTEND_ASSETS = _os.path.join(_FRONTEND_DIST, "assets")

if _os.path.isdir(_FRONTEND_ASSETS):
    app.mount("/assets", _StaticFiles(directory=_FRONTEND_ASSETS), name="frontend-assets")


@app.get("/", include_in_schema=False)
@app.get("/app", include_in_schema=False)
@app.get("/app/{subpath:path}", include_in_schema=False)
def serve_spa_index(subpath: Optional[str] = None) -> Response:
    if _os.path.isfile(_FRONTEND_INDEX):
        return _FileResponse(_FRONTEND_INDEX)
    return JSONResponse(
        status_code=200,
        content={
            "service": "RailFlow API",
            "docs": "/docs",
            "health": "/health",
        },
    )


