import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Options } from "@wdio/types";
import type { TauriCapabilities } from "@wdio/tauri-service";

const root = dirname(fileURLToPath(import.meta.url));
const dataDirectory = process.env.GRIPREAD_TEST_DATA_DIR;
const application =
  process.env.GRIPREAD_NATIVE_BINARY ?? resolve(root, "src-tauri/.native-target/debug/gripread");

if (!dataDirectory) {
  throw new Error(
    "GRIPREAD_TEST_DATA_DIR is required; run the native suite through scripts/native-test.mjs",
  );
}

export const config = {
  rootDir: root,
  runner: "local",
  specs: [resolve(root, "tests/native/**/*.spec.ts")],
  maxInstances: 1,
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: application,
        driverProvider: "embedded",
        embeddedPort: Number(process.env.GRIPREAD_NATIVE_WDIO_PORT ?? 4455),
        startTimeout: 120_000,
        commandTimeout: 60_000,
        statusPollTimeout: 5_000,
        captureBackendLogs: true,
        captureFrontendLogs: true,
        env: {
          GRIPREAD_TEST_DATA_DIR: dataDirectory,
          GRIPREAD_NATIVE_PHASE: process.env.GRIPREAD_NATIVE_PHASE ?? "unknown",
        },
      },
    ],
  ],
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application,
      },
    },
  ],
  framework: "mocha",
  reporters: ["spec"],
  logLevel: process.env.WDIO_LOG_LEVEL === "debug" ? "debug" : "warn",
  outputDir: process.env.GRIPREAD_NATIVE_OUTPUT_DIR,
  bail: 1,
  waitforTimeout: 30_000,
  connectionRetryTimeout: 60_000,
  connectionRetryCount: 0,
  mochaOpts: {
    ui: "bdd",
    timeout: 180_000,
  },
} satisfies Options.Testrunner & { capabilities: TauriCapabilities[] };
