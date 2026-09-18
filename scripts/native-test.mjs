import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const nativeConfig = join("src-tauri", "tauri.native-test.conf.json");
const buildTimeoutMs = positiveIntegerEnv("GRIPREAD_NATIVE_BUILD_TIMEOUT_MS", 20 * 60 * 1000);
const testTimeoutMs = positiveIntegerEnv("GRIPREAD_NATIVE_TEST_TIMEOUT_MS", 5 * 60 * 1000);

if (process.platform !== "darwin") {
  throw new Error("GripRead native acceptance requires macOS and the embedded Tauri WebDriver");
}

const runRoot = await mkdtemp(join(tmpdir(), "gripread-native-"));
const dataDirectory = join(runRoot, "data");
const fixtureDirectory = join(runRoot, "fixtures");
const targetDirectory = join(root, "src-tauri", ".native-target");
const outputDirectory = join(runRoot, "wdio-output");
const wdioPort = process.env.GRIPREAD_NATIVE_WDIO_PORT ?? "4455";
await Promise.all([
  mkdir(dataDirectory, { recursive: true }),
  mkdir(fixtureDirectory, { recursive: true }),
  mkdir(targetDirectory, { recursive: true }),
  mkdir(outputDirectory, { recursive: true }),
]);

const normalizedMixed = createMixedText();
const mixedSource = createMixedSource(normalizedMixed);
const millionSource = "\uFEFF" + "A中😀\r\n".repeat(200_000);
await Promise.all([
  writeFixture("mixed.txt", mixedSource),
  writeFixture("mixed-duplicate.txt", "\uFEFF" + normalizedMixed),
  writeFixture("million.txt", millionSource),
  writeFixture("replacement.txt", "Replacement text\n替换后的内容 😀\n".repeat(12)),
]);

const binary = join(
  targetDirectory,
  "debug",
  process.platform === "win32" ? "gripread.exe" : "gripread",
);
const environment = {
  ...process.env,
  CI: "true",
  CARGO_TARGET_DIR: targetDirectory,
  GRIPREAD_TEST_DATA_DIR: dataDirectory,
  GRIPREAD_NATIVE_FIXTURE_DIR: fixtureDirectory,
  GRIPREAD_NATIVE_BINARY: binary,
  GRIPREAD_NATIVE_OUTPUT_DIR: outputDirectory,
  GRIPREAD_NATIVE_MIXED_TITLE: "mixed",
  GRIPREAD_NATIVE_WDIO_PORT: wdioPort,
  // @wdio/tauri-service's embedded direct-eval client reads this variable in
  // the WDIO process, while the embedded app reads it from its own environment.
  // Keep both sides on the same port or the first browser.tauri.execute() hits
  // the default 4445 endpoint and fails with an opaque fetch error.
  TAURI_WEBDRIVER_PORT: wdioPort,
};

let completed = false;
let activeChild;
let terminationSignal;
const signalHandlers = new Map([
  ["SIGINT", () => requestTermination("SIGINT")],
  ["SIGTERM", () => requestTermination("SIGTERM")],
]);
for (const [signal, handler] of signalHandlers) process.once(signal, handler);
try {
  throwIfTerminated();
  await run(
    [
      "tauri",
      "build",
      "--debug",
      "--no-bundle",
      "--features",
      "native-test",
      "--config",
      nativeConfig,
    ],
    environment,
    "native-test build",
    buildTimeoutMs,
  );

  const phases = [
    ["core", "tests/native/core.spec.ts"],
    ["failures", "tests/native/failures.spec.ts"],
    ["restart", "tests/native/restart.spec.ts"],
    ["interaction", "tests/native/interaction.spec.ts"],
  ];
  for (const [phase, spec] of phases) {
    await run(
      ["exec", "wdio", "run", "wdio.conf.ts", "--spec", spec],
      { ...environment, GRIPREAD_NATIVE_PHASE: phase },
      `native-test ${phase}`,
      testTimeoutMs,
    );
  }
  completed = true;
  console.log("Native WebDriver acceptance passed (embedded macOS WebView).");
} finally {
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  if (completed || process.env.GRIPREAD_NATIVE_CLEANUP_FAILURES === "1") {
    await rm(runRoot, { recursive: true, force: true });
  } else {
    console.error(`Native test artifacts preserved at ${runRoot}`);
  }
}

async function writeFixture(name, content) {
  await writeFile(join(fixtureDirectory, name), content, "utf8");
}

function createMixedText() {
  const paragraph = [
    "ASCII paragraph: the quick brown fox jumps over the lazy dog.",
    "中文段落：阅读位置必须在汉字与标点之间保持稳定。",
    "Emoji boundary: 😀 🚀 🌏 — supplementary characters stay whole.",
    "Line ending coverage follows this line.",
  ].join("\n");
  return `${Array.from({ length: 320 }, (_, index) => `${paragraph} [${index}]`).join("\n")}\n`;
}

function createMixedSource(normalized) {
  const lines = normalized.split("\n");
  const body = lines
    .map((line, index) => {
      if (index === lines.length - 1) return line;
      const ending = index % 3 === 0 ? "\r\n" : index % 3 === 1 ? "\r" : "\n";
      return line + ending;
    })
    .join("");
  return "\uFEFF" + body;
}

function run(args, env, label, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    throwIfTerminated();
    const child = spawn(pnpm, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    activeChild = child;
    let output = "";
    let timeoutError;
    let forceKillTimer;
    let settled = false;
    const timeout = setTimeout(() => {
      timeoutError = new Error(`${label} exceeded its ${timeoutMs} ms timeout`);
      terminateProcess(child, "SIGTERM");
      forceKillTimer = setTimeout(() => terminateProcess(child, "SIGKILL"), 5_000);
      forceKillTimer.unref();
    }, timeoutMs);
    timeout.unref();
    const capture = (chunk) => {
      const text = chunk.toString();
      output = `${output}${text}`.slice(-50_000);
      process.stdout.write(text);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (activeChild === child) activeChild = undefined;
      callback();
    };
    child.once("error", (error) => {
      terminateProcess(child, "SIGTERM");
      finish(() => rejectPromise(new Error(`${label} could not start: ${error.message}`)));
    });
    child.once("exit", (code, signal) => {
      finish(() => {
        if (timeoutError) {
          terminateProcess(child, "SIGKILL");
          rejectPromise(new Error(`${timeoutError.message}\n${output}`));
          return;
        }
        if (terminationSignal) {
          terminateProcess(child, "SIGKILL");
          rejectPromise(new Error(`${label} interrupted by ${terminationSignal}\n${output}`));
          return;
        }
        if (code === 0) {
          resolvePromise();
          return;
        }
        terminateProcess(child, "SIGTERM");
        terminateProcess(child, "SIGKILL");
        rejectPromise(
          new Error(
            `${label} exited with ${signal ? `signal ${signal}` : `code ${code}`}\n${output}`,
          ),
        );
      });
    });
  });
}

function positiveIntegerEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function throwIfTerminated() {
  if (terminationSignal) {
    throw new Error(`Native test interrupted by ${terminationSignal}`);
  }
}

function requestTermination(signal) {
  if (terminationSignal) return;
  terminationSignal = signal;
  if (activeChild) terminateProcess(activeChild, "SIGTERM");
}

function terminateProcess(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}
