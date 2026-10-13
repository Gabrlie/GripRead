// GripRead's version lives in package.json and the Cargo workspace
// (`[workspace.package] version`); the app reads it from package.json.
//
//   node scripts/version.mjs check            both agree
//   node scripts/version.mjs set 0.3.0        writes both, then Cargo.lock
//   node scripts/version.mjs stamp <version> <build>
//       CI only: the build's own version (`0.3.0-dev.17`) in package.json and
//       the Android versionCode in tauri.conf.json, never committed
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const WORKSPACE_VERSION = /(\[workspace\.package\][^[]*?\nversion = ")([^"]+)(")/;

export function versions(root) {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  const cargo = WORKSPACE_VERSION.exec(readFileSync(resolve(root, "Cargo.toml"), "utf8"))?.[2];
  return { pkg, cargo };
}

function writePackageVersion(root, version) {
  const path = resolve(root, "package.json");
  const text = readFileSync(path, "utf8");
  writeFileSync(path, text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
}

export function check(root) {
  const { pkg, cargo } = versions(root);
  const errors = [];
  if (!SEMVER.test(pkg ?? "")) errors.push(`package.json version is not SemVer: ${pkg}`);
  if (pkg !== cargo) errors.push(`package.json (${pkg}) and Cargo.toml (${cargo}) differ`);
  return errors;
}

function set(root, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`expected MAJOR.MINOR.PATCH, got ${version}`);
  writePackageVersion(root, version);
  const cargo = resolve(root, "Cargo.toml");
  writeFileSync(cargo, readFileSync(cargo, "utf8").replace(WORKSPACE_VERSION, `$1${version}$3`));
  execFileSync("cargo", ["update", "--workspace", "--offline"], { cwd: root, stdio: "inherit" });
}

function stamp(root, version, build) {
  if (!SEMVER.test(version)) throw new Error(`not SemVer: ${version}`);
  const code = Number(build);
  if (!Number.isInteger(code) || code < 1)
    throw new Error(`build number must be positive: ${build}`);
  writePackageVersion(root, version);
  const path = resolve(root, "src-tauri/tauri.conf.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.bundle = config.bundle ?? {};
  config.bundle.android = { ...config.bundle.android, versionCode: code };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  const root = process.cwd();
  if (command === "check") {
    const errors = check(root);
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    } else console.log(`Version ${versions(root).pkg}.`);
  } else if (command === "set") set(root, args[0] ?? "");
  else if (command === "stamp") stamp(root, args[0] ?? "", args[1] ?? "");
  else {
    console.error("usage: version.mjs check | set <version> | stamp <version> <build>");
    process.exitCode = 2;
  }
}
