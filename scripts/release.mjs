// Release page content for the Build workflow (.github/workflows/build.yml).
//
//   node scripts/release.mjs notes <version> <dir>
//       The release page in Markdown: the CHANGELOG.md entry, the commits
//       since the previous release of the same kind grouped by Conventional
//       Commit type, a table of the files in <dir>, the server image, and a
//       compare link.
//   node scripts/release.mjs updater <version> <dir>
//       latest.json for the desktop updater, from the .app.tar.gz.sig files
//       in <dir>.
//
// GITHUB_REPOSITORY (owner/name) and IMAGE (the server image) come from the
// workflow environment.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const GROUPS = [
  ["feat", "✨ 新功能"],
  ["fix", "🐛 问题修复"],
  ["perf", "⚡ 性能"],
  ["docs", "📝 文档"],
  ["other", "🔧 构建与其他"],
];

const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;

/** Splits a commit into its Conventional Commit parts; other subjects count as "other". */
export function parseCommit(sha, subject, body = "") {
  const match = CONVENTIONAL.exec(subject.trim());
  const breaking = /^BREAKING[ -]CHANGE:/m.test(body);
  if (!match) return { sha, type: "other", scope: null, breaking, description: subject.trim() };
  const [, type, scope, bang, description] = match;
  const known = GROUPS.some(([key]) => key === type);
  return {
    sha,
    type: known ? type : "other",
    scope: scope ?? null,
    breaking: breaking || bang === "!",
    description,
  };
}

const isPrerelease = (version) => version.includes("-");

/**
 * The tag of the previous release of the same kind: the newest other
 * pre-release for a pre-release, the newest other release for a release.
 * `tags` is newest first.
 */
export function previousTag(tags, version) {
  const current = `v${version}`;
  return (
    tags.find(
      (tag) =>
        tag !== current &&
        /^v\d+\.\d+\.\d+/.test(tag) &&
        isPrerelease(tag) === isPrerelease(version),
    ) ?? null
  );
}

/** The CHANGELOG.md entry for a version, or `Unreleased` for a pre-release. */
export function changelogEntry(changelog, version) {
  const heading = isPrerelease(version) ? "Unreleased" : version;
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${heading}]`));
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

const ANDROID = [
  ["arm64-v8a", "大多数手机（推荐）"],
  ["armeabi-v7a", "较旧的 32 位手机"],
  ["x86_64", "模拟器、部分平板"],
  ["x86", "32 位模拟器"],
  ["universal", "不确定时选这个，包含所有架构，体积较大"],
];
const MACOS = [
  ["arm64", "Apple Silicon（M 系列芯片）"],
  ["x64", "Intel 芯片"],
];

function downloads(files, version, base) {
  const rows = [];
  for (const [abi, note] of ANDROID) {
    const file = `gripread-${version}-${abi}.apk`;
    if (files.includes(file)) rows.push(`| Android | [\`${file}\`](${base}/${file}) | ${note} |`);
  }
  for (const [arch, note] of MACOS) {
    const file = `gripread-${version}-macos-${arch}.dmg`;
    if (files.includes(file)) rows.push(`| macOS | [\`${file}\`](${base}/${file}) | ${note} |`);
  }
  return rows;
}

/** The release page in Markdown. */
export function renderNotes({ version, repo, image, changelog, commits, previous, files }) {
  const url = `https://github.com/${repo}`;
  const tag = `v${version}`;
  const sections = [];

  const entry = changelogEntry(changelog, version);
  if (entry) sections.push(`## 更新内容\n\n${entry}`);

  const line = (commit) => {
    const scope = commit.scope ? `**${commit.scope}：** ` : "";
    return `- ${scope}${commit.description} ([${commit.sha.slice(0, 7)}](${url}/commit/${commit.sha}))`;
  };
  const groups = [];
  const breaking = commits.filter((commit) => commit.breaking);
  if (breaking.length) groups.push(`### ⚠️ 不兼容变更\n\n${breaking.map(line).join("\n")}`);
  for (const [type, title] of GROUPS) {
    const matching = commits.filter((commit) => commit.type === type);
    if (matching.length) groups.push(`### ${title}\n\n${matching.map(line).join("\n")}`);
  }
  if (groups.length) sections.push(`## 提交记录\n\n${groups.join("\n\n")}`);

  const rows = downloads(files, version, `${url}/releases/download/${tag}`);
  if (rows.length) {
    const download = [
      `## 下载\n\n| 平台 | 文件 | 适用于 |\n| --- | --- | --- |\n${rows.join("\n")}`,
    ];
    if (rows.some((row) => row.startsWith("| macOS")))
      download.push(
        "macOS 版本没有签名：第一次打开时请在应用上右键选择「打开」，或在 系统设置 › 隐私与安全性 中点击「仍要打开」。",
      );
    sections.push(download.join("\n\n"));
  }

  const moving = isPrerelease(version) ? "dev" : "latest";
  sections.push(
    `## 服务器镜像\n\n\`\`\`sh\ndocker pull ${image}:${version}\ndocker pull ${image}:${moving}\n\`\`\``,
  );

  const footer = [];
  if (files.includes("SHA256SUMS")) footer.push("所有文件的 SHA-256 校验值见 `SHA256SUMS`。");
  footer.push(
    previous
      ? `**完整变更：** ${url}/compare/${previous}...${tag}`
      : `**完整变更：** ${url}/commits/${tag}`,
  );
  sections.push(footer.join("\n\n"));
  return `${sections.join("\n\n")}\n`;
}

/** latest.json for the Tauri updater; `signatures` maps .sig file names to their contents. */
export function updaterManifest({ version, repo, notes, date, signatures }) {
  const platforms = {};
  for (const [arch, platform] of [
    ["arm64", "darwin-aarch64"],
    ["x64", "darwin-x86_64"],
  ]) {
    const archive = `gripread-${version}-macos-${arch}.app.tar.gz`;
    const signature = signatures[`${archive}.sig`];
    if (signature)
      platforms[platform] = {
        signature: signature.trim(),
        url: `https://github.com/${repo}/releases/download/v${version}/${archive}`,
      };
  }
  return { version, notes, pub_date: date, platforms };
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

// The first release lists no commits: its changelog entry covers everything.
function commitsSince(previous) {
  if (!previous) return [];
  return git("log", `${previous}..HEAD`, "--no-merges", "--format=%H%x1f%s%x1f%b%x1e")
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, subject, body] = record.split("\x1f");
      return parseCommit(sha, subject, body);
    });
}

function main([command, version, dir]) {
  if (!command || !version || !dir)
    throw new Error("usage: release.mjs notes|updater <version> <dir>");
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is not set");
  const files = readdirSync(dir);
  if (command === "notes") {
    const tags = git("tag", "--list", "v*", "--sort=-creatordate").split("\n").filter(Boolean);
    const previous = previousTag(tags, version);
    const root = resolve(import.meta.dirname, "..");
    process.stdout.write(
      renderNotes({
        version,
        repo,
        image: (process.env.IMAGE ?? "").toLowerCase(),
        changelog: readFileSync(join(root, "CHANGELOG.md"), "utf8"),
        commits: commitsSince(previous),
        previous,
        files,
      }),
    );
  } else if (command === "updater") {
    const signatures = Object.fromEntries(
      files
        .filter((file) => file.endsWith(".app.tar.gz.sig"))
        .map((file) => [file, readFileSync(join(dir, file), "utf8")]),
    );
    const manifest = updaterManifest({
      version,
      repo,
      notes: `手不释卷 ${version}`,
      date: new Date().toISOString(),
      signatures,
    });
    writeFileSync(join(dir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    throw new Error(`unknown command: ${command}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
