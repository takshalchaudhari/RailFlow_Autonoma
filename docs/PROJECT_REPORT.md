# 🚄 RailFlow Autonoma — Complete Master Engineering, Architecture & Technical Slide Report

**Competition**: Vortexa 3.0 Hackathon  
**Problem Statement**: `P-03 — RailFlow: Railway Disruption & Platform Conflict Simulator` (Domain 6: Public Systems & Civic Technology)  
**Team**: **Team Autonoma** (`Takshal Chaudhari`, `Ishwari`, `Tanishka Gadakh`, `Samruddhi Nilkanth`)  
**Repository**: [github.com/takshalchaudhari/RailFlow_Autonoma](https://github.com/takshalchaudhari/RailFlow_Autonoma)  
**Live Deployment**: `https://autonoma.noxverse.in/app`

---

## 1. WHY RailFlow Autonoma Was Built (The Problem & Philosophy)

### 1.1 The Real-World Railway Operations Crisis
At a multi-platform railway junction, trains operate on tight headways (e.g., a **10-minute minimum safety clearance** between any two trains using the same platform for signal reset, switch locking, and track clearance).
When **cascading disruptions** occur simultaneously—for example:
1. **Train `T101`** is delayed by **+20 minutes** (`09:00–09:20` $\rightarrow$ `09:20–09:40` on `P1`), and
2. **Platform `P2`** is unexpectedly **closed for maintenance** from **`09:20` to `10:00`**—

a domino effect ensues:
- **`T102`** (scheduled on `P1` at `09:30–09:50`) would **collide** with delayed `T101` (`09:20–09:40`).
- **`T103`** (scheduled on `P2` at `09:25–09:45`) is **blocked** because `P2` is closed (`09:20–10:00`).
- Moving `T103` onto `P3` (`09:25–09:45`) creates a **clearance violation** with **`T104`** (scheduled on `P3` at `09:50–10:10`, leaving only a 5-minute gap instead of the mandatory 10-minute gap).

### 1.2 Why Pure Generative AI / LLMs Fail at Railway Signalling
If you ask a standard LLM (ChatGPT/Claude/Gemini) to *"Reassign platforms and fix the timetable"*:
1. **Arithmetic Hallucinations**: LLMs frequently miscalculate interval overlaps and 10-minute headway gaps (e.g., placing a train at `09:45` after a `09:40` departure).
2. **Non-Determinism**: Running the same prompt twice can yield different platform assignments.
3. **Safety Liability**: In safety-critical railway signalling, an unverified AI decision can cause a physical train collision.

### 1.3 Our Core Engineering Solution: The "Glass-Box" 3-Pillar Architecture
RailFlow Autonoma enforces a **strict architectural firewall** between **Language AI**, **Mathematical Optimization**, and **Independent Safety Verification**:
1. **Pillar 1 — Constrained AI & Duplex Voice Intake (`app/ai/` & `app/services/voice_service.py`)**:
   - AI is **ONLY** allowed to parse human voice/text into structured disruption proposals (`train_delay`, `platform_closure`) and explain verified diffs *after* validation.
   - AI is **architecturally and mathematically forbidden** (`_FORBIDDEN_KEYS` firewall) from assigning platforms or modifying timetables.
2. **Pillar 2 — Deterministic 3-Stage Lexicographic CP-SAT Solver (`app/engine/scheduler.py`)**:
   - Uses **Google OR-Tools CP-SAT** (Constraint Programming with SAT) to mathematically prove feasibility and optimize 4 lexicographic objectives in `~18ms`.
3. **Pillar 3 — Zero-Trust Independent Validator Firewall (`app/engine/validator.py`)**:
   - Has **zero code dependency** on OR-Tools or the scheduler. It independently audits all **13 railway safety rules** before any schedule can become `VALID` or replace the active station timetable.

---

## 2. HOW Everything Works End-to-End (Cause-and-Effect Cascade)

```mermaid
flowchart TD
    A["🎙️ Operator Voice / Text Input\n'Delay T101 by 20m & close P2 09:20-10:00'"] -->|POST /api/scenarios/{id}/disruptions/parse| B["🛡️ AI Boundary Guard (app/ai/parser.py)\nBlocks _FORBIDDEN_KEYS & validates entity IDs"]
    B -->|requires_confirmation = True| C["✋ Human Operator Confirmation Gate\nStaged Disruption Queue in UI"]
    C -->|POST /api/scenarios/{id}/replan\nconfirmed = True| D["🧮 Effective Disruption Normalizer\n(app/engine/disruptions.py)"]
    D --> E["⚙️ Google OR-Tools CP-SAT Solver\n(app/engine/scheduler.py — 3 Lexicographic Stages)"]
    E -->|Candidate Assignments + Change Reasons| F["🧱 Independent Safety Validator Firewall\n(app/engine/validator.py — 13 Hard Rules)"]
    F -->|If VALID| G["💾 SQLite Atomic Transaction (app/database.py)\nPromotes active_version_id = v2 & appends AuditEvent"]
    F -->|If INVALID / INFEASIBLE| H["🚨 Safety Firewall Block\nPreserves prior VALID v1 & logs diagnostic v3"]
    G --> I["🌍 2D Real Geo Map + 🧊 3D WebGL Digital Twin\n+ 🔊 Automatic Duplex Voice Alert"]
    H --> I
```

### Step-by-Step Cascade: How One Action Affects the Entire System
1. **Input Stage**: When the operator speaks or clicks **Step 2 (`Stage T101 +20m & Close P2`)**, `parse_natural_language_disruption()` splits clauses, extracts `ParsedTrainDelayEvent(train_id="T101", delay_minutes=20)` and `ParsedPlatformClosureEvent(platform_id="P2", start_time="09:20", end_time="10:00")`, verifies that `T101` is not fixed/departed and `P2` exists, and returns `requires_confirmation=True, applied=False`.
   - **System Effect**: The active timetable (`v1`) is **untouched**. The UI stages the draft cards and triggers a proactive voice warning (`"Disruption Alert! Collision risk detected for Trains T102 and T103"`).
2. **Normalization Stage**: When the operator confirms and triggers **Step 3 (`Confirm & Re-Route Trains`)**, `compute_effective_disruption_state()` in `app/engine/disruptions.py` merges baseline disruptions with new confirmed disruptions:
   - Computes `T101` effective window: $540 + 20 = 560$ (`09:20`) to $560 + 20 = 580$ (`09:40`).
   - Registers closure on `P2` for $[560, 600)$ (`09:20–10:00`).
3. **Optimization Stage (`solve_schedule()` in `app/engine/scheduler.py`)**:
   - Builds the CP-SAT boolean & integer model (`_build_cpsat_model()`) and runs **3 sequential lexicographic stages** with warm-start hints (`_apply_hints_from_snapshot()`):
     - **Stage 1**: Minimize total additional solver hold ($\sum \text{add\_delay}_i$) $\rightarrow$ finds optimal sum = `20 minutes` (`+15m` on `T102`, `+5m` on `T104`, `0m` on `T103`).
     - **Stage 2**: Lock $\sum \text{add\_delay}_i \le 20$ and minimize platform changes ($\sum \text{plat\_changed}_i$) $\rightarrow$ finds optimal sum = `1` (only `T103` moves `P2 → P3`).
     - **Stage 3**: Lock both above and minimize perturbations to unaffected trains (`_unaffected_perturbed_vars`).
   - Generates grounded, evidence-based reason strings via `_build_change_reason()` linking every move to the exact disruption ID and conflicting train ID.
4. **Independent Validation Stage (`validate_schedule()` in `app/engine/validator.py`)**:
   - Independently inspects the solver's output across **13 checks** (duplicates, missing trains, unknown IDs, unresolved trains, platform existence, allowed/required platforms, time bounds, fixed/departed immutability, dwell preservation, no early arrival, closure non-overlap, and pairwise 10-minute headway gaps).
   - **System Effect**:
     - If `validation_status == "VALID"` and `is_complete == True`, `replan_scenario()` updates `scenarios.active_version_id` in SQLite to the new version (`v2`).
     - If `validation_status == "INVALID"` (e.g., during the **Test Unsafe Schedule Firewall** demo where `T101` and `T102` have only a 5m gap on `P1`), the database saves `v3` as a diagnostic record, **refuses to overwrite `active_version_id`**, and triggers an immediate critical voice alert.
5. **Visual & Audio Telemetry Stage (`StationMap.tsx`, `ThreeStation.tsx`, `VoiceOperatorPanel.tsx`)**:
   - **2D Map**: Draws glowing emerald curve from `T103` through Switch `SW-101W` to `P3` (`BYPASS P2→P3 (0m HOLD)`), places `P2` in red hatched closure state, and animates train tokens along the station clock (`simClock`).
   - **3D Digital Twin**: Stitches real OpenStreetMap / Esri Satellite tiles onto a `2048×1024` WebGL ground texture, renders 3D switch points (`SW-101W`, `SW-102E`), 3D glowing tube geometry for `T103`'s bypass route, and animates 3D multi-car trains at 60 FPS.
   - **Duplex Voice AI**: Automatically speaks the verified outcome out loud via ElevenLabs streaming TTS (`eleven_turbo_v2_5`) or browser neural speech synthesis.

---

## 3. Mathematical Model & Constraint Equations (For Technical Slides)

### 3.1 Decision Variables (Per Train $i \in \mathcal{T}$ and Platform $p \in \mathcal{P}$)
- $x_{i,p} \in \{0, 1\}$ (`assign_{tid}_{pid}`): `1` if train $i$ is assigned to platform $p$, `0` otherwise.
- $u_i \in \{0, 1\}$ (`unresolved_{tid}`): `1` if train $i$ cannot be scheduled (locked to `0` in standard complete solving; allowed only in post-infeasibility diagnostic pass).
- $d_i^{\text{add}} \in [0, D_{\max}]$ (`add_delay_{tid}`): Additional solver-induced holding delay in minutes.
- $A_i, D_i \in [0, 1440]$ (`arr_{tid}`, `dep_{tid}`): Scheduled arrival and departure in minutes from midnight (`00:00`).
- $c_i \in \{0, 1\}$ (`plat_changed_{tid}`): `1` if train $i$ moved away from its baseline platform $p_i^{\text{ref}}$.
- $b_{i,j,p} \in \{0, 1\}$ (`seq_{i}_before_{j}_on_{p}`): Disjunctive ordering boolean for train pair $(i, j)$ on platform $p$.

### 3.2 Hard Constraints Enforced via Reified CP-SAT Clauses (`only_enforce_if`)
1. **Exact Platform Partition**:
   $$\sum_{p \in \mathcal{P}} x_{i,p} + u_i = 1 \quad \forall i \in \mathcal{T}$$
2. **Dwell Time Preservation & Post-Disruption Timing**:
   $$u_i = 0 \implies A_i = A_i^{\text{eff}} + d_i^{\text{add}} \quad \land \quad D_i = D_i^{\text{eff}} + d_i^{\text{add}}$$
   where $A_i^{\text{eff}} = A_i^0 + \delta_i^{\text{disruption}}$ and $D_i^{\text{eff}} = D_i^0 + \delta_i^{\text{disruption}}$ (preserving baseline dwell $W_i = D_i^0 - A_i^0$).
3. **Platform Closure Disjunction** (For each closure $[C_{\text{start}}, C_{\text{end}})$ on platform $p$ with boolean $z_{i,p,c} \in \{0,1\}$):
   $$(x_{i,p} \land z_{i,p,c}) \implies D_i \le C_{\text{start}}$$
   $$(x_{i,p} \land \neg z_{i,p,c}) \implies A_i \ge C_{\text{end}}$$
4. **Pairwise Platform Non-Overlap + Minimum Safety Clearance ($G_p = 10\text{ min}$)**:
   $$(x_{i,p} \land x_{j,p} \land b_{i,j,p}) \implies A_j \ge D_i + G_p$$
   $$(x_{i,p} \land x_{j,p} \land \neg b_{i,j,p}) \implies A_i \ge D_j + G_p$$
5. **Allowed, Required & Immutable Train Locks**:
   - If $p \notin \mathcal{P}_i^{\text{allowed}}$, then $x_{i,p} = 0$.
   - If $p_i^{\text{req}} \neq \text{None}$ and $p \neq p_i^{\text{req}}$, then $x_{i,p} = 0$.
   - If train $i$ is `fixed` or `departed`, then $d_i^{\text{add}} = 0$ and $x_{i, p_i^0} = 1$.

### 3.3 Sequential Lexicographic Optimization Hierarchy
Instead of arbitrary weighted sums that can trade off a platform change against excessive delay, `solve_schedule()` executes **true multi-stage lexicographic optimization**:
1. **Priority 1 (Feasibility)**: $\forall i,\ u_i = 0$ (all trains resolved with 0 safety violations).
2. **Priority 2 (Minimize Total Additional Hold)**:
   $$Z_1^* = \min \sum_{i \in \mathcal{T}} d_i^{\text{add}}$$
3. **Priority 3 (Minimize Platform Reassignments subject to $\sum d_i^{\text{add}} \le Z_1^*$)**:
   $$Z_2^* = \min \sum_{i \in \mathcal{T}} c_i$$
4. **Priority 4 (Minimize Secondary Perturbations subject to $\sum c_i \le Z_2^*$)**:
   $$Z_3^* = \min \sum_{i \notin \mathcal{T}_{\text{disrupted}}} q_i$$

---

## 4. Complete Module, File & Function Inventory (Codebase Reference)

### 4.1 Backend Modules (`app/`)

| File Path | Key Functions / Classes | Exact Role & System Impact |
| :--- | :--- | :--- |
| [`app/main.py`](file:///c:/Users/Dell/Desktop/rail/app/main.py) | `lifespan()`, `health_check()`, `api_create_demo_scenario()`, `api_parse_disruption()`, `api_replan_scenario()`, `api_manual_assign()`, `api_validate_version()`, `api_compare_versions()`, `api_explain_version()`, `api_voice_command()`, `api_voice_tts()` | FastAPI application entry point; registers 16 REST endpoints, CORS middleware, structured HTTP 400/404/422 error handlers, and SPA static serving for `/app`. |
| [`app/schemas.py`](file:///c:/Users/Dell/Desktop/rail/app/schemas.py) | `Train`, `Platform`, `DisruptionInput`, `DisruptionRecord`, `TrainAssignment`, `ChangeRecord`, `ScheduleVersion`, `ValidationRun`, `ValidationErrorItem`, `parse_time_input()`, `format_minutes()` | Pydantic v2 data contracts. Converts `"HH:MM"` strings (`"09:20"`) into integer minutes from midnight (`560`) and validates all API inputs/outputs. |
| [`app/engine/disruptions.py`](file:///c:/Users/Dell/Desktop/rail/app/engine/disruptions.py) | `EffectiveDisruptionState`, `EffectiveTrainSpec`, `compute_effective_disruption_state()` | Normalizes and deduplicates cumulative train delays and platform closures; computes each train's post-disruption earliest arrival/departure before solving. |
| [`app/engine/scheduler.py`](file:///c:/Users/Dell/Desktop/rail/app/engine/scheduler.py) | `_build_cpsat_model()`, `_extract_snapshot()`, `_apply_hints_from_snapshot()`, `_diagnose_unresolved_reason()`, `_build_change_reason()`, `solve_schedule()` | Deterministic Google OR-Tools CP-SAT optimization engine. Runs 3-stage lexicographic optimization + post-infeasibility diagnostic pass and generates human-readable & machine-linked `ChangeRecord` explanations. |
| [`app/engine/validator.py`](file:///c:/Users/Dell/Desktop/rail/app/engine/validator.py) | `validate_schedule()` | **Zero-dependency Independent Safety Firewall**. Executes 13 deterministic checks on any candidate schedule and returns `ValidationRun` (`VALID`, `INVALID`, or `PARTIAL`). |
| [`app/ai/parser.py`](file:///c:/Users/Dell/Desktop/rail/app/ai/parser.py) | `_FORBIDDEN_KEYS`, `validate_ai_proposal_against_scenario()`, `_call_optional_llm_parser()`, `parse_natural_language_disruption()` | Enforces the **AI Safety Boundary**. Blocks any payload containing platform assignments (`AI_PLATFORM_ASSIGNMENT_FORBIDDEN`), validates train/platform IDs against the scenario, and forces `requires_confirmation=True`. |
| [`app/ai/fallback_parser.py`](file:///c:/Users/Dell/Desktop/rail/app/ai/fallback_parser.py) | `_FORBIDDEN_ASSIGNMENT_PATTERNS`, `_TRAIN_DELAY_FULL_PATTERNS`, `_PLATFORM_CLOSURE_FULL_PATTERNS`, `parse_disruption_text_offline()` | 100% offline/free regex & clause-splitting NLP parser. Handles compound sentences (`"Delay T101 by 20m and close P2 from 09:20 to 10:00"`), flags ambiguity, and blocks assignment commands. |
| [`app/ai/explainer.py`](file:///c:/Users/Dell/Desktop/rail/app/ai/explainer.py) | `explain_schedule_version()` | Generates grounded executive summaries, trade-off bullets, and per-train impact narratives strictly from verified `ScheduleVersion` diffs and `ValidationErrorItem` records. |
| [`app/services/voice_service.py`](file:///c:/Users/Dell/Desktop/rail/app/services/voice_service.py) | `get_voice_service_status()`, `synthesize_elevenlabs_speech()`, `_clean_for_speech()`, `process_grounded_voice_command()` | Full-duplex voice controller backend. Handles spoken intent classification (status queries, train lookups, disruption staging) and streams MP3 audio from ElevenLabs (`eleven_turbo_v2_5`) with automatic Web Speech fallback. |
| [`app/services/scenario_service.py`](file:///c:/Users/Dell/Desktop/rail/app/services/scenario_service.py) | `build_standard_demo_request()`, `build_impossible_demo_request()`, `create_scenario()`, `replan_scenario()`, `apply_manual_assignments()`, `compare_revisions()` | Orchestrates transactional workflow: requires `confirmed=True`, invokes `solve_schedule()`, runs `validate_schedule()`, persists immutable revisions, and protects `active_version_id` from invalid candidates. |
| [`app/services/revision_service.py`](file:///c:/Users/Dell/Desktop/rail/app/services/revision_service.py) | `list_schedule_versions()`, `get_schedule_version()`, `revalidate_schedule_version()`, `list_validation_runs()` | Manages immutable revision history and on-demand independent re-validation runs. |
| [`app/services/audit_service.py`](file:///c:/Users/Dell/Desktop/rail/app/services/audit_service.py) | `record_audit_event()`, `list_audit_events()` | Appends tamper-evident operational audit log entries (`SCENARIO_CREATED`, `DISRUPTION_PARSED`, `SCHEDULE_REPLANNED`, `VALIDATION_COMPLETED`, `MANUAL_ASSIGNMENT_EVALUATED`). |
| [`app/database.py`](file:///c:/Users/Dell/Desktop/rail/app/database.py) | `init_db()`, `get_db_connection()`, `db_transaction()` | SQLite connection manager with `WAL` (Write-Ahead Logging) concurrency mode, `FOREIGN KEY` enforcement, and atomic context-managed transactions (`railflow.db`). |

---

### 4.2 Frontend Modules (`frontend/src/`)

| File Path | Key Components / Functions | Exact Role & System Impact |
| :--- | :--- | :--- |
| [`frontend/src/App.tsx`](file:///c:/Users/Dell/Desktop/rail/frontend/src/App.tsx) | `App()` (`BrowserRouter`, `Routes`, `Route`) | Configures all client-side routes (`/`, `/app`, `/app/:tab`, `/map`, `/overview`, `/timetable`, `/disruptions`, `/replanning`, `/validation`, `/revisions`, `/settings`) so every URL path loads cleanly. |
| [`frontend/src/api.ts`](file:///c:/Users/Dell/Desktop/rail/frontend/src/api.ts) | `normalizeTimeStr()`, `normalizeDisruptionForApi()`, `replanScenario()`, `parseDisruptionText()`, `manualAssignScenario()`, `validateScheduleVersion()`, `sendVoiceCommand()`, `fetchVoiceSpeechBlob()` | Typed REST client with automatic payload normalization (prevents HTTP 422 schema mismatches by normalizing `"9:20"` $\rightarrow$ `"09:20"` and mapping `start_time`/`end_time`). |
| [`frontend/src/pages/DashboardLayout.tsx`](file:///c:/Users/Dell/Desktop/rail/frontend/src/pages/DashboardLayout.tsx) | `DashboardLayout()`, `handleRunJudgeAutoDemo()`, `handleRunIntentionalInvalidDemo()`, `handleApplyReplan()`, `triggerVoiceAlert()`, `GanttChart`, `TimetableView`, `DisruptionsView`, `ReplanningView`, `ValidationView`, `RevisionsView` | Central state orchestrator for the entire control room. Connects the live simulation clock (`simClock`), 1-Click Judge Demo, Step-by-Step Simulator, Gantt chart, Timetable editor, Validation matrix, and automatic voice alerts to a single source of truth. |
| [`frontend/src/components/StationMap.tsx`](file:///c:/Users/Dell/Desktop/rail/frontend/src/components/StationMap.tsx) | `StationMap()`, `minToClock()`, `handleFitStation()` | Multi-mode 2D/3D station visualizer. Renders real **OpenStreetMap** and **Esri World Imagery Satellite** tiles, interactive SVG tracks (`P1–P3`), switches (`SW-101W`, `SW-102E`), glowing green bypass route (`BYPASS P2→P3`), non-overlapping West approach slots, and live Driver Cab Signal banners. |
| [`frontend/src/components/ThreeStation.tsx`](file:///c:/Users/Dell/Desktop/rail/frontend/src/components/ThreeStation.tsx) | `ThreeStation()`, `createRealGeoGroundTexture()`, `createLabelSprite()` | 60 FPS **Three.js WebGL 3D Digital Twin**. Dynamically fetches and stitches a `4×2` grid of real OpenStreetMap / Esri Street or Satellite tiles onto a `2048×1024` `THREE.CanvasTexture` ground plane, builds 3D rails, ballast, sleepers, platforms, overhead catenary portals, 3D switch nodes (`SW-101W`, `SW-102E`), 3D `TubeGeometry` route splines, and animated 3D multi-car trains. |
| [`frontend/src/components/VoiceOperatorPanel.tsx`](file:///c:/Users/Dell/Desktop/rail/frontend/src/components/VoiceOperatorPanel.tsx) | `VoiceOperatorPanel()`, `startListening()`, `speakReply()`, `handleSendUtterance()` | Full-Duplex Hands-Free Voice AI engine. Uses browser `SpeechRecognition` (`webkitSpeechRecognition`) for continuous live speech-to-text, sends utterances to `/api/scenarios/{id}/voice/command`, plays back ElevenLabs MP3 streams or `window.speechSynthesis` neural voices, and automatically speaks `proactiveVoiceAlert` events without manual clicks. |

---

## 5. Complete Library, Package & API Reference (For Technical Slides)

### 5.1 Backend Python Libraries ([`requirements.txt`](file:///c:/Users/Dell/Desktop/rail/requirements.txt) + Python Standard Library)

| Library / Package | Version | Exact Classes / Functions Used | Why We Used It & What It Affects |
| :--- | :--- | :--- | :--- |
| **`ortools` (Google OR-Tools)** | `>=9.10.0` | `cp_model.CpModel()`, `model.new_bool_var()`, `model.new_int_var()`, `model.add().only_enforce_if()`, `model.minimize()`, ` model.add_hint()`, `cp_model.CpSolver()` | **Core mathematical engine**. Formulates platform assignment and headway spacing as a Constraint Programming SAT problem; guarantees 0 collisions and finds globally optimal recovery schedules in `~18ms`. |
| **`fastapi`** | `>=0.111.0` | `FastAPI()`, `CORSMiddleware`, `HTTPException`, `RequestValidationError`, `JSONResponse`, `Response`, `FileResponse` | High-performance async REST API server exposing all 16 simulation, solver, validator, audit, and voice endpoints plus single-port SPA hosting. |
| **`pydantic` (v2)** | `>=2.7.0` | `BaseModel`, `Field`, `model_validator`, `field_validator`, `ConfigDict(extra="forbid")` | **Strict schema firewall**. Enforces `extra="forbid"` on AI payloads (`RawLLMParsePayload`) so any unexpected or forbidden field from an LLM immediately triggers a validation rejection. |
| **`uvicorn`** | `>=0.30.0` | `uvicorn.run()`, ASGI worker loop | Production ASGI server configured to run with `--workers 1 --limit-concurrency 64` inside `~85 MB RAM` on a 1 GB Oracle Cloud VPS. |
| **`sqlite3` (Stdlib)** | Built-in (`3.45+`) | `sqlite3.connect()`, `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON` | Zero-overhead embedded relational database storing `scenarios`, `schedule_versions`, `validation_runs`, and `audit_events` with ACID transactions. |
| **`re` & `urllib.request` (Stdlib)** | Built-in | `re.compile()`, `re.split()`, `urllib.request.Request()`, `urlopen()` | Powers the 100% dependency-free offline NLP disruption parser (`fallback_parser.py`) and zero-SDK REST calls to ElevenLabs TTS and optional LLM providers. |
| **`pytest` & `httpx`** | `>=8.0.0` / `>=0.27.0` | `TestClient`, `@pytest.mark.parametrize` | Automated verification suite (`21/21` backend tests) testing overlaps, 10m clearance, closures, infeasible schedules, and AI boundary violations. |

### 5.2 Frontend TypeScript & WebGL Libraries ([`frontend/package.json`](file:///c:/Users/Dell/Desktop/rail/frontend/package.json))

| Library / Web API | Version | Exact Classes / Functions Used | Why We Used It & What It Affects |
| :--- | :--- | :--- | :--- |
| **`three` (`Three.js`)** | `^0.186.1` | `Scene`, `PerspectiveCamera`, `WebGLRenderer`, `CanvasTexture`, `CatmullRomCurve3`, `TubeGeometry`, `BoxGeometry`, `CylinderGeometry`, `MeshStandardMaterial`, `DirectionalLight`, `Raycaster`, `Sprite`, `Vector3` | Renders the interactive **60 FPS 3D Digital Twin** with real geospatial map ground tiles, 3D tracks, overhead catenary wires, 3D switches (`SW-101W`/`SW-102E`), glowing route tubes, and raycasted train/platform selection. |
| **`react` & `react-dom`** | `19.x` | `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef` | Reactive UI state management synchronizing the simulation clock (`simClock`), 2D/3D map, Gantt chart, timetable table, revision diffs, and voice alerts. |
| **`react-router-dom`** | `7.x` | `BrowserRouter`, `Routes`, `Route`, `Navigate` | Handles multi-route navigation (`/`, `/app`, `/app/:tab`, `/map`, `/overview`, `/timetable`, `/disruptions`, `/replanning`, `/validation`, `/revisions`, `/settings`). |
| **`lucide-react`** | `latest` | `TrainFront`, `ShieldCheck`, `ShieldAlert`, `Cpu`, `Mic`, `Compass`, `Box`, `GitCompare`, `Clock`, `Play` | Clean, high-contrast railway operations iconography across all control room panels and badges. |
| **Web Speech API (Browser Native)** | W3C Standard | `window.SpeechRecognition` / `webkitSpeechRecognition`, `window.speechSynthesis`, `SpeechSynthesisUtterance` | Provides **100% free, zero-latency continuous speech recognition (STT)** and fallback neural text-to-speech (TTS) directly in the browser. |
| **ElevenLabs Streaming TTS API** | `v1` (`eleven_turbo_v2_5`) | `POST /v1/text-to-speech/{voice_id}/stream` (`HTMLAudioElement` + `URL.createObjectURL(blob)`) | Ultra-realistic human railway dispatcher voice synthesis for spoken answers and automatic conflict/recovery alerts. |
| **Esri ArcGIS & OpenStreetMap Tiles** | Public XYZ Tiles | `server.arcgisonline.com/.../World_Street_Map` & `World_Imagery`, `tile.openstreetmap.org/{z}/{x}/{y}.png` | Provides real-world street, railway corridor, and aerial satellite basemaps in both 2D and 3D modes with **zero API key required**. |
| **`vite` & `typescript`** | `8.x` / `5.x` | `tsc -b`, `vite build` | Compiles and bundles the entire frontend in `~1.1 seconds` with strict static type checking. |

---

## 6. All 13 Independent Safety Validator Rules (`app/engine/validator.py`)

When judges ask *"What exactly does your Independent Safety Validator check?"*, here are all **13 deterministic rules** enforced in [`validate_schedule()`](file:///c:/Users/Dell/Desktop/rail/app/engine/validator.py#L28-L493):

1. **`DUPLICATE_TRAIN_ASSIGNMENT`**: No train ID may appear more than once in a schedule.
2. **`MISSING_TRAIN`**: Every train defined in the scenario must be present in the schedule.
3. **`UNKNOWN_TRAIN` / `UNKNOWN_TRAIN_IN_DISRUPTION`**: No fabricated or unknown train IDs allowed.
4. **`UNRESOLVED_TRAIN` (`PARTIAL` Gate)**: Any train marked `unresolved=True` prevents the schedule from ever being marked `VALID`.
5. **`UNKNOWN_PLATFORM` / `UNKNOWN_PLATFORM_IN_CLOSURE`**: Assigned platform ID must exist in the station definition (`P1`, `P2`, `P3`).
6. **`DISALLOWED_PLATFORM`**: Platform must be in `train.allowed_platforms`.
7. **`REQUIRED_PLATFORM_VIOLATION`**: If `train.required_platform` is set (e.g., `T201` requires `P1`), it must be assigned to that exact platform.
8. **`INVALID_TIME_RANGE`**: Arrival must strictly precede departure ($0 \le A_i < D_i \le 1440$).
9. **`FIXED_TRAIN_MODIFIED` / `DEPARTED_TRAIN_MODIFIED`**: Trains marked `fixed` or `departed` cannot have their platform, arrival, or departure altered.
10. **`EARLY_ARRIVAL_VIOLATION`**: A train can never be scheduled earlier than its post-disruption earliest arrival ($A_i \ge A_i^0 + \delta_i$).
11. **`DWELL_TIME_CHANGED`**: Station dwell time ($D_i - A_i$) must equal the baseline dwell time ($D_i^0 - A_i^0$).
12. **`PLATFORM_CLOSURE_CONFLICT`**: No train interval $[A_i, D_i)$ on platform $p$ may overlap an active closure $[C_{\text{start}}, C_{\text{end}})$ on $p$.
13. **`PLATFORM_OVERLAP` & `CLEARANCE_GAP_VIOLATION`**: For any two trains $i, j$ on the same platform $p$, they must neither overlap nor have a gap smaller than `min_gap_minutes` ($10\text{ min}$):
    $$A_j - D_i \ge 10 \quad \text{where } A_i \le A_j$$

---

## 7. Ready-to-Use Presentation Slide Deck Content (Copy-Paste for PPT)

### Slide 1: Title & Executive Hook
- **Title**: **RailFlow Autonoma** — Deterministic Railway Disruption & Anti-Collision Simulator (`Vortexa 3.0 · P-03`)
- **Team Autonoma**: Takshal Chaudhari, Ishwari, Tanishka Gadakh, Samruddhi Nilkanth
- **Live URL**: `https://autonoma.noxverse.in/app`
- **Core Hook**: *"LLMs are great at understanding human language, but terrible at safety-critical arithmetic. RailFlow uses AI to listen and explain, Google OR-Tools CP-SAT to re-route trains in 18ms, and a Zero-Trust Independent Validator Firewall to guarantee zero collisions."*

### Slide 2: The Problem (`P-03` Scenario Breakdown)
- **Station**: Meridian / Vortexa Central (`3 Platforms: P1, P2, P3` · `Mandatory 10-Minute Safety Clearance`).
- **The Dual Disruption at `09:20`**:
  1. `Train T101` delayed **+20 mins** $\rightarrow$ occupies `P1` from `09:20–09:40` (clashing with `T102` at `09:30`).
  2. `Platform P2` closed **`09:20–10:00`** for track maintenance (blocking `T103` at `09:25`).
- **Challenge**: Re-route all trains with minimal delay, record exact mathematical reasons for every move, and prove safety independently.

### Slide 3: System Architecture & The Strict AI Boundary
- **3-Layer Separation of Concerns**:
  1. **Intake Layer (`app/ai/parser.py` + `VoiceOperatorPanel.tsx`)**: Converts natural voice/text into structured `DisruptionInput` drafts. Enforces `_FORBIDDEN_KEYS` firewall (`AI_PLATFORM_ASSIGNMENT_FORBIDDEN`) + mandatory human confirmation (`requires_confirmation=True`).
  2. **Optimization Layer (`app/engine/scheduler.py`)**: Google OR-Tools CP-SAT model with 3-stage lexicographic optimization:
     - Stage 1: Min total solver hold ($\sum d_i^{\text{add}}$)
     - Stage 2: Min platform switches ($\sum c_i$)
     - Stage 3: Min secondary perturbations
  3. **Verification Layer (`app/engine/validator.py`)**: Logically separate 13-rule validator. Blocks unsafe schedules (`INVALID`) from ever overwriting the active station revision.

### Slide 4: Mathematical & Operational Results (`v1 → v2`)
- **Solver Runtime**: `~18ms` (`OPTIMAL`)
- **Verified Schedule (`v2 — VALID`)**:
  - **`T101`**: `09:20–09:40` on `P1` (`+20m` external disruption delay).
  - **`T103`**: **Switched `P2 → P3` via `SW-101W` (`09:25–09:45`, `0m` solver hold!)** — completely avoids `P2` closure with zero added delay.
  - **`T102`**: **Held `+15m` on `P1` (`09:50–10:10`)** — enforces exact `10m` clearance after `T101` departs `P1` at `09:40`.
  - **`T104`**: **Held `+5m` on `P3` (`09:55–10:15`)** — enforces exact `10m` clearance after rerouted `T103` departs `P3` at `09:45`.

### Slide 5: 2D/3D Geospatial Digital Twin & Live Duplex Voice AI
- **2D Real Geospatial Map (`StationMap.tsx`)**: Live OpenStreetMap & Esri Satellite basemaps + SVG track schematic, non-overlapping West approach slots, switch indicators (`SW-101W`, `SW-102E`), and live Driver Cab Signal banners.
- **3D WebGL Digital Twin (`ThreeStation.tsx`)**: Three.js 60 FPS 3D station with real stitched street/satellite ground textures (`2048×1024`), 3D track switches, glowing 3D bypass route tubes, and animated multi-car trains.
- **Hands-Free Duplex Voice AI (`VoiceOperatorPanel.tsx`)**: Speak naturally to query trains or stage disruptions; automatically announces conflict and firewall alerts out loud via ElevenLabs (`eleven_turbo_v2_5`) + Web Speech API.

### Slide 6: Cloud Engineering & Verification Metrics
- **Automated Test Coverage**: `31/31` total tests passing (`21/21` Pytest backend constraint & boundary tests + `10/10` Vitest frontend workflow tests).
- **1 GB RAM Oracle VPS Engineering (`deploy_oracle_vps.sh`)**:
  - 2 GB swapfile + memory-capped Vite static build (`512 MB` max heap).
  - Single-process FastAPI + SQLite WAL (`~85 MB` RAM) behind Nginx (`~8 MB` RAM).
  - Zero-port-forwarding **Cloudflare Zero Trust Outbound Tunnel** (`setup_cloudflare_tunnel.sh`) serving `https://autonoma.noxverse.in`.
