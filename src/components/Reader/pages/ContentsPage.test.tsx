// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
        txtTools={false}
      />,
    );
    const rows = screen.getAllByRole("button", { name: /^第\d+章/ });
    expect(rows.length).toBeLessThan(80);
    expect(screen.getByRole("button", { name: /第2501章/ }).getAttribute("aria-current")).toBe(
      "location",
    );
  });
});
