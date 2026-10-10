/**
 * Reader-only platform controls from the Android bridge in MainActivity.kt.
 * Each call does nothing where the bridge is absent (desktop, browser preview).
 */
interface SystemBridge {
  setVolumeKeys(enabled: boolean): void;
  setKeepScreenOn(enabled: boolean): void;
  setSystemBarsHidden(hidden: boolean): void;
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
