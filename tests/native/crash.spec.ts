import { writeFile } from "node:fs/promises";
import { browser } from "@wdio/globals";

import { dataPath, fixturePath, invoke, waitForAppReady } from "./support";

describe("GripRead native publication crash boundary", () => {
  it("terminates after publishing the managed file and before database commit", async () => {
    await waitForAppReady();
    await writeFile(dataPath(".native-fault"), "crash-after-rename\n", "utf8");
    // The native-test fault hook aborts the app after the managed rename. The
    // expected non-zero WebDriver phase is verified by scripts/native-test.mjs;
    // leave the marker and data directory for the independent recovery phase.
    const task = await invoke<{ operationId: string }>("start_import", {
      request: { path: fixturePath("replacement.txt") },
    });
    await browser.pause(500);
    await invoke("get_import_status", { request: { operationId: task.operationId } });
    throw new Error("crash-after-rename did not terminate the native process");
  });
});
