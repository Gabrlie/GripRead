// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tocEntry } from "../../../test/toc";
import { ContentsPage } from "./ContentsPage";

afterEach(cleanup);

describe("ContentsPage", () => {
  it("renders only the rows near the screen for a long contents", () => {
    const toc = Array.from({ length: 3000 }, (_, index) =>
      tocEntry(index, `第${index + 1}章`, {
        bookId: "b",
        contentVersion: "v",
        resourceId: `chapter-${index}`,
        offset: 0,
        contextBefore: "",
        contextAfter: "",
      }),
    );
    render(
      <ContentsPage
        bookTitle="书"
        toc={toc}
        ruleName=""
        splitLongChapters={false}
        position={0}
        loading={false}
        error={null}
        busy={false}
        bookmarks={[]}
        contentVersion="v"
        onReload={() => undefined}
        onSeek={() => undefined}
        onOpenBookmark={() => undefined}
        onDeleteBookmark={() => undefined}
        onEditBookmark={() => undefined}
        onOpenRules={() => undefined}
        onToggleSplit={() => undefined}
        onClose={() => undefined}
        resourceId="chapter-2500"
        kind="online"
      />,
    );
    const rows = screen.getAllByRole("button", { name: /^第\d+章/ });
    expect(rows.length).toBeLessThan(80);
    expect(screen.getByRole("button", { name: /第2501章/ }).getAttribute("aria-current")).toBe(
      "location",
    );
  });

  it("offers an online book's tools, its update times, and the chapters inside one", async () => {
    const at = (offset: number, index: number) => ({
      bookId: "b",
      contentVersion: "v",
      resourceId: `chapter-${index}`,
      offset,
      contextBefore: "",
      contextAfter: "",
    });
    const toc = [
      { ...tocEntry(0, "第一章", at(0, 0)), tag: "更新于昨天" },
      tocEntry(1, "上半", at(12, 0)),
      tocEntry(2, "下半", at(40, 0)),
      tocEntry(3, "第二章", at(0, 1)),
    ];
    const toggle = vi.fn();
    const update = vi.fn();
    const replace = vi.fn();
    render(
      <ContentsPage
        bookTitle="书"
        toc={toc}
        ruleName=""
        splitLongChapters={false}
        position={20}
        loading={false}
        error={null}
        busy={false}
        bookmarks={[]}
        contentVersion="v"
        onReload={() => undefined}
        onSeek={() => undefined}
        onOpenBookmark={() => undefined}
        onDeleteBookmark={() => undefined}
        onEditBookmark={() => undefined}
        onOpenRules={() => undefined}
        onToggleSplit={() => undefined}
        onClose={() => undefined}
        resourceId="chapter-0"
        kind="online"
        innerChapters
        onToggleInner={toggle}
        onOpenReplace={replace}
        onUpdateToc={update}
      />,
    );
    expect(screen.getByText("更新于昨天")).toBeTruthy();
    // The page is past 上半 and before 下半.
    expect(screen.getByRole("button", { name: /上半/ }).getAttribute("aria-current")).toBe(
      "location",
    );
    await userEvent.click(screen.getByRole("button", { name: "目录选项" }));
    expect(await screen.findByRole("menuitem", { name: /章内分章/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /拆分超长章节/ })).toBeNull();
    await userEvent.click(await screen.findByRole("menuitem", { name: /章内分章/ }));
    expect(toggle).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "目录选项" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /替换净化/ }));
    expect(replace).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "目录选项" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /更新目录/ }));
    expect(update).toHaveBeenCalledOnce();
  });
});
