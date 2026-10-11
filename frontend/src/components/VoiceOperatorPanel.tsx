import React, { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Mic,
  MicOff,
  Play,
  Radio,
  RotateCcw,
  Send,
  ShieldAlert,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  getVoiceStatus,
  sendVoiceCommand,
  synthesizeVoiceSpeech,
} from "../api";
import {
  DisruptionInput,
  ScenarioResponse,
  ScheduleVersion,
  VoiceMessage,
  VoiceStatusResponse,
} from "../types";

export interface VoiceOperatorPanelProps {
  scenario: ScenarioResponse;
  currentVersion: ScheduleVersion;
  simClock: number;
  onStageDisruptionDrafts: (drafts: DisruptionInput[], rawText: string) => void;
  onSelectTrain: (trainId: string) => void;
  onSelectPlatform: (platformId: string) => void;
  proactiveAlert?: {
    id: string;
    text: string;
    severity: "info" | "warn" | "critical";
  } | null;
  autoAlertsEnabled?: boolean;
  externalListenTrigger?: number;
  onVoiceStateChange?: (state: VoiceInteractionState, interim: string) => void;
}

export type VoiceInteractionState =
  | "idle"
  | "listening"
  | "processing"
  | "speaking"
  | "error";

const EXAMPLE_COMMANDS = [
  "Which trains are affected by the platform two closure?",
  "Explain why T101 needs reassignment.",
  "Read out the current validation errors.",
  "Summarize the next thirty minutes.",
  "Delay T101 by twenty minutes and close platform P2 from 09:20 to 10:00.",
];

export const VoiceOperatorPanel: React.FC<VoiceOperatorPanelProps> = ({
  scenario,
  currentVersion,
  simClock,
  onStageDisruptionDrafts,
  onSelectTrain,
  onSelectPlatform,
  proactiveAlert,
  autoAlertsEnabled = true,
  externalListenTrigger = 0,
  onVoiceStateChange,
}) => {
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatusResponse | null>(
    null
  );
  const [selectedVoiceId, setSelectedVoiceId] = useState<string>(
    "21m00Tcm4TlvDq8ikWAM"
  );
  const [utterance, setUtterance] = useState<string>("");
  const [interimTranscript, setInterimTranscript] = useState<string>("");
  const [interactionState, setInteractionState] =
    useState<VoiceInteractionState>("idle");
  const [continuousTurn, setContinuousTurn] = useState<boolean>(true);
  const [ttsNotice, setTtsNotice] = useState<string | null>(null);
  const [messages, setMessages] = useState<VoiceMessage[]>([
    {
      id: "welcome-msg",
      role: "assistant",
      text: "RailFlow Duplex Voice AI active. Speak anytime or enable hands-free mic — I will answer you out loud immediately and automatically announce any track closures, delays, or safety alerts.",
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      intent: "system_ready",
    },
  ]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recognitionRef = useRef<{ stop: () => void; abort?: () => void } | null>(
    null
  );
  const submittingRef = useRef<boolean>(false);
  const continuousTurnRef = useRef<boolean>(continuousTurn);
  continuousTurnRef.current = continuousTurn;
  const latestInterimRef = useRef<string>("");
  const lastSpokenAlertIdRef = useRef<string>("");

  useEffect(() => {
    if (onVoiceStateChange) {
      onVoiceStateChange(interactionState, interimTranscript);
    }
  }, [interactionState, interimTranscript, onVoiceStateChange]);

  useEffect(() => {
    let mounted = true;
    getVoiceStatus()
      .then((st) => {
        if (!mounted) return;
        setVoiceStatus(st);
        if (st.voices.length > 0) {
          setSelectedVoiceId(st.voices[0].voice_id);
        }
      })
      .catch(() => {
        if (!mounted) return;
        setVoiceStatus({
          configured: false,
          status: "not_configured",
          provider: "elevenlabs",
          conversation_mode: "browser_web_speech",
          convai_websocket_available: false,
          stt_mode: "browser_speech_recognition",
          message: "Voice service using local browser speech fallback",
          voices: [
            {
              voice_id: "21m00Tcm4TlvDq8ikWAM",
              name: "Rachel — Dispatch Lead",
            },
          ],
          ai_platform_assignment_forbidden: true,
        });
      });
    return () => {
      mounted = false;
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          // ignore
        }
      }
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  const stopAllAudio = () => {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      } catch {
        // ignore
      }
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
    setInteractionState((prev) => (prev === "speaking" ? "idle" : prev));
  };

  const handleStopInterrupt = () => {
    stopAllAudio();
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
    }
    latestInterimRef.current = "";
    setInterimTranscript("");
    setInteractionState("idle");
  };

  const speakWithFreeBrowserTTS = (text: string, onDone?: () => void) => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = "en-US";
        utter.rate = 1.04;
        setInteractionState("speaking");
        utter.onend = () => {
          setInteractionState("idle");
          if (onDone) onDone();
        };
        utter.onerror = () => {
          setInteractionState("idle");
          if (onDone) onDone();
        };
        window.speechSynthesis.speak(utter);
        return true;
      } catch {
        setInteractionState("idle");
        if (onDone) onDone();
        return false;
      }
    }
    setInteractionState("idle");
    if (onDone) onDone();
    return false;
  };

  const playAudioUrl = (url: string, fallbackText: string, onDone?: () => void) => {
    stopAllAudio();
    if (!audioRef.current) {
      speakWithFreeBrowserTTS(fallbackText, onDone);
      return;
    }
    setInteractionState("speaking");
    audioRef.current.src = url;
    audioRef.current.onended = () => {
      setInteractionState("idle");
      if (onDone) onDone();
    };
    audioRef.current.onerror = () => {
      setInteractionState("idle");
      speakWithFreeBrowserTTS(fallbackText, onDone);
    };
    audioRef.current.play().catch(() => {
      speakWithFreeBrowserTTS(fallbackText, onDone);
    });
  };

  const speakTextImmediately = async (
    text: string,
    onDone?: () => void
  ): Promise<string | null> => {
    if (selectedVoiceId === "free_browser_tts" || !voiceStatus?.configured) {
      speakWithFreeBrowserTTS(text, onDone);
      return null;
    }
    try {
      const tts = await synthesizeVoiceSpeech(text, selectedVoiceId);
      if (tts.audioUrl) {
        playAudioUrl(tts.audioUrl, text, onDone);
        return tts.audioUrl;
      }
      speakWithFreeBrowserTTS(text, onDone);
      return null;
    } catch {
      speakWithFreeBrowserTTS(text, onDone);
      return null;
    }
  };

  // Automatic Proactive Voice Alerts (Zero Manual Intervention)
  useEffect(() => {
    if (
      !proactiveAlert ||
      !autoAlertsEnabled ||
      proactiveAlert.id === lastSpokenAlertIdRef.current
    ) {
      return;
    }
    lastSpokenAlertIdRef.current = proactiveAlert.id;
    const alertMsg: VoiceMessage = {
      id: `auto-alert-${proactiveAlert.id}`,
      role: "assistant",
      text: proactiveAlert.text,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      intent: `auto_${proactiveAlert.severity}_alert`,
    };
    setMessages((prev) => [...prev, alertMsg]);
    // Speak immediately out loud without waiting for any manual button click
    void speakTextImmediately(proactiveAlert.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proactiveAlert, autoAlertsEnabled]);

  // Allow external trigger from Topbar Live Voice Button
  useEffect(() => {
    if (externalListenTrigger > 0) {
      handleToggleMic();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalListenTrigger]);

  const handleSubmitCommand = async (rawInput?: string, fromSpeech = false) => {
    const text = (rawInput ?? utterance).trim();
    if (!text || submittingRef.current) return;

    stopAllAudio();
    submittingRef.current = true;

    const opMsg: VoiceMessage = {
      id: `op-${Date.now()}`,
      role: "operator",
      text,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };
    setMessages((prev) => [...prev, opMsg]);
    if (!rawInput) setUtterance("");
    latestInterimRef.current = "";
    setInterimTranscript("");
    setInteractionState("processing");
    setTtsNotice(null);

    try {
      const resp = await sendVoiceCommand(scenario.id, {
        utterance: text,
        version_id: currentVersion.id,
        sim_clock: simClock,
      });

      if (resp.referenced_trains.length > 0) {
        onSelectTrain(resp.referenced_trains[0]);
      } else if (resp.referenced_platforms.length > 0) {
        onSelectPlatform(resp.referenced_platforms[0]);
      }

      // Automatically stage parsed disruptions when spoken by operator!
      if (resp.normalized_disruptions && resp.normalized_disruptions.length > 0) {
        onStageDisruptionDrafts(resp.normalized_disruptions, text);
      }

      const resumeMicIfContinuous = () => {
        if (fromSpeech && continuousTurnRef.current) {
          setTimeout(() => {
            startMicrophoneCapture();
          }, 300);
        }
      };

      const audioUrl = await speakTextImmediately(
        resp.reply_text,
        resumeMicIfContinuous
      );

      const aiMsg: VoiceMessage = {
        id: `ai-${Date.now()}`,
        role: "assistant",
        text: resp.reply_text,
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        intent: resp.intent,
        draftEvents:
          resp.normalized_disruptions.length > 0
            ? resp.normalized_disruptions
            : undefined,
        audioUrl,
      };
      setMessages((prev) => [...prev, aiMsg]);
    } catch (err) {
      setInteractionState("error");
      const fallbackErr =
        err instanceof Error
          ? `Command failed: ${err.message}`
          : "Failed to process voice command.";
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "assistant",
          text: fallbackErr,
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          intent: "error",
        },
      ]);
      speakWithFreeBrowserTTS(fallbackErr);
    } finally {
      submittingRef.current = false;
      setInteractionState((prev) =>
        prev === "processing" ? "idle" : prev
      );
    }
  };

  const startMicrophoneCapture = () => {
    const SpeechRec =
      (window as unknown as Record<string, unknown>).SpeechRecognition ||
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition;

    if (!SpeechRec) {
      setInteractionState("error");
      setTtsNotice(
        "Browser microphone speech recognition unavailable. Use the instant voice bar below to talk to the AI dispatcher."
      );
      return;
    }

    stopAllAudio();

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rec = new (SpeechRec as any)();
      rec.lang = "en-US";
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;

      let finalCaptured = "";
      latestInterimRef.current = "";

      rec.onstart = () => {
        setInterimTranscript("");
        setInteractionState("listening");
        setTtsNotice(null);
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onresult = (event: any) => {
        let interim = "";
        let finalStr = "";
        for (let i = event.resultIndex || 0; i < event.results.length; i++) {
          const res = event.results[i];
          const chunk = res?.[0]?.transcript || "";
          if (res.isFinal) {
            finalStr += chunk;
          } else {
            interim += chunk;
          }
        }
        if (interim.trim()) {
          latestInterimRef.current = interim.trim();
          setInterimTranscript(interim.trim());
        }
        if (finalStr.trim()) {
          finalCaptured = finalStr.trim();
          latestInterimRef.current = "";
          setInterimTranscript("");
          setUtterance(finalCaptured);
          void handleSubmitCommand(finalCaptured, true);
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onerror = (ev: any) => {
        const errCode = ev?.error || "unknown";
        if (errCode === "not-allowed" || errCode === "service-not-allowed") {
          setInteractionState("error");
          setTtsNotice(
            "Microphone permission blocked by browser. Allow mic access in the URL bar or click any quick voice command below."
          );
        } else if (errCode === "no-speech") {
          setInteractionState("idle");
        } else {
          setInteractionState("idle");
        }
      };

      rec.onend = () => {
        // Crucial fix: if Chrome ended speech before marking isFinal, submit the captured interim words immediately!
        if (!finalCaptured && latestInterimRef.current.trim()) {
          const pending = latestInterimRef.current.trim();
          finalCaptured = pending;
          latestInterimRef.current = "";
          setInterimTranscript("");
          setUtterance(pending);
          void handleSubmitCommand(pending, true);
          return;
        }
        setInterimTranscript("");
        setInteractionState((prev) =>
          prev === "listening" && !finalCaptured ? "idle" : prev
        );
      };

      recognitionRef.current = rec;
      rec.start();
    } catch {
      setInteractionState("error");
      setTtsNotice("Could not initialize browser microphone capture.");
    }
  };

  const handleToggleMic = () => {
    if (interactionState === "listening" && recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
      setInteractionState("idle");
      return;
    }
    startMicrophoneCapture();
  };

  const handlePlayCaption = async (msg: VoiceMessage) => {
    if (selectedVoiceId === "free_browser_tts") {
      speakWithFreeBrowserTTS(msg.text);
      return;
    }
    if (msg.audioUrl) {
      playAudioUrl(msg.audioUrl, msg.text);
      return;
    }
    if (voiceStatus?.configured) {
      setInteractionState("processing");
      const tts = await synthesizeVoiceSpeech(msg.text, selectedVoiceId);
      if (tts.audioUrl) {
        playAudioUrl(tts.audioUrl, msg.text);
        return;
      }
      if (tts.error) {
        setTtsNotice(`${tts.error} (Played via Free Browser Voice)`);
      }
      speakWithFreeBrowserTTS(msg.text);
    } else {
      speakWithFreeBrowserTTS(msg.text);
    }
  };

  const stateLabelMap: Record<VoiceInteractionState, string> = {
    idle: "Ready to Talk",
    listening: "Listening to Operator…",
    processing: "Understanding & Checking Schedule…",
    speaking: "Speaking Response…",
    error: "Attention Needed",
  };

  return (
    <div className="voice-operator-panel" data-testid="voice-operator-panel">
      <div className="voice-header">
        <div>
          <span className="eyebrow">LIVE SPOKEN DISPATCH ASSISTANT</span>
          <h3>RailFlow Voice Operator</h3>
        </div>
        <div className="voice-badges-stack">
          <span
            className={`voice-status-pill ${
              voiceStatus?.configured ? "ready" : "unconfigured"
            }`}
            data-testid="voice-service-status-badge"
            title={voiceStatus?.message}
          >
            {voiceStatus?.configured ? (
              <>
                <Volume2 size={12} /> ElevenLabs TTS Ready
              </>
            ) : (
              <>
                <VolumeX size={12} /> Browser Voice Active
              </>
            )}
          </span>
        </div>
      </div>

      {/* Live Spoken Conversation Primary Bar */}
      <div
        className={`voice-live-bar state-${interactionState}`}
        data-testid="voice-live-bar"
      >
        <div className="voice-live-status">
          <span
            className={`voice-state-dot ${interactionState}`}
            aria-hidden="true"
          />
          <div>
            <strong data-testid="voice-conversation-state">
              {stateLabelMap[interactionState]}
            </strong>
            <span className="voice-mode-caption">
              {voiceStatus?.configured
                ? "Turn-based Spoken Conversation (Mic STT + ElevenLabs Streaming TTS)"
                : "Turn-based Spoken Conversation (Browser Speech API)"}
            </span>
          </div>
        </div>

        <div className="voice-live-actions">
          <button
            type="button"
            className={`voice-talk-btn ${
              interactionState === "listening" ? "listening" : ""
            }`}
            onClick={handleToggleMic}
            disabled={interactionState === "processing"}
            data-testid="voice-ptt-btn"
          >
            {interactionState === "listening" ? (
              <>
                <MicOff size={14} /> Stop Talking
              </>
            ) : (
              <>
                <Mic size={14} /> Start Talking
              </>
            )}
          </button>

          {(interactionState === "speaking" ||
            interactionState === "listening") && (
            <button
              type="button"
              className="hud-btn danger-outline"
              onClick={handleStopInterrupt}
              title="Immediately stop audio playback or microphone capture"
              data-testid="voice-stop-audio-btn"
            >
              <Square size={12} /> Interrupt / Stop
            </button>
          )}
        </div>
      </div>

      {interimTranscript && (
        <div
          className="voice-interim-banner"
          data-testid="voice-interim-transcript"
        >
          <Radio size={13} />
          <span>
            Listening: <em>“{interimTranscript}”</em>
          </span>
        </div>
      )}

      <div className="voice-controls-row">
        <label className="voice-select-label">
          Voice:
          <select
            className="control-select compact"
            value={selectedVoiceId}
            onChange={(e) => setSelectedVoiceId(e.target.value)}
            aria-label="Select ElevenLabs or Free Browser voice"
          >
            {(voiceStatus?.voices ?? []).map((v) => (
              <option key={v.voice_id} value={v.voice_id}>
                {v.name} (ElevenLabs)
              </option>
            ))}
            <option value="free_browser_tts">
              Free Browser Neural Voice (Web Speech API)
            </option>
          </select>
        </label>

        <label
          className="voice-continuous-label"
          title="Automatically re-open microphone after each spoken reply"
        >
          <input
            type="checkbox"
            checked={continuousTurn}
            onChange={(e) => setContinuousTurn(e.target.checked)}
            data-testid="voice-continuous-toggle"
          />
          <span>Auto-Continue Turn</span>
        </label>
      </div>

      <p className="voice-safety-note">
        <ShieldAlert size={13} /> Grounded controller assistant. AI cannot
        assign platforms, mark schedules valid, or apply unconfirmed
        disruptions.
      </p>

      {ttsNotice && (
        <div className="voice-notice" data-testid="voice-notice">
          <AlertTriangle size={13} />
          <span>{ttsNotice}</span>
        </div>
      )}

      {/* Quick Spoken Prompts */}
      <div className="voice-prompts">
        {EXAMPLE_COMMANDS.map((cmd, idx) => (
          <button
            key={idx}
            type="button"
            className="voice-prompt-chip"
            onClick={() => handleSubmitCommand(cmd, false)}
            disabled={interactionState === "processing"}
            data-testid={`voice-prompt-${idx}`}
          >
            “{cmd}”
          </button>
        ))}
      </div>

      {/* Conversation History & Captions */}
      <div className="voice-transcript-list" data-testid="voice-transcript-list">
        {messages.map((m) => (
          <div
            key={m.id}
            className={`voice-bubble ${
              m.role === "operator" ? "operator" : "assistant"
            }`}
          >
            <div className="voice-bubble-meta">
              <strong>
                {m.role === "operator" ? "Operator" : "RailFlow Dispatch Voice"}
              </strong>
              <span>{m.timestamp}</span>
            </div>
            <p className="voice-bubble-text">{m.text}</p>

            {m.role === "assistant" && (
              <div className="voice-bubble-actions">
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => handlePlayCaption(m)}
                  title="Play or replay spoken response"
                  data-testid={`voice-replay-${m.id}`}
                >
                  <Play size={11} /> Speak / Replay
                </button>
                {interactionState === "speaking" && (
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={handleStopInterrupt}
                  >
                    <Square size={10} /> Stop Audio
                  </button>
                )}
                {m.draftEvents && m.draftEvents.length > 0 && (
                  <button
                    type="button"
                    className="mini-btn accent"
                    onClick={() =>
                      onStageDisruptionDrafts(m.draftEvents!, m.text)
                    }
                    data-testid="stage-voice-draft-btn"
                  >
                    <CheckCircle2 size={11} /> Stage Draft for Confirmation (
                    {m.draftEvents.length})
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {interactionState === "processing" && (
          <div className="voice-bubble assistant">
            <em>Checking live station timetable & validator records…</em>
          </div>
        )}
      </div>

      {/* Live Editable Transcript & Text Fallback */}
      <form
        className="voice-input-form"
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmitCommand(undefined, false);
        }}
      >
        <input
          type="text"
          value={utterance}
          onChange={(e) => setUtterance(e.target.value)}
          placeholder="Speak via microphone or edit/type transcript here…"
          className="text-input compact"
          disabled={interactionState === "processing"}
          data-testid="voice-command-input"
        />
        <button
          type="submit"
          className="primary compact"
          disabled={interactionState === "processing" || !utterance.trim()}
          data-testid="voice-send-btn"
          title="Submit transcript and speak reply"
        >
          <Send size={13} />
        </button>
        <button
          type="button"
          className="outline compact"
          onClick={() => {
            handleStopInterrupt();
            setMessages((prev) => prev.slice(0, 1));
          }}
          title="Stop audio and clear conversation history"
        >
          <RotateCcw size={13} />
        </button>
      </form>

      <audio ref={audioRef} style={{ display: "none" }} />
    </div>
  );
};
