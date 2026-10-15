import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import { applySystemInsets } from "./services/insets";
import { captureLongTasks, captureUncaughtErrors } from "./services/log";
import { native } from "./services/transport";
import "@fontsource-variable/literata/wght.css";
import "@fontsource-variable/noto-serif-sc/wght.css";
import "@fontsource-variable/hanken-grotesk/wght.css";
import "./styles.css";
import { t } from "./i18n";

async function start() {
  applySystemInsets();
  captureUncaughtErrors();
  captureLongTasks();
  if (import.meta.env.MODE === "native-test") {
    await import("@wdio/tauri-plugin");
  }

  // Preview mode renders the real UI with in-memory data in a plain browser.
  const services =
    import.meta.env.MODE === "preview"
      ? (await import("./preview/services")).previewServices()
      : undefined;
  // Served by the GripRead server, the page signs in first.
  const web = !native && import.meta.env.MODE !== "preview";
  const { WebGate } = web ? await import("./components/Web/WebGate") : { WebGate: null };
  const app = <App services={services} />;
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>{WebGate ? <WebGate>{app}</WebGate> : app}</React.StrictMode>,
  );
}
void start().catch((error) => {
  console.error(error);
  document.getElementById("root")!.textContent = t("app.startFailed");
});
