/**
 * Text-to-speech for read-aloud: the Android TextToSpeech bridge in
 * MainActivity.kt, or the Web Speech API on desktop WebViews and browsers.
 */
export interface SpeechItem {
  id: string;
  text: string;
}

export interface SpeechOptions {
  rate: number;
  pitch: number;
  voice: string | null;
}

/**
 * Progress of a queued item. `range` reports the UTF-16 range of its text
 * being spoken, where the engine supports it.
 */
export type SpeechEvent =
  | { type: "start" | "done" | "error"; id: string }
  | { type: "range"; id: string; start: number; end: number };

/** `pending` until the engine has started, `unavailable` without one. */
export type SpeechStatus = "pending" | "ready" | "unavailable";

export interface SpeechVoice {
  name: string;
  label: string;
}

export interface SpeechEngine {
  available(): boolean;
  status(): SpeechStatus;
  /** Opens the system speech settings, where the platform has them. */
  openSettings?: () => void;
  /** Queues items in order; `flush` first drops anything still queued. */
  speak(items: SpeechItem[], options: SpeechOptions, flush: boolean): void;
  stop(): void;
  voices(): Promise<SpeechVoice[]>;
  onEvent(listener: (event: SpeechEvent) => void): () => void;
}

interface AndroidSpeechBridge {
  prepare(): void;
  ready(): boolean;
  status?(): string;
  openSettings?(): void;
  speak(items: string, rate: number, pitch: number, voice: string, flush: boolean): void;
  stop(): void;
  voices(): string;
}

function androidBridge(): AndroidSpeechBridge | undefined {
  return (window as Window & { GripReadTts?: AndroidSpeechBridge }).GripReadTts;
}

function androidEngine(bridge: AndroidSpeechBridge): SpeechEngine {
  bridge.prepare();
  const whenReady = () =>
    new Promise<void>((resolve) => {
      if (bridge.ready()) return resolve();
      const handle = (event: Event) => {
        const type = (event as CustomEvent<SpeechEvent | { type: string }>).detail?.type;
        if (type !== "ready" && type !== "unavailable") return;
        window.removeEventListener("gripread-tts", handle);
        resolve();
      };
      window.addEventListener("gripread-tts", handle);
    });
  const status = (): SpeechStatus => {
    const value = bridge.status?.() ?? (bridge.ready() ? "ready" : "pending");
    return value === "ready" || value === "unavailable" ? value : "pending";
  };
  return {
    available: () => status() !== "unavailable",
    status,
    openSettings: bridge.openSettings && (() => bridge.openSettings?.()),
    speak: (items, options, flush) =>
      void whenReady().then(() =>
        bridge.speak(
          JSON.stringify(items),
          options.rate,
          options.pitch,
          options.voice ?? "",
          flush,
        ),
      ),
    stop: () => bridge.stop(),
    voices: async () => {
      await whenReady();
      try {
        return JSON.parse(bridge.voices()) as SpeechVoice[];
      } catch {
        return [];
      }
    },
    onEvent: (listener) => {
      const handle = (event: Event) => {
        const detail = (event as CustomEvent<SpeechEvent>).detail;
        if (!detail) return;
        if (detail.type === "range") {
          if (detail.start >= 0) listener(detail);
        } else if (detail.type === "start" || detail.type === "done" || detail.type === "error")
          listener({ type: detail.type, id: detail.id });
      };
      window.addEventListener("gripread-tts", handle);
      return () => window.removeEventListener("gripread-tts", handle);
    },
  };
}

function webEngine(): SpeechEngine {
  const synthesis = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  const listeners = new Set<(event: SpeechEvent) => void>();
  const emit = (event: SpeechEvent) => listeners.forEach((listener) => listener(event));
  let generation = 0;
  return {
    available: () => Boolean(synthesis),
    status: () => (synthesis ? "ready" : "unavailable"),
    speak: (items, options, flush) => {
      if (!synthesis) return;
      if (flush) {
        generation += 1;
        synthesis.cancel();
      }
      const current = generation;
      const voice = synthesis.getVoices().find((item) => item.name === options.voice);
      for (const item of items) {
        const utterance = new SpeechSynthesisUtterance(item.text);
        utterance.rate = options.rate;
        utterance.pitch = options.pitch;
        if (voice) utterance.voice = voice;
        // Cancelled utterances still report; only the live queue counts.
        utterance.onstart = () => current === generation && emit({ type: "start", id: item.id });
        utterance.onend = () => current === generation && emit({ type: "done", id: item.id });
        utterance.onerror = () => current === generation && emit({ type: "error", id: item.id });
        utterance.onboundary = (event) =>
          current === generation &&
          emit({
            type: "range",
            id: item.id,
            start: event.charIndex,
            end: event.charIndex + Math.max(1, event.charLength ?? 1),
          });
        synthesis.speak(utterance);
      }
    },
    stop: () => {
      generation += 1;
      synthesis?.cancel();
    },
    voices: async () =>
      (synthesis?.getVoices() ?? []).map((voice) => ({
        name: voice.name,
        label: `${voice.lang} · ${voice.name}`,
      })),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let engine: SpeechEngine | null = null;

/** The device's speech engine, created on first use. */
export function speechEngine(): SpeechEngine {
  if (!engine) {
    const bridge = androidBridge();
    engine = bridge ? androidEngine(bridge) : webEngine();
  }
  return engine;
}
