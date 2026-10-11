export type SolverStatus =
  | "BASELINE"
  | "MANUAL"
  | "OPTIMAL"
  | "FEASIBLE"
  | "INFEASIBLE"
  | "UNKNOWN";

export type ValidationStatus =
  | "VALID"
  | "INVALID"
  | "PARTIAL"
  | "INFEASIBLE"
  | "UNKNOWN";

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  ai_platform_assignment_forbidden: boolean;
  scheduler_engine: string;
  independent_validator: boolean;
}

export interface Station {
  id: string;
  name: string;
  timezone?: string;
  clearance_minutes?: number;
}

export interface Platform {
  id: string;
  station_id?: string;
  name?: string | null;
  min_gap_minutes?: number;
  clearance_minutes?: number;
}

export interface PlatformClosure {
  id: string;
  platform_id: string;
  start: number;
  end: number;
  start_str: string;
  end_str: string;
  reason?: string | null;
}

export interface Train {
  id: string;
  name?: string | null;
  arrival: number;
  departure: number;
  arrival_str: string;
  departure_str: string;
  dwell_minutes: number;
  platform_id: string | null;
  allowed_platforms: string[] | null;
  required_platform: string | null;
  fixed: boolean;
  departed: boolean;
}

export interface DisruptionEventInput {
  id?: string | null;
  type: "train_delay" | "platform_closure";
  target_id?: string | null;
  train_id?: string | null;
  platform_id?: string | null;
  delay_minutes?: number | null;
  start?: number | string | null;
  end?: number | string | null;
  start_time?: number | string | null;
  end_time?: number | string | null;
}

export interface DisruptionEvent {
  id: string;
  type: "train_delay" | "platform_closure";
  target_id: string;
  train_id: string | null;
  platform_id: string | null;
  delay_minutes: number | null;
  start: number | null;
  end: number | null;
  start_str: string | null;
  end_str: string | null;
  confirmation_status: "pending" | "confirmed" | "rejected";
  application_status: "unapplied" | "applied" | "duplicate_skipped";
}

export type ParsedEvent =
  | {
      type: "train_delay";
      train_id: string;
      delay_minutes: number;
    }
  | {
      type: "platform_closure";
      platform_id: string;
      start_time: string;
      end_time: string;
    };

export interface DisruptionParseResponse {
  raw_text: string;
  parser_mode: "llm" | "deterministic_fallback";
  events: ParsedEvent[];
  normalized_disruptions: DisruptionEventInput[];
  requires_confirmation: boolean;
  applied: boolean;
  ambiguous: boolean;
  clarification_needed: string[];
  warnings: string[];
}

export interface TrainAssignment {
  train_id: string;
  platform_id: string | null;
  arrival: number | null;
  departure: number | null;
  arrival_str: string | null;
  departure_str: string | null;
  baseline_arrival: number;
  baseline_departure: number;
  effective_arrival: number;
  effective_departure: number;
  disruption_delay_minutes: number;
  additional_delay_minutes: number;
  total_delay_minutes: number;
  fixed: boolean;
  departed: boolean;
  unresolved: boolean;
  unresolved_reason: string | null;
}

export interface ScheduleChange {
  train_id: string;
  previous_platform: string | null;
  proposed_platform: string | null;
  previous_arrival: number | null;
  previous_departure: number | null;
  proposed_arrival: number | null;
  proposed_departure: number | null;
  previous_arrival_str: string | null;
  previous_departure_str: string | null;
  proposed_arrival_str: string | null;
  proposed_departure_str: string | null;
  disruption_delay_minutes: number;
  additional_delay_minutes: number;
  platform_changed: boolean;
  timing_changed: boolean;
  unresolved: boolean;
  reason: string;
  associated_disruption_ids: string[];
}

export interface ValidationErrorItem {
  code: string;
  severity: "ERROR" | "WARNING";
  message: string;
  platform_id: string | null;
  train_ids: string[];
}

export interface ObjectiveMetrics {
  unresolved_count: number;
  total_additional_delay_minutes: number;
  platform_changes_count: number;
  unaffected_train_changes_count: number;
  solve_time_ms: number;
  is_diagnostic_partial: boolean;
}

export interface ScheduleVersion {
  id: string;
  scenario_id: string;
  version_number: number;
  parent_version_id: string | null;
  solver_status: SolverStatus;
  validation_status: ValidationStatus;
  is_complete: boolean;
  created_at: string;
  assignments: TrainAssignment[];
  changes: ScheduleChange[];
  applied_disruptions: DisruptionEvent[];
  newly_applied_disruptions: DisruptionEvent[];
  validation_findings: ValidationErrorItem[];
  unresolved_trains: string[];
  objective_metrics: ObjectiveMetrics | null;
}

export interface ScenarioResponse {
  id: string;
  name: string;
  description?: string | null;
  station: Station;
  default_min_gap_minutes: number;
  platforms: Platform[];
  trains: Train[];
  active_version_id: string;
  latest_version_number: number;
  created_at: string;
  active_schedule_version?: ScheduleVersion | null;
}

export interface ReplanRequest {
  confirmed: boolean;
  baseline_version_id?: string | null;
  expected_active_version_id?: string | null;
  disruptions: DisruptionEventInput[];
  solver_time_limit_seconds?: number;
  max_additional_delay_minutes?: number;
  allow_partial_diagnostic?: boolean;
}

export interface ManualAssignmentItem {
  train_id: string;
  platform_id: string | null;
  arrival?: number | string | null;
  departure?: number | string | null;
}

export interface ManualAssignRequest {
  baseline_version_id?: string | null;
  assignments: ManualAssignmentItem[];
  save_as_diagnostic?: boolean;
  reason?: string;
}

export interface ValidationRun {
  id: string;
  version_id: string;
  validation_status: ValidationStatus;
  is_complete: boolean;
  errors: ValidationErrorItem[];
  unresolved_train_ids: string[];
  validated_at: string;
}

export interface ScheduleExplanationResponse {
  version_id: string;
  scenario_id: string;
  explanation_mode: "llm" | "deterministic_fallback";
  solver_status: SolverStatus;
  validation_status: ValidationStatus;
  is_complete: boolean;
  summary: string;
  change_explanations: string[];
  unresolved_explanations: string[];
  validation_explanations: string[];
  tradeoff_notes: string[];
  read_only_verified: boolean;
}

export interface ComparisonDiffRow {
  train_id: string;
  base_platform: string | null;
  target_platform: string | null;
  base_arrival_str: string | null;
  base_departure_str: string | null;
  target_arrival_str: string | null;
  target_departure_str: string | null;
  platform_changed: boolean;
  timing_changed: boolean;
  unresolved: boolean;
  additional_delay_minutes: number;
  disruption_delay_minutes: number;
}

export interface ScheduleComparisonResponse {
  scenario_id: string;
  base_version_id: string;
  base_version_number: number;
  base_validation_status: ValidationStatus;
  target_version_id: string;
  target_version_number: number;
  target_solver_status: SolverStatus;
  target_validation_status: ValidationStatus;
  target_is_complete: boolean;
  train_diffs: ComparisonDiffRow[];
  recorded_changes: ScheduleChange[];
}

export interface AuditEvent {
  id: string;
  scenario_id: string | null;
  version_id: string | null;
  timestamp: string;
  actor: string;
  action: string;
  details: Record<string, unknown>;
}

export type ScheduleAssignment = TrainAssignment;
export type ScheduleDisruption = DisruptionEvent;
export type DisruptionInput = DisruptionEventInput;
export type DisruptionProposalItem = ParsedEvent;

export interface VoiceOption {
  voice_id: string;
  name: string;
  category?: string;
}

export interface VoiceStatusResponse {
  configured: boolean;
  status: string;
  provider: string;
  conversation_mode?: string;
  convai_websocket_available?: boolean;
  stt_mode?: string;
  message: string;
  voices: VoiceOption[];
  ai_platform_assignment_forbidden: boolean;
}

export interface VoiceCommandResponse {
  intent: string;
  reply_text: string;
  requires_confirmation: boolean;
  draft_events: DisruptionProposalItem[];
  normalized_disruptions: DisruptionInput[];
  warnings: string[];
  referenced_trains: string[];
  referenced_platforms: string[];
  solver_status: SolverStatus;
  validation_status: ValidationStatus;
  version_id: string;
}

export interface VoiceMessage {
  id: string;
  role: "operator" | "assistant";
  text: string;
  timestamp: string;
  intent?: string;
  draftEvents?: DisruptionInput[];
  audioUrl?: string | null;
}


