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

  it("puts a chapter's update time and length on a second line under its title", async () => {
    const at = (index: number) => ({
      bookId: "b",
      contentVersion: "v",
      resourceId: "a",
      offset: index * 100,
      contextBefore: "",
      contextAfter: "",
    });
    const update = vi.fn();
    render(
      <ContentsPage
        bookTitle="书"
        toc={[
          { ...tocEntry(0, "第一章", at(0)), tag: "1637字", length: 3256 },
          { ...tocEntry(1, "第二章", at(1)), length: 12 },
        ]}
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
        onUpdateToc={update}
        kind="txt"
      />,
    );
    const first = screen.getByRole("button", { name: /第一章/ });
    const second = screen.getByRole("button", { name: /第二章/ });
    expect(screen.getByText("1637字").previousElementSibling?.textContent).toBe("第一章");
    expect(first.style.height).toBe("56px");
    expect(second.style.height).toBe("46px");
    await userEvent.click(screen.getByRole("button", { name: "目录选项" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /显示字数/ }));
    expect(screen.getByText("1637字 · 3256字")).toBeTruthy();
    expect(screen.getByText("12字").previousElementSibling?.textContent).toBe("第二章");
    expect(second.style.height).toBe("56px");
    // A local TXT finds its chapters again from 更新目录.
    await userEvent.click(screen.getByRole("button", { name: "目录选项" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /更新目录/ }));
    expect(update).toHaveBeenCalledOnce();
  });

  it("offers no rule tools for the contents a converted book kept", async () => {
    render(
      <ContentsPage
        bookTitle="书"
        toc={[
          tocEntry(0, "春日", {
            bookId: "b",
            contentVersion: "v",
            resourceId: "a",
            offset: 0,
            contextBefore: "",
            contextAfter: "",
          }),
        ]}
        ruleName="书源目录"
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
        onOpenUntitled={() => undefined}
        onClose={() => undefined}
        kind="txt"
        fixed
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "目录选项" }));
    expect(await screen.findByRole("menuitem", { name: /显示字数/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /目录规则/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /拆分超长章节/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /未命中规则时的标题/ })).toBeNull();
  });
});
