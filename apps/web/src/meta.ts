// Each page's title, its share text and its link preview card (og/<card>.png from the brand's
// cards). The app shows the titles in the tab, and the Worker writes all of it into the HTML so a
// link preview matches the page it points to.

export interface PageMeta {
  readonly title: string;
  readonly description: string;
  readonly card: string;
}

export const LANDING: PageMeta = {
  title: "Vayle: paid limit orders for NVDA",
  description:
    "Name your price once. Each week your order earns that week's premium, skips the week, or fills at exactly your price, settled in the actual token.",
  card: "landing",
};

// Keyed by the path under /app.
export const APP_PAGES: Readonly<Record<string, PageMeta>> = {
  "/": {
    title: "Overview",
    description: "Your orders, what they've earned and what's ready to withdraw.",
    card: "app",
  },
  "/trade": {
    title: "Trade",
    description: "This week's prices for NVDA. Above the close you sell, below it you buy.",
    card: "trade",
  },
  "/orders": {
    title: "Orders",
    description: "Every order, and what it's doing this week.",
    card: "orders",
  },
  "/orders/:id": {
    title: "Order",
    description: "One order: its terms, this week, and what it has earned.",
    card: "orders",
  },
  "/activity": {
    title: "Activity",
    description: "Premiums, fills and withdrawals, each linked to its transaction.",
    card: "activity",
  },
  "/market": {
    title: "Market",
    description:
      "This week's prices, the feed, the limits and the schedule, read from the contracts.",
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
