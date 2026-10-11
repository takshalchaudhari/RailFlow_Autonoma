import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock,
  Cpu,
  FastForward,
  FileCheck2,
  GitCompare,
  History,
  LayoutDashboard,
  Map as MapIcon,
  Mic,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TrainFront,
  Wrench,
  XCircle,
} from "lucide-react";
import {
  API_BASE_URL,
  ApiError,
  compareScheduleVersions,
  createDemoScenario,
  explainScheduleVersion,
  getHealth,
  getScenario,
  listAuditEvents,
  listScenarios,
  listScheduleVersions,
  listValidationRuns,
  manualAssignScenario,
  normalizeDisruptionForApi,
  normalizeTimeStr,
  parseDisruptionText,
  replanScenario,
  validateScheduleVersion,
} from "../api";
import { StationMap } from "../components/StationMap";
import { VoiceOperatorPanel } from "../components/VoiceOperatorPanel";
import {
  AuditEvent,
  ComparisonDiffRow,
  DisruptionInput,
  DisruptionParseResponse,
  HealthResponse,
  ManualAssignmentItem,
  Platform,
  ScenarioResponse,
  ScheduleAssignment,
  ScheduleComparisonResponse,
  ScheduleExplanationResponse,
  ScheduleVersion,
  SolverStatus,
  Train,
  ValidationErrorItem,
  ValidationRun,
  ValidationStatus,
} from "../types";

type NavPage =
  | "map"
  | "overview"
  | "timetable"
  | "disruptions"
  | "replanning"
  | "validation"
  | "revisions"
  | "settings";

const NAV_ITEMS: { id: NavPage; label: string; icon: React.FC<{ size?: number }> }[] = [
  { id: "map", label: "Live Map", icon: MapIcon },
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "timetable", label: "Timetable", icon: CalendarClock },
  { id: "disruptions", label: "Disruptions", icon: Wrench },
  { id: "replanning", label: "Replanning", icon: Cpu },
  { id: "validation", label: "Validation", icon: FileCheck2 },
  { id: "revisions", label: "Revisions & Audit", icon: History },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

export function minToClock(m: number | null | undefined): string {
  if (m === null || m === undefined || Number.isNaN(m)) return "--:--";
  const clamped = Math.max(0, Math.round(m));
  const hh = Math.floor(clamped / 60) % 24;
  const mm = clamped % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function clockToMin(clock: string): number {
  const parts = clock.trim().split(":");
  if (parts.length !== 2) return 540;
  const hh = parseInt(parts[0], 10);
  const mm = parseInt(parts[1], 10);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return 540;
  return Math.max(0, Math.min(1440, hh * 60 + mm));
}

export function SolverBadge({ status }: { status: SolverStatus }) {
  const tone =
    status === "OPTIMAL" || status === "FEASIBLE"
      ? "badge-valid"
      : status === "INFEASIBLE"
      ? "badge-invalid"
      : status === "UNKNOWN"
      ? "badge-warn"
      : "badge-info";
  return (
    <span className={`status-badge ${tone}`} data-testid="solver-status-badge">
      <Cpu size={12} /> Solver: {status}
    </span>
  );
}

export function ValidationBadge({
  status,
  isComplete,
}: {
  status: ValidationStatus;
  isComplete?: boolean;
}) {
  const effectiveStatus =
    isComplete === false && status === "VALID" ? "PARTIAL" : status;
  const tone =
    effectiveStatus === "VALID"
      ? "badge-valid"
      : effectiveStatus === "PARTIAL" || effectiveStatus === "UNKNOWN"
      ? "badge-warn"
      : "badge-invalid";
  return (
    <span
      className={`status-badge ${tone}`}
      data-testid="validation-status-badge"
    >
      {effectiveStatus === "VALID" ? (
        <CheckCircle2 size={12} />
      ) : effectiveStatus === "PARTIAL" ? (
        <AlertTriangle size={12} />
      ) : (
        <XCircle size={12} />
      )}
      Validator: {effectiveStatus}
    </span>
  );
}

export default function DashboardLayout() {
  const [activePage, setActivePage] = useState<NavPage>("map");
  const [rightTab, setRightTab] = useState<"inspector" | "voice">("inspector");
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(false);

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioResponse[]>([]);
  const [scenario, setScenario] = useState<ScenarioResponse | null>(null);
  const [history, setHistory] = useState<ScheduleVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string>("");
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);

  // Map & Inspector entity selection
  const [selectedTrainId, setSelectedTrainId] = useState<string | null>("T101");
  const [selectedPlatformId, setSelectedPlatformId] = useState<string | null>(
    null
  );

  // Live Simulation Clock (default 09:10 = 550m)
  const [simClock, setSimClock] = useState<number>(550);
  const [playing, setPlaying] = useState<boolean>(false);
  const [speed, setSpeed] = useState<1 | 2 | 4>(1);

  const [loading, setLoading] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<{
    title: string;
    message: string;
    findings?: ValidationErrorItem[];
  } | null>(null);
  const [notice, setNotice] = useState<string>(
    "Connecting to RailFlow deterministic scheduling engine…"
  );

  // Disruption workflow state
  const [nlText, setNlText] = useState<string>(
    "Train T101 is delayed by 20 minutes and platform P2 is closed from 09:20 to 10:00."
  );
  const [parseResult, setParseResult] =
    useState<DisruptionParseResponse | null>(null);
  const [stagedDisruptions, setStagedDisruptions] = useState<DisruptionInput[]>(
    []
  );
  const [operatorConfirmed, setOperatorConfirmed] = useState<boolean>(false);
  const [baselineForReplan, setBaselineForReplan] = useState<string>("");
  const [allowPartialDiagnostic, setAllowPartialDiagnostic] =
    useState<boolean>(true);

  const currentVersion: ScheduleVersion | null = useMemo(() => {
    if (!scenario) return null;
    if (selectedVersionId) {
      const found = history.find((v) => v.id === selectedVersionId);
      if (found) return found;
    }
    return scenario.active_schedule_version ?? history[0] ?? null;
  }, [scenario, history, selectedVersionId]);

  const baselineVersion: ScheduleVersion | null = useMemo(() => {
    if (history.length === 0) return null;
    return (
      history.find((v) => v.version_number === 1) ??
      history[0] ??
      null
    );
  }, [history]);

  // Simulation playback loop
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setSimClock((prev) => {
        const next = prev + speed;
        return next > 630 ? 525 : next;
      });
    }, 350);
    return () => window.clearInterval(timer);
  }, [playing, speed]);

  const handleApiException = useCallback((err: unknown, fallbackTitle: string) => {
    if (err instanceof ApiError) {
      const details = err.details as Record<string, unknown> | undefined;
      const rawErrors =
        (err.validationErrors && err.validationErrors.length > 0
          ? err.validationErrors
          : undefined) ||
        (details?.validation_errors as ValidationErrorItem[] | undefined) ||
        (details?.errors as ValidationErrorItem[] | undefined);
      setErrorBanner({
        title: `${fallbackTitle} (${err.code} · HTTP ${err.status})`,
        message: err.message,
        findings: Array.isArray(rawErrors) ? rawErrors : undefined,
      });
    } else if (err instanceof Error) {
      setErrorBanner({
        title: fallbackTitle,
        message: err.message,
      });
    } else {
      setErrorBanner({
        title: fallbackTitle,
        message: "An unexpected network or application error occurred.",
      });
    }
  }, []);

  const refreshScenarioBundle = useCallback(
    async (targetScenarioId: string, focusVersionId?: string) => {
      const [scen, versions, audits, allScens] = await Promise.all([
        getScenario(targetScenarioId),
        listScheduleVersions(targetScenarioId),
        listAuditEvents(targetScenarioId),
        listScenarios(),
      ]);
      setScenario(scen);
      setHistory(versions);
      setAuditEvents(audits);
      setScenarios(allScens);

      const chosenVerId =
        focusVersionId ||
        scen.active_version_id ||
        (versions.length > 0 ? versions[versions.length - 1].id : "");
      setSelectedVersionId(chosenVerId);
      setBaselineForReplan(scen.active_version_id);
      return { scen, versions, audits };
    },
    []
  );

  // Initial bootstrap: connect to backend and auto-seed standard demo if needed
  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      try {
        const h = await getHealth();
        if (!mounted) return;
        setHealth(h);
        const existing = await listScenarios();
        if (!mounted) return;
        setScenarios(existing);
        if (existing.length > 0) {
          const preferred =
            existing.find((s) => s.id === "demo-standard") ?? existing[0];
          await refreshScenarioBundle(preferred.id);
          if (mounted) {
            setNotice(
              `Station "${preferred.station?.name ?? "Central Junction"}" online — Active baseline revision: ${preferred.active_version_id}.`
            );
          }
        } else {
          const seeded = await createDemoScenario("standard", "demo-standard");
          if (!mounted) return;
          await refreshScenarioBundle(seeded.id);
          if (mounted) {
            setNotice(
              `Seeded Central Junction scenario (${seeded.id}) with 3 platforms (P1–P3) and 4 scheduled trains (T101–T104).`
            );
          }
        }
      } catch (err) {
        if (mounted) {
          handleApiException(err, "Backend Connection Error");
        }
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [handleApiException, refreshScenarioBundle]);

  const handleLoadDemo = async (preset: "standard" | "impossible") => {
    setLoading(true);
    setErrorBanner(null);
    try {
      const customId =
        preset === "standard"
          ? `demo-standard-${Date.now().toString().slice(-4)}`
          : `demo-impossible-${Date.now().toString().slice(-4)}`;
      const created = await createDemoScenario(preset, customId);
      await refreshScenarioBundle(created.id);
      setParseResult(null);
      setStagedDisruptions([]);
      setOperatorConfirmed(false);
      setSelectedTrainId("T101");
      setSelectedPlatformId(null);

      if (preset === "impossible") {
        setNlText("Platform P2 is closed from 09:20 to 10:00.");
        setNotice(
          `Loaded Impossible Scenario (${created.id}): Train T103 is FIXED on Platform P2 (09:25–09:45). Closing P2 will demonstrate INFEASIBLE / PARTIAL diagnostic handling.`
        );
      } else {
        setNlText(
          "Train T101 is delayed by 20 minutes and platform P2 is closed from 09:20 to 10:00."
        );
        setNotice(
          `Loaded Standard Scenario (${created.id}) — Baseline v1 validated (${created.active_version_id}).`
        );
      }
    } catch (err) {
      handleApiException(err, `Failed to create ${preset} demo scenario`);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectScenario = async (id: string) => {
    if (!id) return;
    setLoading(true);
    setErrorBanner(null);
    try {
      const { scen } = await refreshScenarioBundle(id);
      setParseResult(null);
      setStagedDisruptions([]);
      setOperatorConfirmed(false);
      setNotice(
        `Switched to scenario "${scen.name}" (${scen.id}) — Active version: ${scen.active_version_id}.`
      );
    } catch (err) {
      handleApiException(err, "Failed to load scenario");
    } finally {
      setLoading(false);
    }
  };

  const handleParseDisruption = async () => {
    if (!scenario || !nlText.trim()) return;
    setLoading(true);
    setErrorBanner(null);
    try {
      const res = await parseDisruptionText(scenario.id, nlText.trim(), true);
      setParseResult(res);
      const normalized = (res.normalized_disruptions ?? []).map(
        normalizeDisruptionForApi
      );
      setStagedDisruptions(normalized);
      setOperatorConfirmed(false);
      const audits = await listAuditEvents(scenario.id);
      setAuditEvents(audits);
      if (res.ambiguous && res.clarification_needed.length > 0) {
        setErrorBanner({
          title: "Ambiguous Disruption Input — Clarification Needed",
          message: res.clarification_needed.join(" "),
        });
      }
      setNotice(
        `Parsed ${(res.events ?? []).length} proposed disruption event(s) via ${res.parser_mode}. Inspect, edit if needed, and confirm before replanning.`
      );
    } catch (err) {
      handleApiException(err, "Disruption Parser Rejected Input");
    } finally {
      setLoading(false);
    }
  };

  const handleApplyReplan = async () => {
    if (!scenario) return;
    if (!operatorConfirmed) {
      setErrorBanner({
        title: "Operator Confirmation Required",
        message:
          "RailFlow safety rules forbid applying unconfirmed disruptions. Check the confirmation box before running CP-SAT replanning.",
      });
      return;
    }
    if (stagedDisruptions.length === 0) {
      setErrorBanner({
        title: "No Staged Disruptions",
        message:
          "Parse the natural-language text or stage at least one disruption event before running the replanner.",
      });
      return;
    }
    const cleanDisruptions = stagedDisruptions.map(normalizeDisruptionForApi);
    for (let i = 0; i < cleanDisruptions.length; i++) {
      const item = cleanDisruptions[i];
      if (item.type === "train_delay") {
        if (!item.train_id) {
          setErrorBanner({
            title: `Invalid Staged Disruption #${i + 1}`,
            message: "Train delay event requires a valid train_id.",
          });
          return;
        }
        if (!item.delay_minutes || item.delay_minutes <= 0) {
          setErrorBanner({
            title: `Invalid Staged Disruption #${i + 1}`,
            message: `Delay minutes for ${item.train_id} must be a positive integer (> 0).`,
          });
          return;
        }
      } else {
        if (!item.platform_id) {
          setErrorBanner({
            title: `Invalid Staged Disruption #${i + 1}`,
            message: "Platform closure event requires a valid platform_id.",
          });
          return;
        }
        const st = String(item.start_time || "");
        const et = String(item.end_time || "");
        if (!/^\d{2}:\d{2}$/.test(st) || !/^\d{2}:\d{2}$/.test(et)) {
          setErrorBanner({
            title: `Invalid Staged Disruption #${i + 1}`,
            message: `Platform ${item.platform_id} closure requires start_time and end_time in HH:MM format (e.g., 09:20 to 10:00).`,
          });
          return;
        }
        if (clockToMin(st) >= clockToMin(et)) {
          setErrorBanner({
            title: `Invalid Staged Disruption #${i + 1}`,
            message: `Platform ${item.platform_id} closure start time (${st}) must strictly precede end time (${et}).`,
          });
          return;
        }
      }
    }

    setLoading(true);
    setErrorBanner(null);
    try {
      const baseVer = baselineForReplan || scenario.active_version_id;
      const newVer = await replanScenario(scenario.id, {
        baseline_version_id: baseVer,
        confirmed: true,
        disruptions: cleanDisruptions,
        allow_partial_diagnostic: allowPartialDiagnostic,
      });
      await refreshScenarioBundle(scenario.id, newVer.id);
      setOperatorConfirmed(false);
      if (newVer.validation_status === "VALID") {
        setNotice(
          `Created & activated revision v${newVer.version_number} (${newVer.id}) — Solver: ${newVer.solver_status} | Validator: ${newVer.validation_status}.`
        );
      } else {
        setNotice(
          `Created diagnostic revision v${newVer.version_number} (${newVer.id}) — Solver: ${newVer.solver_status} | Validator: ${newVer.validation_status}. Prior valid baseline (${scenario.active_version_id}) remains active.`
        );
      }
    } catch (err) {
      handleApiException(err, "Replanning Rejected");
    } finally {
      setLoading(false);
    }
  };

  // Stage quick disruption from map or inspector without bypassing confirmation
  const handleQuickStageDisruption = (d: DisruptionInput, summaryText: string) => {
    setStagedDisruptions((prev) => [...prev, normalizeDisruptionForApi(d)]);
    setOperatorConfirmed(false);
    setNotice(
      `Staged disruption draft (${summaryText}). Confirm in the Operations panel or Disruptions page before replanning.`
    );
  };

  // Trigger intentional invalid candidate in one click (to demonstrate validator firewall)
  const handleRunIntentionalInvalidDemo = async () => {
    if (!scenario || !currentVersion) return;
    setLoading(true);
    setErrorBanner(null);
    try {
      const baseItems: ManualAssignmentItem[] = (
        currentVersion.assignments ?? []
      ).map((a) => ({
        train_id: a.train_id,
        platform_id: a.platform_id ?? "P1",
        arrival: a.arrival ?? a.baseline_arrival,
        departure: a.departure ?? a.baseline_departure,
      }));
      // Force T101 and T102 onto P1 with only a 5m gap (violating 10m clearance requirement)
      const modified = baseItems.map((row) => {
        if (row.train_id === "T101") {
          return { ...row, platform_id: "P1", arrival: 540, departure: 560 };
        }
        if (row.train_id === "T102") {
          return { ...row, platform_id: "P1", arrival: 565, departure: 585 };
        }
        return row;
      });
      const diagVer = await manualAssignScenario(scenario.id, {
        baseline_version_id: scenario.active_version_id,
        assignments: modified,
        save_as_diagnostic: true,
        reason: "Intentional clearance violation diagnostic test",
      });
      await refreshScenarioBundle(scenario.id, diagVer.id);
      setNotice(
        `Created intentional INVALID candidate v${diagVer.version_number} (${diagVer.id}) — Validator status: ${diagVer.validation_status}. Active valid schedule remains ${scenario.active_version_id}.`
      );
    } catch (err) {
      handleApiException(err, "Intentional Invalid Candidate Rejected");
    } finally {
      setLoading(false);
    }
  };

  const [showJudgeGuide, setShowJudgeGuide] = useState<boolean>(true);

  // 1-Click Complete Judge Auto-Demo: resets to standard v1, stages T101 +20m & P2 closure, and executes mathematical replanning
  const handleRunJudgeAutoDemo = async () => {
    setLoading(true);
    setErrorBanner(null);
    setActivePage("map");
    try {
      setNotice("Judge Demo (1/3): Loading clean baseline station timetable (v1)…");
      const freshScenario = await createDemoScenario("standard");
      const demoDisruptions: DisruptionInput[] = [
        { type: "train_delay", train_id: "T101", delay_minutes: 20 },
        {
          type: "platform_closure",
          platform_id: "P2",
          start_time: "09:20",
          end_time: "10:00",
        },
      ];
      setStagedDisruptions(demoDisruptions);
      setOperatorConfirmed(true);
      setNotice(
        "Judge Demo (2/3): Staged T101 (+20m delay on P1) & Platform P2 Closure (09:20–10:00). Running OR-Tools CP-SAT Solver + Independent Safety Validator…"
      );
      const newVer = await replanScenario(freshScenario.id, {
        baseline_version_id: freshScenario.active_version_id,
        confirmed: true,
        disruptions: demoDisruptions,
        allow_partial_diagnostic: false,
      });
      await refreshScenarioBundle(freshScenario.id, newVer.id);
      setSimClock(575); // 09:35 AM — right when T101 is on P1 and T102 is on P3!
      setSelectedTrainId("T102");
      setNotice(
        `Judge Demo Complete (v${newVer.version_number} VALID): Train T102 automatically re-routed from closed Platform P2 → Platform P3 (0m delay), and Train T103 held on P1 until 09:50 to keep the 10-minute safety gap!`
      );
    } catch (err) {
      handleApiException(err, "Judge Auto-Demo Failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (typeof window !== "undefined" && window.location.search.includes("autodemo=1")) {
      window.history.replaceState({}, "", window.location.pathname);
      handleRunJudgeAutoDemo();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="control-centre-shell">
      {/* LEFT COMPACT NAVIGATION RAIL */}
      <aside className="nav-rail" aria-label="Main navigation">
        <div className="rail-brand">
          <div className="rail-logo">RF</div>
          <div className="rail-brand-text">
            <strong>RailFlow</strong>
            <span>CONTROL CENTRE</span>
          </div>
        </div>

        <nav className="rail-menu">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={`rail-nav-btn ${
                  activePage === item.id ? "active" : ""
                }`}
                onClick={() => setActivePage(item.id)}
                data-testid={`nav-${item.id}`}
              >
                <Icon size={16} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="rail-telemetry-box">
          <div className="telemetry-mini">
            <span>PLATFORMS</span>
            <strong>{scenario?.platforms?.length ?? 0}</strong>
          </div>
          <div className="telemetry-mini">
            <span>TRAINS</span>
            <strong>{scenario?.trains?.length ?? 0}</strong>
          </div>
          <div className="telemetry-mini">
            <span>REVISIONS</span>
            <strong>{history.length}</strong>
          </div>
          <div className="telemetry-mini">
            <span>CLEARANCE</span>
            <strong>{scenario?.station?.clearance_minutes ?? 10}m</strong>
          </div>
        </div>

        <div className="rail-footer">
          <span className={`dot ${health ? "online" : "offline"}`} />
          <div>
            <strong>{health ? "OR-Tools CP-SAT" : "Offline"}</strong>
            <small>AI Assign Forbidden</small>
          </div>
        </div>
      </aside>

      {/* MAIN OPERATIONS COLUMN */}
      <div className="main-ops-column">
        {/* TOP OPERATIONS BAR */}
        <header className="ops-topbar">
          <div className="topbar-left">
            <span
              className="fictional-simulation-pill"
              data-testid="fictional-simulation-banner"
            >
              FICTIONAL SIMULATION — NO LIVE RAILWAY DATA
            </span>
            <div className="station-selector-group">
              <select
                className="control-select compact"
                value={scenario?.id ?? ""}
                onChange={(e) => handleSelectScenario(e.target.value)}
                disabled={loading}
                aria-label="Select active station scenario"
                data-testid="scenario-selector"
              >
                {scenarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.station?.name ?? "Central Junction"} — {s.name} ({s.id})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="hud-btn"
                onClick={() => handleLoadDemo("standard")}
                disabled={loading}
                data-testid="load-standard-demo-btn"
              >
                <Sparkles size={13} /> Standard Demo
              </button>
              <button
                type="button"
                className="hud-btn warn"
                onClick={() => handleLoadDemo("impossible")}
                disabled={loading}
                data-testid="load-impossible-demo-btn"
              >
                <ShieldAlert size={13} /> Impossible Demo
              </button>
            </div>
          </div>

          <div className="topbar-center">
            <div className="clock-widget">
              <Clock size={14} className="clock-icon" />
              <span className="clock-label">SIM CLOCK</span>
              <strong className="clock-time">{minToClock(simClock)}</strong>
              <button
                type="button"
                className="clock-btn"
                onClick={() => setPlaying((p) => !p)}
                title={playing ? "Pause simulation" : "Play simulation"}
              >
                {playing ? <Pause size={13} /> : <Play size={13} />}
              </button>
              <button
                type="button"
                className="clock-btn"
                onClick={() =>
                  setSpeed((s) => (s === 1 ? 2 : s === 2 ? 4 : 1))
                }
              >
                <FastForward size={12} /> {speed}×
              </button>
            </div>
          </div>

          <div className="topbar-right">
            {scenario && currentVersion && (
              <>
                <select
                  className="control-select compact"
                  value={currentVersion.id}
                  onChange={(e) => setSelectedVersionId(e.target.value)}
                  aria-label="Select schedule revision"
                  data-testid="revision-selector"
                >
                  {history.map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.version_number} ({v.id}) — {v.solver_status} /{" "}
                      {v.validation_status}
                      {v.id === scenario.active_version_id ? " [ACTIVE]" : ""}
                    </option>
                  ))}
                </select>
                <SolverBadge status={currentVersion.solver_status} />
                <ValidationBadge
                  status={currentVersion.validation_status}
                  isComplete={currentVersion.is_complete}
                />
              </>
            )}
            <button
              type="button"
              className="hud-btn icon-only"
              onClick={() =>
                scenario &&
                refreshScenarioBundle(scenario.id, currentVersion?.id)
              }
              title="Refresh scenario state"
            >
              <RefreshCw size={14} />
            </button>
          </div>
        </header>

        {/* SECONDARY QUICK-ACTION & STATUS STRIP */}
        <div className="quick-action-strip">
          <div className="notice-readout" data-testid="status-notice-bar">
            {notice}
          </div>
          <div className="quick-action-buttons">
            <button
              type="button"
              className="hud-btn"
              onClick={() => setActivePage("disruptions")}
              data-testid="quick-create-disruption-btn"
            >
              <Plus size={13} /> Create Disruption
            </button>
            <button
              type="button"
              className="hud-btn accent"
              onClick={() => {
                if (stagedDisruptions.length > 0 && operatorConfirmed) {
                  handleApplyReplan();
                } else {
                  setActivePage("disruptions");
                }
              }}
              data-testid="quick-run-replanning-btn"
            >
              <Cpu size={13} /> Run Replanning
            </button>
            <button
              type="button"
              className="hud-btn"
              onClick={async () => {
                if (!scenario || !currentVersion) return;
                const run = await validateScheduleVersion(currentVersion.id);
                await refreshScenarioBundle(scenario.id, currentVersion.id);
                setNotice(
                  `Independent Validator verified v${currentVersion.version_number}: ${run.validation_status} (${run.errors.length} findings).`
                );
              }}
              data-testid="quick-validate-schedule-btn"
            >
              <ShieldCheck size={13} /> Validate Schedule
            </button>
            <button
              type="button"
              className="hud-btn"
              onClick={() => setActivePage("revisions")}
              data-testid="quick-compare-revisions-btn"
            >
              <GitCompare size={13} /> Compare Revisions
            </button>
          </div>
        </div>

        {errorBanner && (
          <div className="error-banner" role="alert" data-testid="error-banner">
            <AlertTriangle size={18} />
            <div className="error-banner-body">
              <strong>{errorBanner.title}</strong>
              <p>{errorBanner.message}</p>
              {errorBanner.findings && errorBanner.findings.length > 0 && (
                <ul className="finding-mini-list">
                  {errorBanner.findings.map((f, idx) => (
                    <li key={idx}>
                      <code>{f.code}</code>: {f.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button
              type="button"
              className="dismiss-btn"
              onClick={() => setErrorBanner(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        {/* JUDGE & FIRST-TIME VISITOR PLAIN-ENGLISH STORY BANNER */}
        {scenario && currentVersion && (
          <div className="judge-story-banner" data-testid="judge-story-banner">
            <div className="judge-story-top">
              <div className="judge-story-headline">
                <span className="judge-tag">WHAT IS THIS WEBSITE?</span>
                <strong>
                  Railway Station Disruption &amp; Anti-Collision Simulator
                </strong>
                <span className="judge-sub">
                  When a train is late or a track closes, <b>AI</b> translates the
                  alert, <b>Google OR-Tools</b> re-routes the trains, and a{" "}
                  <b>Safety Firewall</b> verifies a 10-minute safety gap.
                </span>
              </div>
              <div className="judge-story-actions">
                <button
                  type="button"
                  className="judge-demo-cta"
                  onClick={handleRunJudgeAutoDemo}
                  disabled={loading}
                  data-testid="judge-auto-demo-btn"
                >
                  <Play size={13} /> Watch 1-Click Judge Demo
                </button>
                <button
                  type="button"
                  className="judge-firewall-cta"
                  onClick={handleRunIntentionalInvalidDemo}
                  disabled={loading}
                  data-testid="judge-firewall-demo-btn"
                  title="Test what happens if someone tries to put 2 trains on P1 with only a 5-minute gap"
                >
                  <ShieldAlert size={13} /> Test Unsafe Schedule (Firewall)
                </button>
                <button
                  type="button"
                  className="judge-toggle-btn"
                  onClick={() => setShowJudgeGuide((g) => !g)}
                >
                  {showJudgeGuide ? "Hide Story ▲" : "How It Works ▼"}
                </button>
              </div>
            </div>

            {showJudgeGuide && (
              <div className="judge-story-cards">
                <div
                  className={`judge-story-card ${
                    currentVersion.version_number === 1 &&
                    stagedDisruptions.length === 0
                      ? "active-card"
                      : ""
                  }`}
                >
                  <span className="jsc-step">1. THE BASELINE (v1)</span>
                  <strong>4 Trains · 3 Platforms · 10m Safety Gap</strong>
                  <p>
                    <code>T101</code> (P1 09:00–09:20), <code>T102</code> (P2
                    09:30–09:50), <code>T103</code> (P1 09:35–09:55),{" "}
                    <code>T104</code> (P3 10:00–10:20). All signals{" "}
                    <b className="txt-green">GREEN</b>.
                  </p>
                </div>

                <div
                  className={`judge-story-card ${
                    stagedDisruptions.length > 0 ? "active-card warn" : ""
                  }`}
                >
                  <span className="jsc-step">2. THE CRISIS (09:20 AM)</span>
                  <strong>T101 +20m Late &amp; Track P2 Closed!</strong>
                  <p>
                    <code>T101</code> now stays on <b>P1 until 09:40</b>{" "}
                    (colliding with <code>T103</code> at 09:35!), while{" "}
                    <b>Platform P2 closes 09:20–10:00</b> (blocking{" "}
                    <code>T102</code>!).
                  </p>
                </div>

                <div
                  className={`judge-story-card ${
                    currentVersion.version_number > 1 &&
                    currentVersion.validation_status === "VALID"
                      ? "active-card safe"
                      : currentVersion.validation_status === "INVALID"
                      ? "active-card danger"
                      : ""
                  }`}
                >
                  <span className="jsc-step">
                    3. LIVE RESULT (v{currentVersion.version_number} ·{" "}
                    {currentVersion.validation_status})
                  </span>
                  {currentVersion.validation_status === "INVALID" ? (
                    <>
                      <strong className="txt-red">
                        Blocked by Safety Firewall!
                      </strong>
                      <p>
                        Independent Validator caught{" "}
                        <b>{currentVersion.validation_findings?.length ?? 1} safety violation(s)</b>{" "}
                        and kept safe baseline <b>{scenario.active_version_id}</b>{" "}
                        active.
                      </p>
                    </>
                  ) : currentVersion.version_number > 1 ? (
                    <>
                      <strong className="txt-green">
                        Conflict Solved — Zero Collisions!
                      </strong>
                      <p>
                        <code>T102</code> switched <b>P2 → P3</b> (0m delay!)
                        and <code>T103</code> held until <b>09:50 on P1</b>{" "}
                        (exact 10m safety buffer after <code>T101</code>).
                      </p>
                    </>
                  ) : (
                    <>
                      <strong>Ready to Solve</strong>
                      <p>
                        Click <b>&ldquo;▶ Watch 1-Click Judge Demo&rdquo;</b>{" "}
                        above to watch OR-Tools re-route <code>T102</code>{" "}
                        (P2 → P3) and hold <code>T103</code> (+15m).
                      </p>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* CENTRAL WORKSPACE + CONTEXTUAL RIGHT PANEL */}
        {!scenario || !currentVersion ? (
          <div className="empty-centre">
            <Activity size={32} />
            <h2>Initializing Central Junction Simulation…</h2>
          </div>
        ) : (
          <div className="centre-split-grid">
            {/* CENTRE STAGE (70%+ width on Map view) */}
            <div className="centre-stage">
              {activePage === "map" && (
                <div className="map-centric-stage">
                  {/* Native Driver & Signaller 1-Click Guided Simulation Bar */}
                  <div
                    className="driver-guided-bar"
                    data-testid="driver-guided-bar"
                  >
                    <div className="driver-guided-steps">
                      <span className="driver-bar-title">
                        DRIVER &amp; SIGNALLER QUICK GUIDE:
                      </span>
                      <button
                        type="button"
                        className={`driver-step-btn ${
                          currentVersion.version_number === 1 &&
                          stagedDisruptions.length === 0
                            ? "active-step"
                            : ""
                        }`}
                        onClick={() => handleLoadDemo("standard")}
                        disabled={loading}
                        data-testid="driver-step-1-btn"
                      >
                        <span className="step-num">1</span> Normal Day (v1)
                      </button>
                      <button
                        type="button"
                        className={`driver-step-btn ${
                          stagedDisruptions.length > 0 ? "active-step" : ""
                        }`}
                        onClick={() => {
                          setStagedDisruptions([
                            {
                              type: "train_delay",
                              train_id: "T101",
                              delay_minutes: 20,
                            },
                            {
                              type: "platform_closure",
                              platform_id: "P2",
                              start_time: "09:20",
                              end_time: "10:00",
                            },
                          ]);
                          setOperatorConfirmed(true);
                          setNotice(
                            "Step 2 Ready: T101 (+20m delay) & Platform P2 closure (09:20–10:00) staged and confirmed. Click Step 3 to Re-Route Trains."
                          );
                        }}
                        disabled={loading}
                        data-testid="driver-step-2-btn"
                      >
                        <span className="step-num">2</span> Stage T101 +20m
                        &amp; Close P2
                      </button>
                      <button
                        type="button"
                        className={`driver-step-btn primary-step ${
                          stagedDisruptions.length > 0 && operatorConfirmed
                            ? "pulse-ready"
                            : ""
                        }`}
                        onClick={async () => {
                          if (stagedDisruptions.length === 0) {
                            setStagedDisruptions([
                              {
                                type: "train_delay",
                                train_id: "T101",
                                delay_minutes: 20,
                              },
                              {
                                type: "platform_closure",
                                platform_id: "P2",
                                start_time: "09:20",
                                end_time: "10:00",
                              },
                            ]);
                            setOperatorConfirmed(true);
                            return;
                          }
                          setOperatorConfirmed(true);
                          await handleApplyReplan();
                        }}
                        disabled={loading}
                        data-testid="driver-step-3-btn"
                      >
                        <span className="step-num">3</span>{" "}
                        {stagedDisruptions.length > 0
                          ? `Confirm & Re-Route Trains (${stagedDisruptions.length})`
                          : "Confirm & Re-Route Trains"}
                      </button>
                    </div>

                    {/* Live Driver Cab & Platform Readout Pills */}
                    <div
                      className="driver-cab-strip"
                      data-testid="driver-cab-strip"
                    >
                      {(currentVersion.assignments ?? []).map((a) => {
                        const chg = (currentVersion.changes ?? []).find(
                          (c) => c.train_id === a.train_id
                        );
                        const isMoved = Boolean(chg?.platform_changed);
                        const isDelayed = a.total_delay_minutes > 0;
                        return (
                          <div
                            key={a.train_id}
                            className={`driver-mini-card ${
                              selectedTrainId === a.train_id ? "selected" : ""
                            } ${
                              a.unresolved
                                ? "hold"
                                : isMoved
                                ? "rerouted"
                                : isDelayed
                                ? "delayed"
                                : "ontime"
                            }`}
                            onClick={() => {
                              setSelectedTrainId(a.train_id);
                              setSelectedPlatformId(null);
                            }}
                            data-testid={`driver-card-${a.train_id}`}
                          >
                            <div className="driver-mini-top">
                              <span
                                className={`driver-led ${
                                  a.unresolved
                                    ? "red"
                                    : isMoved || isDelayed
                                    ? "amber"
                                    : "green"
                                }`}
                              />
                              <strong>{a.train_id}</strong>
                              <span className="driver-track-pill">
                                {a.unresolved
                                  ? "HOLD"
                                  : isMoved
                                  ? `${chg?.previous_platform} → ${a.platform_id}`
                                  : `Track ${a.platform_id}`}
                              </span>
                            </div>
                            <div className="driver-mini-sub">
                              <span>
                                {a.arrival_str ?? "--:--"}–
                                {a.departure_str ?? "--:--"}
                              </span>
                              <span>
                                {a.unresolved
                                  ? "Blocked"
                                  : isDelayed
                                  ? `+${a.total_delay_minutes}m`
                                  : "On Time"}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <StationMap
                    scenario={scenario}
                    activeVersion={currentVersion}
                    baselineVersion={baselineVersion}
                    simClock={simClock}
                    setSimClock={setSimClock}
                    playing={playing}
                    setPlaying={setPlaying}
                    speed={speed}
                    setSpeed={setSpeed}
                    selectedTrainId={selectedTrainId}
                    selectedPlatformId={selectedPlatformId}
                    onSelectTrain={(tid) => {
                      setSelectedTrainId(tid);
                      setSelectedPlatformId(null);
                      setRightTab("inspector");
                      setRightCollapsed(false);
                    }}
                    onSelectPlatform={(pid) => {
                      setSelectedPlatformId(pid);
                      setSelectedTrainId(null);
                      setRightTab("inspector");
                      setRightCollapsed(false);
                    }}
                  />

                  {/* Compact Bottom Platform Occupancy Timeline Strip */}
                  <CompactOccupancyStrip
                    scenario={scenario}
                    version={currentVersion}
                    simClock={simClock}
                    selectedTrainId={selectedTrainId}
                    selectedPlatformId={selectedPlatformId}
                    onSelectTrain={(tid) => {
                      setSelectedTrainId(tid);
                      setSelectedPlatformId(null);
                    }}
                    onSelectPlatform={(pid) => {
                      setSelectedPlatformId(pid);
                      setSelectedTrainId(null);
                    }}
                  />
                </div>
              )}

              {activePage === "overview" && (
                <OverviewPage
                  scenario={scenario}
                  version={currentVersion}
                  stagedDisruptions={stagedDisruptions}
                  operatorConfirmed={operatorConfirmed}
                  simClock={simClock}
                  onNavigate={(p) => setActivePage(p)}
                  onSelectTrain={(tid) => {
                    setSelectedTrainId(tid);
                    setSelectedPlatformId(null);
                  }}
                />
              )}

              {activePage === "timetable" && (
                <TimetablePage
                  scenario={scenario}
                  version={currentVersion}
                  simClock={simClock}
                  onSelectTrain={(tid) => {
                    setSelectedTrainId(tid);
                    setSelectedPlatformId(null);
                  }}
                  onQuickDelay={(tid, mins) => {
                    handleQuickStageDisruption(
                      { type: "train_delay", train_id: tid, delay_minutes: mins },
                      `Delay ${tid} +${mins}m`
                    );
                    setActivePage("disruptions");
                  }}
                />
              )}

              {activePage === "disruptions" && (
                <DisruptionsPage
                  scenario={scenario}
                  history={history}
                  nlText={nlText}
                  setNlText={setNlText}
                  parseResult={parseResult}
                  stagedDisruptions={stagedDisruptions}
                  setStagedDisruptions={setStagedDisruptions}
                  operatorConfirmed={operatorConfirmed}
                  setOperatorConfirmed={setOperatorConfirmed}
                  baselineForReplan={baselineForReplan}
                  setBaselineForReplan={setBaselineForReplan}
                  allowPartialDiagnostic={allowPartialDiagnostic}
                  setAllowPartialDiagnostic={setAllowPartialDiagnostic}
                  onParse={handleParseDisruption}
                  onApply={handleApplyReplan}
                  loading={loading}
                />
              )}

              {activePage === "replanning" && (
                <ReplanningAndAssignmentPage
                  scenario={scenario}
                  version={currentVersion}
                  history={history}
                  loading={loading}
                  setLoading={setLoading}
                  onSelectVersion={(id) => setSelectedVersionId(id)}
                  onRunIntentionalInvalid={handleRunIntentionalInvalidDemo}
                  onManualAssignSuccess={async (newVer, savedAsDiagnostic) => {
                    await refreshScenarioBundle(scenario.id, newVer.id);
                    setNotice(
                      savedAsDiagnostic
                        ? `Saved diagnostic candidate v${newVer.version_number} (${newVer.id}) — Validator: ${newVer.validation_status}. Active valid schedule remains ${scenario.active_version_id}.`
                        : `Committed validated manual revision v${newVer.version_number} (${newVer.id}).`
                    );
                  }}
                  onManualAssignError={(err) =>
                    handleApiException(err, "Validator Rejected Manual Schedule")
                  }
                />
              )}

              {activePage === "validation" && (
                <ValidationCenterPage
                  scenario={scenario}
                  version={currentVersion}
                  onRefresh={async () => {
                    await refreshScenarioBundle(scenario.id, currentVersion.id);
                  }}
                  onFocusConflictOnMap={(platformId, trainIds, startMin) => {
                    if (platformId) setSelectedPlatformId(platformId);
                    if (trainIds.length > 0) setSelectedTrainId(trainIds[0]);
                    if (startMin !== null) setSimClock(startMin);
                    setActivePage("map");
                  }}
                  onRunIntentionalInvalid={handleRunIntentionalInvalidDemo}
                />
              )}

              {activePage === "revisions" && (
                <RevisionsAndAuditPage
                  scenario={scenario}
                  currentVersion={currentVersion}
                  history={history}
                  auditEvents={auditEvents}
                  onSelectVersion={(id) => setSelectedVersionId(id)}
                  onRefreshAudit={async () => {
                    const audits = await listAuditEvents(scenario.id);
                    setAuditEvents(audits);
                  }}
                />
              )}

              {activePage === "settings" && (
                <SettingsPage
                  health={health}
                  scenario={scenario}
                  onResetStandard={() => handleLoadDemo("standard")}
                  onResetImpossible={() => handleLoadDemo("impossible")}
                />
              )}
            </div>

            {/* RIGHT CONTEXTUAL OPERATIONS & VOICE OPERATOR PANEL */}
            <aside
              className={`contextual-right-panel ${
                rightCollapsed ? "collapsed" : ""
              }`}
              data-testid="contextual-right-panel"
            >
              <div className="right-panel-tabs">
                <button
                  type="button"
                  className={`right-tab-btn ${
                    rightTab === "inspector" && !rightCollapsed ? "active" : ""
                  }`}
                  onClick={() => {
                    setRightTab("inspector");
                    setRightCollapsed(false);
                  }}
                  data-testid="right-tab-inspector"
                >
                  <TrainFront size={13} /> Operations
                </button>
                <button
                  type="button"
                  className={`right-tab-btn ${
                    rightTab === "voice" && !rightCollapsed ? "active" : ""
                  }`}
                  onClick={() => {
                    setRightTab("voice");
                    setRightCollapsed(false);
                  }}
                  data-testid="right-tab-voice"
                >
                  <Mic size={13} /> Voice Operator
                </button>
                <button
                  type="button"
                  className="collapse-toggle-btn"
                  onClick={() => setRightCollapsed((c) => !c)}
                  title={rightCollapsed ? "Expand panel" : "Collapse panel"}
                >
                  <ChevronRight
                    size={14}
                    style={{
                      transform: rightCollapsed ? "rotate(180deg)" : "none",
                    }}
                  />
                </button>
              </div>

              {!rightCollapsed && (
                <div className="right-panel-content">
                  {rightTab === "inspector" ? (
                    <ContextualOperationsInspector
                      scenario={scenario}
                      version={currentVersion}
                      selectedTrainId={selectedTrainId}
                      selectedPlatformId={selectedPlatformId}
                      stagedDisruptions={stagedDisruptions}
                      operatorConfirmed={operatorConfirmed}
                      setOperatorConfirmed={setOperatorConfirmed}
                      onSelectTrain={(tid) => {
                        setSelectedTrainId(tid);
                        setSelectedPlatformId(null);
                      }}
                      onSelectPlatform={(pid) => {
                        setSelectedPlatformId(pid);
                        setSelectedTrainId(null);
                      }}
                      onStageDisruption={handleQuickStageDisruption}
                      onConfirmAndReplan={handleApplyReplan}
                      onFocusTime={(m) => setSimClock(m)}
                      loading={loading}
                    />
                  ) : (
                    <VoiceOperatorPanel
                      scenario={scenario}
                      currentVersion={currentVersion}
                      simClock={simClock}
                      onStageDisruptionDrafts={(drafts, rawText) => {
                        setStagedDisruptions((prev) => [...prev, ...drafts]);
                        setOperatorConfirmed(false);
                        setRightTab("inspector");
                        setNotice(
                          `Voice Operator staged ${drafts.length} disruption draft(s) from "${rawText}". Review and confirm to replan.`
                        );
                      }}
                      onSelectTrain={(tid) => {
                        setSelectedTrainId(tid);
                        setSelectedPlatformId(null);
                      }}
                      onSelectPlatform={(pid) => {
                        setSelectedPlatformId(pid);
                        setSelectedTrainId(null);
                      }}
                    />
                  )}
                </div>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================================
   COMPACT BOTTOM PLATFORM OCCUPANCY STRIP (UNDER LIVE MAP)
   ============================================================================ */
function CompactOccupancyStrip({
  scenario,
  version,
  simClock,
  selectedTrainId,
  selectedPlatformId,
  onSelectTrain,
  onSelectPlatform,
}: {
  scenario: ScenarioResponse;
  version: ScheduleVersion;
  simClock: number;
  selectedTrainId: string | null;
  selectedPlatformId: string | null;
  onSelectTrain: (tid: string) => void;
  onSelectPlatform: (pid: string) => void;
}) {
  const platforms = scenario.platforms ?? [];
  const assignments = version.assignments ?? [];
  const disruptions = version.applied_disruptions ?? [];
  const findings = version.validation_findings ?? [];

  const minTime = 525; // 08:45
  const maxTime = 630; // 10:30
  const span = maxTime - minTime;
  const toPct = (m: number) =>
    Math.max(0, Math.min(100, ((m - minTime) / span) * 100));

  const ticks = [525, 540, 555, 570, 585, 600, 615, 630];
  const conflictingTrains = new Set<string>();
  findings.forEach((f) =>
    (f.train_ids ?? []).forEach((tid) => conflictingTrains.add(tid))
  );

  return (
    <div
      className="compact-occupancy-strip"
      data-testid="compact-occupancy-timeline"
    >
      <div className="strip-scale">
        <div className="strip-label-col">PLATFORM TIMELINE</div>
        <div className="strip-track-col">
          {ticks.map((t) => (
            <span
              key={t}
              className="strip-tick"
              style={{ left: `${toPct(t)}%` }}
            >
              {minToClock(t)}
            </span>
          ))}
        </div>
      </div>

      {platforms.map((p) => {
        const gapMin =
          p.clearance_minutes ??
          p.min_gap_minutes ??
          scenario.station?.clearance_minutes ??
          10;
        const pAsgns = assignments.filter(
          (a) =>
            a.platform_id === p.id &&
            !a.unresolved &&
            a.arrival !== null &&
            a.departure !== null
        );
        const pClosures = disruptions.filter(
          (d) =>
            d.type === "platform_closure" &&
            (d.platform_id === p.id || d.target_id === p.id) &&
            d.start !== null &&
            d.end !== null
        );

        return (
          <div
            key={p.id}
            className={`strip-row ${
              selectedPlatformId === p.id ? "selected" : ""
            }`}
            onClick={() => onSelectPlatform(p.id)}
            data-testid={`timeline-row-${p.id}`}
          >
            <div className="strip-label-col">
              <strong>{p.id}</strong>
              <small>Gap {gapMin}m</small>
            </div>
            <div className="strip-track-col">
              <div
                className="sim-playhead"
                style={{ left: `${toPct(simClock)}%` }}
              />
              {pClosures.map((c) => {
                const s = c.start as number;
                const e = c.end as number;
                return (
                  <div
                    key={c.id}
                    className="strip-closure"
                    style={{
                      left: `${toPct(s)}%`,
                      width: `${Math.max(2, toPct(e) - toPct(s))}%`,
                    }}
                    title={`${p.id} CLOSED ${c.start_str}–${c.end_str}`}
                  >
                    CLOSED {c.start_str}–{c.end_str}
                  </div>
                );
              })}

              {pAsgns.map((a) => {
                const arr = a.arrival as number;
                const dep = a.departure as number;
                const left = toPct(arr);
                const width = Math.max(4, toPct(dep) - left);
                const bufLeft = toPct(dep);
                const bufWidth = Math.max(1, toPct(dep + gapMin) - bufLeft);
                const isConflict = conflictingTrains.has(a.train_id);
                const isDelayed = a.total_delay_minutes > 0;

                return (
                  <React.Fragment key={a.train_id}>
                    <div
                      className="strip-buffer"
                      style={{ left: `${bufLeft}%`, width: `${bufWidth}%` }}
                    />
                    <div
                      className={`strip-train ${
                        isConflict
                          ? "conflict"
                          : isDelayed
                          ? "delayed"
                          : "normal"
                      } ${selectedTrainId === a.train_id ? "selected" : ""}`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectTrain(a.train_id);
                      }}
                      data-testid={`timeline-train-${a.train_id}`}
                    >
                      <strong>{a.train_id}</strong>
                      <span>
                        {a.arrival_str}–{a.departure_str}
                      </span>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================================
   RIGHT PANEL: CONTEXTUAL OPERATIONS INSPECTOR
   ============================================================================ */
function ContextualOperationsInspector({
  scenario,
  version,
  selectedTrainId,
  selectedPlatformId,
  stagedDisruptions,
  operatorConfirmed,
  setOperatorConfirmed,
  onSelectTrain,
  onSelectPlatform,
  onStageDisruption,
  onConfirmAndReplan,
  onFocusTime,
  loading,
}: {
  scenario: ScenarioResponse;
  version: ScheduleVersion;
  selectedTrainId: string | null;
  selectedPlatformId: string | null;
  stagedDisruptions: DisruptionInput[];
  operatorConfirmed: boolean;
  setOperatorConfirmed: (v: boolean) => void;
  onSelectTrain: (tid: string) => void;
  onSelectPlatform: (pid: string) => void;
  onStageDisruption: (d: DisruptionInput, label: string) => void;
  onConfirmAndReplan: () => void;
  onFocusTime: (m: number) => void;
  loading: boolean;
}) {
  const trains = scenario.trains ?? [];
  const platforms = scenario.platforms ?? [];
  const assignments = version.assignments ?? [];
  const changes = version.changes ?? [];
  const disruptions = version.applied_disruptions ?? [];
  const findings = version.validation_findings ?? [];

  const selectedTrain = trains.find((t) => t.id === selectedTrainId) ?? null;
  const selectedAsgn =
    assignments.find((a) => a.train_id === selectedTrainId) ?? null;
  const selectedChange =
    changes.find((c) => c.train_id === selectedTrainId) ?? null;

  const selectedPlatform =
    platforms.find((p) => p.id === selectedPlatformId) ?? null;

  return (
    <div className="inspector-panel-stack" data-testid="operations-inspector">
      {/* 1. Staged Unconfirmed Disruptions Gate (if any) */}
      {stagedDisruptions.length > 0 && (
        <div
          className="inspector-card gate-card"
          data-testid="inspector-staged-disruptions"
        >
          <div className="card-header-mini">
            <span className="eyebrow">PENDING DISRUPTION GATE</span>
            <strong>
              {stagedDisruptions.length} Event(s) Awaiting Confirmation
            </strong>
          </div>
          <ul className="compact-list">
            {stagedDisruptions.map((d, idx) => (
              <li key={idx}>
                {d.type === "train_delay" ? (
                  <span>
                    Delay <strong>{d.train_id || d.target_id}</strong> by{" "}
                    <strong>+{d.delay_minutes}m</strong>
                  </span>
                ) : (
                  <span>
                    Close <strong>{d.platform_id || d.target_id}</strong> (
                    {normalizeTimeStr(d.start_time ?? d.start)}–
                    {normalizeTimeStr(d.end_time ?? d.end)})
                  </span>
                )}
              </li>
            ))}
          </ul>
          <label className="confirm-checkbox">
            <input
              type="checkbox"
              checked={operatorConfirmed}
              onChange={(e) => setOperatorConfirmed(e.target.checked)}
              data-testid="inspector-confirm-checkbox"
            />
            <span>I confirm these disruption events for CP-SAT replanning</span>
          </label>
          <button
            type="button"
            className="primary full-width"
            disabled={!operatorConfirmed || loading}
            onClick={onConfirmAndReplan}
            data-testid="inspector-replan-btn"
          >
            {loading ? "Solving…" : "Confirm & Run CP-SAT Replan"}
          </button>
        </div>
      )}

      {/* 2. Selected Platform Details */}
      {selectedPlatform && (
        <div
          className="inspector-card"
          data-testid={`inspector-platform-${selectedPlatform.id}`}
        >
          <div className="card-header-mini">
            <span className="eyebrow">SELECTED PLATFORM TELEMETRY</span>
            <h3>
              Platform {selectedPlatform.id} —{" "}
              {selectedPlatform.name ?? "Mainline Berth"}
            </h3>
          </div>
          <div className="kv-grid">
            <div>
              <span>Min Separation Gap</span>
              <strong>
                {selectedPlatform.clearance_minutes ??
                  selectedPlatform.min_gap_minutes ??
                  scenario.station?.clearance_minutes ??
                  10}{" "}
                min
              </strong>
            </div>
            <div>
              <span>Assigned Trains</span>
              <strong>
                {
                  assignments.filter(
                    (a) =>
                      a.platform_id === selectedPlatform.id && !a.unresolved
                  ).length
                }
              </strong>
            </div>
          </div>

          <h4>Scheduled Occupancy on {selectedPlatform.id}</h4>
          <ul className="compact-list">
            {assignments
              .filter(
                (a) => a.platform_id === selectedPlatform.id && !a.unresolved
              )
              .map((a) => (
                <li
                  key={a.train_id}
                  onClick={() => onSelectTrain(a.train_id)}
                  style={{ cursor: "pointer" }}
                >
                  <strong>{a.train_id}</strong>: {a.arrival_str}–
                  {a.departure_str}{" "}
                  {a.total_delay_minutes > 0 && (
                    <span className="text-amber">
                      (+{a.total_delay_minutes}m)
                    </span>
                  )}
                </li>
              ))}
          </ul>

          <h4>Quick Disruption Action on {selectedPlatform.id}</h4>
          <button
            type="button"
            className="outline full-width"
            onClick={() =>
              onStageDisruption(
                {
                  type: "platform_closure",
                  platform_id: selectedPlatform.id,
                  start_time: "09:20",
                  end_time: "10:00",
                },
                `Close ${selectedPlatform.id} 09:20–10:00`
              )
            }
            data-testid={`stage-closure-${selectedPlatform.id}-btn`}
          >
            Stage Closure on {selectedPlatform.id} (09:20–10:00)
          </button>
        </div>
      )}

      {/* 3. Selected Train Details */}
      {selectedAsgn && (
        <div
          className="inspector-card"
          data-testid={`inspector-train-${selectedAsgn.train_id}`}
        >
          <div className="card-header-mini">
            <span className="eyebrow">SELECTED TRAIN TELEMETRY</span>
            <h3>
              {selectedAsgn.train_id} ·{" "}
              {selectedAsgn.unresolved
                ? "UNRESOLVED"
                : `Platform ${selectedAsgn.platform_id}`}
            </h3>
          </div>

          <div className="kv-grid">
            <div>
              <span>Baseline Window</span>
              <strong>
                {minToClock(selectedAsgn.baseline_arrival)}–
                {minToClock(selectedAsgn.baseline_departure)}
              </strong>
            </div>
            <div>
              <span>Scheduled Window</span>
              <strong>
                {selectedAsgn.unresolved
                  ? "UNASSIGNED"
                  : `${selectedAsgn.arrival_str}–${selectedAsgn.departure_str}`}
              </strong>
            </div>
            <div>
              <span>Disruption Delay</span>
              <strong className={selectedAsgn.disruption_delay_minutes > 0 ? "text-amber" : ""}>
                +{selectedAsgn.disruption_delay_minutes} min
              </strong>
            </div>
            <div>
              <span>Solver Hold</span>
              <strong>+{selectedAsgn.additional_delay_minutes} min</strong>
            </div>
            <div>
              <span>Allowed Platforms</span>
              <strong>
                {(selectedTrain?.allowed_platforms ?? []).length > 0
                  ? (selectedTrain?.allowed_platforms ?? []).join(", ")
                  : "All (P1, P2, P3)"}
              </strong>
            </div>
            <div>
              <span>Commitment</span>
              <strong>
                {selectedAsgn.fixed
                  ? "FIXED"
                  : selectedAsgn.departed
                  ? "DEPARTED"
                  : "Mutable"}
              </strong>
            </div>
          </div>

          {selectedChange &&
            (selectedChange.platform_changed ||
              selectedChange.timing_changed) && (
              <div className="change-reason-box">
                <strong>Recorded Change Reason:</strong>
                <p>{selectedChange.reason}</p>
              </div>
            )}

          <h4>Quick Disruption Action on {selectedAsgn.train_id}</h4>
          <div className="btn-row-compact">
            <button
              type="button"
              className="outline compact"
              onClick={() =>
                onStageDisruption(
                  {
                    type: "train_delay",
                    train_id: selectedAsgn.train_id,
                    delay_minutes: 20,
                  },
                  `Delay ${selectedAsgn.train_id} +20m`
                )
              }
              data-testid={`stage-delay-${selectedAsgn.train_id}-btn`}
            >
              Delay {selectedAsgn.train_id} +20m
            </button>
            {selectedAsgn.arrival !== null && (
              <button
                type="button"
                className="outline compact"
                onClick={() => onFocusTime(selectedAsgn.arrival!)}
              >
                Jump Clock to {selectedAsgn.arrival_str}
              </button>
            )}
          </div>
        </div>
      )}

      {/* 4. Active Disruptions & Validation Findings Summary */}
      <div className="inspector-card">
        <div className="card-header-mini">
          <span className="eyebrow">ACTIVE DISRUPTIONS & VALIDATION</span>
          <h4>
            Revision v{version.version_number} ({version.validation_status})
          </h4>
        </div>

        {disruptions.length === 0 ? (
          <p className="muted-small">
            No confirmed disruptions applied to this revision.
          </p>
        ) : (
          <ul className="compact-list">
            {disruptions.map((d) => (
              <li key={d.id}>
                {d.type === "train_delay" ? (
                  <span>
                    <strong>{d.train_id}</strong> delayed +{d.delay_minutes}m
                  </span>
                ) : (
                  <span>
                    <strong>{d.platform_id}</strong> closed {d.start_str}–
                    {d.end_str}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {findings.length > 0 && (
          <div className="findings-alert-box" data-testid="inspector-findings">
            <strong>{findings.length} Validation Error(s):</strong>
            <ul className="compact-list">
              {findings.map((f, i) => (
                <li
                  key={i}
                  onClick={() => {
                    if (f.platform_id) onSelectPlatform(f.platform_id);
                    else if ((f.train_ids ?? []).length > 0)
                      onSelectTrain(f.train_ids[0]);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <code>{f.code}</code>: {f.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================================
   PAGE: OVERVIEW
   ============================================================================ */
function OverviewPage({
  scenario,
  version,
  stagedDisruptions,
  operatorConfirmed,
  simClock,
  onNavigate,
  onSelectTrain,
}: {
  scenario: ScenarioResponse;
  version: ScheduleVersion;
  stagedDisruptions: DisruptionInput[];
  operatorConfirmed: boolean;
  simClock: number;
  onNavigate: (page: NavPage) => void;
  onSelectTrain: (tid: string) => void;
}) {
  const assignments = version.assignments ?? [];
  const findings = version.validation_findings ?? [];
  const delayedTrains = assignments.filter((a) => a.total_delay_minutes > 0);

  return (
    <div className="page-scroll-container" data-testid="overview-page">
      <div className="kpi-grid-6">
        <div className="kpi-card">
          <span>Scheduled Trains</span>
          <strong>{scenario.trains.length}</strong>
          <small>Tracked in scenario</small>
        </div>
        <div className="kpi-card">
          <span>Available Platforms</span>
          <strong>{scenario.platforms.length}</strong>
          <small>
            Min gap: {scenario.station?.clearance_minutes ?? 10} min
          </small>
        </div>
        <div className="kpi-card">
          <span>Delayed Trains</span>
          <strong className={delayedTrains.length > 0 ? "text-amber" : ""}>
            {delayedTrains.length}
          </strong>
          <small>
            {delayedTrains.length > 0
              ? delayedTrains.map((d) => d.train_id).join(", ")
              : "All on baseline time"}
          </small>
        </div>
        <div className="kpi-card">
          <span>Platform Conflicts</span>
          <strong className={findings.length > 0 ? "text-red" : "text-emerald"}>
            {version.validation_status === "UNKNOWN"
              ? "Not yet validated"
              : findings.length}
          </strong>
          <small>Independent validator check</small>
        </div>
        <div className="kpi-card">
          <span>Awaiting Confirmation</span>
          <strong className={stagedDisruptions.length > 0 ? "text-amber" : ""}>
            {stagedDisruptions.length}
          </strong>
          <small>
            {operatorConfirmed ? "Confirmed & ready" : "Unconfirmed drafts"}
          </small>
        </div>
        <div className="kpi-card">
          <span>Validation Status</span>
          <strong>{version.validation_status}</strong>
          <small>Solver: {version.solver_status}</small>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Station Occupancy Timeline — v{version.version_number}</h2>
            <p>
              Click any train block to inspect its telemetry or navigate to
              Disruptions / Validation
            </p>
          </div>
          <div className="btn-row-compact">
            <button
              type="button"
              className="primary compact"
              onClick={() => onNavigate("disruptions")}
            >
              Report Disruption
            </button>
            <button
              type="button"
              className="outline compact"
              onClick={() => onNavigate("validation")}
            >
              Open Validation Center
            </button>
            <button
              type="button"
              className="outline compact"
              onClick={() => onNavigate("map")}
            >
              Return to 3D Live Map
            </button>
          </div>
        </div>
        <CompactOccupancyStrip
          scenario={scenario}
          version={version}
          simClock={simClock}
          selectedTrainId={null}
          selectedPlatformId={null}
          onSelectTrain={onSelectTrain}
          onSelectPlatform={() => {}}
        />
      </section>
    </div>
  );
}

/* ============================================================================
   PAGE: TIMETABLE (SEARCHABLE, FILTERABLE, SORTABLE TABLE)
   ============================================================================ */
function TimetablePage({
  scenario,
  version,
  onSelectTrain,
  onQuickDelay,
}: {
  scenario: ScenarioResponse;
  version: ScheduleVersion;
  simClock: number;
  onSelectTrain: (tid: string) => void;
  onQuickDelay: (tid: string, mins: number) => void;
}) {
  const [search, setSearch] = useState<string>("");
  const [platformFilter, setPlatformFilter] = useState<string>("ALL");

  const trains = scenario.trains ?? [];
  const assignments = version.assignments ?? [];
  const trainMap = useMemo(
    () => new Map<string, Train>(trains.map((t) => [t.id, t])),
    [trains]
  );

  const filtered = useMemo(() => {
    return assignments.filter((a) => {
      if (
        search.trim() &&
        !a.train_id.toLowerCase().includes(search.trim().toLowerCase())
      ) {
        return false;
      }
      if (platformFilter !== "ALL" && a.platform_id !== platformFilter) {
        return false;
      }
      return true;
    });
  }, [assignments, search, platformFilter]);

  return (
    <div className="page-scroll-container" data-testid="timetable-page">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Station Timetable — Revision v{version.version_number}</h2>
            <p>
              Search and filter train assignments, platform restrictions, and
              delay impacts
            </p>
          </div>
          <div className="btn-row-compact">
            <div className="search-box">
              <Search size={14} />
              <input
                type="text"
                placeholder="Search train ID (e.g. T101)…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="text-input compact"
                data-testid="timetable-search-input"
              />
            </div>
            <select
              className="control-select compact"
              value={platformFilter}
              onChange={(e) => setPlatformFilter(e.target.value)}
              aria-label="Filter by platform"
              data-testid="timetable-platform-filter"
            >
              <option value="ALL">All Platforms</option>
              {(scenario.platforms ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  Platform {p.id}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="table-wrap">
          <table className="ops-table" data-testid="timetable-table">
            <thead>
              <tr>
                <th>Train ID</th>
                <th>Scheduled Arrival</th>
                <th>Scheduled Departure</th>
                <th>Delay</th>
                <th>Assigned Platform</th>
                <th>Allowed Platforms</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => {
                const t = trainMap.get(a.train_id);
                const allowed = t?.allowed_platforms ?? [];
                return (
                  <tr key={a.train_id}>
                    <td>
                      <strong>{a.train_id}</strong>
                    </td>
                    <td>{a.arrival_str ?? minToClock(a.arrival)}</td>
                    <td>{a.departure_str ?? minToClock(a.departure)}</td>
                    <td className={a.total_delay_minutes > 0 ? "text-amber" : ""}>
                      +{a.total_delay_minutes} min
                    </td>
                    <td>
                      <span className="plat-badge">
                        {a.platform_id ?? "UNASSIGNED"}
                      </span>
                    </td>
                    <td>
                      {allowed.length > 0 ? allowed.join(", ") : "All (P1–P3)"}
                    </td>
                    <td>
                      {a.unresolved ? (
                        <span className="text-red">UNRESOLVED</span>
                      ) : a.fixed ? (
                        "FIXED"
                      ) : a.total_delay_minutes > 0 ? (
                        <span className="text-amber">DELAYED</span>
                      ) : (
                        <span className="text-emerald">ON TIME</span>
                      )}
                    </td>
                    <td>
                      <div className="btn-row-compact">
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => onSelectTrain(a.train_id)}
                        >
                          Inspect
                        </button>
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => onQuickDelay(a.train_id, 20)}
                        >
                          +20m Delay
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/* ============================================================================
   PAGE: DISRUPTIONS WORKFLOW
   ============================================================================ */
function DisruptionsPage({
  scenario,
  history,
  nlText,
  setNlText,
  parseResult,
  stagedDisruptions,
  setStagedDisruptions,
  operatorConfirmed,
  setOperatorConfirmed,
  baselineForReplan,
  setBaselineForReplan,
  allowPartialDiagnostic,
  setAllowPartialDiagnostic,
  onParse,
  onApply,
  loading,
}: {
  scenario: ScenarioResponse;
  history: ScheduleVersion[];
  nlText: string;
  setNlText: (s: string) => void;
  parseResult: DisruptionParseResponse | null;
  stagedDisruptions: DisruptionInput[];
  setStagedDisruptions: React.Dispatch<React.SetStateAction<DisruptionInput[]>>;
  operatorConfirmed: boolean;
  setOperatorConfirmed: (b: boolean) => void;
  baselineForReplan: string;
  setBaselineForReplan: (id: string) => void;
  allowPartialDiagnostic: boolean;
  setAllowPartialDiagnostic: (b: boolean) => void;
  onParse: () => void;
  onApply: () => void;
  loading: boolean;
}) {
  const [structType, setStructType] = useState<
    "train_delay" | "platform_closure"
  >("train_delay");
  const [structTrainId, setStructTrainId] = useState<string>(
    scenario.trains?.[0]?.id ?? "T101"
  );
  const [structDelayMin, setStructDelayMin] = useState<number>(20);
  const [structPlatId, setStructPlatId] = useState<string>(
    scenario.platforms?.[1]?.id ?? "P2"
  );
  const [structStart, setStructStart] = useState<string>("09:20");
  const [structEnd, setStructEnd] = useState<string>("10:00");
  const [structError, setStructError] = useState<string | null>(null);

  const isNlOutOfSync =
    Boolean(nlText.trim()) &&
    (!parseResult || parseResult.raw_text.trim() !== nlText.trim());

  const handleAddStructured = () => {
    setStructError(null);
    if (structType === "train_delay") {
      if (!structDelayMin || structDelayMin <= 0 || structDelayMin > 1440) {
        setStructError("Delay minutes must be a positive integer between 1 and 1440.");
        return;
      }
      setStagedDisruptions((prev) => [
        ...prev,
        normalizeDisruptionForApi({
          type: "train_delay",
          train_id: structTrainId,
          delay_minutes: Math.round(structDelayMin),
        }),
      ]);
    } else {
      const normStart = normalizeTimeStr(structStart);
      const normEnd = normalizeTimeStr(structEnd);
      if (!/^\d{2}:\d{2}$/.test(normStart) || !/^\d{2}:\d{2}$/.test(normEnd)) {
        setStructError("Closure start and end must be valid HH:MM times (e.g., 09:20 to 10:00).");
        return;
      }
      if (clockToMin(normStart) >= clockToMin(normEnd)) {
        setStructError(`Closure start (${normStart}) must strictly precede end (${normEnd}).`);
        return;
      }
      setStagedDisruptions((prev) => [
        ...prev,
        normalizeDisruptionForApi({
          type: "platform_closure",
          platform_id: structPlatId,
          start_time: normStart,
          end_time: normEnd,
        }),
      ]);
    }
    setOperatorConfirmed(false);
  };

  const handleUpdateStagedItem = (
    idx: number,
    patch: Partial<DisruptionInput>
  ) => {
    setStagedDisruptions((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, ...patch } : item))
    );
    setOperatorConfirmed(false);
  };

  return (
    <div className="page-scroll-container" data-testid="disruptions-page">
      <div className="two-col-grid">
        {/* A. Natural-Language Parser */}
        <section className="panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">A. NATURAL-LANGUAGE INGESTION</span>
              <h2>Parse Free-Text Disruption</h2>
            </div>
          </div>
          <textarea
            rows={3}
            className="nl-textarea"
            value={nlText}
            onChange={(e) => setNlText(e.target.value)}
            data-testid="nl-disruption-textarea"
          />
          <div className="btn-row-compact" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="primary"
              onClick={onParse}
              disabled={loading || !nlText.trim()}
              data-testid="parse-nl-btn"
            >
              {loading ? "Parsing…" : "Parse & Review Proposal"}
            </button>
            <button
              type="button"
              className="outline"
              onClick={() =>
                setNlText(
                  "Train T101 is delayed by 20 minutes and platform P2 is closed from 09:20 to 10:00."
                )
              }
              data-testid="reset-standard-nl-btn"
            >
              Standard Demo Text
            </button>
          </div>
          {isNlOutOfSync && (
            <div
              className="parse-meta-box"
              style={{
                marginTop: 10,
                borderLeft: "3px solid #f59e0b",
                paddingLeft: 8,
              }}
              data-testid="nl-unparsed-notice"
            >
              <small>
                Click <strong>Parse &amp; Review Proposal</strong> above to
                convert this natural-language description into structured
                proposals in the review queue below.
              </small>
            </div>
          )}
          {parseResult && (
            <div
              className="parse-meta-box"
              style={{ marginTop: 12 }}
              data-testid="parsed-proposal-box"
            >
              <small>
                Parser Adapter: <code>{parseResult.parser_mode}</code> ·
                Requires Confirmation:{" "}
                <code>{String(parseResult.requires_confirmation)}</code> ·
                Proposed Events: <strong>{(parseResult.events ?? []).length}</strong>
              </small>
              {(parseResult.events ?? []).length > 0 && (
                <ul className="compact-list" style={{ marginTop: 6 }}>
                  {parseResult.events.map((ev, i) => (
                    <li key={i} data-testid={`parsed-event-item-${i}`}>
                      {ev.type === "train_delay" ? (
                        <span>
                          Proposed: Delay <strong>{ev.train_id}</strong> by{" "}
                          <strong>+{ev.delay_minutes} min</strong>
                        </span>
                      ) : (
                        <span>
                          Proposed: Close <strong>{ev.platform_id}</strong> from{" "}
                          <strong>{ev.start_time}</strong> to{" "}
                          <strong>{ev.end_time}</strong>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {(parseResult.warnings ?? []).length > 0 && (
                <p className="text-amber" style={{ marginTop: 6, fontSize: 12 }}>
                  {parseResult.warnings.join(" ")}
                </p>
              )}
            </div>
          )}
        </section>

        {/* B. Structured Form */}
        <section className="panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">B. STRUCTURED MANUAL ENTRY</span>
              <h2>Add Disruption Event</h2>
            </div>
          </div>
          <div className="form-grid-compact">
            <label>
              Event Type
              <select
                className="control-select"
                value={structType}
                onChange={(e) =>
                  setStructType(
                    e.target.value as "train_delay" | "platform_closure"
                  )
                }
                data-testid="structured-type-select"
              >
                <option value="train_delay">Train Delay</option>
                <option value="platform_closure">Platform Closure</option>
              </select>
            </label>

            {structType === "train_delay" ? (
              <>
                <label>
                  Train ID
                  <select
                    className="control-select"
                    value={structTrainId}
                    onChange={(e) => setStructTrainId(e.target.value)}
                    data-testid="structured-train-select"
                  >
                    {(scenario.trains ?? []).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Delay (minutes)
                  <input
                    type="number"
                    min={1}
                    max={360}
                    className="text-input"
                    value={structDelayMin}
                    onChange={(e) => setStructDelayMin(Number(e.target.value))}
                    data-testid="structured-delay-input"
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  Platform ID
                  <select
                    className="control-select"
                    value={structPlatId}
                    onChange={(e) => setStructPlatId(e.target.value)}
                    data-testid="structured-platform-select"
                  >
                    {(scenario.platforms ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Start (HH:MM)
                  <input
                    type="text"
                    className="text-input"
                    value={structStart}
                    onChange={(e) => setStructStart(e.target.value)}
                    data-testid="structured-start-input"
                  />
                </label>
                <label>
                  End (HH:MM)
                  <input
                    type="text"
                    className="text-input"
                    value={structEnd}
                    onChange={(e) => setStructEnd(e.target.value)}
                    data-testid="structured-end-input"
                  />
                </label>
              </>
            )}
          </div>
          {structError && (
            <p className="text-red" style={{ marginTop: 8, fontSize: 12 }}>
              {structError}
            </p>
          )}
          <button
            type="button"
            className="outline"
            style={{ marginTop: 12 }}
            onClick={handleAddStructured}
            data-testid="add-structured-disruption-btn"
          >
            <Plus size={14} /> Stage Event in Review Queue
          </button>
        </section>
      </div>

      {/* Confirmation Gate & Replan Trigger */}
      <section className="panel" data-testid="confirmation-gate-panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">MANDATORY OPERATOR CONFIRMATION GATE</span>
            <h2>Staged Disruptions ({stagedDisruptions.length})</h2>
          </div>
          <div className="btn-row-compact">
            {stagedDisruptions.length > 0 && (
              <button
                type="button"
                className="mini-btn"
                onClick={() => {
                  setStagedDisruptions([]);
                  setOperatorConfirmed(false);
                }}
                data-testid="clear-staged-disruptions-btn"
              >
                Clear Queue
              </button>
            )}
            <label className="version-picker-label">
              Baseline Revision:
              <select
                className="control-select compact"
                value={baselineForReplan}
                onChange={(e) => setBaselineForReplan(e.target.value)}
              >
                {history
                  .filter((v) => v.validation_status === "VALID")
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.version_number} ({v.id})
                    </option>
                  ))}
              </select>
            </label>
          </div>
        </div>

        {stagedDisruptions.length === 0 ? (
          <p className="muted-small">
            No disruption events staged yet. Click{" "}
            <strong>Parse &amp; Review Proposal</strong> or add a structured
            event above.
          </p>
        ) : (
          <table className="ops-table" data-testid="staged-disruptions-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Type</th>
                <th>Target (Editable)</th>
                <th>Parameters (Editable)</th>
                <th>Summary</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {stagedDisruptions.map((d, idx) => {
                const startVal = normalizeTimeStr(d.start_time ?? d.start);
                const endVal = normalizeTimeStr(d.end_time ?? d.end);
                const targetVal =
                  d.type === "train_delay"
                    ? d.train_id || d.target_id || "T101"
                    : d.platform_id || d.target_id || "P2";

                return (
                  <tr key={idx} data-testid={`staged-disruption-row-${idx}`}>
                    <td>{idx + 1}</td>
                    <td>
                      <code>{d.type}</code>
                    </td>
                    <td>
                      {d.type === "train_delay" ? (
                        <select
                          className="control-select compact"
                          value={targetVal}
                          onChange={(e) =>
                            handleUpdateStagedItem(idx, {
                              train_id: e.target.value,
                              target_id: e.target.value,
                            })
                          }
                          aria-label={`Train ID for staged event ${idx + 1}`}
                          data-testid={`staged-train-select-${idx}`}
                        >
                          {(scenario.trains ?? []).map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.id}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <select
                          className="control-select compact"
                          value={targetVal}
                          onChange={(e) =>
                            handleUpdateStagedItem(idx, {
                              platform_id: e.target.value,
                              target_id: e.target.value,
                            })
                          }
                          aria-label={`Platform ID for staged event ${idx + 1}`}
                          data-testid={`staged-platform-select-${idx}`}
                        >
                          {(scenario.platforms ?? []).map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.id}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      {d.type === "train_delay" ? (
                        <div className="btn-row-compact">
                          <input
                            type="number"
                            min={1}
                            max={360}
                            className="text-input compact"
                            style={{ width: 76 }}
                            value={d.delay_minutes ?? 20}
                            onChange={(e) =>
                              handleUpdateStagedItem(idx, {
                                delay_minutes: Number(e.target.value),
                              })
                            }
                            aria-label={`Delay minutes for staged event ${idx + 1}`}
                            data-testid={`staged-delay-input-${idx}`}
                          />
                          <span>min</span>
                        </div>
                      ) : (
                        <div className="btn-row-compact">
                          <input
                            type="text"
                            className="text-input compact"
                            style={{ width: 74 }}
                            value={startVal}
                            onChange={(e) =>
                              handleUpdateStagedItem(idx, {
                                start_time: e.target.value,
                                start: undefined,
                              })
                            }
                            aria-label={`Closure start for staged event ${idx + 1}`}
                            data-testid={`staged-start-input-${idx}`}
                          />
                          <span>to</span>
                          <input
                            type="text"
                            className="text-input compact"
                            style={{ width: 74 }}
                            value={endVal}
                            onChange={(e) =>
                              handleUpdateStagedItem(idx, {
                                end_time: e.target.value,
                                end: undefined,
                              })
                            }
                            aria-label={`Closure end for staged event ${idx + 1}`}
                            data-testid={`staged-end-input-${idx}`}
                          />
                        </div>
                      )}
                    </td>
                    <td>
                      {d.type === "train_delay" ? (
                        <span>
                          <strong>{targetVal}</strong> +{d.delay_minutes} min delay
                        </span>
                      ) : (
                        <span>
                          <strong>{targetVal}</strong> closed {startVal}–{endVal}
                        </span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={() => {
                          setStagedDisruptions((prev) =>
                            prev.filter((_, i) => i !== idx)
                          );
                          setOperatorConfirmed(false);
                        }}
                        data-testid={`remove-staged-${idx}-btn`}
                      >
                        Reject / Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div className="gate-controls-row" style={{ marginTop: 14 }}>
          <label className="confirm-checkbox">
            <input
              type="checkbox"
              checked={operatorConfirmed}
              onChange={(e) => setOperatorConfirmed(e.target.checked)}
              disabled={stagedDisruptions.length === 0}
              data-testid="operator-confirm-checkbox"
            />
            <span>
              <strong>Operator Confirmation:</strong> I have verified the staged
              disruptions and authorize deterministic CP-SAT replanning.
            </span>
          </label>

          <label className="confirm-checkbox">
            <input
              type="checkbox"
              checked={allowPartialDiagnostic}
              onChange={(e) => setAllowPartialDiagnostic(e.target.checked)}
            />
            <span>
              Allow diagnostic partial schedule if strictly INFEASIBLE
            </span>
          </label>

          <button
            type="button"
            className="primary"
            disabled={
              loading || !operatorConfirmed || stagedDisruptions.length === 0
            }
            onClick={onApply}
            data-testid="confirm-and-replan-btn"
          >
            {loading
              ? "Running OR-Tools CP-SAT…"
              : "Confirm & Run Deterministic Replan"}
          </button>
        </div>
      </section>
    </div>
  );
}

/* ============================================================================
   PAGE: REPLANNING, SOLVER TRANSPARENCY & MANUAL ASSIGNMENT SANDBOX
   ============================================================================ */
function ReplanningAndAssignmentPage({
  scenario,
  version,
  loading,
  setLoading,
  onRunIntentionalInvalid,
  onManualAssignSuccess,
  onManualAssignError,
}: {
  scenario: ScenarioResponse;
  version: ScheduleVersion;
  history: ScheduleVersion[];
  loading: boolean;
  setLoading: (b: boolean) => void;
  onSelectVersion: (id: string) => void;
  onRunIntentionalInvalid: () => void;
  onManualAssignSuccess: (
    newVer: ScheduleVersion,
    savedAsDiagnostic: boolean
  ) => Promise<void>;
  onManualAssignError: (err: unknown) => void;
}) {
  const [rows, setRows] = useState<ManualAssignmentItem[]>([]);
  const [saveAsDiagnostic, setSaveAsDiagnostic] = useState<boolean>(true);
  const [explanation, setExplanation] =
    useState<ScheduleExplanationResponse | null>(null);

  useEffect(() => {
    setRows(
      (version.assignments ?? []).map((a) => ({
        train_id: a.train_id,
        platform_id: a.platform_id ?? "P1",
        arrival: a.arrival ?? a.baseline_arrival,
        departure: a.departure ?? a.baseline_departure,
      }))
    );
    explainScheduleVersion(version.id)
      .then(setExplanation)
      .catch(() => setExplanation(null));
  }, [version]);

  const handleSubmitManual = async () => {
    setLoading(true);
    try {
      const created = await manualAssignScenario(scenario.id, {
        baseline_version_id: scenario.active_version_id,
        assignments: rows,
        save_as_diagnostic: saveAsDiagnostic,
      });
      await onManualAssignSuccess(created, saveAsDiagnostic);
    } catch (err) {
      onManualAssignError(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page-scroll-container" data-testid="replanning-page">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">
              DETERMINISTIC CP-SAT SOLVER & EXPLANATION
            </span>
            <h2>
              Revision v{version.version_number} ({version.id}) — Solver:{" "}
              {version.solver_status}
            </h2>
          </div>
          <div className="badge-row">
            <SolverBadge status={version.solver_status} />
            <ValidationBadge
              status={version.validation_status}
              isComplete={version.is_complete}
            />
          </div>
        </div>

        {explanation && (
          <div className="explanation-box" data-testid="solver-explanation-box">
            <p>
              <strong>Summary:</strong> {explanation.summary}
            </p>
            {(explanation.change_explanations ?? []).length > 0 && (
              <ul className="compact-list">
                {explanation.change_explanations.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">
              MANUAL PLATFORM ASSIGNMENT & CONFLICT TESTER
            </span>
            <h2>Manual Assignment Sandbox</h2>
          </div>
          <div className="btn-row-compact">
            <button
              type="button"
              className="hud-btn warn"
              onClick={onRunIntentionalInvalid}
              disabled={loading}
              data-testid="force-invalid-demo-btn"
            >
              <AlertTriangle size={13} /> Load Intentional Invalid Candidate
            </button>
          </div>
        </div>

        <table className="ops-table">
          <thead>
            <tr>
              <th>Train</th>
              <th>Platform</th>
              <th>Arrival (HH:MM)</th>
              <th>Departure (HH:MM)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={r.train_id}>
                <td>
                  <strong>{r.train_id}</strong>
                </td>
                <td>
                  <select
                    className="control-select compact"
                    value={r.platform_id ?? "P1"}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((item, i) =>
                          i === idx
                            ? { ...item, platform_id: e.target.value }
                            : item
                        )
                      )
                    }
                  >
                    {(scenario.platforms ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="text"
                    className="text-input compact"
                    value={
                      typeof r.arrival === "number"
                        ? minToClock(r.arrival)
                        : r.arrival ?? "09:00"
                    }
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((item, i) =>
                          i === idx
                            ? { ...item, arrival: clockToMin(e.target.value) }
                            : item
                        )
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    type="text"
                    className="text-input compact"
                    value={
                      typeof r.departure === "number"
                        ? minToClock(r.departure)
                        : r.departure ?? "09:20"
                    }
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((item, i) =>
                          i === idx
                            ? { ...item, departure: clockToMin(e.target.value) }
                            : item
                        )
                      )
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="gate-controls-row" style={{ marginTop: 12 }}>
          <label className="confirm-checkbox">
            <input
              type="checkbox"
              checked={saveAsDiagnostic}
              onChange={(e) => setSaveAsDiagnostic(e.target.checked)}
            />
            <span>
              Save invalid proposals as diagnostic <code>INVALID</code>{" "}
              revisions (never promoted to active valid schedule)
            </span>
          </label>
          <button
            type="button"
            className="primary"
            onClick={handleSubmitManual}
            disabled={loading}
            data-testid="submit-manual-assign-btn"
          >
            Validate & Submit Candidate
          </button>
        </div>
      </section>
    </div>
  );
}

/* ============================================================================
   PAGE: VALIDATION CENTER (INDEPENDENT SOURCE OF TRUTH)
   ============================================================================ */
function ValidationCenterPage({
  version,
  onRefresh,
  onFocusConflictOnMap,
  onRunIntentionalInvalid,
}: {
  scenario: ScenarioResponse;
  version: ScheduleVersion;
  onRefresh: () => Promise<void>;
  onFocusConflictOnMap: (
    platformId: string | null,
    trainIds: string[],
    startMin: number | null
  ) => void;
  onRunIntentionalInvalid: () => void;
}) {
  const [runs, setRuns] = useState<ValidationRun[]>([]);
  const [running, setRunning] = useState<boolean>(false);

  useEffect(() => {
    listValidationRuns(version.id)
      .then(setRuns)
      .catch(() => setRuns([]));
  }, [version.id]);

  const findings = version.validation_findings ?? [];
  const hasCode = (prefix: string) =>
    findings.some((f) => f.code.includes(prefix));

  const checks = [
    {
      label: "Complete Train Coverage",
      passed:
        version.is_complete &&
        !hasCode("MISSING") &&
        !hasCode("UNRESOLVED"),
    },
    {
      label: "Valid Arrival & Departure Times",
      passed: !hasCode("INVALID_TIME") && !hasCode("DWELL") && !hasCode("EARLY"),
    },
    {
      label: "Platform Occupancy Overlap",
      passed: !hasCode("OVERLAP"),
    },
    {
      label: "Minimum Platform Clearance Gap",
      passed: !hasCode("CLEARANCE"),
    },
    {
      label: "Platform Closure Windows",
      passed: !hasCode("CLOSURE"),
    },
    {
      label: "Required & Allowed Platform Restrictions",
      passed: !hasCode("ALLOWED_PLATFORM") && !hasCode("REQUIRED_PLATFORM"),
    },
    {
      label: "Fixed & Departed Operational Commitments",
      passed: !hasCode("IMMUTABLE") && !hasCode("FIXED"),
    },
  ];

  const handleRunValidator = async () => {
    setRunning(true);
    try {
      await validateScheduleVersion(version.id);
      const updated = await listValidationRuns(version.id);
      setRuns(updated);
      await onRefresh();
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="page-scroll-container" data-testid="validation-page">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">INDEPENDENT VALIDATION FIREWALL</span>
            <h2>
              Validation Center — Revision v{version.version_number} (
              {version.validation_status})
            </h2>
          </div>
          <div className="btn-row-compact">
            <button
              type="button"
              className="hud-btn warn"
              onClick={onRunIntentionalInvalid}
              data-testid="validation-force-invalid-btn"
            >
              Test Intentional Invalid Schedule
            </button>
            <button
              type="button"
              className="primary"
              onClick={handleRunValidator}
              disabled={running}
              data-testid="run-independent-validation-btn"
            >
              {running ? "Validating…" : "Run Independent Validation"}
            </button>
          </div>
        </div>

        <div className="check-grid">
          {checks.map((c, idx) => (
            <div
              key={idx}
              className={`check-item ${c.passed ? "pass" : "fail"}`}
            >
              {c.passed ? (
                <CheckCircle2 size={16} />
              ) : (
                <XCircle size={16} />
              )}
              <span>{c.label}</span>
              <strong>{c.passed ? "PASS" : "FAIL"}</strong>
            </div>
          ))}
        </div>

        {findings.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <h3>Detailed Constraint Violations ({findings.length})</h3>
            <table className="ops-table" data-testid="validation-findings-table">
              <thead>
                <tr>
                  <th>Rule Code</th>
                  <th>Trains</th>
                  <th>Platform</th>
                  <th>Explanation</th>
                  <th>Map Focus</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f, i) => (
                  <tr key={i}>
                    <td>
                      <code>{f.code}</code>
                    </td>
                    <td>{(f.train_ids ?? []).join(", ") || "—"}</td>
                    <td>{f.platform_id ?? "—"}</td>
                    <td>{f.message}</td>
                    <td>
                      <button
                        type="button"
                        className="mini-btn accent"
                        onClick={() =>
                          onFocusConflictOnMap(
                            f.platform_id ?? null,
                            f.train_ids ?? [],
                            560
                          )
                        }
                        data-testid={`focus-conflict-${i}-btn`}
                      >
                        Focus on 3D Map
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <h4>Recorded Independent Validation Runs ({runs.length})</h4>
          <ul className="compact-list">
            {runs.map((r) => (
              <li key={r.id}>
                <code>{r.id}</code> — Status:{" "}
                <strong>{r.validation_status}</strong> ({r.errors.length} errors)
                at {r.validated_at}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

/* ============================================================================
   PAGE: REVISIONS COMPARISON & AUDIT LOG
   ============================================================================ */
function RevisionsAndAuditPage({
  scenario,
  currentVersion,
  history,
  auditEvents,
  onSelectVersion,
  onRefreshAudit,
}: {
  scenario: ScenarioResponse;
  currentVersion: ScheduleVersion;
  history: ScheduleVersion[];
  auditEvents: AuditEvent[];
  onSelectVersion: (id: string) => void;
  onRefreshAudit: () => Promise<void>;
}) {
  const [baseVerId, setBaseVerId] = useState<string>(
    history[0]?.id ?? currentVersion.id
  );
  const [targetVerId, setTargetVerId] = useState<string>(currentVersion.id);
  const [comparison, setComparison] =
    useState<ScheduleComparisonResponse | null>(null);

  useEffect(() => {
    setTargetVerId(currentVersion.id);
  }, [currentVersion.id]);

  useEffect(() => {
    if (!baseVerId || !targetVerId) return;
    compareScheduleVersions(baseVerId, targetVerId)
      .then(setComparison)
      .catch(() => setComparison(null));
  }, [baseVerId, targetVerId]);

  return (
    <div className="page-scroll-container" data-testid="revisions-page">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">BEFORE-AND-AFTER SCHEDULE DIFF</span>
            <h2>Compare Schedule Revisions</h2>
          </div>
          <div className="btn-row-compact">
            <label className="version-picker-label">
              Base:
              <select
                className="control-select compact"
                value={baseVerId}
                onChange={(e) => setBaseVerId(e.target.value)}
              >
                {history.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version_number} ({v.id})
                  </option>
                ))}
              </select>
            </label>
            <label className="version-picker-label">
              Target:
              <select
                className="control-select compact"
                value={targetVerId}
                onChange={(e) => {
                  setTargetVerId(e.target.value);
                  onSelectVersion(e.target.value);
                }}
              >
                {history.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version_number} ({v.id}) — {v.validation_status}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {comparison && (
          <table className="ops-table" data-testid="comparison-diff-table">
            <thead>
              <tr>
                <th>Train</th>
                <th>Base Platform</th>
                <th>Revised Platform</th>
                <th>Base Window</th>
                <th>Revised Window</th>
                <th>Delay Impact</th>
              </tr>
            </thead>
            <tbody>
              {(comparison.train_diffs ?? []).map((row: ComparisonDiffRow) => (
                <tr key={row.train_id}>
                  <td>
                    <strong>{row.train_id}</strong>
                  </td>
                  <td>{row.base_platform ?? "—"}</td>
                  <td>
                    <strong className={row.platform_changed ? "text-emerald" : ""}>
                      {row.target_platform ?? "UNASSIGNED"}
                    </strong>
                  </td>
                  <td>
                    {row.base_arrival_str}–{row.base_departure_str}
                  </td>
                  <td>
                    {row.target_arrival_str}–{row.target_departure_str}
                  </td>
                  <td>
                    +{row.disruption_delay_minutes + row.additional_delay_minutes}{" "}
                    min
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">CHRONOLOGICAL AUDIT TRAIL</span>
            <h2>Recorded Audit Events ({auditEvents.length})</h2>
          </div>
          <button
            type="button"
            className="outline compact"
            onClick={onRefreshAudit}
          >
            Refresh Audit Log
          </button>
        </div>
        <table className="ops-table" data-testid="audit-events-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Revision</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {auditEvents.map((ev) => (
              <tr key={ev.id}>
                <td>{ev.timestamp}</td>
                <td>
                  <code>{ev.actor}</code>
                </td>
                <td>
                  <strong>{ev.action}</strong>
                </td>
                <td>{ev.version_id ?? scenario.active_version_id}</td>
                <td>
                  <code>{JSON.stringify(ev.details)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/* ============================================================================
   PAGE: SETTINGS
   ============================================================================ */
function SettingsPage({
  health,
  scenario,
  onResetStandard,
  onResetImpossible,
}: {
  health: HealthResponse | null;
  scenario: ScenarioResponse;
  onResetStandard: () => void;
  onResetImpossible: () => void;
}) {
  return (
    <div className="page-scroll-container" data-testid="settings-page">
      <section className="panel">
        <h2>System Configuration & Architectural Guarantees</h2>
        <div className="kv-grid" style={{ marginTop: 12 }}>
          <div>
            <span>Backend Endpoint</span>
            <strong>{API_BASE_URL}</strong>
          </div>
          <div>
            <span>Scheduling Engine</span>
            <strong>{health?.scheduler_engine ?? "ortools-cp-sat"}</strong>
          </div>
          <div>
            <span>Independent Validator</span>
            <strong>Enabled (Firewall Enforced)</strong>
          </div>
          <div>
            <span>AI Platform Assignment</span>
            <strong>Strictly Forbidden</strong>
          </div>
          <div>
            <span>Active Scenario ID</span>
            <strong>{scenario.id}</strong>
          </div>
          <div>
            <span>Active Valid Schedule</span>
            <strong>{scenario.active_version_id}</strong>
          </div>
        </div>
        <div className="btn-row-compact" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="primary"
            onClick={onResetStandard}
          >
            Reset Standard Demo Scenario
          </button>
          <button
            type="button"
            className="outline"
            onClick={onResetImpossible}
          >
            Load Impossible Fixed-Train Scenario
          </button>
        </div>
      </section>
    </div>
  );
}
