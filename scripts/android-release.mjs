// Builds a signed release APK on this machine, so a change can be tried on a
// phone without a GitHub release. It installs over GitHub builds and the
// reverse, since both take their versionCode from the build time
// (scripts/version.mjs).
//
//   node scripts/android-release.mjs [targets...]     default: aarch64
//
// The version is `<package.json version>-alpha.<UTC yyyymmddhhmm>`, which
// sorts before the beta pre-releases and the release of the same version, so
// the in-app updater still offers those. Signing uses ANDROID_KEYSTORE_PATH,
// ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, and ANDROID_KEY_PASSWORD, and
// the Android variables of scripts/android.mjs. The APKs land in target/apk/;
// package.json and tauri.conf.json are restored afterwards.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stamp } from "./version.mjs";

const root = resolve(import.meta.dirname, "..");
for (const name of ["ANDROID_KEYSTORE_PATH", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS"])
  if (!process.env[name]) throw new Error(`${name} must be set to sign the release APK`);

const ABIS = { aarch64: "arm64-v8a", armv7: "armeabi-v7a", i686: "x86", x86_64: "x86_64" };
const FLAVORS = { aarch64: "arm64", armv7: "arm", i686: "x86", x86_64: "x86_64" };
const targets = process.argv.length > 2 ? process.argv.slice(2) : ["aarch64"];
for (const target of targets)
  if (!ABIS[target]) throw new Error(`unknown target ${target}; use ${Object.keys(ABIS)}`);

const now = new Date();
const base = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const version = `${base}-alpha.${now.toISOString().slice(0, 16).replace(/\D/g, "")}`;

const kept = ["package.json", "src-tauri/tauri.conf.json"].map((path) => [
  join(root, path),
  readFileSync(join(root, path)),
]);
let status = 0;
try {
  stamp(root, version, now);
  const build = spawnSync(
    process.execPath,
    [
      join(root, "scripts/android.mjs"),
      "pnpm",
      "tauri",
      "android",
      "build",
      "--apk",
      "--split-per-abi",
      "--target",
      ...targets,
    ],
    { cwd: root, stdio: "inherit" },
  );
  status = build.status ?? 1;
} finally {
  // Restored before exiting: process.exit inside try would skip this.
  for (const [path, contents] of kept) writeFileSync(path, contents);
}
if (status !== 0) process.exit(status);

const out = join(root, "target/apk");
mkdirSync(out, { recursive: true });
for (const target of targets) {
  const flavor = FLAVORS[target];
  const apk = join(out, `GripRead-${version}-Android-${ABIS[target]}.apk`);
  copyFileSync(
    join(
      root,
      `src-tauri/gen/android/app/build/outputs/apk/${flavor}/release/app-${flavor}-release.apk`,
    ),
    apk,
  );
  console.log(apk);
}
