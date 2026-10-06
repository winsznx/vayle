// Writes each deployable contract's ABI from the forge artifacts into src/generated, or with
// --check, fails when a committed file no longer matches the artifacts. Run it after forge build.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEPLOYABLES, kebab, moduleSource } from "./source.ts";

class ArtifactMissing extends Error {
  override readonly name = "ArtifactMissing";
}

class AbiOutOfDate extends Error {
  override readonly name = "AbiOutOfDate";
}

const ARTIFACTS = new URL("../../../contracts/out/", import.meta.url);
const GENERATED = new URL("./generated/", import.meta.url);

function readAbi(name: string): unknown {
  const path = fileURLToPath(new URL(`${name}.sol/${name}.json`, ARTIFACTS));
  if (!existsSync(path)) throw new ArtifactMissing(`no artifact at ${path}; run forge build`);
  const artifact = JSON.parse(readFileSync(path, "utf8")) as { abi: unknown };
  return artifact.abi;
}

function run(check: boolean): void {
  const stale: string[] = [];
  for (const name of DEPLOYABLES) {
    const path = fileURLToPath(new URL(`${kebab(name)}.ts`, GENERATED));
    const source = moduleSource(name, readAbi(name));
    if (!check) writeFileSync(path, source);
    else if (!existsSync(path) || readFileSync(path, "utf8") !== source) stale.push(name);
  }
  if (stale.length > 0) {
    throw new AbiOutOfDate(`run pnpm --filter @vayle/abi generate: ${stale.join(", ")} changed`);
  }
}

try {
  run(process.argv.includes("--check"));
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
}
