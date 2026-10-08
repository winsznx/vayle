import manifest from "@vayle/brand/logos/manifest.json" with { type: "json" };
import { CASH_SYMBOL } from "../tokens.ts";
import { TickerBadge, type BadgeSize } from "./TickerBadge.tsx";

// An asset's real logo from the brand package's pinned files: a Stock Token shows the mark of the
// company or fund it tracks in a rounded tile, USDG its own mark in a disc. A bare mark sits inset
// on its plate, and a logo that's already a tile fills it. The logo goes left of the text that
// names the asset, so it's decorative by default; `named` gives it the ticker as its name, and
// `label` shows the ticker beside it where nothing else names the asset. An asset with no pinned
// logo, like a token this build doesn't know, falls back to its ticker badge.

interface Logo {
  readonly file: string;
  readonly sha256: string;
  readonly plate: string;
  readonly art: string;
}

const LOGOS: Readonly<Record<string, Logo>> = manifest.logos;

// Files are served from /logos/ by the web build. The hash keeps a cached copy from outliving a
// change to the pinned file.
export function logoSrc(symbol: string): string | null {
  const logo = LOGOS[symbol];
  return logo === undefined ? null : `/logos/${logo.file}?v=${logo.sha256.slice(0, 12)}`;
}

export function TokenLogo({
  symbol,
  size = "md",
  named = false,
  quiet = false,
  label = false,
}: {
  readonly symbol: string;
  readonly size?: BadgeSize;
  readonly named?: boolean;
  // Dimmed, for a choice that isn't the current one.
  readonly quiet?: boolean;
  readonly label?: boolean;
}) {
  const logo = LOGOS[symbol];
  const src = logoSrc(symbol);
  if (logo === undefined || src === null) {
    return <TickerBadge symbol={symbol} size={size} named={named || label} quiet={quiet} />;
  }
  const shape = symbol === CASH_SYMBOL ? "disc" : "tile";
  const mark = (
    <span
      className={`logo logo-${size} logo-${shape} logo-${logo.art} logo-plate-${logo.plate}${quiet ? " logo-quiet" : ""}`}
    >
      <img src={src} alt={named && !label ? symbol : ""} decoding="async" loading="lazy" />
    </span>
  );
  if (!label) return mark;
  return (
    <span className={`logo-labeled logo-labeled-${size}${quiet ? " logo-quiet" : ""}`}>
      {mark}
      <span className="logo-label">{symbol}</span>
    </span>
  );
}
