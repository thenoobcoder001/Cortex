import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { migrateLegacyStorageKeys } from "./app/utils.js";
import "./styles.css";

// Must run before App mounts: its state initialisers read the "cortex.*" keys.
migrateLegacyStorageKeys();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
