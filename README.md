<div align="center">

<!-- 3D Animated Hero Banner -->
<img src="./docs/assets/hero-3d-banner.svg" alt="RailFlow Autonoma — 3D Animated Hero Banner" width="100%" />

<br />

# 🚆 RailFlow (`Team Autonoma`)
### **AI-Assisted Railway Disruption & Anti-Collision Control System**
**VORTEXA 3.0 Hackathon · Challenge P-03 · Domain 6: Public Systems & Civic Technology**

[![Live Production Domain](https://img.shields.io/badge/🌐_Live_Demo-autonoma.noxverse.in-2563eb?style=for-the-badge)](https://autonoma.noxverse.in)
[![Solver Engine](https://img.shields.io/badge/⚙️_Scheduler-Google_OR--Tools_CP--SAT-059669?style=for-the-badge)](./backend/app/services/scheduler.py)
[![Safety Firewall](https://img.shields.io/badge/🛡️_Safety_Firewall-Independent_Validator-d97706?style=for-the-badge)](./backend/app/services/validator.py)
[![Voice AI](https://img.shields.io/badge/🎙️_Voice_AI-2--Way_Live_Duplex_+_Auto--Alerts-7c3aed?style=for-the-badge)](./frontend/src/components/VoiceOperatorPanel.tsx)

</div>

---

## 👥 Meet Team Autonoma (Project Collaborators & Members)

| Avatar | Member Name | GitHub Handle | Core Role & Contribution |
| :---: | :--- | :--- | :--- |
| <img src="https://avatars.githubusercontent.com/u/231168688?v=4" width="48" height="48" style="border-radius:50%;" alt="Takshal Chaudhari" /> | **Takshal Chaudhari** | [`@takshalchaudhari`](https://github.com/takshalchaudhari) | **Team Lead** · Full-Stack System Architecture, FastAPI Backend & OR-Tools Integration |
| <img src="https://avatars.githubusercontent.com/u/276861601?v=4" width="48" height="48" style="border-radius:50%;" alt="Ishwari" /> | **Ishwari** | [`@IshwariByte`](https://github.com/IshwariByte) | **Core Member** · Deterministic CP-SAT Optimization Engine & Independent 6-Rule Safety Validator |
| <img src="https://avatars.githubusercontent.com/u/281140542?v=4" width="48" height="48" style="border-radius:50%;" alt="Tanishka Gadakh" /> | **Tanishka Gadakh** | [`@tanishkagadakh`](https://github.com/tanishkagadakh) | **Core Member** · Real OpenStreetMap / Esri Geospatial Map, 3D Digital Twin & Live Telemetry UI |
| <img src="https://avatars.githubusercontent.com/u/314237864?v=4" width="48" height="48" style="border-radius:50%;" alt="Samruddhi Nilkanth" /> | **Samruddhi Nilkanth** | [`@samruddhi-nilkanth`](https://github.com/samruddhi-nilkanth) | **Core Member** · Real-Time Two-Way Duplex Voice AI (ElevenLabs + Web Speech) & Proactive Auto-Alerts |

---

## 🎯 For Judges: Understand RailFlow in 10 Seconds

### ❓ The Problem (Why standard AI fails in railways)
When a train is delayed or a platform closes unexpectedly, human controllers have **seconds** to re-route incoming trains without causing a collision.
- **If you ask an LLM (like ChatGPT/Gemini) to assign train tracks directly, it can hallucinate** and put two trains on the same track at the same time.
- **In safety-critical railway operations, AI must NEVER directly control track switches.**

### 💡 Our Solution (The 3-Layer Safety Firewall)
**RailFlow** combines **conversational AI speed** with **100% mathematical railway safety**:
1. **🎙️ Layer 1 — Two-Way Voice & Text AI (Input & Explanation Only):** The operator speaks naturally (*"Delay T101 by 20 minutes and close Platform P2 from 09:20 to 10:00"*). The AI extracts structured disruption proposals and **speaks back out loud automatically** whenever an alert or conflict happens—**but a strict code firewall blocks AI from ever assigning a platform**.
2. **⚙️ Layer 2 — Google OR-Tools CP-SAT Solver (Mathematical Optimization):** Once the operator clicks **Confirm**, our deterministic constraint-programming solver computes the fastest conflict-free timetable in **`< 50ms`**.
3. **🛡️ Layer 3 — Independent Safety Validator (Zero-Trust Verification):** Before any schedule is shown as `VALID`, a completely separate Python verification service checks **6 hard railway safety laws** (zero track overlap, mandatory **10-minute safety headway**, no closed-platform docking, allowed platform rules, and immutable departed trains). If even 1 rule fails, the schedule is **blocked** and the station stays on the last safe schedule.

<div align="center">
  <img src="./docs/assets/architecture-3d-pipeline.svg" alt="3-Layer Safety Firewall Architecture" width="100%" />
</div>

---

## 🖥️ Live Control Room Preview (Real Map + Live Analytics + Duplex Voice AI)

<div align="center">
  <img src="./docs/assets/live-station-map-preview.png" alt="RailFlow Live Control Room Preview" width="100%" />
</div>

### ✨ What Judges Can Test Live on the Dashboard:
1. **▶ Watch 1-Click Judge Demo Button:** Runs the entire Challenge P-03 crisis and recovery automatically in 1 click—watch `T103` re-route from closed `P2 -> P3` with **0m delay** while `T102` and `T104` hold for an exact **10-minute anti-collision gap**.
2. **🛡️ Test Unsafe Schedule (Firewall) Button:** Intentionally injects an illegal 5-minute gap on `Platform P1` (`T101` departing `09:20`, `T102` arriving `09:25`) so judges can watch the **Independent Safety Validator** reject the schedule (`INVALID`) and protect the baseline.
3. **🎙️ Real-Time Two-Way Duplex Voice AI + Automatic Voice Alerts:**
   - **Zero Manual Intervention Alerts:** Whenever a train is delayed, a platform closes, a schedule is re-routed, or a safety violation is blocked, the AI **automatically speaks the alert out loud** to the operator.
   - **Live Two-Way Conversation:** Click **`🎙️ Talk to AI Now (Live)`** and speak naturally—ask *"Which trains are delayed?"* or say *"Delay T101 by 20 minutes"*, and the AI immediately answers you out loud and stages the disruption.
4. **🗺️ 4 Interactive Station Views (Zero API Key Required):**
   - **Real Street Map** (Live OpenStreetMap / Esri Street railway corridor)
   - **Satellite View** (Esri World Imagery aerial view)
   - **2D Track Diagram** (Interlocking signalling schematic)
   - **3D Station Twin** (Interactive Three.js WebGL 3D station with animated trains & signals)
5. **📊 Real-Time Railway Operations Analytics Console:**
   - **Train Punctuality & Recovery KPIs** (Direct Delay vs. Solver Safety Hold vs. Net Total Delay)
   - **Platform Capacity & Utilization Bars** (`09:00–10:30` occupied vs. 10m safety buffer vs. closed minutes)
   - **Interlocking Headway & Anti-Collision Matrix** (Verifying every consecutive train pair has $\ge 10\text{ min}$ clearance)
   - **Full Train Telemetry & Delay Recovery Ledger** (Baseline vs. Active window, track switches, and exact solver rationale)

---

## 🎬 How the Challenge P-03 Scenario Works (Math Breakdown)

<div align="center">
  <img src="./docs/assets/station-3d-twin-animated.svg" alt="Animated Central Junction 3-Platform Recovery" width="100%" />
</div>

### 1️⃣ Normal Baseline Schedule (`Revision v1`)
Central Junction has **3 Platforms (`P1`, `P2`, `P3`)**, **4 Passenger Trains (`T101–T104`)**, and a mandatory **10-minute safety clearance** between trains on the same platform:

| Train | Baseline Platform | Arrival | Departure | Status |
| :---: | :---: | :---: | :---: | :--- |
| **`T101`** | **Platform P1** | `09:00` | `09:20` | 🟢 On Time |
| **`T102`** | **Platform P1** | `09:30` | `09:50` | 🟢 Safe (`10m` gap after `T101` leaves at `09:20`) |
| **`T103`** | **Platform P2** | `09:25` | `09:45` | 🟢 On Time |
| **`T104`** | **Platform P3** | `09:40` | `10:00` | 🟢 On Time |

### 2️⃣ The Crisis (2 Simultaneous Disruptions)
- ⚠️ **Disruption 1 (`T101` Delayed +20m):** `T101` now occupies **Platform P1** from **`09:20 to 09:40`** $\rightarrow$ **COLLISION RISK** with `T102` (scheduled `09:30–09:50` on `P1`!).
- 🚧 **Disruption 2 (`Platform P2` Closed `09:20–10:00`):** Track maintenance shuts down **Platform P2** $\rightarrow$ **BLOCKS** `T103` (scheduled `09:25–09:45` on `P2`!).

### 3️⃣ How RailFlow Solves It (`Revision v2 — OPTIMAL & VALID`)
| Train | Old Track & Time | **New Track & Time (`v2`)** | Solver Hold | Why OR-Tools & Safety Validator Chose This |
| :---: | :---: | :---: | :---: | :--- |
| **`T101`** | `P1` (`09:00–09:20`) | **`P1` (`09:20–09:40`)** | `+0 min` | Absorbs the +20m external delay on **Platform P1**. |
| **`T102`** | `P1` (`09:30–09:50`) | **`P1` (`09:50–10:10`)** | `+20 min` | Held until `09:50` so it has an exact **10-minute safety gap** after `T101` departs `P1` at `09:40`. |
| **`T103`** | `P2` (`09:25–09:45`) | **`P3` (`09:25–09:45`)** | **`+0 min`!** | **Re-routed from closed `P2` $\rightarrow$ open `P3`** with **zero additional delay**! |
| **`T104`** | `P3` (`09:40–10:00`) | **`P3` (`09:55–10:15`)** | `+15 min` | Held until `09:55` so it has an exact **10-minute safety gap** after `T103` departs `P3` at `09:45`. |

---

## 💻 Quick Local Setup (Windows / macOS / Linux)

### 1. Start the FastAPI + OR-Tools Backend (Port `8010`)
```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate | Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app.main:app --host 0.0.0.0 --port 8010
```

### 2. Start the React + Vite Frontend (Port `5180`)
```bash
cd frontend
npm install
npm run dev -- --host 0.0.0.0 --port 5180
```
Open **`http://localhost:5180/app`** in Chrome, Edge, or Brave.

### 3. Run the Automated Test Suites (58/58 Passing)
```bash
# Backend Pytest Suite (49 tests: CP-SAT solver, 6-rule validator, AI boundary firewall, voice endpoints)
cd backend && pytest

# Frontend Vitest Suite (9 tests: API normalization, UI rendering, safety firewall gates)
cd frontend && npm test
```

---

## ☁️ 1-Command Deployment on 1GB RAM / 1 vCPU Oracle Free Tier VPS + Cloudflare Tunnel (`autonoma.noxverse.in`)

Because an **Oracle Cloud Free Tier (`VM.Standard.E2.1.Micro` — 1 vCPU, 1 GB RAM)** has limited memory, we include an automated deployment script ([`deploy/setup_vps_cloudflare.sh`](./deploy/setup_vps_cloudflare.sh)) that:
1. Creates a **2 GB Linux Swapfile** first so `npm run build` and `ortools` never hit Out-Of-Memory (`OOM`).
2. Compiles the React frontend into static files served by **Nginx** (`~8 MB RAM`) and runs **FastAPI + Uvicorn** with a single worker (`--workers 1`, `~95 MB RAM`).
3. Connects **Cloudflare Zero-Trust Tunnel (`cloudflared`)** directly to **`https://autonoma.noxverse.in`** with **zero open firewall ports** required.

### Run on Your Ubuntu VPS in 2 Commands:
```bash
git clone https://github.com/takshalchaudhari/RailFlow_Autonoma.git /opt/railflow
cd /opt/railflow
sudo CLOUDFLARE_TUNNEL_TOKEN="YOUR_CLOUDFLARE_TUNNEL_TOKEN" \
     ELEVENLABS_API_KEY="YOUR_ELEVENLABS_KEY_OPTIONAL" \
     bash deploy/setup_vps_cloudflare.sh
```

In your **Cloudflare Zero Trust Dashboard** (`Networks` $\rightarrow$ `Tunnels` $\rightarrow$ `Public Hostname`):
- **Subdomain:** `autonoma`
- **Domain:** `noxverse.in`
- **Service Type:** `HTTP`
- **URL:** `localhost:80`

---

<div align="center">
  <b>Built with ❤️ by Team Autonoma (`@takshalchaudhari`, `@IshwariByte`, `@tanishkagadakh`, `@samruddhi-nilkanth`) for Vortexa 3.0 · Challenge P-03</b><br/>
  <sub>FICTIONAL SIMULATION — NO LIVE RAILWAY DATA</sub>
</div>
