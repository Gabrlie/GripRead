import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkDocuments } from "./check-docs.mjs";

const fixtureRules = { "README.md": { headings: ["Purpose"] } };
const options = { requirements: fixtureRules, budgets: {} };

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), "gripread-docs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

test("valid relative links and duplicate heading anchors pass; fenced examples are ignored", async (t) => {
  const root = await fixture(t, {
    "README.md":
      "# Example\n\n## Purpose\n\n[Guide](.ai/guide.md#detail-1) and [space](<.ai/with space.md>).\n\n```md\n[example](missing.md)\n```\n\n[Upstream](https://example.invalid/page).\n",
    ".ai/guide.md": "# Guide\n\n## Detail\n\nFirst.\n\n## Detail\n\nSecond.\n",
    ".ai/with space.md": "# Space\n",
  });
  assert.deepEqual((await checkDocuments(root, options)).errors, []);
});

test("missing local files and anchors are rejected", async (t) => {
  const root = await fixture(t, {
    "README.md": "# Example\n\n## Purpose\n\n[Missing](.ai/missing.md) and [anchor](#absent).\n",
  });
  const result = await checkDocuments(root, options);
  assert.ok(result.errors.some((error) => error.includes("invalid local link .ai/missing.md")));
  assert.ok(result.errors.some((error) => error.includes("missing heading anchor")));
});

test("required documents and sections cannot disappear", async (t) => {
  const root = await fixture(t, { "README.md": "# Example\n\n## Renamed\n" });
  const result = await checkDocuments(root, {
    requirements: { ...fixtureRules, ".ai/required.md": { headings: [] } },
    budgets: {},
  });
  assert.ok(result.errors.some((error) => error.includes('missing section "Purpose"')));
  assert.ok(result.errors.some((error) => error.includes("required document is missing")));
});

test("note lifecycle disagrees with a claimed implemented state", async (t) => {
  const root = await fixture(t, {
    "README.md": "# Example\n\n## Purpose\n",
    ".ai/notes/proposed/change.md":
      "# Change\n\nStatus: implemented\n\n## Problem\n\n## Proposal\n\n## Alternatives considered\n\n## Acceptance criteria\n\n## Risks\n",
  });
  assert.ok(
    (await checkDocuments(root, options)).errors.some((error) =>
      error.includes("expected exactly one status from proposed"),
    ),
  );
});

test("specifications reject duplicate or unknown statuses and entry word overflow", async (t) => {
  const root = await fixture(t, {
    "README.md":
      "# Example\n\nStatus: planned\nStatus: done\n\n## Purpose\n\nSeveral extra words here.\n",
  });
  const result = await checkDocuments(root, {
    requirements: { "README.md": { headings: ["Purpose"], status: ["planned", "implemented"] } },
    budgets: { "README.md": 5 },
  });
  assert.ok(result.errors.some((error) => error.includes("expected exactly one status")));
  assert.ok(result.errors.some((error) => error.includes("exceed limit 5")));
});

test("links cannot escape the repository or hide behind unsupported reference syntax", async (t) => {
  const root = await fixture(t, {
    "README.md":
      "# Example\n\n## Purpose\n\n[Outside](../outside.md) and [absolute](/tmp/outside.md).\n\n[Guide][ref]\n\n[ref]: .ai/guide.md\n",
  });
  const result = await checkDocuments(root, options);
  assert.ok(result.errors.some((error) => error.includes("link escapes repository")));
  assert.ok(result.errors.some((error) => error.includes("use repository-relative links")));
  assert.ok(result.errors.some((error) => error.includes("reference-style links")));
});

test("the command-line checker exits nonzero on an invalid repository", async (t) => {
  const root = await fixture(t, { "README.md": "# Incomplete\n" });
  await mkdir(join(root, "scripts"));
  const command = join(root, "scripts/check-docs.mjs");
  await copyFile(fileURLToPath(new URL("./check-docs.mjs", import.meta.url)), command);
  assert.throws(
    () => execFileSync(process.execPath, [command], { cwd: root, stdio: "pipe" }),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr.toString(), /required document is missing/);
      return true;
    },
  );
});
