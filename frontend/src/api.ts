import type {
  AuditEvent,
  DisruptionParseResponse,
  HealthResponse,
  ManualAssignRequest,
  ReplanRequest,
  ScenarioResponse,
  ScheduleComparisonResponse,
  ScheduleExplanationResponse,
  ScheduleVersion,
  ValidationErrorItem,
  ValidationRun,
} from "./types";

const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

function resolveDefaultApiBaseUrl(): string {
  const configured = metaEnv.VITE_API_BASE_URL || metaEnv.VITE_BACKEND_URL;
  if (configured !== undefined && configured.trim() !== "") {
    return configured.trim().replace(/\/$/, "");
  }
  if (typeof window !== "undefined" && window.location) {
    const { hostname, port, origin } = window.location;
    const isLocalHost = hostname === "localhost" || hostname === "127.0.0.1";
    const isViteDevPort = port === "5173" || port === "5180" || port === "3000";
    if (!isLocalHost || !isViteDevPort) {
      return origin.replace(/\/$/, "");
    }
  }
  return "http://127.0.0.1:8010";
}

export const API_BASE_URL = resolveDefaultApiBaseUrl();

export class ApiError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown> | unknown[] | null;
  validationErrors: ValidationErrorItem[];

  constructor(
    message: string,
    status: number,
    code = "API_ERROR",
    details: Record<string, unknown> | unknown[] | null = null,
    validationErrors: ValidationErrorItem[] = []
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.validationErrors = validationErrors;
  }
}

async function fetchWithFallback(path: string, init?: RequestInit): Promise<Response> {
  const candidates = path.startsWith("http")
    ? [path]
    : [
        `${API_BASE_URL}${path}`,
        path,
        `http://127.0.0.1:8010${path}`,
        `http://127.0.0.1:8000${path}`,
      ];
  const uniqueCandidates = Array.from(new Set(candidates));

  let lastErr: unknown = null;
  for (const url of uniqueCandidates) {
    try {
      const res = await fetch(url, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(init?.headers ?? {}),
        },
        ...init,
      });
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("Network failure");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetchWithFallback(path, init);
  } catch {
    throw new ApiError(
      `Cannot reach RailFlow backend at ${API_BASE_URL}. Ensure the FastAPI server is running.`,
      0,
      "NETWORK_ERROR"
    );
  }

  const rawText = await response.text();
  let data: unknown = null;
  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { detail: rawText };
    }
  }

  if (!response.ok) {
    const payload = (data ?? {}) as {
      error?: {
        code?: string;
        message?: string;
        details?: Record<string, unknown> | unknown[];
      };
      detail?: string;
    };

    const code = payload.error?.code ?? `HTTP_${response.status}`;
    const message =
      payload.error?.message ??
      payload.detail ??
      `Request failed with status ${response.status}`;
    const details = payload.error?.details ?? null;

    let validationErrors: ValidationErrorItem[] = [];
    if (Array.isArray(details)) {
      validationErrors = details.map((raw) => {
        const item = (raw ?? {}) as {
          type?: string;
          loc?: (string | number)[];
          msg?: string;
        };
        const locParts = (item.loc ?? []).filter((p) => p !== "body");
        const locStr = locParts.length > 0 ? locParts.join(".") : "payload";
        const msgStr = String(item.msg ?? "Invalid value").replace(
          /^Value error,\s*/i,
          ""
        );
        return {
          code: String(item.type ?? "SCHEMA_VALIDATION_ERROR").toUpperCase(),
          severity: "ERROR",
          message: `${locStr}: ${msgStr}`,
          platform_id: null,
          train_ids: [],
        };
      });
    } else if (
      details &&
      typeof details === "object" &&
      (Array.isArray((details as { errors?: unknown }).errors) ||
        Array.isArray(
          (details as { validation_errors?: unknown }).validation_errors
        ))
    ) {
      validationErrors = (
        ((details as { errors?: ValidationErrorItem[] }).errors ??
          (details as { validation_errors?: ValidationErrorItem[] })
            .validation_errors) ||
        []
      );
    }

    throw new ApiError(message, response.status, code, details, validationErrors);
  }

  if (data === null) {
    throw new ApiError("Received empty response from server.", response.status, "EMPTY_RESPONSE");
  }

  return data as T;
}

export function normalizeTimeStr(
  val: number | string | null | undefined
): string {
  if (typeof val === "number" && !Number.isNaN(val)) {
    const clamped = Math.max(0, Math.min(1440, Math.round(val)));
    const hh = Math.floor(clamped / 60);
    const mm = clamped % 60;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    const m = /^(\d{1,2}):(\d{2})(?::00)?$/.exec(trimmed);
    if (m) {
      return `${m[1].padStart(2, "0")}:${m[2]}`;
    }
    return trimmed;
  }
  return "";
}

export function normalizeDisruptionForApi(
  d: import("./types").DisruptionEventInput
): import("./types").DisruptionEventInput {
  if (d.type === "train_delay") {
    const trainId = String(d.train_id || d.target_id || "").trim();
    const delayMins =
      typeof d.delay_minutes === "number"
        ? Math.round(d.delay_minutes)
        : Number(d.delay_minutes ?? 0);
    return {
      ...(d.id ? { id: d.id } : {}),
      type: "train_delay",
      train_id: trainId,
      delay_minutes: delayMins,
    };
  }
  const platformId = String(d.platform_id || d.target_id || "").trim();
  const startStr = normalizeTimeStr(d.start_time ?? d.start);
  const endStr = normalizeTimeStr(d.end_time ?? d.end);
  return {
    ...(d.id ? { id: d.id } : {}),
    type: "platform_closure",
    platform_id: platformId,
    start_time: startStr,
    end_time: endStr,
  };
}

export const checkHealth = () => request<HealthResponse>("/health");

export const createDemoScenario = (
  preset: "standard" | "impossible" = "standard",
  scenarioId?: string
) => {
  const params = new URLSearchParams({ preset });
  if (scenarioId) {
    params.set("scenario_id", scenarioId);
  }
  return request<ScenarioResponse>(`/api/scenarios/demo?${params.toString()}`, {
    method: "POST",
  });
};

export const createCustomScenario = (payload: Record<string, unknown>) =>
  request<ScenarioResponse>("/api/scenarios", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const listScenarios = () => request<ScenarioResponse[]>("/api/scenarios");

export const getScenario = (scenarioId: string) =>
  request<ScenarioResponse>(`/api/scenarios/${encodeURIComponent(scenarioId)}`);

export const parseDisruption = (
  scenarioId: string,
  text: string,
  preferLlm = true
) =>
  request<DisruptionParseResponse>(
    `/api/scenarios/${encodeURIComponent(scenarioId)}/disruptions/parse`,
    {
      method: "POST",
      body: JSON.stringify({ text, prefer_llm: preferLlm }),
    }
  );

export const replanScenario = (scenarioId: string, payload: ReplanRequest) => {
  const normalizedPayload: ReplanRequest = {
    confirmed: Boolean(payload.confirmed),
    baseline_version_id: String(payload.baseline_version_id || "").trim(),
    ...(payload.expected_active_version_id
      ? { expected_active_version_id: payload.expected_active_version_id }
      : {}),
    disruptions: (payload.disruptions ?? []).map(normalizeDisruptionForApi),
    ...(typeof payload.solver_time_limit_seconds === "number"
      ? { solver_time_limit_seconds: payload.solver_time_limit_seconds }
      : {}),
    ...(typeof payload.max_additional_delay_minutes === "number"
      ? { max_additional_delay_minutes: payload.max_additional_delay_minutes }
      : {}),
    allow_partial_diagnostic: payload.allow_partial_diagnostic ?? true,
  };
  return request<ScheduleVersion>(
    `/api/scenarios/${encodeURIComponent(scenarioId)}/replan`,
    {
      method: "POST",
      body: JSON.stringify(normalizedPayload),
    }
  );
};

export const manualAssign = (scenarioId: string, payload: ManualAssignRequest) =>
  request<ScheduleVersion>(
    `/api/scenarios/${encodeURIComponent(scenarioId)}/manual-assign`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );

export const listScheduleVersions = (scenarioId: string) =>
  request<ScheduleVersion[]>(
    `/api/scenarios/${encodeURIComponent(scenarioId)}/schedule-versions`
  );

export const getScheduleVersion = (versionId: string) =>
  request<ScheduleVersion>(
    `/api/schedule-versions/${encodeURIComponent(versionId)}`
  );

export const revalidateScheduleVersion = (versionId: string) =>
  request<ValidationRun>(
    `/api/schedule-versions/${encodeURIComponent(versionId)}/validate`,
    {
      method: "POST",
    }
  );

export const listValidationRuns = (versionId: string) =>
  request<ValidationRun[]>(
    `/api/schedule-versions/${encodeURIComponent(versionId)}/validation-runs`
  );

export const compareScheduleVersions = (
  baseVersionId: string,
  targetVersionId: string
) =>
  request<ScheduleComparisonResponse>(
    `/api/schedule-versions/${encodeURIComponent(
      baseVersionId
    )}/compare/${encodeURIComponent(targetVersionId)}`
  );

export const explainScheduleVersion = (versionId: string) =>
  request<ScheduleExplanationResponse>(
    `/api/schedule-versions/${encodeURIComponent(versionId)}/explain`
  );

export const listAuditEvents = (scenarioId: string) =>
  request<AuditEvent[]>(
    `/api/scenarios/${encodeURIComponent(scenarioId)}/audit-events`
  );

export const getHealth = checkHealth;
export const parseDisruptionText = parseDisruption;
export const manualAssignScenario = manualAssign;
export const validateScheduleVersion = revalidateScheduleVersion;

export const getVoiceStatus = () =>
  request<import("./types").VoiceStatusResponse>("/api/voice/status");

export const sendVoiceCommand = (
  scenarioId: string,
  payload: { utterance: string; version_id?: string; sim_clock?: number }
) =>
  request<import("./types").VoiceCommandResponse>(
    `/api/scenarios/${encodeURIComponent(scenarioId)}/voice-command`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );

export async function synthesizeVoiceSpeech(
  text: string,
  voiceId: string
): Promise<{ audioUrl: string | null; error: string | null }> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/voice/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice_id: voiceId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      return {
        audioUrl: null,
        error:
          data?.error?.message ||
          `Voice service unavailable (HTTP ${res.status}).`,
      };
    }
    const blob = await res.blob();
    return { audioUrl: URL.createObjectURL(blob), error: null };
  } catch {
    return {
      audioUrl: null,
      error: "ElevenLabs TTS request failed or backend unreachable.",
    };
  }
}

