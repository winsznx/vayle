import { readFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import satori from "satori";

// Vayle's link previews, drawn from data and rendered at build time: the same card for every page,
// with that page's two-line headline and sentence. Satori lays it out and turns text into paths,
// resvg rasterizes it at 1200 by 630. No live numbers go in: platforms keep previews for days.

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

export interface Card {
  // The file name, og/<key>.png.
  readonly key: string;
  // The quiet first line and the ink second line of the headline.
  readonly headline: readonly [string, string];
  readonly sentence: string;
}

export const CARDS: readonly Card[] = [
  {
    key: "landing",
    headline: ["Name your price for NVDA.", "Get paid while it waits."],
    sentence: "Paid limit orders for NVDA on Robinhood Chain, settled in the actual token.",
  },
  {
    key: "app",
    headline: ["Your paid limit orders,", "in one place."],
    sentence: "Your orders, what they've earned and what's ready to withdraw.",
  },
  {
    key: "trade",
    headline: ["This week's prices for NVDA.", "Pick yours on the ladder."],
    sentence:
      "Above the close you sell, below it you buy, and each week the order is paid to wait.",
  },
  {
    key: "orders",
    headline: ["Every order,", "and what it's doing this week."],
    sentence: "Earned, skipped or filled, with what to do next.",
  },
  {
    key: "activity",
    headline: ["Every week,", "on the record."],
    sentence: "Premiums, fills and withdrawals, each linked to its transaction.",
  },
  {
    key: "market",
    headline: ["The market's state,", "straight from the contracts."],
    sentence: "This week's prices, the feed, the limits and the schedule.",
  },
];

const INK = "#04060f";
const GHOST = "#8a90a2";
const MUTED = "#5b6072";
const PAGE = "#e4e7f1";
const SHEET = "#ffffff";
const RAISED = "#fafbfe";
const SUNKEN = "#f3f5f9";
const HAIRLINE = "#e6e8ef";
const FAINT = "#9298a8";
const BLUE = "#253cef";
const BLUE_SOFT = "#f0f1ff";

const root = new URL("../", import.meta.url);
const file = (path: string): Buffer => readFileSync(new URL(path, root));
const dataUri = (path: string, type: string): string =>
  `data:${type};base64,${file(path).toString("base64")}`;

function font(weight: 400 | 500 | 600): { name: string; data: Buffer; weight: 400 | 500 | 600 } {
  return {
    name: "Plus Jakarta Sans",
    data: readFileSync(
      new URL(
        `node_modules/@fontsource/plus-jakarta-sans/files/plus-jakarta-sans-latin-${weight}-normal.woff`,
        root,
      ),
    ),
    weight,
  };
}

// Satori lays out with flexbox only, so every box is a flex container unless it says otherwise.
function h(type: string, style: CSSProperties, ...children: ReactNode[]): ReactElement {
  return { type, props: { style: { display: "flex", ...style }, children }, key: null };
}

function img(src: string, style: CSSProperties): ReactElement {
  return { type: "img", props: { src, style }, key: null };
}

function rung(held: boolean): ReactElement {
  if (held) {
    return h(
      "div",
      {
        position: "relative",
        display: "flex",
        alignItems: "center",
        height: 42,
        paddingLeft: 10,
        borderRadius: 12,
        background: BLUE_SOFT,
      },
      h("div", {
        position: "absolute",
        left: "100%",
        top: 20,
        width: 420,
        height: 3,
        backgroundImage: `linear-gradient(90deg, ${BLUE} 30%, rgba(37, 60, 239, 0))`,
      }),
      h(
        "div",
        {
          display: "flex",
          padding: "5px 12px",
          borderRadius: 999,
          color: SHEET,
          background: BLUE,
          fontSize: 15,
          fontWeight: 600,
        },
        "Your price",
      ),
    );
  }
  return h(
    "div",
    { display: "flex", alignItems: "center", height: 42, borderTop: `1px solid ${HAIRLINE}` },
    h("div", { width: "44%", height: 8, marginLeft: 12, borderRadius: 4, background: SUNKEN }),
  );
}

function ladder(nvdaLogo: string): ReactElement {
  return h(
    "div",
    {
      position: "absolute",
      top: 100,
      right: 92,
      display: "flex",
      flexDirection: "column",
      width: 336,
      padding: 18,
      borderRadius: 26,
      background: RAISED,
      boxShadow: `0 0 0 1px ${HAIRLINE}, 0 28px 56px -18px rgba(4, 6, 15, 0.24)`,
    },
    h(
      "div",
      {
        display: "flex",
        alignItems: "center",
        gap: 12,
        paddingBottom: 14,
        borderBottom: `1px solid ${HAIRLINE}`,
        color: INK,
        fontSize: 18,
        fontWeight: 600,
      },
      img(nvdaLogo, { width: 36, height: 36, borderRadius: 11 }),
      "NVDA",
    ),
    rung(false),
    rung(false),
    rung(true),
    rung(false),
    h("div", { display: "flex", height: 30, borderTop: `2px dashed ${FAINT}` }),
    rung(false),
    rung(false),
  );
}

function tokenNote(src: string, round: boolean, text: string): ReactElement {
  return h(
    "div",
    { display: "flex", alignItems: "center", gap: 10 },
    img(src, { width: 28, height: 28, borderRadius: round ? 14 : 9 }),
    text,
  );
}

function card(c: Card): ReactElement {
  const nvda = dataUri("assets/tokens/nvda.png", "image/png");
  const usdg = dataUri("assets/tokens/usdg.png", "image/png");
  const lockup = dataUri("source/vayle-lockup-horizontal.svg", "image/svg+xml");
  return h(
    "div",
    {
      display: "flex",
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      padding: 18,
      background: PAGE,
      fontFamily: "Plus Jakarta Sans",
    },
    h(
      "div",
      {
        position: "relative",
        display: "flex",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        borderRadius: 34,
        background: SHEET,
      },
      img(lockup, { position: "absolute", top: 56, left: 64, height: 44 }),
      h(
        "div",
        {
          position: "absolute",
          top: 176,
          left: 64,
          display: "flex",
          flexDirection: "column",
          width: 620,
          fontSize: 52,
          fontWeight: 400,
          letterSpacing: -1.8,
          lineHeight: 1.04,
        },
        h("div", { display: "flex", color: GHOST }, c.headline[0]),
        h("div", { display: "flex", color: INK }, c.headline[1]),
      ),
      h(
        "div",
        {
          position: "absolute",
          top: 318,
          left: 66,
          display: "flex",
          width: 520,
          color: MUTED,
          fontSize: 22,
          lineHeight: 1.45,
        },
        c.sentence,
      ),
      ladder(nvda),
      h(
        "div",
        {
          position: "absolute",
          bottom: 56,
          left: 66,
          display: "flex",
          gap: 26,
          color: INK,
          fontSize: 18,
          fontWeight: 500,
        },
        tokenNote(nvda, false, "NVDA Stock Token"),
        tokenNote(usdg, true, "Premium in USDG"),
      ),
    ),
  );
}

// One card as a PNG.
export async function renderCard(c: Card): Promise<Buffer> {
  const svg = await satori(card(c), {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts: [font(400), font(500), font(600)],
  });
  return new Resvg(svg, { fitTo: { mode: "width", value: CARD_WIDTH } }).render().asPng();
}
