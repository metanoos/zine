import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { SecurityBootstrap } from "./app/SecurityBootstrap";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SecurityBootstrap>
      <App />
    </SecurityBootstrap>
  </React.StrictMode>,
);
