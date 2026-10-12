// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import type { AppServices } from "../../services/contracts";
import { syncServiceMocks, unconfiguredWebDav } from "../../test/sync";
import { BackupPage } from "./BackupPage";
import { CloudShelfPage } from "./CloudShelfPage";

afterEach(cleanup);

function runtime() {
  const sync = syncServiceMocks();
  vi.mocked(sync.getWebDav).mockResolvedValue({
    ...unconfiguredWebDav(),
    url: "https://dav.example.com/dav/",
    username: "reader",
    password: "secret",
    autoBackup: true,
    configured: true,
  });
  // The pages use only the sync service and the stores' refreshes.
  const services = {
    library: {
      listBooks: vi.fn(async () => []),
      listRemovedBooks: vi.fn(async () => []),
      onImportProgress: vi.fn(async () => () => undefined),
    },
    reader: {},
    settings: {
      getSettings: vi.fn(async () => {
        throw new Error("unused");
      }),
      getShelfPreferences: vi.fn(async () => {
        throw new Error("unused");
      }),
    },
    sync,
  } as unknown as AppServices;
  return new AppRuntime(services);
}

describe("backup and the cloud bookshelf", () => {
  it("previews a WebDAV backup before restoring it and reports the result", async () => {
    const app = runtime();
    const sync = app.services.sync;
    vi.mocked(sync.listBackups).mockResolvedValue([
      { name: "auto-20261011-080000.json", size: 2048, modified: 1, automatic: true, device: null },
    ]);
    vi.mocked(sync.previewBackup).mockResolvedValue({
      createdAt: 1,
      device: "Android",
      books: 3,
      booksOnDevice: 1,
      bookmarks: 2,
      groups: 0,
      replaceRules: 0,
      tocRules: 0,
      hasPreferences: false,
      bookSources: 0,
      onlineBooks: 0,
    });
    vi.mocked(sync.restoreBackup).mockResolvedValue({
      groupsCreated: 0,
      rulesRestored: 0,
      preferencesRestored: false,
      booksRestored: 1,
      booksPending: 2,
      positionsRestored: 1,
      bookmarksAdded: 2,
      recoveryPoint: "recovery-1.json",
      sourcesRestored: 0,
      onlineBooksRestored: 0,
    });
    render(
      <RuntimeContext.Provider value={app}>
        <BackupPage onClose={() => undefined} />
      </RuntimeContext.Provider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "从 WebDAV 恢复" }));
    await userEvent.click(await screen.findByRole("button", { name: "恢复" }));
    expect(await screen.findByText("书籍 3 本，本机已有 1 本")).toBeTruthy();
    expect(sync.restoreBackup).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "恢复备份" });
    await userEvent.click(
      [...dialog.querySelectorAll("button")].find((button) => button.textContent === "恢复")!,
    );
    expect(sync.restoreBackup).toHaveBeenCalledWith({
      kind: "remote",
      name: "auto-20261011-080000.json",
    });
    expect(await screen.findByText(/2 本书不在本机/)).toBeTruthy();
  });

  it("downloads a cloud book into the ordinary import", async () => {
    const app = runtime();
    const sync = app.services.sync;
    vi.mocked(sync.listCloudBooks).mockResolvedValue([
      {
        name: "山河.txt",
        title: "山河",
        author: null,
        size: 10,
        sourceSha256: "h",
        uploadedAt: 1,
        localBookId: null,
        localRemoved: false,
      },
    ]);
    vi.mocked(sync.downloadCloudBook).mockResolvedValue({
      path: "/staging/山河.txt",
      name: "山河.txt",
    });
    const importBatch = vi.spyOn(app.library, "importBatch").mockResolvedValue(undefined);
    render(
      <RuntimeContext.Provider value={app}>
        <CloudShelfPage onClose={() => undefined} />
      </RuntimeContext.Provider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "下载" }));
    await waitFor(() => expect(importBatch).toHaveBeenCalledWith(["/staging/山河.txt"]));
    expect(sync.downloadCloudBook).toHaveBeenCalledWith("山河.txt");
  });
});
