import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { checkBoundaries } from "./check-boundaries.mjs";

function fixture(files, run) {
  const root = mkdtempSync(join(tmpdir(), "gripread-boundaries-"));
  try {
    for (const [file, content] of Object.entries({
      "crates/core/Cargo.toml": '[dependencies]\nserde = "1"\n',
      ...files,
    })) {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test("rejects real module edges through aliases, exports and dynamic imports", () => {
  fixture(
    {
      "src/components/View.tsx":
        'export { mock } from "@/fixtures/books"; const api = import("@tauri-apps/api/core");',
      "src/reader/controller.ts": 'import { state } from "../application/runtime";',
    },
    (root) => {
      const errors = checkBoundaries(root);
      assert.equal(errors.length, 3);
      assert.ok(errors.some((error) => error.includes("native APIs belong")));
      assert.ok(errors.some((error) => error.includes("mock data")));
      assert.ok(errors.some((error) => error.includes("presentation")));
    },
  );
});
test("ignores comments while allowing service adapters and interface-only consumers", () => {
  fixture(
    {
      "src/components/View.tsx":
        '// import mock from "@/fixtures/books";\nimport type {ReaderService} from "../services/contracts";',
      "src/services/ipc.ts": 'import { invoke } from "@tauri-apps/api/core";',
      "src/reader/controller.ts": 'import type {ReaderService} from "../services/contracts";',
    },
    (root) => assert.deepEqual(checkBoundaries(root), []),
  );
});

test("lets component tests import shared test helpers but not production pages", () => {
  fixture(
    {
      "src/components/View.test.tsx": 'import { tocListing } from "../test/toc";',
      "src/components/View.tsx": 'import { tocListing } from "../test/toc";',
    },
    (root) => {
      const errors = checkBoundaries(root);
      assert.deepEqual(errors, [
        "src/components/View.tsx: production pages cannot import test or mock data",
      ]);
    },
  );
});

test("keeps the source engine free of Tauri", () => {
  fixture(
    {
      "crates/core/src/sources/js/mod.rs": "use tauri::AppHandle;",
      "crates/core/src/sources/rule.rs": "fn rule() {}",
      "src/main.ts": "",
    },
    (root) => {
      const errors = checkBoundaries(root);
      assert.deepEqual(errors, [
        "crates/core/src/sources/js/mod.rs: the source engine cannot depend on Tauri",
      ]);
    },
  );
});

test("keeps the core free of Tauri", () => {
  fixture(
    {
      "crates/core/Cargo.toml": '[dependencies]\ntauri = { version = "2" }\n',
      "src/main.ts": "",
    },
    (root) => {
      assert.deepEqual(checkBoundaries(root), [
        "crates/core/Cargo.toml: the core cannot depend on Tauri",
      ]);
    },
  );
});
