import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { SecurityBootstrap } from "./app/SecurityBootstrap";

// Resolve theme before React mounts so the first paint already matches the
// user's choice (no flash). "auto" follows prefers-color-scheme; light/dark
// are explicit overrides. Stored under the same key App() reads/writes.
(function resolveTheme() {
  const stored = localStorage.getItem("zine-theme");
  const theme = stored === "light" || stored === "dark" ? stored : "auto";
  if (theme !== "auto") document.documentElement.setAttribute("data-theme", theme);
})();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SecurityBootstrap>
      <App />
    </SecurityBootstrap>
  </React.StrictMode>,
);
