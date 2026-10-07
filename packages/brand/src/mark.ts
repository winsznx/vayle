// The Vayle symbol on its 48-unit grid: a ladder of prices with one rung, the holder's, running out
// past the rails. Every SVG master and raster export is generated from these paths, so the mark
// can't drift between surfaces.
export const MARK_VIEWBOX = "0 0 48 48";

// The symbol's own bounds inside the grid. Lockups and inline uses frame the symbol with this so
// the ladder sits flush with the edge it's aligned to.
export const MARK_BOUNDS_VIEWBOX = "8 3 37 42";

// The whole symbol as one outline, for single-colour use.
export const MARK_PATH =
  "M8 5A2 2 0 0 1 12 5V10H24V5A2 2 0 0 1 28 5V21H42A3 3 0 0 1 42 27H28V43A2 2 0 0 1 24 43V38H12V43A2 2 0 0 1 8 43ZM12 14V21H24V14ZM12 27V34H24V27Z";

// The two-colour symbol: the ladder, and the held rung drawn over it in the brand colour.
export const MARK_LADDER_PATH =
  "M8 5A2 2 0 0 1 12 5V10H24V5A2 2 0 0 1 28 5V43A2 2 0 0 1 24 43V38H12V43A2 2 0 0 1 8 43ZM12 14V21H24V14ZM12 27V34H24V27Z";
export const MARK_HELD_PATH = "M12 21H42A3 3 0 0 1 42 27H12Z";

// The symbol redrawn on whole pixels inside a 16-unit tile, for 16 and 32 px icons where the
// master's rounded ends and 4-unit rails would blur.
export const MARK_SMALL_VIEWBOX = "0 0 16 16";
export const MARK_SMALL_PATH =
  "M4 3H5V5H8V3H9V7H12A1 1 0 0 1 12 9H9V13H8V11H5V13H4ZM5 6V7H8V6ZM5 9V10H8V9Z";
