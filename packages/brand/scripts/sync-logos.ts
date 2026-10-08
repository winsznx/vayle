// Downloads the logo of every asset Vayle can show, every Stock Token in the market check and USDG,
// and pins each one by checksum in logos/manifest.json. A logo whose bytes change upstream fails
// the run: a changed logo is a decision for a person, so check it and rerun with --accept, and the
// manifest records the new hash. A new asset needs --accept too.
//
// Where each logo comes from is kept in a sources file outside the repo, since it names outside
// services:
//   node scripts/sync-logos.ts --sources <file> [--accept]
// It maps each symbol to { sourceUrl, plate, art }. plate is the ground the logo sits on, light for
// most and dark for a white mark. art says how it sits there: full for a logo that's already a
// tile and fills it, inset for a bare mark with transparent corners, which gets a margin.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import check from "../../../deployments/market-check.json" with { type: "json" };

class LogoRefused extends Error {
  override readonly name = "LogoRefused";
}

class SourcesMissing extends Error {
  override readonly name = "SourcesMissing";
}

type Plate = "light" | "dark";
type Art = "full" | "inset";

interface Source {
  readonly sourceUrl: string;
  readonly plate: Plate;
  readonly art: Art;
}

export interface Logo {
  file: string;
  sha256: string;
  bytes: number;
  contentType: "image/png" | "image/webp";
  plate: Plate;
  art: Art;
  retrievedAt: string;
}

const dir = new URL("../logos/", import.meta.url);
const manifestUrl = new URL("manifest.json", dir);
const accept = process.argv.includes("--accept");
// A real logo is never this small. A smaller download is an error page or an empty image.
const MIN_BYTES = 200;
// The shared placeholder the issuer serves for every Stock Token, and the image a coin directory
// shows by contract, both the network operator's mark. Neither is an asset's logo.
const PLACEHOLDERS: ReadonlySet<string> = new Set([
  "3acff25ee4e8f842d245c315002965c712c7f42f00fff4377e1ad8ce88d78ab1",
  "1d27692eb0b9da6c00e92ca16566f8174de2d73320d872d2ac01ec17a92c9262",
]);

function sourcesPath(): string {
  const at = process.argv.indexOf("--sources");
  const path = at === -1 ? undefined : process.argv[at + 1];
  if (path === undefined) {
    throw new SourcesMissing("usage: node scripts/sync-logos.ts --sources <file> [--accept]");
  }
  return resolve(path);
}

function contentTypeOf(bytes: Buffer): Logo["contentType"] | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

// Every Stock Token the market check lists, and the payment token.
function symbols(): string[] {
  return [...check.tokens.map((t) => t.symbol), facts.usdg.symbol];
}

const sourcesFile = sourcesPath();
const sources = (JSON.parse(readFileSync(sourcesFile, "utf8")) as { logos: Record<string, Source> })
  .logos;
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as {
  schema: number;
  about: string;
  logos: Record<string, Logo>;
};

const failures: string[] = [];
const kept = new Set<string>();
for (const symbol of symbols()) {
  const source = sources[symbol];
  if (source === undefined) {
    failures.push(`${symbol}: ${sourcesFile} has no source for it`);
    continue;
  }
  const response = await fetch(source.sourceUrl, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!response.ok) {
    failures.push(`${symbol}: its source answered ${response.status}`);
    continue;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const contentType = contentTypeOf(bytes);
  const pinned = manifest.logos[symbol];
  if (bytes.length < MIN_BYTES || contentType === null) {
    failures.push(`${symbol}: its source returned ${bytes.length} bytes that aren't a PNG or WebP`);
    continue;
  }
  if (PLACEHOLDERS.has(sha256)) {
    failures.push(`${symbol}: its source returned the shared placeholder, not the asset's logo`);
    continue;
  }
  const file = `${symbol.toLowerCase()}.${contentType === "image/png" ? "png" : "webp"}`;
  kept.add(file);
  if (pinned?.sha256 === sha256 && pinned.plate === source.plate && pinned.art === source.art) {
    console.log(`${symbol}: unchanged`);
    continue;
  }
  if (!accept) {
    failures.push(
      pinned === undefined
        ? `${symbol}: not pinned yet, ${sha256}`
        : `${symbol}: now ${sha256}, the manifest pins ${pinned.sha256}`,
    );
    continue;
  }
  writeFileSync(new URL(file, dir), bytes);
  manifest.logos[symbol] = {
    file,
    sha256,
    bytes: bytes.length,
    contentType,
    plate: source.plate,
    art: source.art,
    retrievedAt: new Date().toISOString(),
  };
  console.log(`${symbol}: accepted ${sha256}`);
}

if (accept && failures.length === 0) {
  const listed = new Set(symbols());
  for (const name of readdirSync(dir)) {
    if (/\.(png|webp)$/.test(name) && !kept.has(name)) rmSync(new URL(name, dir));
  }
  manifest.logos = Object.fromEntries(
    Object.entries(manifest.logos)
      .filter(([symbol]) => listed.has(symbol))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  throw new LogoRefused("check the logos above, then rerun with --accept");
}
