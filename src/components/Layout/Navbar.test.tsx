// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRuntime, RuntimeContext } from "../../application/runtime";
import { AppProvider } from "../../context/AppContext";
import type { AppServices } from "../../services/contracts";
import type { ReaderPreferences } from "../../types/generated";
import { GeneratedCover } from "../Bookshelf/BookCover";
import { Navbar } from "./Navbar";

afterEach(cleanup);

async function runtimeWith(preferences: Partial<ReaderPreferences>) {
  const runtime = new AppRuntime({
    library: { listBooks: vi.fn(async () => []), onImportProgress: vi.fn(async () => () => {}) },
    reader: {},
    settings: {
      getSettings: vi.fn(async () => ({ theme: "light", ...preferences }) as ReaderPreferences),
      saveSettings: vi.fn(async (value: ReaderPreferences) => value),
      getShelfPreferences: vi.fn(async () => ({
        layout: "list",
        sort: "recent_read",
        groupId: "all",
      })),
      saveShelfPreferences: vi.fn(async (value: unknown) => value),
    },
    sync: {},
    sources: {},
  } as unknown as AppServices);
  await runtime.settings.load();
  return runtime;
}

describe("外观 › 主界面 与 底部导航", () => {
  it("hides the 发现 tab and the labels when asked", async () => {
    const runtime = await runtimeWith({ showDiscover: false, navLabels: false });
    render(
      <RuntimeContext.Provider value={runtime}>
        <AppProvider>
          <Navbar />
        </AppProvider>
      </RuntimeContext.Provider>,
    );
    const dock = screen.getByLabelText("Mobile Navigation Dock");
    expect(dock.querySelectorAll("button")).toHaveLength(3);
    // Without labels each tab still has its name for screen readers.
    expect(dock.querySelector('button[aria-label="书架"]')).toBeTruthy();
    expect(dock.textContent).not.toContain("书架");
  });
});

describe("默认封面", () => {
  it("shows the title and author as 外观 says", async () => {
    const runtime = await runtimeWith({ coverShowName: false });
    const { container } = render(
      <RuntimeContext.Provider value={runtime}>
        <GeneratedCover title="剑来" author="烽火戏诸侯" />
      </RuntimeContext.Provider>,
    );
    expect(container.textContent).not.toContain("剑来");
    expect(container.textContent).toContain("烽火戏诸侯");
  });
});
