// Each page's title, its share text and its link preview card (og/<card>.png from the brand's
// cards). The app shows the titles in the tab, and the Worker writes all of it into the HTML so a
// link preview matches the page it points to.

export interface PageMeta {
  readonly title: string;
  readonly description: string;
  readonly card: string;
}

export const LANDING: PageMeta = {
  title: "Vayle: weekly pay for Stock Token holders",
  description:
    "Pick the price you'd sell at. Get paid while you wait for it. Each week a buyer pays you for the right to buy your tokens at that price when the market closes Friday.",
  card: "landing",
};

export const PROOF: PageMeta = {
  title: "Vayle on mainnet",
  description:
    "Every Vayle transaction on Robinhood Chain mainnet, the deployed contracts, the market check, the tests, and how many wallets outside the team have set targets.",
  card: "landing",
};

// Keyed by the path under /app.
export const APP_PAGES: Readonly<Record<string, PageMeta>> = {
  "/": {
    title: "Overview",
    description: "Your targets, what they've earned and what's ready to withdraw.",
    card: "app",
  },
  "/trade": {
    title: "Trade",
    description:
      "This week's rates for each Stock Token. Set a sell target above the close or a buy target below it.",
    card: "trade",
  },
  "/markets": {
    title: "Markets",
    description:
      "Every Stock Token market: the live ones with their week and rates, and the rest with what the market check found.",
    card: "markets",
  },
  "/orders": {
    title: "Targets",
    description: "Every target, and what it's doing this week.",
    card: "orders",
  },
  "/orders/:id": {
    title: "Target",
    description: "One target: its terms, this week, and what it has earned.",
    card: "orders",
  },
  "/activity": {
    title: "Activity",
    description: "Payments, fills and withdrawals, each linked to its transaction.",
    card: "activity",
  },
  "/market": {
    title: "Status",
    description: "Each market's week, feed, limits and schedule, read from the contracts.",
    card: "market",
  },
};

export const NOT_FOUND: PageMeta = {
  title: "Not found",
  description: "There's no page here.",
  card: "app",
};

// The meta for a path under /app, with a flag for paths that aren't a page.
export function appPage(path: string): { readonly meta: PageMeta; readonly found: boolean } {
  const exact = APP_PAGES[path];
  if (exact !== undefined) return { meta: exact, found: true };
  if (/^\/orders\/\d+$/.test(path)) {
    const order = APP_PAGES["/orders/:id"];
    if (order !== undefined) return { meta: order, found: true };
  }
  return { meta: NOT_FOUND, found: false };
}

export function tabTitle(title: string): string {
  return `${title} | Vayle`;
}
