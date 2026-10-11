<div align="center">

<!-- 3D ANIMATED ISOMETRIC STATION SIMULATION HERO -->
<img src="docs/assets/railflow-3d-animated-hero.svg" alt="RailFlow Autonoma 3D Animated Station Digital Twin" width="100%" />

<br />

# 🚆 RailFlow Autonoma
### *3D Railway Disruption & Anti-Collision Simulator with Mathematical Safety Firewall*

[![Vortexa 3.0](https://img.shields.io/badge/VORTEXA_3.0-Challenge_P--03-0284c7?style=for-the-badge&logo=railway&logoColor=white)](https://autonoma.noxverse.in)
[![Live Demo](https://img.shields.io/badge/LIVE_DEMO-autonoma.noxverse.in-10b981?style=for-the-badge&logo=cloudflare&logoColor=white)](https://autonoma.noxverse.in/app?autodemo=1)
[![Solver](https://img.shields.io/badge/Engine-Google_OR--Tools_CP--SAT-9333ea?style=for-the-badge)](app/engine/scheduler.py)
[![Safety Firewall](https://img.shields.io/badge/Validator-66%2F66_Tests_Passing-16a34a?style=for-the-badge)](tests/)

**[🌐 Live Judge Overview (`autonoma.noxverse.in`)](https://autonoma.noxverse.in) · [▶️ Launch 1-Click Auto-Demo (`/app?autodemo=1`)](https://autonoma.noxverse.in/app?autodemo=1) · [🚀 1-Command VPS + Cloudflare Tunnel Setup](#-1-command-oracle-vps--cloudflare-tunnel-deployment-autonomanoxversein)**

</div>

---

## 🎯 Understand RailFlow in 15 Seconds (Judge's Brief)

### ❓ What Problem Does This Website Solve?
At a busy railway station, platforms (`P1`, `P2`, `P3`) are shared physical tracks. Suppose two emergencies happen at **09:20 AM**:
1. **Train `T101` is delayed by `+20 minutes`** on `Platform P1` (staying until `09:40`, which collides with **`Train T102`** scheduled at `09:30`!).
2. **`Platform P2` is suddenly closed (`09:20–10:00`)** for maintenance (blocking **`Train T103`** scheduled at `09:25–09:45`!).

### 🛑 Why Can't You Just Use ChatGPT / Pure AI?
Letting an LLM directly assign train tracks is dangerous—AI can hallucinate and put two passenger trains on the same platform at the same time.

### ✅ How RailFlow Autonoma Solves It Safely (4-Layer Architecture)

<div align="center">
  <img src="docs/assets/railflow-3d-pipeline.svg" alt="RailFlow 4-Stage Safety Pipeline" width="100%" />
</div>

| Stage | Component | What It Does | Safety Guarantee |
| :--- | :--- | :--- | :--- |
| **1. Speak / Type** | **AI + Voice Parser** (`app/ai/parser.py`) | Controller speaks or types *"Delay T101 by 20m and close P2 from 09:20 to 10:00"*. | 🚫 **AI is mathematically forbidden from assigning tracks** (`app/ai/schemas.py`). |
| **2. Sign-Off** | **Human Confirmation Gate** | Controller reviews the staged alert in the queue and clicks **Confirm**. | 👤 **No unconfirmed AI output can ever trigger replanning.** |
| **3. Solve** | **Google OR-Tools CP-SAT** (`app/engine/scheduler.py`) | Computes the fastest conflict-free recovery schedule across all platforms. | ⚡ **Re-routes `T103` (`P2 → P3`, `0m` delay) & holds `T102`/`T104` with exact `10m` gaps.** |
| **4. Firewall** | **Independent Validator** (`app/engine/validator.py`) | Separate code path checks all **6 Hard Railway Safety Laws** before activation. | 🛡️ **If any rule fails, the schedule is blocked (`INVALID`) and baseline `v1` stays active.** |

---

## 🖥️ Visual Tour — Built for Judges, Signallers & Train Drivers

<div align="center">
  <img src="docs/assets/live-3d-twin-preview.png" alt="RailFlow 3D Digital Twin and Judge Story Banner" width="100%" />
  <p><em>Above: The <b>"What Is This Website?" Judge Storyboard</b>, <b>3-Step Driver Quick Guide</b>, and interactive <b>Three.js 3D Digital Twin</b>.</em></p>
</div>

<div align="center">
  <img src="docs/assets/live-station-map-preview.png" alt="RailFlow 2D Geographic & Signalling Map with Driver Cab HUD" width="100%" />
  <p><em>Above: Custom <b>Vector Cartographic Basemap</b>, <b>Multi-Aspect Trackside Signals (🟢/🟡/🔴)</b>, <b>Emerald Re-Route Path (P2 → P3)</b>, and <b>Driver Cab Instruction HUD</b>.</em></p>
</div>

### 🕹️ Try the 3-Click Guided Simulation Inside `/app`
1. **Click `▶ Watch 1-Click Judge Demo`** at the top of the dashboard (or step through `1 Normal Day (v1)` → `2 Stage T101 +20m & Close P2` → `3 Confirm & Re-Route Trains`).
2. **Inspect the Live Driver Cab Strip:**
   - 🟠 **`T101` (`Track P1` · `09:20–09:40`):** Delayed `+20m` by initial disruption; occupies `P1` safely.
   - 🟠 **`T102` (`Track P1` · `09:50–10:10`):** Held `+20m` by solver so it enters `P1` **exactly 10 minutes after `T101` departs at `09:40`**.
   - 🟢 **`T103` (`Re-Routed P2 → P3` · `09:25–09:45`):** Automatically switched via turnout `SW-101W` onto open `Platform P3` with **0 minutes of added delay!**
   - 🟠 **`T104` (`Track P3` · `09:55–10:15`):** Held `+15m` so it enters `P3` **exactly 10 minutes after `T103` departs at `09:45`**.
3. **Click `🛡️ Test Unsafe Schedule (Firewall)`:** Forces two trains onto `P1` with only a 5-minute gap so you can watch the **Independent Safety Validator** reject the candidate (`INVALID`) while keeping the safe schedule active.

---

## ⚖️ The Six Hard Railway Safety Invariants

Every candidate schedule is verified against **6 mathematical invariants** in [`app/engine/validator.py`](app/engine/validator.py) (completely independent from the solver in [`app/engine/scheduler.py`](app/engine/scheduler.py)):

1. **Half-Open Interval Occupancy `[arrival, departure)`:** Every train preserves its required dwell time and satisfies `departure > arrival`.
2. **Zero Platform Overlap + Mandatory 10-Minute Clearance:** For any two trains $A, B$ on the same platform:
   $$\text{dep}_A + 10 \le \text{arr}_B \quad \text{or} \quad \text{dep}_B + 10 \le \text{arr}_A$$
3. **Platform Closure Exclusion:** No train can occupy platform $P$ during any active closure window `[close_start, close_end)`.
4. **Platform Compatibility & Required Track:** Every train's assigned platform must belong to `allowed_platforms` and match `required_platform` if locked.
5. **Post-Disruption Baseline Monotonicity:** No train can be scheduled to arrive earlier than its effective post-disruption arrival ($\text{arr}_{\text{rev}} \ge \text{arr}_{\text{base}} + \text{delay}$).
6. **Complete & Authentic Schedule Set:** Every scenario train (`T101`–`T104`) must appear exactly once; `FIXED`/`DEPARTED` trains cannot be moved.

---

## ☁️ 1-Command Oracle VPS + Cloudflare Tunnel Deployment (`autonoma.noxverse.in`)

This repository includes two automated deployment scripts engineered specifically for an **Oracle Cloud Free Tier VPS (1 GB RAM, 1 vCPU)** routing to **`https://autonoma.noxverse.in`** via **Cloudflare Tunnel (`cloudflared`)**—**no open inbound firewall ports (`80`/`443`) or manual SSL certificates needed!**

### Why This Runs Smoothly on 1 GB RAM:
- **2 GB Swap File Auto-Creation:** Prevents Out-Of-Memory (OOM) crashes during `npm run build`.
- **Single-Process Production Server (`~85 MB RAM`):** FastAPI ([`app/main.py`](app/main.py)) serves both the compiled React SPA (`frontend/dist`) and `/api/v1/*` from `127.0.0.1:8010` using a single Uvicorn worker.
- **Outbound Cloudflare Tunnel (`cloudflared`):** Connects outbound from `127.0.0.1:8010` to Cloudflare's edge and serves **`https://autonoma.noxverse.in`** with automatic HTTPS.

---

### 🚀 Method 1: Zero-Trust Token Tunnel (Fastest — 1 Single Command!)

1. Open **[Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/) → Networks → Tunnels → Create a Tunnel → Cloudflared**.
2. Name it `railflow-autonoma`, copy your **Tunnel Token** (`eyJhIjoi...`), and add a **Public Hostname**:
   - **Subdomain:** `autonoma`
   - **Domain:** `noxverse.in`
   - **Service Type:** `HTTP` → **URL:** `127.0.0.1:8010`
3. SSH into your 1 GB Oracle VPS and paste **this single command**:

```bash
curl -fsSL https://raw.githubusercontent.com/takshalchaudhari/RailFlow_Autonoma/main/deploy_oracle_vps.sh | sudo ELEVENLABS_API_KEY="YOUR_ELEVENLABS_KEY" CF_TUNNEL_TOKEN="PASTE_YOUR_CLOUDFLARE_TUNNEL_TOKEN" bash
```

---

### 🔐 Method 2: CLI-Managed Cloudflare Tunnel (No Dashboard Setup Needed!)

If you don't want to configure the Zero Trust dashboard manually, run these **2 commands** on your VPS—the script will log you into Cloudflare, create the tunnel, automatically route the DNS record for **`autonoma.noxverse.in`**, and start the `cloudflared` daemon:

```bash
# Step 1: Install Swap + Build App + Start RailFlow on 127.0.0.1:8010
curl -fsSL https://raw.githubusercontent.com/takshalchaudhari/RailFlow_Autonoma/main/deploy_oracle_vps.sh | sudo ELEVENLABS_API_KEY="YOUR_ELEVENLABS_KEY" bash

# Step 2: Authenticate Cloudflare CLI & Auto-Route https://autonoma.noxverse.in -> 127.0.0.1:8010
sudo bash /opt/railflow/setup_cloudflare_tunnel.sh
```
*(When Step 2 prints a `https://dash.cloudflare.com/argotunnel?...` link, open it in your browser, select **`noxverse.in`**, and press Authorize—the script will automatically create the tunnel, bind `autonoma.noxverse.in` DNS, and launch the background service!)*

### 🔍 Useful VPS Service Commands
```bash
sudo systemctl status railflow      # Check FastAPI + React SPA server (:8010)
sudo systemctl status cloudflared   # Check Cloudflare Tunnel (autonoma.noxverse.in)
sudo journalctl -u railflow -f      # View live RailFlow logs
```

---

## 💻 Local Development Quickstart (Windows / macOS / Linux)

```bash
# 1. Clone repository & install Python backend dependencies
git clone https://github.com/takshalchaudhari/RailFlow_Autonoma.git
cd RailFlow_Autonoma
python -m venv .venv
# Windows: .\.venv\Scripts\Activate.ps1   |   Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt

# 2. Run all 66 automated backend & safety validator tests
python -m pytest -v
python scripts/verify_live_demo.py

# 3. Build frontend & launch Single-Process Server on http://localhost:8010/app
cd frontend
npm install
npm run build
cd ..
python -m uvicorn app.main:app --host 0.0.0.0 --port 8010
```

---

## 📋 Vortexa 3.0 Compliance — Declared Tech Stack & AI Usage Disclosure

In accordance with **Vortexa 3.0 Official Hackathon Rules (Rule 2 & Rule 4)**, all languages, frameworks, libraries, AI tools, and APIs are declared below:

- **Backend:** Python 3.12, FastAPI, Uvicorn, Pydantic v2, Google OR-Tools CP-SAT (`ortools`), SQLite3, `pytest` + `httpx`.
- **Frontend:** React 18, TypeScript, Vite, Three.js (`three` WebGL 3D station digital twin), Custom SVG Vector Cartographic & Signalling Engine, Lucide Icons.
- **AI & Voice Boundaries (With 100% Free Offline Fallbacks):**
  - **Disruption Parser & Schedule Explainer (`app/ai/`):** Optional OpenAI/Gemini-compatible API strictly validated by Pydantic schemas (`app/ai/schemas.py`), defaulting to a **100% deterministic offline regex parser & template explainer** (`app/ai/fallback_parser.py`).
  - **Voice Dispatch (`app/services/voice_service.py`):** Optional server-side ElevenLabs TTS (`eleven_multilingual_v2`), defaulting to native browser `window.speechSynthesis` & `SpeechRecognition`.
- **Operating Boundary:** Fictional simulation environment only (`Vortexa Central Station`); never interfaces with live railway hardware.
