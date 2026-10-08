import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { diffFacts, serializeFacts } from "./facts.ts";
import { resolveFacts, rpcClient } from "./resolve.ts";

const OUTPUT = fileURLToPath(
  new URL("../../../deployments/robinhood-mainnet.json", import.meta.url),
);

function formatValue(value: unknown): string {
  return JSON.stringify(value);
}

// The committed facts' Multicall3 creation block, which verify keeps when the RPC can't check it.
function recordedMulticall3Created(committed: unknown): number | null {
  if (typeof committed !== "object" || committed === null) return null;
  const multicall3 = (committed as { multicall3?: { blockCreated?: unknown } }).multicall3;
  return typeof multicall3?.blockCreated === "number" ? multicall3.blockCreated : null;
}

async function main(mode: string | undefined): Promise<number> {
  const client = rpcClient(process.env);
  const committed: unknown = mode === "verify" ? JSON.parse(readFileSync(OUTPUT, "utf8")) : null;
  const facts = await resolveFacts(client, new Date(), recordedMulticall3Created(committed));
  if (mode === "resolve") {
    writeFileSync(OUTPUT, serializeFacts(facts));
    console.log(`wrote ${OUTPUT} at block ${facts.block.number}`);
    return 0;
  }
  if (mode === "verify") {
    const differences = diffFacts(committed, JSON.parse(serializeFacts(facts)));
    for (const d of differences) {
      const tag = d.volatile ? "changed" : "DRIFT  ";
      console.log(`${tag} ${d.path}: ${formatValue(d.committed)} -> ${formatValue(d.current)}`);
    }
    const drift = differences.filter((d) => !d.volatile).length;
    console.log(
      `block ${facts.block.number}: ${drift} drifted, ${differences.length - drift} volatile changes`,
    );
    return drift > 0 ? 1 : 0;
  }
  console.error("usage: chain-facts <resolve|verify>");
  return 2;
}

main(process.argv[2]).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const named = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`chain-facts: ${named}`);
    process.exitCode = 1;
  },
);
