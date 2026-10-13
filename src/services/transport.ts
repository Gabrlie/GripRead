import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen as listenNative } from "@tauri-apps/api/event";

/** The app (Tauri), or the web version served by the GripRead server. */
export const native = isTauri();

/** The Android app, whose pickers and "save as" screens are its own. */
export function androidApp(): boolean {
  return native && /Android/i.test(navigator.userAgent);
}

/** A failure the server reports, shaped like the core's `AppError`. */
export interface TransportError {
  code: string;
  message: string;
}

/** Called when the server says the page is not signed in. */
let signedOut: () => void = () => undefined;

export function onSignedOut(listener: () => void): void {
  signedOut = listener;
}

async function failure(response: Response): Promise<TransportError> {
  try {
    const body = (await response.json()) as Partial<TransportError>;
    return { code: body.code ?? "io", message: body.message ?? response.statusText };
  } catch {
    return { code: "io", message: `${response.status} ${response.statusText}` };
  }
}

/**
 * Runs a core command (`crates/core/src/api.rs`) by name with the page's
 * arguments (`{ request }` or nothing): through the app's one `rpc` command,
 * or `POST /api/rpc/{name}` on the server. Byte replies arrive as an
 * `ArrayBuffer`.
 */
export async function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (native) return invoke<T>("rpc", { name, args: args ?? null });
  const response = await fetch(`/api/rpc/${name}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: args === undefined ? undefined : JSON.stringify(args),
  });
  if (!response.ok) {
    const error = await failure(response);
    if (response.status === 401) signedOut();
    throw error;
  }
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return (await response.json()) as T;
  return (await response.arrayBuffer()) as T;
}

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();
let socket: WebSocket | null = null;
let retry = 0;

/** One WebSocket to `/api/events` for every listener, reconnecting with backoff. */
function connect(): void {
  if (socket || handlers.size === 0) return;
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const opened = new WebSocket(`${scheme}//${location.host}/api/events`);
  socket = opened;
  opened.onopen = () => {
    retry = 0;
  };
  opened.onmessage = (message) => {
    try {
      const { event, payload } = JSON.parse(String(message.data)) as {
        event: string;
        payload: unknown;
      };
      handlers.get(event)?.forEach((handler) => handler(payload));
    } catch {
      // A malformed message is skipped; the next one still arrives.
    }
  };
  opened.onclose = () => {
    socket = null;
    if (handlers.size === 0) return;
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * 2 ** retry);
  };
}

/** Listens to a core event (`import-progress`, `download-progress`, …). */
export async function listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (native) return listenNative<T>(event, (message) => handler(message.payload));
  const wrapped = handler as Handler;
  const set = handlers.get(event) ?? new Set<Handler>();
  set.add(wrapped);
  handlers.set(event, set);
  connect();
  return () => {
    set.delete(wrapped);
    if (set.size === 0) handlers.delete(event);
    if (handlers.size === 0) socket?.close();
  };
}
