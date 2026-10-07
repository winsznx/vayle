import nvda from "@vayle/brand/assets/tokens/nvda.png";
import usdg from "@vayle/brand/assets/tokens/usdg.png";

// Asset logos come only from the checksummed files in the brand package. Stock Tokens sit in a
// rounded-square tile, the payment token in a disc. The icon goes left of the text that names it,
// so it's decorative by default; pass `named` when it stands alone.

export type TokenSymbol = "NVDA" | "USDG";
export type TokenSize = "xs" | "sm" | "md" | "lg" | "xl" | "hero";

const TOKENS: Readonly<Record<TokenSymbol, { src: string; shape: "tile" | "disc"; name: string }>> =
  {
    NVDA: { src: nvda, shape: "tile", name: "NVDA Stock Token" },
    USDG: { src: usdg, shape: "disc", name: "USDG" },
  };

const PX: Readonly<Record<TokenSize, number>> = {
  xs: 16,
  sm: 20,
  md: 24,
  lg: 34,
  xl: 44,
  hero: 60,
};

export function TokenIcon({
  symbol,
  size = "md",
  named = false,
}: {
  readonly symbol: TokenSymbol;
  readonly size?: TokenSize;
  readonly named?: boolean;
}) {
  const token = TOKENS[symbol];
  const px = PX[size];
  return (
    <span className={`token token-${token.shape}`} style={{ width: px, height: px }}>
      <img src={token.src} width={px} height={px} alt={named ? token.name : ""} decoding="async" />
    </span>
  );
}
