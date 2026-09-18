import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { browser, expect } from "@wdio/globals";
import type {
  ContentWindow,
  ImportPhase,
  ImportResult,
  ImportStatus,
  ImportTask,
  LibraryBook,
  ReaderPreferences,
} from "../../src/types/generated";

const execFileAsync = promisify(execFile);

const configuredTestTimeout = Number(process.env.GRIPREAD_NATIVE_ASSERT_TIMEOUT_MS);
export const TEST_TIMEOUT =
  Number.isSafeInteger(configuredTestTimeout) && configuredTestTimeout > 0
    ? configuredTestTimeout
    : 90_000;
export const WINDOW_UNITS = 1_800;
export const LARGE_WINDOW_UNITS = 16_384;

export interface NativeError {
  code: string;
  message: string;
}

export interface PageSnapshot {
  bookId: string;
  start: number;
  end: number;
  total: number;
  text: string;
  rectCount: number;
  overflowHeight: number;
  clientHeight: number;
}

export function fixturePath(name: string): string {
  const directory = process.env.GRIPREAD_NATIVE_FIXTURE_DIR;
  if (!directory) {
    throw new Error("GRIPREAD_NATIVE_FIXTURE_DIR is required");
  }
  return `${directory}/${name}`;
}

export function dataPath(name: string): string {
  const directory = process.env.GRIPREAD_TEST_DATA_DIR;
  if (!directory) {
    throw new Error("GRIPREAD_TEST_DATA_DIR is required");
  }
  return `${directory}/${name}`;
}

export async function waitForFile(path: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    {
      timeout: TEST_TIMEOUT,
      interval: 50,
      timeoutMsg: `Expected native marker ${path}`,
    },
  );
}

export async function normalizedFixture(name: string): Promise<string> {
  const bytes = await readFile(fixturePath(name), "utf8");
  return bytes.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/**
 * Execute a real Tauri command through the WDIO plugin. The macOS system file
 * picker is outside embedded WebDriver control, so this is deliberately the
 * only test bypass for selecting a fixture path; the command itself, storage,
 * import journal, and reader service remain the production IPC path.
 */
export async function invoke<T>(command: string, args?: unknown): Promise<T> {
  return browser.tauri.execute(
    ({ core }, payload) => {
      const request = payload as { command: string; args?: Record<string, unknown> };
      if (request.args === undefined) {
        return core.invoke(request.command);
      }
      return core.invoke(request.command, request.args);
    },
    { command, args: args as Record<string, unknown> | undefined },
  ) as Promise<T>;
}

export function errorFromUnknown(value: unknown): NativeError {
  if (isRecord(value)) {
    const directCode = value.code;
    const directMessage = value.message;
    if (typeof directCode === "string" && typeof directMessage === "string") {
      return { code: directCode, message: directMessage };
    }
    if (directMessage !== undefined) {
      const nested = errorFromUnknown(directMessage);
      if (nested.code !== "io" || nested.message !== String(directMessage)) {
        return nested;
      }
    }
  }

  const message = value instanceof Error ? value.message : String(value);
  const serialized = tryParseRecord(message);
  if (serialized) {
    return errorFromUnknown(serialized);
  }

  const prefixed = message.match(/(?:^|\s)([a-z][a-z0-9_]*)\s*:\s*(.+)$/i);
  if (prefixed) {
    return { code: prefixed[1], message: prefixed[2] };
  }
  return { code: "io", message };
}

export async function expectInvokeError(command: string, args: unknown): Promise<NativeError> {
  try {
    await invoke(command, args);
  } catch (error: unknown) {
    return errorFromUnknown(error);
  }
  throw new Error(`Expected Tauri command ${command} to fail`);
}

export async function waitForAppReady(): Promise<void> {
  const marker = await browser.$('[data-testid="app-ready"]');
  await marker.waitForExist({ timeout: TEST_TIMEOUT });
  await marker.waitForDisplayed({ timeout: TEST_TIMEOUT });
}

export async function useInstantPageTurns(): Promise<void> {
  // The normal acceptance run keeps navigation deterministic in embedded
  // WebKit. Set this flag for a separate animated adapter run.
  if (process.env.GRIPREAD_NATIVE_ANIMATED === "1") return;
  const settings = await invoke<ReaderPreferences>("get_settings");
  if (settings.pageTurnEffect === "instant") return;
  await invoke("save_settings", {
    request: { settings: { ...settings, pageTurnEffect: "instant" } },
  });
  await browser.refresh();
  await waitForAppReady();
}

export async function waitForImport(operationId: string): Promise<ImportStatus> {
  let status: ImportStatus | undefined;
  await browser.waitUntil(
    async () => {
      status = await invoke<ImportStatus>("get_import_status", {
        request: { operationId },
      });
      return (["completed", "failed", "cancelled"] as ImportPhase[]).includes(status.phase);
    },
    {
      timeout: TEST_TIMEOUT,
      interval: 100,
      timeoutMsg: `Import ${operationId} did not reach a terminal state`,
    },
  );
  if (!status) {
    throw new Error(`Import ${operationId} produced no status`);
  }
  return status;
}

export async function importFixture(name: string): Promise<ImportResult> {
  const task = await invoke<ImportTask>("start_import", {
    request: { path: fixturePath(name) },
  });
  const status = await waitForImport(task.operationId);
  if (status.phase !== "completed" || !status.result) {
    throw new Error(
      `Import ${name} failed: ${status.error?.code ?? "unknown"} ${status.error?.message ?? "no error"}`,
    );
  }
  return status.result;
}

export async function refreshLibraryInUi(bookId: string): Promise<void> {
  const menu = await browser.$('button[aria-label="更多选项"]');
  await menu.waitForExist({ timeout: TEST_TIMEOUT });
  await menu.click();
  const items = await browser.$$('[role="menuitem"]');
  let refresh: WebdriverIO.Element | undefined;
  for (const item of items) {
    if ((await item.getText()).includes("刷新书架")) {
      refresh = item;
      break;
    }
  }
  if (!refresh) throw new Error("刷新书架 menu item is not present");
  await refresh.click();
  const card = await browser.$(`[data-testid="library-book-${bookId}"]`);
  await card.waitForExist({ timeout: TEST_TIMEOUT });
  await card.waitForDisplayed({ timeout: TEST_TIMEOUT });
}

export async function listBooks(): Promise<LibraryBook[]> {
  return invoke<LibraryBook[]>("list_books");
}

export async function openBook(bookId: string): Promise<PageSnapshot> {
  const card = await browser.$(`[data-testid="library-book-${bookId}"]`);
  await card.waitForExist({ timeout: TEST_TIMEOUT });
  await card.waitForDisplayed({ timeout: TEST_TIMEOUT });
  await card.click();

  const page = await browser.$('[data-testid="reader-page"]');
  await page.waitForExist({ timeout: TEST_TIMEOUT });
  await page.waitForDisplayed({ timeout: TEST_TIMEOUT });
  return readPage();
}

export async function readPage(): Promise<PageSnapshot> {
  return browser.execute(() => {
    const page = document.querySelector<HTMLElement>('[data-testid="reader-page"]');
    if (!page) {
      throw new Error("reader-page is not present");
    }
    const content = page.querySelector<HTMLElement>(".reader-text") ?? page;
    const asNumber = (name: string): number => {
      const value = Number(page.dataset[name]);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`reader-page has invalid data-${name}: ${page.dataset[name] ?? ""}`);
      }
      return value;
    };
    const range = document.createRange();
    range.selectNodeContents(content);
    return {
      bookId: page.dataset.bookId ?? "",
      start: asNumber("start"),
      end: asNumber("end"),
      total: asNumber("total"),
      text: content.textContent ?? "",
      rectCount: range.getClientRects().length,
      overflowHeight: content.scrollHeight,
      clientHeight: content.clientHeight,
    };
  });
}

export async function clickReaderControl(
  testId: "reader-next" | "reader-previous" | "reader-close",
): Promise<void> {
  const control = await browser.$(`[data-testid="${testId}"]`);
  await control.waitForExist({ timeout: TEST_TIMEOUT });
  await browser.execute((selector) => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) {
      throw new Error(`missing reader control ${selector}`);
    }
    element.click();
  }, `[data-testid="${testId}"]`);
}

export async function waitForPageStart(start: number): Promise<PageSnapshot> {
  let snapshot: PageSnapshot | undefined;
  await browser.waitUntil(
    async () => {
      snapshot = await readPage();
      return snapshot.start === start;
    },
    {
      timeout: TEST_TIMEOUT,
      interval: 100,
      timeoutMsg: `reader-page did not return to UTF-16 start ${start}`,
    },
  );
  if (!snapshot) throw new Error(`reader-page did not produce start ${start}`);
  return snapshot;
}

export async function waitForPageFit(start: number, tolerance = 1): Promise<PageSnapshot> {
  let snapshot: PageSnapshot | undefined;
  try {
    await browser.waitUntil(
      async () => {
        snapshot = await readPage();
        return (
          snapshot.start === start && snapshot.overflowHeight <= snapshot.clientHeight + tolerance
        );
      },
      {
        timeout: TEST_TIMEOUT,
        interval: 100,
        timeoutMsg: `reader-page did not settle at UTF-16 start ${start}`,
      },
    );
  } catch (error) {
    let details = "unavailable";
    try {
      details = JSON.stringify(await readPage());
    } catch (diagnosticError) {
      details = `diagnostic failed: ${String(diagnosticError)}`;
    }
    throw new Error(
      `reader-page did not settle at UTF-16 start ${start}; state=${details}; ${String(error)}`,
    );
  }
  if (!snapshot) throw new Error(`reader-page did not settle at UTF-16 start ${start}`);
  return snapshot;
}

export async function waitForNextPage(previous: PageSnapshot): Promise<PageSnapshot> {
  let snapshot: PageSnapshot | undefined;
  try {
    await browser.waitUntil(
      async () => {
        snapshot = await readPage();
        return snapshot.start > previous.start;
      },
      {
        timeout: TEST_TIMEOUT,
        interval: 100,
        timeoutMsg: `reader-page did not advance from UTF-16 start ${previous.start}`,
      },
    );
  } catch (error) {
    let details = "unavailable";
    try {
      const next = await browser.$('[data-testid="reader-next"]');
      details = JSON.stringify({
        page: await readPage(),
        nextExists: await next.isExisting(),
        nextEnabled: await next.isEnabled(),
        alerts: await browser.execute(() =>
          Array.from(document.querySelectorAll('[role="alert"]')).map((node) =>
            node.textContent?.trim(),
          ),
        ),
      });
    } catch (diagnosticError) {
      details = `diagnostic failed: ${String(diagnosticError)}`;
    }
    throw new Error(
      `reader-page did not advance from UTF-16 start ${previous.start}; state=${details}; ${String(error)}`,
    );
  }
  if (!snapshot) throw new Error("reader-page did not advance");
  return snapshot;
}

export async function waitForReaderClosed(): Promise<void> {
  try {
    await browser.waitUntil(
      async () =>
        await browser.execute(() => !document.querySelector('[data-testid="reader-page"]')),
      {
        timeout: TEST_TIMEOUT,
        interval: 100,
        timeoutMsg: "reader-page remained open after close",
      },
    );
  } catch (error) {
    let details = "unavailable";
    try {
      details = await browser
        .execute(() => ({
          reader: Boolean(document.querySelector('[data-testid="reader-page"]')),
          alerts: Array.from(document.querySelectorAll('[role="alert"]')).map((node) =>
            node.textContent?.trim(),
          ),
          closeDisabled: document.querySelector<HTMLButtonElement>('[data-testid="reader-close"]')
            ?.disabled,
        }))
        .then((value) => JSON.stringify(value));
    } catch (diagnosticError) {
      details = `diagnostic failed: ${String(diagnosticError)}`;
    }
    throw new Error(`reader-page remained open after close; state=${details}; ${String(error)}`);
  }
}

export async function clickSaveControl(): Promise<void> {
  const selectors = [
    '[data-testid="reader-save"]',
    'button[title="保存书签"]',
    'button[aria-label="保存阅读位置"]',
  ];
  for (const selector of selectors) {
    const control = await browser.$(selector);
    if (await control.isExisting()) {
      await browser.execute((value) => {
        const element = document.querySelector<HTMLElement>(value);
        if (!element) throw new Error(`missing save control ${value}`);
        element.click();
      }, selector);
      return;
    }
  }
  throw new Error("No reader save control is present");
}

export async function managedAssetPath(bookId: string): Promise<string> {
  const dataDirectory = process.env.GRIPREAD_TEST_DATA_DIR;
  if (!dataDirectory) throw new Error("GRIPREAD_TEST_DATA_DIR is required");
  const sql = `SELECT relative_path FROM book_assets WHERE book_id = '${bookId.replaceAll("'", "''")}' LIMIT 1;`;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("sqlite3", [
      "-json",
      `${dataDirectory}/gripread.sqlite3`,
      sql,
    ]));
  } catch (error: unknown) {
    throw new Error(
      `Unable to inspect the isolated test database with sqlite3: ${errorFromUnknown(error).message}`,
    );
  }
  let rows: Array<{ relative_path?: unknown }>;
  try {
    rows = JSON.parse(stdout) as Array<{ relative_path?: unknown }>;
  } catch (error: unknown) {
    throw new Error(`sqlite3 returned invalid JSON: ${String(error)}; output=${stdout}`);
  }
  const relativePath = rows[0]?.relative_path;
  if (typeof relativePath !== "string" || !relativePath.startsWith("books/")) {
    throw new Error(`No managed asset path was found for book ${bookId}`);
  }
  return `${dataDirectory}/${relativePath}`;
}

export async function replaceManagedAsset(bookId: string, text: string): Promise<Buffer> {
  const path = await managedAssetPath(bookId);
  const original = await readFile(path);
  await writeFile(path, text, "utf8");
  return original;
}

export async function restoreManagedAsset(bookId: string, original: Buffer): Promise<void> {
  await writeFile(await managedAssetPath(bookId), original);
}

export function expectUtf16Window(window: ContentWindow, expected: string): void {
  expect(window.endOffset - window.startOffset).toBe(window.text.length);
  expect(window.startOffset).toBeGreaterThanOrEqual(0);
  expect(window.endOffset).toBeLessThanOrEqual(expected.length);
  if (window.text.length > 0) {
    const first = window.text.charCodeAt(0);
    const last = window.text.charCodeAt(window.text.length - 1);
    if (first >= 0xdc00 && first <= 0xdfff) {
      throw new Error("content window starts in the middle of a surrogate pair");
    }
    if (last >= 0xd800 && last <= 0xdbff) {
      throw new Error("content window ends in the middle of a surrogate pair");
    }
  }
}

export async function readManagedAsset(bookId: string): Promise<Buffer> {
  return readFile(await managedAssetPath(bookId));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function tryParseRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
