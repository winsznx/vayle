import { CASH_SYMBOL } from "../tokens.ts";

// A token named by its ticker in a badge, the brand's mark for every token: a Stock Token in an ink
// tile, USDG in an outlined pill. Badges take the place of artwork, so no company's or issuer's mark
// appears anywhere. The badge sits left of the text that names the token, so it's decorative by
// default; pass `named` when it stands alone.

export type BadgeSize = "xs" | "sm" | "md" | "lg" | "xl" | "hero";

export function TickerBadge({
  symbol,
  size = "md",
  named = false,
  quiet = false,
}: {
  readonly symbol: string;
  readonly size?: BadgeSize;
  readonly named?: boolean;
  // An outlined tile instead of a filled one, for a choice that isn't the current one.
  readonly quiet?: boolean;
}) {
  const kind = symbol === CASH_SYMBOL ? "ticker-cash" : quiet ? "ticker-quiet" : "ticker-stock";
  return (
    <span className={`ticker ticker-${size} ${kind}`} aria-hidden={named ? undefined : true}>
      {symbol}
    </span>
  );
}
