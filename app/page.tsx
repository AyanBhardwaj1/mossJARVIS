"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JarvisVoiceEngine } from "@/lib/voice-engine";

type CoreState = "booting" | "idle" | "listening" | "thinking" | "speaking" | "offline";
type FeedItem = { id: string; role: "user" | "jarvis" | "system"; text: string; time: string };
type Task = { id?: string; title: string; due?: string; priority?: string };
type ConfigValues = {
  mossProjectId: string;
  mossProjectKey: string;
  openRouterApiKey: string;
  openRouterModel: string;
  elevenLabsApiKey: string;
  elevenLabsVoiceId: string;
  elevenLabsModelId: string;
  picovoiceAccessKey: string;
};

const defaultConfig: ConfigValues = {
  mossProjectId: "",
  mossProjectKey: "",
  openRouterApiKey: "",
  openRouterModel: "openai/gpt-4.1-mini",
  elevenLabsApiKey: "",
  elevenLabsVoiceId: "JBFqnCBsd6RMkjVDRZzb",
  elevenLabsModelId: "eleven_multilingual_v2",
  picovoiceAccessKey: "",
};

const initialFeed: FeedItem[] = [
  { id: "sys-1", role: "system", text: "Neural interface online. Local voice models standing by.", time: "SYS" },
  { id: "sys-2", role: "jarvis", text: "Good evening. All local systems are nominal.", time: "00:01" },
];

function nowLabel() {
  return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function shortDue(value?: string) {
  if (!value || value === "unscheduled") return "OPEN";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.toUpperCase();
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }).toUpperCase();
}

async function postJarvis<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/jarvis", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || "Jarvis request failed.");
  return data as T;
}

function HudIcon({ name }: { name: "mic" | "memory" | "task" | "brief" | "settings" }) {
  const paths = {
    mic: <><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/></>,
    memory: <><path d="M8 3v3M16 3v3M8 18v3M16 18v3M3 8h3M18 8h3M3 16h3M18 16h3"/><rect x="6" y="6" width="12" height="12" rx="2"/><circle cx="12" cy="12" r="3"/></>,
    task: <><path d="m5 12 3 3 6-7"/><path d="M14 5h5v14H5v-5"/></>,
    brief: <><path d="M4 19h16M6 16V8l6-4 6 4v8M9 16v-4h6v4"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

export default function JarvisHud() {
  const [coreState, setCoreState] = useState<CoreState>("booting");
  const [sessionId, setSessionId] = useState("");
  const [status, setStatus] = useState("INITIALIZING NEURAL CORE");
  const [clock, setClock] = useState<Date | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>(initialFeed);
  const [query, setQuery] = useState("");
  const [partial, setPartial] = useState("");
  const [tasks, setTasks] = useState<Task[]>([
    { id: "demo-a", title: "Review open project vectors", due: "unscheduled", priority: "normal" },
    { id: "demo-b", title: "Calibrate morning briefing", due: new Date().toISOString(), priority: "high" },
  ]);
  const [memoryDocs, setMemoryDocs] = useState(0);
  const [memoryMs, setMemoryMs] = useState(0);
  const [recalled, setRecalled] = useState(0);
  const [voiceReady, setVoiceReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState<ConfigValues>(defaultConfig);
  const [configLinks, setConfigLinks] = useState({ moss: false, openRouter: false, elevenLabs: false, picovoice: false });
  const [savingConfig, setSavingConfig] = useState(false);
  const [pipeline, setPipeline] = useState([0, 0, 0]);
  const voiceRef = useRef<JarvisVoiceEngine | null>(null);
  const submitRef = useRef<(text: string) => void>(() => undefined);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    setClock(new Date());
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let saved = defaultConfig;
      try {
        const stored = window.localStorage.getItem("jarvis-runtime-config");
        if (stored) saved = { ...defaultConfig, ...(JSON.parse(stored) as Partial<ConfigValues>) };
      } catch {
        // Ignore malformed local configuration and show the empty form.
      }
      setConfig(saved);

      try {
        const statusData = await postJarvis<{ config: { moss: boolean; openRouter: boolean; elevenLabs: boolean } }>({
          action: "status",
          config: saved,
        });
        if (cancelled) return;
        const links = { ...statusData.config, picovoice: Boolean(saved.picovoiceAccessKey || process.env.NEXT_PUBLIC_PICOVOICE_ACCESS_KEY) };
        setConfigLinks(links);
        if (!links.moss) {
          setCoreState("offline");
          setStatus("MOSS CREDENTIALS REQUIRED");
          setSettingsOpen(true);
          return;
        }

        const data = await postJarvis<{ id: string; memoryDocs: number }>({ action: "init", config: saved });
        if (cancelled) return;
        setSessionId(data.id);
        setMemoryDocs(data.memoryDocs);
        setCoreState("idle");
        setStatus("AWAITING VOICE COMMAND");
        setPipeline([100, 100, 100]);
      } catch (error) {
        if (cancelled) return;
        setCoreState("offline");
        setStatus(error instanceof Error ? error.message.toUpperCase() : "CONFIGURATION REQUIRED");
        setSettingsOpen(true);
      }
    })();
    return () => {
      cancelled = true;
      void voiceRef.current?.destroy();
    };
  }, []);

  const stateLabel = useMemo(() => {
    if (coreState === "idle") return voiceReady ? "WAKE LINK ARMED" : "SYSTEM READY";
    return coreState.toUpperCase();
  }, [coreState, voiceReady]);

  const addFeed = useCallback((role: FeedItem["role"], text: string) => {
    setFeed((current) => [
      ...current,
      { id: `${role}-${Date.now()}-${Math.random()}`, role, text, time: nowLabel() },
    ].slice(-12));
  }, []);

  const speak = useCallback(async (text: string) => {
    setCoreState("speaking");
    setStatus("ELEVENLABS VOICE SYNTHESIS");
    try {
      await voiceRef.current?.pause();
      const response = await fetch("/api/jarvis/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error("ElevenLabs unavailable");
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      audioRef.current = audio;
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error("Audio playback failed"));
        void audio.play().catch(reject);
      });
      URL.revokeObjectURL(url);
    } catch {
      if ("speechSynthesis" in window) {
        await new Promise<void>((resolve) => {
          const utterance = new SpeechSynthesisUtterance(text);
          const british = window.speechSynthesis.getVoices().find((voice) => /en-GB/i.test(voice.lang));
          if (british) utterance.voice = british;
          utterance.rate = 0.96;
          utterance.onend = () => resolve();
          utterance.onerror = () => resolve();
          window.speechSynthesis.speak(utterance);
        });
      }
    } finally {
      await voiceRef.current?.resumeWake();
      setCoreState("idle");
      setStatus(voiceReady ? "WAKE WORD CHANNEL ACTIVE" : "AWAITING COMMAND");
    }
  }, [voiceReady]);

  const sendTurn = useCallback(async (text: string) => {
    const cleaned = text.trim();
    if (!cleaned || !sessionId || coreState === "thinking" || coreState === "speaking") return;
    setQuery("");
    setPartial("");
    addFeed("user", cleaned);
    setCoreState("thinking");
    setStatus("QUERYING DUAL MEMORY LAYERS");
    setPipeline([100, 24, 8]);
    try {
      window.setTimeout(() => setPipeline([100, 100, 35]), 260);
      const data = await postJarvis<{
        response: string;
        tasks: Task[];
        memoryMs: number;
        recalled: number;
        persisted: { pushed: number };
      }>({ action: "turn", sessionId, text: cleaned });
      setPipeline([100, 100, 100]);
      setMemoryMs(data.memoryMs);
      setRecalled(data.recalled);
      setMemoryDocs(data.persisted.pushed);
      if (data.tasks.length) {
        setTasks((current) => [...data.tasks.map((task, index) => ({ ...task, id: `new-${Date.now()}-${index}` })), ...current]);
      }
      addFeed("jarvis", data.response);
      await speak(data.response);
    } catch (error) {
      setCoreState("offline");
      setStatus(error instanceof Error ? error.message.toUpperCase() : "CORE REQUEST FAILED");
      addFeed("system", error instanceof Error ? error.message : "Core request failed.");
    }
  }, [addFeed, coreState, sessionId, speak]);

  submitRef.current = (text: string) => void sendTurn(text);

  async function armVoice(andListen = false) {
    try {
      if (!voiceRef.current) {
        const engine = new JarvisVoiceEngine({
          onWake: () => {
            setCoreState("listening");
            setStatus("WAKE SIGNATURE CONFIRMED");
          },
          onPartial: (text) => setPartial(text),
          onUtterance: (text) => submitRef.current(text),
          onError: (message) => {
            setStatus(message.toUpperCase());
            setCoreState("offline");
          },
        });
        await engine.initialize(config.picovoiceAccessKey || process.env.NEXT_PUBLIC_PICOVOICE_ACCESS_KEY || "");
        voiceRef.current = engine;
      }
      setVoiceReady(true);
      setCoreState(andListen ? "listening" : "idle");
      setStatus(andListen ? "LISTENING FOR COMMAND" : "SAY JARVIS TO BEGIN");
      if (andListen) await voiceRef.current.listenOnce();
    } catch (error) {
      setCoreState("offline");
      setStatus(error instanceof Error ? error.message.toUpperCase() : "VOICE LINK FAILED");
      setSettingsOpen(true);
    }
  }

  function updateConfig(key: keyof ConfigValues, value: string) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  async function saveConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingConfig(true);
    setCoreState("booting");
    setStatus("VALIDATING SECURE CONNECTIONS");
    try {
      window.localStorage.setItem("jarvis-runtime-config", JSON.stringify(config));
      const data = await postJarvis<{
        id: string;
        memoryDocs: number;
        config: { moss: boolean; openRouter: boolean; elevenLabs: boolean };
      }>({ action: "init", config });
      setSessionId(data.id);
      setMemoryDocs(data.memoryDocs);
      setConfigLinks({ ...data.config, picovoice: Boolean(config.picovoiceAccessKey || process.env.NEXT_PUBLIC_PICOVOICE_ACCESS_KEY) });
      setPipeline([100, 100, 100]);
      setCoreState("idle");
      setStatus("CORE CONFIGURATION ACCEPTED");
      setSettingsOpen(false);
      addFeed("system", "Credentials accepted. Neural core and second brain are online.");
    } catch (error) {
      setCoreState("offline");
      setStatus(error instanceof Error ? error.message.toUpperCase() : "CREDENTIAL VALIDATION FAILED");
    } finally {
      setSavingConfig(false);
    }
  }

  async function requestBriefing() {
    if (!sessionId) return;
    setCoreState("thinking");
    setStatus("ASSEMBLING DAILY BRIEFING");
    try {
      const data = await postJarvis<{ briefing: string; tasks: Task[] }>({ action: "briefing", sessionId });
      setTasks(data.tasks);
      addFeed("jarvis", data.briefing);
      await speak(data.briefing);
    } catch (error) {
      setCoreState("offline");
      setStatus(error instanceof Error ? error.message.toUpperCase() : "BRIEFING FAILED");
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void sendTurn(query);
  }

  async function windowAction(action: "minimize" | "close") {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const windowHandle = getCurrentWindow();
      if (action === "minimize") await windowHandle.minimize();
      else await windowHandle.close();
    } catch {
      if (action === "close") window.close();
    }
  }

  return (
    <main className={`hud-shell state-${coreState}`}>
      <div className="noise" />
      <div className="scanline" />

      <header className="topbar" data-tauri-drag-region>
        <div className="brand-lockup" data-tauri-drag-region>
          <span className="brand-mark"><i /><i /><i /></span>
          <div><strong>J.A.R.V.I.S.</strong><small>JUST A RATHER VERY INTELLIGENT SYSTEM</small></div>
        </div>
        <div className="top-telemetry" data-tauri-drag-region>
          <span>CORE <b>{coreState === "offline" ? "DEGRADED" : "NOMINAL"}</b></span>
          <span>MEM <b>{memoryDocs.toString().padStart(4, "0")}</b></span>
          <span>LINK <b>{voiceReady ? "VOICE" : "TEXT"}</b></span>
        </div>
        <div className="window-controls">
          <button onClick={() => void windowAction("minimize")} aria-label="Minimize">—</button>
          <button onClick={() => setSettingsOpen(true)} aria-label="Settings">⌬</button>
          <button onClick={() => void windowAction("close")} aria-label="Close">×</button>
        </div>
      </header>

      <div className="hud-grid">
        <aside className="left-rail">
          <section className="readout-panel identity-panel">
            <div className="section-tag">SYS // IDENTITY</div>
            <div className="user-glyph"><span>SK</span><i /></div>
            <p>PRIMARY OPERATOR</p><strong>SANJEEV KUMAR</strong>
            <div className="security-line"><span /><span /><span /><span /><span /></div>
            <small>BIOMETRIC LINK // VERIFIED</small>
          </section>

          <section className="readout-panel system-panel">
            <div className="section-tag">SYSTEM DIAGNOSTICS</div>
            <RadialGauge value={coreState === "thinking" ? 82 : 36} label="NEURAL LOAD" />
            <Metric label="MOSS LATENCY" value={memoryMs ? `${memoryMs.toFixed(1)} MS` : "STANDBY"} width={memoryMs ? 92 : 28} />
            <Metric label="MEMORY RECALL" value={`${recalled} VECTORS`} width={Math.min(100, recalled * 9)} />
            <Metric label="VOICE MATRIX" value={voiceReady ? "ARMED" : "LOCAL"} width={voiceReady ? 100 : 42} />
          </section>

          <nav className="quick-actions">
            <button className={voiceReady ? "active" : ""} onClick={() => void armVoice(false)}><HudIcon name="mic"/><span>ARM VOICE</span></button>
            <button onClick={() => void requestBriefing()}><HudIcon name="brief"/><span>BRIEFING</span></button>
            <button onClick={() => setSettingsOpen(true)}><HudIcon name="settings"/><span>CONFIG</span></button>
          </nav>
        </aside>

        <section className="core-stage">
          <div className="coordinate x" /><div className="coordinate y" />
          <div className="target-brackets"><i/><i/><i/><i/></div>
          <button className="reactor" onClick={() => void armVoice(true)} aria-label="Activate voice input">
            <span className="orbit orbit-a"><i/><i/><i/></span>
            <span className="orbit orbit-b" />
            <span className="orbit orbit-c" />
            <span className="radar-sweep" />
            <span className="core-disc">
              <span className="core-hex"><b>J</b></span>
              <em>{stateLabel}</em>
              <small>{coreState === "listening" ? "VOICE CHANNEL 01" : "ARC REACTOR // MK VII"}</small>
            </span>
            <span className="tick-ring" />
          </button>

          <div className="state-caption">
            <span className="live-dot" />
            <strong>{status}</strong>
            <small>{coreState === "offline" ? "OPEN CONFIGURATION TO COMPLETE LINK" : "CLICK CORE OR SAY “JARVIS”"}</small>
          </div>

          <div className="pipeline-readout">
            {[
              ["AUDIO IN", pipeline[0]], ["MEMORY", pipeline[1]], ["RESPONSE", pipeline[2]],
            ].map(([label, value]) => (
              <div key={String(label)}><span>{label}</span><i style={{ "--progress": `${value}%` } as React.CSSProperties}/><b>{value}%</b></div>
            ))}
          </div>
        </section>

        <aside className="right-rail">
          <section className="time-panel">
            <div className="section-tag">CHRONOLOGY // LOCAL</div>
            <strong>{clock ? clock.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "--:--:--"}</strong>
            <span>{clock ? clock.toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).toUpperCase() : "TIME LINK ACQUIRING"}</span>
          </section>

          <section className="task-panel">
            <div className="panel-title"><span><HudIcon name="task"/>TASK MATRIX</span><b>{tasks.length.toString().padStart(2, "0")}</b></div>
            <div className="task-list">
              {tasks.length === 0 ? <p className="empty-state">NO OPEN COMMITMENTS</p> : tasks.slice(0, 5).map((task, index) => (
                <article key={task.id || `${task.title}-${index}`}>
                  <span className={`priority priority-${task.priority || "normal"}`} />
                  <div><strong>{task.title}</strong><small>{task.priority?.toUpperCase() || "NORMAL PRIORITY"}</small></div>
                  <time>{shortDue(task.due)}</time>
                </article>
              ))}
            </div>
            <button className="outline-button" onClick={() => void requestBriefing()}>GENERATE MORNING BRIEFING <span>↗</span></button>
          </section>

          <section className="memory-panel">
            <div className="panel-title"><span><HudIcon name="memory"/>SECOND BRAIN</span><b>SYNC</b></div>
            <div className="memory-graphic"><i/><i/><i/><i/><b>{memoryDocs}</b><small>DOCUMENTS</small></div>
            <div className="memory-stats"><span>WORKING <b>LOCAL</b></span><span>LONG-TERM <b>CLOUD</b></span></div>
          </section>
        </aside>
      </div>

      <section className="transcript-console">
        <div className="console-heading"><span>LIVE TRANSCRIPT // TELEMETRY FEED</span><b>{partial ? "RECEIVING" : "CHANNEL OPEN"}</b></div>
        <div className="feed-lines">
          {feed.slice(-4).map((item) => (
            <p key={item.id} className={item.role}><time>{item.time}</time><strong>{item.role === "jarvis" ? "JARVIS" : item.role === "user" ? "OPERATOR" : "SYSTEM"}</strong><span>{item.text}</span></p>
          ))}
          {partial && <p className="user live"><time>LIVE</time><strong>OPERATOR</strong><span>{partial}<i /></span></p>}
        </div>
        <form onSubmit={submit}>
          <span className="prompt-mark">›_</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ENTER DIRECTIVE OR CLICK THE ARC CORE TO SPEAK..." disabled={!sessionId}/>
          <button disabled={!query.trim() || !sessionId}>TRANSMIT</button>
        </form>
      </section>

      {settingsOpen && (
        <div className="modal-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <section className="config-modal" onMouseDown={(event) => event.stopPropagation()}>
            <div className="panel-title"><span><HudIcon name="settings"/>SYSTEM CONFIGURATION</span><button onClick={() => setSettingsOpen(false)}>×</button></div>
            <p>Credentials are stored only in this browser and transmitted to your local Jarvis server. Password fields remain masked.</p>
            <form className="config-form" onSubmit={saveConfiguration}>
              <ConfigGroup title="MOSS // PERSISTENT MEMORY" ready={configLinks.moss}>
                <ConfigField label="PROJECT ID" value={config.mossProjectId} onChange={(value) => updateConfig("mossProjectId", value)} placeholder="Moss project ID" />
                <ConfigField secret label="PROJECT KEY" value={config.mossProjectKey} onChange={(value) => updateConfig("mossProjectKey", value)} placeholder="Moss project key" />
              </ConfigGroup>

              <ConfigGroup title="OPENROUTER // REASONING" ready={configLinks.openRouter}>
                <ConfigField secret label="API KEY" value={config.openRouterApiKey} onChange={(value) => updateConfig("openRouterApiKey", value)} placeholder={configLinks.openRouter ? "Already linked — leave blank to keep" : "sk-or-v1-..."} />
                <ConfigField label="MODEL" value={config.openRouterModel} onChange={(value) => updateConfig("openRouterModel", value)} placeholder="openai/gpt-4.1-mini" />
              </ConfigGroup>

              <ConfigGroup title="ELEVENLABS // VOICE" ready={configLinks.elevenLabs}>
                <ConfigField secret label="API KEY" value={config.elevenLabsApiKey} onChange={(value) => updateConfig("elevenLabsApiKey", value)} placeholder="ElevenLabs API key" />
                <ConfigField label="VOICE ID" value={config.elevenLabsVoiceId} onChange={(value) => updateConfig("elevenLabsVoiceId", value)} placeholder="George (British) voice ID" />
              </ConfigGroup>

              <ConfigGroup title="PICOVOICE // WAKE + STT" ready={configLinks.picovoice} single>
                <ConfigField secret label="ACCESS KEY" value={config.picovoiceAccessKey} onChange={(value) => updateConfig("picovoiceAccessKey", value)} placeholder="Picovoice AccessKey" />
              </ConfigGroup>

              <button className="save-config" type="submit" disabled={savingConfig}>
                {savingConfig ? "VALIDATING CONNECTIONS..." : "SAVE KEYS & INITIALIZE CORE"}
              </button>
            </form>
          </section>
        </div>
      )}
    </main>
  );
}

function Metric({ label, value, width }: { label: string; value: string; width: number }) {
  return <div className="metric"><div><span>{label}</span><b>{value}</b></div><i><span style={{ width: `${width}%` }}/></i></div>;
}

function RadialGauge({ value, label }: { value: number; label: string }) {
  return <div className="radial-gauge" style={{ "--gauge": `${value * 3.6}deg` } as React.CSSProperties}><div><strong>{value}</strong><span>%</span><small>{label}</small></div></div>;
}

function ConfigGroup({
  title,
  ready,
  single = false,
  children,
}: {
  title: string;
  ready: boolean;
  single?: boolean;
  children: React.ReactNode;
}) {
  return (
    <fieldset className={single ? "config-group single" : "config-group"}>
      <legend><span>{title}</span><b className={ready ? "ready" : "pending"}>{ready ? "LINKED" : "PENDING"}</b></legend>
      <div className="config-grid">{children}</div>
    </fieldset>
  );
}

function ConfigField({
  label,
  value,
  placeholder,
  secret = false,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  secret?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="config-field">
      <span>{label}</span>
      <input
        type={secret ? "password" : "text"}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  );
}
