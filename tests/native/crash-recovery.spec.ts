import { readdir, unlink } from "node:fs/promises";
import { expect } from "@wdio/globals";

import { dataPath, invoke, waitForAppReady } from "./support";
import type { LibraryBook } from "../../src/types/generated";

describe("GripRead native publication crash recovery", () => {
  it("opens the interrupted data directory without an unpublished asset", async () => {
    await waitForAppReady();
    const books = await invoke<LibraryBook[]>("list_books");
    expect(books).toHaveLength(0);
    const staging = await readdir(dataPath("staging"));
    expect(staging.filter((name) => /\.(part|raw|old)$/.test(name))).toHaveLength(0);
    await unlink(dataPath(".native-fault")).catch(() => undefined);
  });
});
