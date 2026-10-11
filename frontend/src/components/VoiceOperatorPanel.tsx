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
  const [continuousTurn, setContinuousTurn] = useState<boolean>(false);
  const [ttsNotice, setTtsNotice] = useState<string | null>(null);
  const [messages, setMessages] = useState<VoiceMessage[]>([
    {
      id: "welcome-msg",
      role: "assistant",
      text: "RailFlow Voice Operator ready. Click Start Talking to speak directly, or ask about affected trains, validation findings, or next-30-minute movements.",
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
    setInterimTranscript("");
    setInteractionState("idle");
  };

  const speakWithFreeBrowserTTS = (text: string, onDone?: () => void) => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = "en-US";
        utter.rate = 1.03;
        setInteractionState("speaking");
        utter.onend = () => {
          setInteractionState("idle");
          if (onDone) onDone();
        };
        utter.onerror = () => {
          setInteractionState("idle");
        };
        window.speechSynthesis.speak(utter);
        return true;
      } catch {
        setInteractionState("idle");
        return false;
      }
    }
    setInteractionState("idle");
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
      // Browser autoplay restriction or decode failure — fall back to Web Speech
      speakWithFreeBrowserTTS(fallbackText, onDone);
    });
  };

  const handleSubmitCommand = async (rawInput?: string, fromSpeech = false) => {
    const text = (rawInput ?? utterance).trim();
    if (!text || submittingRef.current) return;

    // Stop any currently playing speech before processing the new turn
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
    setInterimTranscript("");
    setInteractionState("processing");
    setTtsNotice(null);

    try {
      const resp = await sendVoiceCommand(scenario.id, {
        utterance: text,
        version_id: currentVersion.id,
        sim_clock: simClock,
      });

      // Focus referenced entity on map if any
      if (resp.referenced_trains.length > 0) {
        onSelectTrain(resp.referenced_trains[0]);
      } else if (resp.referenced_platforms.length > 0) {
        onSelectPlatform(resp.referenced_platforms[0]);
      }

      let audioUrl: string | null = null;
      const resumeMicIfContinuous = () => {
        if (fromSpeech && continuousTurnRef.current) {
          setTimeout(() => {
            startMicrophoneCapture();
          }, 350);
        }
      };

      if (selectedVoiceId === "free_browser_tts") {
        speakWithFreeBrowserTTS(resp.reply_text, resumeMicIfContinuous);
      } else if (voiceStatus?.configured) {
        const tts = await synthesizeVoiceSpeech(
          resp.reply_text,
          selectedVoiceId
        );
        if (tts.audioUrl) {
          audioUrl = tts.audioUrl;
        } else {
          if (tts.error) {
            setTtsNotice(`${tts.error} (Switched to Free Browser Voice)`);
          }
          speakWithFreeBrowserTTS(resp.reply_text, resumeMicIfContinuous);
        }
      } else {
        speakWithFreeBrowserTTS(resp.reply_text, resumeMicIfContinuous);
      }

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

      if (audioUrl) {
        playAudioUrl(audioUrl, resp.reply_text, resumeMicIfContinuous);
      }
    } catch (err) {
      setInteractionState("error");
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "assistant",
          text:
            err instanceof Error
              ? `Command failed: ${err.message}`
              : "Failed to process voice command.",
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          intent: "error",
        },
      ]);
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
        "Browser speech recognition is unavailable in this browser. Type your spoken command below and press Send to hear the ElevenLabs reply."
      );
      return;
    }

    // Interrupt any active TTS playback when the operator starts talking
    stopAllAudio();

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rec = new (SpeechRec as any)();
      rec.lang = "en-US";
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      let finalCaptured = "";

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
        if (interim) {
          setInterimTranscript(interim);
        }
        if (finalStr.trim()) {
          finalCaptured = finalStr.trim();
          setInterimTranscript("");
          setUtterance(finalCaptured);
          handleSubmitCommand(finalCaptured, true);
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rec.onerror = (ev: any) => {
        const errCode = ev?.error || "unknown";
        if (errCode === "not-allowed" || errCode === "service-not-allowed") {
          setInteractionState("error");
          setTtsNotice(
            "Microphone permission denied by browser. Allow microphone access or use the live transcript input below."
          );
        } else if (errCode === "no-speech") {
          setInteractionState("idle");
          setTtsNotice("No speech detected. Click Start Talking when ready.");
        } else {
          setInteractionState("idle");
          setTtsNotice(
            `Speech capture interrupted (${errCode}). You can edit or submit your transcript below.`
          );
        }
      };

      rec.onend = () => {
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
