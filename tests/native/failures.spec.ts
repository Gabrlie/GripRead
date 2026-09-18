import { expect } from "@wdio/globals";
import { rename, unlink, writeFile } from "node:fs/promises";

import {
  WINDOW_UNITS,
  dataPath,
  expectInvokeError,
  importFixture,
  invoke,
  managedAssetPath,
  normalizedFixture,
  readManagedAsset,
  restoreManagedAsset,
  replaceManagedAsset,
  waitForImport,
  waitForAppReady,
  waitForFile,
} from "./support";
import type { ImportResult, ImportTask, LibraryBook } from "../../src/types/generated";

describe("GripRead native recoverable asset failures", () => {
  let imported: ImportResult;

  before(async () => {
    await waitForAppReady();
    imported = await importFixture("mixed.txt");
  });

  it("reports a content-version error when a managed asset is replaced", async () => {
    const replacement = await normalizedFixture("replacement.txt");
    const originalAsset = await replaceManagedAsset(imported.book.id, replacement);
    try {
      const error = await expectInvokeError("read_content_window", {
        request: {
          bookId: imported.book.id,
          locator: null,
          maxUnits: WINDOW_UNITS,
          direction: "forward",
        },
      });
      expect(error.message).toContain("unexpected byte length");
    } finally {
      await restoreManagedAsset(imported.book.id, originalAsset);
    }
  });

  it("reports an asset-missing error when the managed file disappears", async () => {
    const path = await managedAssetPath(imported.book.id);
    const bytes = await readManagedAsset(imported.book.id);
    const movedPath = `${path}.native-test-missing`;
    await rename(path, movedPath);
    try {
      const error = await expectInvokeError("read_content_window", {
        request: {
          bookId: imported.book.id,
          locator: null,
          maxUnits: WINDOW_UNITS,
          direction: "forward",
        },
      });
      expect(error.message).toBe("managed content file is missing");
    } finally {
      await rename(movedPath, path);
      expect((await readManagedAsset(imported.book.id)).equals(bytes)).toBe(true);
    }
  });

  it("does not create a book or report success for a missing import source", async () => {
    const before = await invoke<LibraryBook[]>("list_books");
    const task = await invoke<ImportTask>("start_import", {
      request: {
        path: `${process.env.GRIPREAD_NATIVE_FIXTURE_DIR}/does-not-exist.txt`,
      },
    });
    const status = await waitForImport(task.operationId);
    expect(status.phase).toBe("failed");
    expect(status.result).toBeNull();
    expect(status.error?.code).toBe("file_not_found");
    const after = await invoke<LibraryBook[]>("list_books");
    expect(after.map((entry) => entry.book.id)).toEqual(before.map((entry) => entry.book.id));
  });

  it("cancels a paused commit and leaves no new book", async () => {
    const before = await invoke<LibraryBook[]>("list_books");
    const fault = dataPath(".native-fault");
    const paused = dataPath(".native-paused");
    await writeFile(fault, "pause-before-commit\n", "utf8");
    try {
      const task = await invoke<ImportTask>("start_import", {
        request: {
          path: `${process.env.GRIPREAD_NATIVE_FIXTURE_DIR}/replacement.txt`,
        },
      });
      await waitForFile(paused);
      const cancel = await invoke<{ requested: boolean }>("cancel_import", {
        request: { operationId: task.operationId },
      });
      expect(cancel.requested).toBe(true);
      const status = await waitForImport(task.operationId);
      expect(status.phase).toBe("cancelled");
      expect(status.result).toBeNull();
      await unlink(fault).catch(() => undefined);
      const after = await invoke<LibraryBook[]>("list_books");
      expect(after.map((entry) => entry.book.id)).toEqual(before.map((entry) => entry.book.id));
    } finally {
      await unlink(fault).catch(() => undefined);
      await unlink(paused).catch(() => undefined);
    }
  });

  it("cleans a failed final commit without publishing a book", async () => {
    const before = await invoke<LibraryBook[]>("list_books");
    const fault = dataPath(".native-fault");
    await writeFile(fault, "before-final-commit-error\n", "utf8");
    try {
      const task = await invoke<ImportTask>("start_import", {
        request: {
          path: `${process.env.GRIPREAD_NATIVE_FIXTURE_DIR}/replacement.txt`,
        },
      });
      const status = await waitForImport(task.operationId);
      expect(status.phase).toBe("failed");
      expect(status.result).toBeNull();
      const after = await invoke<LibraryBook[]>("list_books");
      expect(after.map((entry) => entry.book.id)).toEqual(before.map((entry) => entry.book.id));
    } finally {
      await unlink(fault).catch(() => undefined);
    }
  });
});
