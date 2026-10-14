import { call, native, type TransportError } from "./transport";

/** Whether the server has its password, and whether this page is signed in. */
export interface ServerStatus {
  configured: boolean;
  signedIn: boolean;
  device?: string | null;
}

/** A signed-in device or browser (设备管理). */
export interface ServerSession {
  id: string;
  device: string;
  createdAt: number;
  lastSeen: number;
  current: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // The app reaches its connected server through the core, with its session.
  if (native) {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    const reply = await call<T | null>("server_api", {
      request: { method: init?.method ?? "GET", path, body },
    });
    return reply as T;
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    let error: TransportError = { code: "io", message: `${response.status}` };
    try {
      error = (await response.json()) as TransportError;
    } catch {
      // Keep the status as the message.
    }
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** 定时追更 (`crates/server/src/jobs.rs`). */
export interface JobSettings {
  /** Hours between updates; 0 turns them off. */
  intervalHours: number;
  /** New chapters of each book fetched ahead. */
  prefetch: number;
  /** Minutes between 订阅 refreshes; 0 turns them off. Older servers lack it. */
  rssIntervalMinutes?: number;
}

export interface JobStatus {
  running: boolean;
  lastRun: number | null;
  nextRun: number | null;
  updated: number;
  newChapters: number;
  failed: number;
}

/** A short name for this browser, shown in 设备管理. */
export function browserName(): string {
  const agent = navigator.userAgent;
  const system = /Android/i.test(agent)
    ? "Android"
    : /iPhone|iPad/i.test(agent)
      ? "iOS"
      : /Mac OS/i.test(agent)
        ? "macOS"
        : /Windows/i.test(agent)
          ? "Windows"
          : "Linux";
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "浏览器";
  return `${browser} · ${system}`;
}

/** The server's account API (`crates/server/src/auth.rs`), for the web version. */
export const serverAccount = {
  status: () => request<ServerStatus>("/api/auth/status"),
  setup: (password: string) =>
    request<{ token: string }>("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ password, device: browserName() }),
    }),
  login: (password: string) =>
    request<{ token: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password, device: browserName() }),
    }),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  sessions: () => request<ServerSession[]>("/api/auth/sessions"),
  revoke: (id: string) =>
    request<void>(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  changePassword: (current: string, next: string) =>
    request<void>("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ current, next }),
    }),
  jobs: () => request<{ settings: JobSettings; status: JobStatus }>("/api/jobs"),
  saveJobs: (settings: JobSettings) =>
    request<JobSettings>("/api/jobs", { method: "PUT", body: JSON.stringify(settings) }),
  updateNow: () => request<unknown>("/api/jobs/update", { method: "POST", body: "{}" }),
};
