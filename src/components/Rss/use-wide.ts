import { useEffect, useState } from "react";

const WIDE = "(min-width: 768px)";

/** Whether the screen is wide enough for 订阅's three columns (Tailwind `md`). */
export function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia?.(WIDE).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(WIDE);
    if (!media) return;
    const change = () => setWide(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return wide;
}
