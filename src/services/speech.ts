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

export type SpeechEvent = { type: "start" | "done" | "error"; id: string };

export interface SpeechVoice {
  name: string;
  label: string;
}

export interface SpeechEngine {
  available(): boolean;
  /** Queues items in order; `flush` first drops anything still queued. */
  speak(items: SpeechItem[], options: SpeechOptions, flush: boolean): void;
  stop(): void;
  voices(): Promise<SpeechVoice[]>;
  onEvent(listener: (event: SpeechEvent) => void): () => void;
}

interface AndroidSpeechBridge {
  prepare(): void;
  ready(): boolean;
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
  return {
    available: () => true,
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
        if (
          detail &&
          (detail.type === "start" || detail.type === "done" || detail.type === "error")
        )
          listener(detail);
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
