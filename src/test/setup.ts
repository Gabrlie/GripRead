import { afterEach } from "vitest";

// Tests read the interface in 简体中文, whatever the machine's language.
if (typeof navigator !== "undefined") {
  Object.defineProperty(navigator, "language", { value: "zh-CN", configurable: true });
  Object.defineProperty(navigator, "languages", { value: ["zh-CN"], configurable: true });
}

// Loaded after the language is set, as the interface reads it once.
const { resetToasts } = await import("../components/ui/toast");
// A message left by one test does not show in the next.
afterEach(() => resetToasts());
