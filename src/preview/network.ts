import type { NetworkSettings } from "../types/generated";

/** Network settings as a fresh device has them. */
export const PREVIEW_NETWORK: NetworkSettings = {
  dohEnabled: false,
  dohServer: "ali",
  dohCustomUrl: "",
  dohBootstrap: "",
  proxyKind: "none",
  proxyHost: "",
  proxyPort: 1080,
  proxyUsername: "",
  proxyPassword: "",
  preset: "balanced",
  custom: {
    requests: 12,
    perHost: 6,
    windowMs: 1000,
    search: 8,
    downloadBooks: 2,
    downloadChapters: 4,
  },
};
