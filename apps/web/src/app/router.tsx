import { createBrowserRouter } from "react-router";
import { ActivityPage } from "./pages/Activity.tsx";
import { MarketPage } from "./pages/Market.tsx";
import { MarketsPage } from "./pages/Markets.tsx";
import { NotFoundPage } from "./pages/NotFound.tsx";
import { OrderPage } from "./pages/Order.tsx";
import { OrdersPage } from "./pages/Orders.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { TradePage } from "./pages/Trade.tsx";
import { AppShell, RouteError, type RouteHandle } from "./shell/AppShell.tsx";

const title = (t: string): RouteHandle => ({ title: t });

// The holder app lives under /app. Created once, outside React, as the router docs ask.
export const router = createBrowserRouter(
  [
    {
      path: "/",
      Component: AppShell,
      ErrorBoundary: RouteError,
      children: [
        { index: true, Component: OverviewPage, handle: title("Overview") },
        { path: "trade", Component: TradePage, handle: title("Trade") },
        { path: "markets", Component: MarketsPage, handle: title("Markets") },
        { path: "orders", Component: OrdersPage, handle: title("Targets") },
        { path: "orders/:id", Component: OrderPage, handle: title("Target") },
        { path: "activity", Component: ActivityPage, handle: title("Activity") },
        { path: "market", Component: MarketPage, handle: title("Status") },
        { path: "*", Component: NotFoundPage, handle: title("Not found") },
      ],
    },
  ],
  { basename: "/app" },
);
