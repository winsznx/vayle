import { MARK_BOUNDS_VIEWBOX, MARK_HELD_PATH, MARK_LADDER_PATH } from "@vayle/brand/mark";

// The symbol, with the ladder in the text colour and the held rung in the brand colour, and the
// wordmark beside it unless `symbolOnly`.
export function BrandMark({ symbolOnly = false }: { readonly symbolOnly?: boolean }) {
  return (
    <span className="brand">
      <svg
        className="brand-symbol"
        viewBox={MARK_BOUNDS_VIEWBOX}
        aria-hidden="true"
        focusable="false"
      >
        <path className="brand-ladder" d={MARK_LADDER_PATH} />
        <path className="brand-held" d={MARK_HELD_PATH} />
      </svg>
      {symbolOnly ? (
        <span className="visually-hidden">Vayle</span>
      ) : (
        <span className="brand-word">Vayle</span>
      )}
    </span>
  );
}
