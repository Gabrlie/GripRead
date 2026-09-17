import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(pnpm, ["tauri", "dev", "--no-watch"], {
  cwd: root,
  env: { ...process.env, CI: "true" },
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
});

let output = "";
let settled = false;
const timeout = setTimeout(() => {
  finish(new Error("timed out waiting for the Tauri native host to start"));
}, 60_000);

function finish(error) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  stopChild("SIGINT");
  setTimeout(() => stopChild("SIGTERM"), 2_000).unref();
  if (error) {
    console.error(`${error.message}\n${output}`);
    process.exitCode = 1;
  } else {
    console.log("Native Tauri startup smoke passed.");
  }
}

function stopChild(signal) {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between startup detection and cleanup.
    }
  }
  child.kill(signal);
}

function observe(chunk) {
  output += chunk.toString();
  if (/Running[\s\S]*target[\\/]debug[\\/]gripread(?:\.exe)?/.test(output)) {
    finish();
  }
}

child.stdout.on("data", observe);
child.stderr.on("data", observe);
child.once("error", (error) => finish(error));
child.once("exit", (code, signal) => {
  if (!settled) {
    finish(new Error(`Tauri host exited before startup (code=${code}, signal=${signal})`));
  }
});
