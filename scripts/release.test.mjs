import assert from "node:assert/strict";
import test from "node:test";
import {
  changelogEntry,
  parseCommit,
  previousTag,
  renderNotes,
  updaterManifest,
} from "./release.mjs";

test("commits split into Conventional Commit parts", () => {
  assert.deepEqual(parseCommit("a1", "feat(reader): EPUB books"), {
    sha: "a1",
    type: "feat",
    scope: "reader",
    breaking: false,
    description: "EPUB books",
  });
  assert.equal(parseCommit("a2", "fix!: drop old backups").breaking, true);
  assert.equal(parseCommit("a3", "refactor: x", "BREAKING CHANGE: y").breaking, true);
  assert.equal(parseCommit("a4", "ci: lowercase the image").type, "other");
  assert.equal(parseCommit("a5", "Merge something odd").type, "other");
});

test("the previous release is of the same kind", () => {
  const tags = ["v0.3.0-dev.40", "v0.2.1", "v0.3.0-dev.12", "v0.2.0"];
  assert.equal(previousTag(tags, "0.3.0-dev.41"), "v0.3.0-dev.40");
  assert.equal(previousTag(tags, "0.3.0-dev.40"), "v0.3.0-dev.12");
  assert.equal(previousTag(tags, "0.3.0"), "v0.2.1");
  assert.equal(previousTag(["v0.3.0"], "0.3.0"), null);
});

const CHANGELOG = `# 更新日志

## [Unreleased]

### 新增

- EPUB

## [0.2.0] - 2026-10-14

### 新增

- 服务器
`;

test("the changelog entry follows the release kind", () => {
  assert.equal(changelogEntry(CHANGELOG, "0.3.0-dev.2"), "### 新增\n\n- EPUB");
  assert.equal(changelogEntry(CHANGELOG, "0.2.0"), "### 新增\n\n- 服务器");
  assert.equal(changelogEntry(CHANGELOG, "9.9.9"), "");
});

test("the release page has the entry, grouped commits, downloads, and links", () => {
  const notes = renderNotes({
    version: "0.3.0",
    repo: "o/r",
    image: "ghcr.io/o/gripread",
    changelog: CHANGELOG.replace("## [Unreleased]", "## [0.3.0] - 2026-11-01"),
    commits: [
      parseCommit("1111111aaaa", "fix(sync): keep bookmarks"),
      parseCommit("2222222bbbb", "feat!: new library format"),
      parseCommit("3333333cccc", "build: more targets"),
    ],
    previous: "v0.2.0",
    files: ["gripread-0.3.0-arm64-v8a.apk", "gripread-0.3.0-macos-x64.dmg", "SHA256SUMS"],
  });
  assert.match(notes, /^## 更新内容\n\n### 新增\n\n- EPUB/);
  assert.ok(notes.indexOf("不兼容变更") < notes.indexOf("新功能"));
  assert.match(
    notes,
    /- \*\*sync：\*\* keep bookmarks \(\[1111111\]\(https:\/\/github.com\/o\/r\/commit\/1111111aaaa\)\)/,
  );
  assert.match(
    notes,
    /\| Android \| \[`gripread-0.3.0-arm64-v8a.apk`\]\(https:\/\/github.com\/o\/r\/releases\/download\/v0.3.0\/gripread-0.3.0-arm64-v8a.apk\)/,
  );
  assert.match(notes, /\| macOS \| .*Intel/);
  assert.match(notes, /仍要打开/);
  assert.doesNotMatch(notes, /universal/);
  assert.match(
    notes,
    /docker pull ghcr.io\/o\/gripread:0.3.0\ndocker pull ghcr.io\/o\/gripread:latest/,
  );
  assert.match(notes, /SHA256SUMS/);
  assert.match(notes, /compare\/v0.2.0...v0.3.0/);
});

test("a pre-release page uses the dev image and the commits link without a previous tag", () => {
  const notes = renderNotes({
    version: "0.3.0-dev.1",
    repo: "o/r",
    image: "i",
    changelog: "",
    commits: [],
    previous: null,
    files: [],
  });
  assert.doesNotMatch(notes, /更新内容|提交记录|## 下载/);
  assert.match(notes, /docker pull i:dev/);
  assert.match(notes, /commits\/v0.3.0-dev.1/);
});

test("the updater manifest lists each signed macOS archive", () => {
  const manifest = updaterManifest({
    version: "0.3.0",
    repo: "o/r",
    notes: "n",
    date: "d",
    signatures: { "gripread-0.3.0-macos-arm64.app.tar.gz.sig": "sig\n" },
  });
  assert.deepEqual(manifest.platforms, {
    "darwin-aarch64": {
      signature: "sig",
      url: "https://github.com/o/r/releases/download/v0.3.0/gripread-0.3.0-macos-arm64.app.tar.gz",
    },
  });
});
