// Tests read the interface in 简体中文, whatever the machine's language.
if (typeof navigator !== "undefined") {
  Object.defineProperty(navigator, "language", { value: "zh-CN", configurable: true });
  Object.defineProperty(navigator, "languages", { value: ["zh-CN"], configurable: true });
}
