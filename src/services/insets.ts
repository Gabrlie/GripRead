/** Native bridge installed by MainActivity.kt; absent outside Android. */
interface InsetsBridge {
  get(): string;
}

const SIDES = ["top", "right", "bottom", "left"] as const;

/**
 * Publishes system bar and cutout insets as `--safe-*` CSS variables. The
 * stylesheet falls back to `env(safe-area-inset-*)` when no bridge exists.
 */
export function applySystemInsets(target: Window = window): () => void {
  const bridge = (target as Window & { GripReadInsets?: InsetsBridge }).GripReadInsets;
  if (!bridge) return () => undefined;
  const apply = () => {
    let insets: unknown;
    try {
      insets = JSON.parse(bridge.get());
    } catch (error) {
      console.error("Invalid system insets", error);
      return;
    }
    const style = target.document.documentElement.style;
    for (const side of SIDES) {
      const value = (insets as Record<string, unknown> | null)?.[side];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        style.setProperty(`--safe-${side}`, `${value}px`);
    }
  };
  apply();
  target.addEventListener("gripread-insets", apply);
  target.addEventListener("resize", apply);
  return () => {
    target.removeEventListener("gripread-insets", apply);
    target.removeEventListener("resize", apply);
  };
}
