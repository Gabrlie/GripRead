import { vi } from "vitest";
import type { UpdateService } from "../services/contracts";
import type { UpdateCheck, UpdateSettings } from "../types/generated";

export function updateSettings(overrides: Partial<UpdateSettings> = {}): UpdateSettings {
  return { channel: "stable", autoCheck: true, lastCheck: null, skipped: null, ...overrides };
}

export function noUpdate(current = "0.2.1"): UpdateCheck {
  return { kind: "android", current, update: null, releases: [], viaServer: false };
}

export function updateServiceMocks(overrides: Partial<UpdateService> = {}): UpdateService {
  return {
    getSettings: vi.fn(async () => updateSettings()),
    saveSettings: vi.fn(async (request) => updateSettings({ ...request })),
    check: vi.fn(async (current: string) => noUpdate(current)),
    install: vi.fn(async () => "started" as const),
    cancel: vi.fn(async () => ({ requested: true })),
    onProgress: vi.fn(async () => () => undefined),
    ...overrides,
  };
}
