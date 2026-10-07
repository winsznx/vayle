# Brand

Vayle's identity in one package: the symbol's geometry, the design tokens, the logo masters, the favicons and app icons, the social card and the token logos. [`design.md`](design.md) is the spec. It covers what each piece is for, the colour roles, contrast, type, layout and the rules for using the mark. [`brand.json`](brand.json) is the same spec for machines.

## Using it

```ts
import { MARK_BOUNDS_VIEWBOX, MARK_HELD_PATH, MARK_LADDER_PATH } from "@vayle/brand/mark";
import nvda from "@vayle/brand/assets/tokens/nvda.png";
```

```css
@import "@vayle/brand/tokens.css";
```

`tokens.css` defines every colour, type size, space, radius, shadow and motion value as a custom property, for light and dark. Draw the symbol from `src/mark.ts` instead of copying an SVG, so it can't drift.

## What's here

| Path             | Contents                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `src/mark.ts`    | The symbol's paths: two-colour, one-colour, and the small version drawn on whole pixels                  |
| `css/tokens.css` | Design tokens                                                                                            |
| `source/`        | Symbol, wordmark, horizontal and stacked lockups in colour, black, white and reversed, plus the app icon |
| `favicon/`       | Favicon SVG and ICO, PNG renders, and the iOS and web app icons                                          |
| `social/`        | The 1200 by 630 social card and the page it's rendered from                                              |
| `assets/tokens/` | NVDA and USDG logos, with where each came from and its checksum in `manifest.json`                       |

## Rebuilding

The masters and icons are generated, never edited by hand. After changing `src/mark.ts` or the wordmark settings:

```sh
pip install fonttools brotli uharfbuzz cairosvg
python scripts/build_masters.py
```

It writes `source/` and `favicon/`, and copies the served icons into `apps/web/public/`. On macOS with Homebrew's cairo, run it with `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`. Then re-render the social card by opening `social/og.html` at 1200 by 630 and saving a screenshot over `social/vayle-og-1200x630.png` and `apps/web/public/og.png`.

The token logos are pinned by checksum in `assets/tokens/manifest.json`. Where each one comes from is kept in a sources file outside the repo, mapping each symbol to its `sourceUrl`. To re-download them and check nothing changed:

```sh
node scripts/sync-tokens.ts --sources <file>
```

It stops with an error if a file's checksum changed. Pass `--accept` once you've looked at the new file.

## Checks

```sh
pnpm --filter @vayle/brand test
```

The tests fail if a master or icon wasn't regenerated after a change to `src/mark.ts`, if an SVG carries text, scripts or outside references, if the web app serves different icons from this package, or if a token logo doesn't match its manifest.
