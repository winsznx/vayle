// Re-downloads every asset logo in assets/tokens/manifest.json and fails loudly if the bytes
// changed. A changed logo is a decision for a person, not something to accept quietly: rerun with
// --accept after checking the new image, and the manifest records the new hash.
//
// Where each logo comes from lives in a sources file kept outside the repo:
//   node scripts/sync-tokens.ts --sources <file> [--accept]
// The file maps each symbol to { sourceUrl } or, for a logo found by its contract address,
// { sourceUrl, resolvedVia } where resolvedVia answers with the current image URL.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

class LogoChanged extends Error {
  override readonly name = "LogoChanged";
}

class SourcesMissing extends Error {
  override readonly name = "SourcesMissing";
}

interface Icon {
  sha256: string;
  bytes: number;
  file: string;
  retrievedAt: string;
}

interface Source {
  sourceUrl: string;
  resolvedVia?: string;
}

const dir = new URL("../assets/tokens/", import.meta.url);
const manifestUrl = new URL("manifest.json", dir);
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as { icons: Record<string, Icon> };
const accept = process.argv.includes("--accept");
// A real logo is never this small; a smaller download is an error page or a placeholder.
const MIN_BYTES = 400;

function sourcesPath(): string {
  const at = process.argv.indexOf("--sources");
  const path = at === -1 ? undefined : process.argv[at + 1];
  if (path === undefined) {
    throw new SourcesMissing("usage: node scripts/sync-tokens.ts --sources <file> [--accept]");
  }
  return resolve(path);
}

const sourcesFile = sourcesPath();
const sources = JSON.parse(readFileSync(sourcesFile, "utf8")) as {
  icons: Record<string, Source>;
};

async function urlOf(source: Source): Promise<string> {
  if (source.resolvedVia === undefined) return source.sourceUrl;
  const response = await fetch(source.resolvedVia);
  if (!response.ok) throw new LogoChanged(`${source.resolvedVia} answered ${response.status}`);
  const info = (await response.json()) as { data?: { attributes?: { image_url?: string } } };
  const url = info.data?.attributes?.image_url;
  if (url === undefined) throw new LogoChanged(`${source.resolvedVia} lists no image`);
  return url;
}

const failures: string[] = [];
for (const [symbol, icon] of Object.entries(manifest.icons)) {
  const source = sources.icons[symbol];
  if (source === undefined) {
    failures.push(`${symbol}: ${sourcesFile} has no source for it`);
    continue;
  }
  const url = await urlOf(source);
  const response = await fetch(url);
  if (!response.ok) {
    failures.push(`${symbol}: ${url} answered ${response.status}`);
    continue;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length < MIN_BYTES) {
    failures.push(`${symbol}: ${url} returned only ${bytes.length} bytes`);
  } else if (sha256 === icon.sha256 && url === source.sourceUrl) {
    console.log(`${symbol}: unchanged`);
  } else if (accept) {
    writeFileSync(new URL(icon.file, dir), bytes);
    Object.assign(icon, { sha256, bytes: bytes.length, retrievedAt: new Date().toISOString() });
    source.sourceUrl = url;
    console.log(`${symbol}: accepted ${sha256}`);
  } else {
    failures.push(`${symbol}: ${url} now has sha256 ${sha256}, the manifest pins ${icon.sha256}`);
  }
}

if (accept) {
  writeFileSync(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(sourcesFile, `${JSON.stringify(sources, null, 2)}\n`);
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  throw new LogoChanged("a logo changed upstream; check it, then rerun with --accept");
}
