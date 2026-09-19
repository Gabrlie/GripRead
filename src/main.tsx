import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import "@fontsource-variable/literata/wght.css";
import "@fontsource-variable/noto-serif-sc/wght.css";
import "@fontsource-variable/hanken-grotesk/wght.css";
import "./styles.css";

async function start() {
  if (import.meta.env.MODE === "native-test") {
    await import("@wdio/tauri-plugin");
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
void start().catch((error) => {
  console.error(error);
  document.getElementById("root")!.textContent = "应用初始化失败，请重新启动。";
});
