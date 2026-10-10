import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "@cafe-loyalty/ui/fonts.css";
import "@cafe-loyalty/ui/tokens.css";
import "@cafe-loyalty/ui/base.css";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("Root element #root is missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
