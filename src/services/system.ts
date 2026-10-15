import { t } from "../i18n";
/**
 * Reader-only platform controls from the Android bridge in MainActivity.kt.
 * Each call does nothing where the bridge is absent (desktop, browser preview).
 */
interface SystemBridge {
  setVolumeKeys(enabled: boolean): void;
  setKeepScreenOn(enabled: boolean): void;
  setSystemBarsHidden(hidden: boolean): void;
  setSelectionMenu(enabled: boolean): void;
  setBrightness(value: number): void;
  /** Absent in builds before 0.2.1-beta.2. */
  getBrightness?(): number;
  setOrientation(orientation: string): void;
  share(text: string): void;
  battery(): number;
}

function bridge(): SystemBridge | undefined {
  return (window as Window & { GripReadSystem?: SystemBridge }).GripReadSystem;
}

export const system = {
  /** Whether native platform controls exist on this device. */
  available: () => bridge() !== undefined,
  setVolumeKeys: (enabled: boolean) => bridge()?.setVolumeKeys(enabled),
  setKeepScreenOn: (enabled: boolean) => bridge()?.setKeepScreenOn(enabled),
  setSystemBarsHidden: (hidden: boolean) => bridge()?.setSystemBarsHidden(hidden),
  /** Hides the WebView's own selection toolbar while the reader shows its menu. */
  setSelectionMenu: (enabled: boolean) => bridge()?.setSelectionMenu(enabled),
  /** Window brightness 0–1, or `null` to follow the system. */
  setBrightness: (value: number | null) => bridge()?.setBrightness(value ?? -1),
  /** The brightness shown now (the reader's own, else the system's), 0–1. */
  getBrightness: (): number | null => {
    const value = bridge()?.getBrightness?.();
    return value === undefined || !Number.isFinite(value) ? null : value;
  },
  /** The system brightness changed (by hand or automatically); 0–1. */
  onBrightness: (listener: (value: number) => void) => {
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (typeof detail === "number") listener(detail);
    };
    window.addEventListener("gripread-brightness", handle);
    return () => window.removeEventListener("gripread-brightness", handle);
  },
  setOrientation: (orientation: "auto" | "portrait" | "landscape") =>
    bridge()?.setOrientation(orientation),
  /** Shares text through the system sheet; elsewhere uses the Web Share API or copies it. */
  share: async (text: string): Promise<"shared" | "copied"> => {
    const native = bridge();
    if (native) {
      native.share(text);
      return "shared";
    }
    if (navigator.share) {
      await navigator.share({ text });
      return "shared";
    }
    await copyText(text);
    return "copied";
  },
  /** Battery level 0–100, or `null` when unknown. */
  battery: (): number | null => {
    const level = bridge()?.battery();
    return level === undefined || level < 0 ? null : level;
  },
  /** Volume keys pressed while enabled; returns an unsubscribe function. */
  onVolumeKey: (listener: (direction: "next" | "previous") => void) => {
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (detail === "next" || detail === "previous") listener(detail);
    };
    window.addEventListener("gripread-volume-key", handle);
    return () => window.removeEventListener("gripread-volume-key", handle);
  },
};

/** Copies text; falls back to a temporary selection where the Clipboard API is unavailable. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Insecure contexts and some WebViews have no asynchronous clipboard.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error(t("system.copyFailed"));
}
