import "../ui/ui.css";
import "./proof.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Proof, type ProofData } from "./Proof.tsx";

// The record tools/proof writes. A build made before it exists still works and says so.
const records = import.meta.glob<{ default: ProofData }>("../../../../deployments/proof.json", {
  eager: true,
});
const data = Object.values(records)[0]?.default ?? null;

const root = document.getElementById("root");
if (root === null) throw new Error("proof/index.html has no #root element.");

createRoot(root).render(
  <StrictMode>
    <Proof data={data} />
  </StrictMode>,
);
