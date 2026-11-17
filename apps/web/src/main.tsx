import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RuntimeStartup } from "./startup/RuntimeStartup";
import "./styles.css";

const root = document.getElementById("root");
const loadApplication = () => import("./App");

if (!root) {
  throw new Error("Root element #root was not found.");
}

createRoot(root).render(
  <StrictMode>
    <RuntimeStartup loadApplication={loadApplication} />
  </StrictMode>
);
