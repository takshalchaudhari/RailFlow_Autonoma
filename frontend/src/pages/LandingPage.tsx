import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Mic,
  Play,
  ShieldAlert,
  ShieldCheck,
  Train,
} from "lucide-react";
import { Link } from "react-router-dom";
import concept from "../assets/railflow-concept.png";

export default function LandingPage() {
  return (
    <main className="landing" data-testid="landing-page">
      <div className="aurora" />

      {/* Top Navigation */}
      <nav className="marketing-nav">
        <div className="brand-group">
          <span className="brand">
            Rail<span>Flow</span> Autonoma
          </span>
          <span className="brand-pill">
            VORTEXA 3.0 · P-03 RAILWAY SAFETY SIMULATOR
          </span>
        </div>
        <div className="marketing-nav-links">
          <Link className="quiet-link" to="/app?autodemo=1">
            <Play size={14} /> Run Judge Auto-Demo
          </Link>
          <Link className="launch-sm" to="/app">
            Open Station Simulator <ArrowRight size={15} />
          </Link>
        </div>
      </nav>

      {/* Hero Section — Plain English Explanation for Judges */}
      <section className="hero">
        <div className="hero-copy">
          <div className="judge-eyebrow">
            <Train size={15} />
            <span>WHAT IS RAILFLOW? · PLAIN-ENGLISH OVERVIEW FOR JUDGES</span>
          </div>
          <h1>
            When a train is late and a platform closes,{" "}
            <em>how do you prevent a collision?</em>
          </h1>
          <p className="hero-lead">
            <strong>The Problem:</strong> At a busy railway station, platforms
            are shared tracks. If <strong>Train T101 is 20 minutes late</strong>{" "}
            and <strong>Platform P2 closes for maintenance</strong>, incoming
            trains will overlap on the same track unless a controller rapidly
            re-routes them with a mandatory <strong>10-minute safety gap</strong>.
          </p>
          <p className="hero-lead-sub">
            <strong>Our Solution:</strong> RailFlow lets station controllers or
            drivers report disruptions by <strong>Voice or Plain English</strong>
            , uses <strong>Google OR-Tools mathematical optimization</strong> to
            re-route trains around closed tracks, and verifies every move through
            an <strong>Independent Safety Firewall</strong> before any train
            driver gets a green signal.
          </p>

          <div className="hero-cta-row">
            <Link
              className="launch"
              to="/app"
              data-testid="landing-launch-btn"
            >
              Open Live Station Console <ArrowRight size={18} />
            </Link>
            <Link
              className="launch-secondary"
              to="/app?autodemo=1"
              data-testid="landing-autodemo-btn"
            >
              <Play size={16} /> Watch 1-Click Judge Demo
            </Link>
          </div>
        </div>

        {/* Visual Before vs. After Card on Hero */}
        <div className="hero-visual-stack">
          <div className="judge-scenario-card">
            <div className="jsc-header">
              <span className="jsc-badge">LIVE SCENARIO INSIDE SIMULATOR</span>
              <strong>Vortexa Central Station (Platforms P1, P2, P3)</strong>
            </div>

            <div className="jsc-comparison">
              <div className="jsc-box danger">
                <div className="jsc-box-title">
                  <AlertTriangle size={15} />
                  <span>1. THE DISRUPTION (09:20 AM)</span>
                </div>
                <ul>
                  <li>
                    <strong>Train T101 (+20m Delay):</strong> Stuck on{" "}
                    <code>Platform P1</code> until <code>09:40</code> — clashes
                    with <strong>Train T102</strong> arriving at{" "}
                    <code>09:30</code>!
                  </li>
                  <li>
                    <strong>Platform P2 Closed (09:20–10:00):</strong> Blocks{" "}
                    <strong>Train T103</strong> scheduled at{" "}
                    <code>09:25–09:45</code>!
                  </li>
                </ul>
              </div>

              <div className="jsc-box safe">
                <div className="jsc-box-title">
                  <CheckCircle2 size={15} />
                  <span>2. RAILFLOW RECOVERY (v2 VALID)</span>
                </div>
                <ul>
                  <li>
                    <strong>Train T103 Re-Routed (P2 → P3):</strong> Moved from
                    closed <code>P2</code> to open <code>P3</code> (
                    <code>09:25–09:45</code>) with <strong>0m delay</strong>!
                  </li>
                  <li>
                    <strong>Trains T102 &amp; T104 Held Safely:</strong>{" "}
                    <code>T102</code> arrives at <code>09:50</code> on{" "}
                    <code>P1</code> and <code>T104</code> at <code>09:55</code>{" "}
                    on <code>P3</code> (exact <strong>10m safety gaps</strong>).
                  </li>
                </ul>
              </div>
            </div>
          </div>
          <img
            className="hero-concept"
            src={concept}
            alt="RailFlow dispatch control room concept"
          />
        </div>
      </section>

      {/* 4-Step Pipeline Section — Why AI Alone Is Not Enough */}
      <section className="proof">
        <div className="proof-copy">
          <span className="eyebrow">
            WHY NORMAL AI FAILS IN RAILWAY SAFETY
          </span>
          <h2>
            AI translates the human. Mathematics moves the trains. A firewall
            checks the law.
          </h2>
          <p>
            Asking a raw LLM (like ChatGPT) to assign train tracks is unsafe
            because AI can hallucinate and put two trains on the same platform.
            RailFlow enforces a strict <strong>4-layer safety architecture</strong>:
          </p>
        </div>

        <div className="feature-grid">
          <article>
            <div className="step-pill">STEP 1 · AI / VOICE INPUT</div>
            <Mic size={22} />
            <h3>Speak or Type the Problem</h3>
            <p>
              Say <em>&ldquo;Delay T101 by 20m and close P2 from 09:20 to 10:00&rdquo;</em>.
              AI converts your words into a structured alert—and is{" "}
              <strong>strictly forbidden from assigning tracks</strong>.
            </p>
          </article>

          <article>
            <div className="step-pill">STEP 2 · HUMAN SIGN-OFF</div>
            <ShieldAlert size={22} />
            <h3>Controller Confirms Facts</h3>
            <p>
              Nothing touches the station timetable until the human signaller
              reviews the staged disruption queue and clicks{" "}
              <strong>Confirm</strong>.
            </p>
          </article>

          <article>
            <div className="step-pill">STEP 3 · OR-TOOLS SOLVER</div>
            <Cpu size={22} />
            <h3>Mathematical Re-Routing</h3>
            <p>
              Google OR-Tools CP-SAT computes the optimal platform reassignment
              and holding times to minimize passenger delay.
            </p>
          </article>

          <article>
            <div className="step-pill">STEP 4 · SAFETY FIREWALL</div>
            <ShieldCheck size={22} />
            <h3>Independent 6-Rule Validator</h3>
            <p>
              A separate deterministic validator checks overlaps, 10-minute
              clearance gaps, and track closures before drivers get green
              signals.
            </p>
          </article>
        </div>
      </section>
    </main>
  );
}
