import "../ui/ui.css";
import "./landing.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Landing } from "./Landing.tsx";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element.");

createRoot(root).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
);
