import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./index.css";

async function boot() {
  // Browser preview: install the IPC mock only when not running inside Tauri.
  if (!("__TAURI_INTERNALS__" in window)) {
    const { installMock } = await import("./lib/mock");
    installMock();
  }
  const { default: App } = await import("./App");
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
void boot();
