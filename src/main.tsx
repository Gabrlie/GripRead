import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import { applySystemInsets } from "./services/insets";
import "@fontsource-variable/literata/wght.css";
import "@fontsource-variable/noto-serif-sc/wght.css";
import "@fontsource-variable/hanken-grotesk/wght.css";
import "./styles.css";

async function start() {
  applySystemInsets();
  if (import.meta.env.MODE === "native-test") {
    await import("@wdio/tauri-plugin");
  }

  // Preview mode renders the real UI with in-memory data in a plain browser.
  const services =
    import.meta.env.MODE === "preview"
      ? (await import("./preview/services")).previewServices()
      : undefined;
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App services={services} />
    </React.StrictMode>,
  );
}
void start().catch((error) => {
  console.error(error);
  document.getElementById("root")!.textContent = "应用初始化失败，请重新启动。";
});
