import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./globals.css";
import { installGlobalErrorReporting } from "./shared/utils/clientErrorReporting";

// Installed BEFORE the first render so a failure during mount is still
// reported. Without this, a render throw unmounts the tree and the page goes
// blank with no trace of the cause.
installGlobalErrorReporting();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
