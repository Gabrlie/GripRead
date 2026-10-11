import { describe, expect, it } from "vitest";
import { defaultDeviceName } from "./device";

describe("default device name", () => {
  it("uses the phone model, or the platform when the model is hidden", () => {
    expect(
      defaultDeviceName(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36",
      ),
    ).toBe("Pixel 8");
    expect(defaultDeviceName("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36")).toBe(
      "Android 设备",
    );
    expect(defaultDeviceName("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Linux 电脑");
  });
});
