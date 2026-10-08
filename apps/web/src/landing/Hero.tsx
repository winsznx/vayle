import { markets } from "@vayle/markets";
import { useEffect, useState, type ReactNode } from "react";
import { dollars, easternClock } from "../app/format.ts";
import { ladderAround, type Rung } from "../app/week.ts";
import { CASH_SYMBOL } from "../tokens.ts";
import { TickerBadge } from "../ui/TickerBadge.tsx";
import { readFeed, type FeedPrice } from "./feed.ts";
import { useReveal, Words } from "./reveal.tsx";

// The hero's example ladder uses the first market the build lists, on that listing's grid.
const SHOWN = markets.at(0) ?? null;
const PLACEHOLDER_RUNGS = 8;
// Feed round IDs carry the aggregator phase in their top bits; the round itself is the low 64.
const AGGREGATOR_ROUND = (1n << 64n) - 1n;

type FeedState =
  | { readonly status: "loading" }
  | { readonly status: "live"; readonly feed: FeedPrice }
  | { readonly status: "unavailable" };

function useFeed(): FeedState {
  const rpcUrl = import.meta.env.VITE_RPC_URL ?? "";
  const [state, setState] = useState<FeedState>(
    rpcUrl === "" || SHOWN === null ? { status: "unavailable" } : { status: "loading" },
  );
  useEffect(() => {
    if (rpcUrl === "" || SHOWN === null) return;
    const controller = new AbortController();
    readFeed(rpcUrl, SHOWN, controller.signal).then(
      (feed) => {
        setState(feed === null ? { status: "unavailable" } : { status: "live", feed });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({ status: "unavailable" });
      },
    );
    return () => {
      controller.abort();
    };
  }, [rpcUrl]);
  return state;
}

// The price the hero holds up as an example: the second rung above the current price.
function heldRung(rungs: readonly Rung[]): bigint | null {
  const sells = rungs.filter((r) => r.side === "sell");
  return sells[sells.length - 2]?.strike ?? sells[sells.length - 1]?.strike ?? null;
}

function LadderObject({ state }: { readonly state: FeedState }) {
  const live = state.status === "live" && SHOWN !== null ? state.feed : null;
  const rungs =
    live === null || SHOWN === null
      ? []
      : ladderAround(live.price, SHOWN.strikeTick, SHOWN.strikeRangeBps).slice(1, -1);
  const symbol = SHOWN?.symbol ?? "Stock Token";
  const held = heldRung(rungs);
  const closeAt = rungs.findIndex((r) => r.side === "buy");
  const tag = <span className="held-tag">Your price</span>;
  const rows =
    live === null
      ? Array.from({ length: PLACEHOLDER_RUNGS }, (_, i) => (
          <li key={i} className={i === 2 ? "rung rung-empty rung-held" : "rung rung-empty"}>
            {i === 2 && tag}
          </li>
        ))
      : rungs.map((rung, i) => (
          <li
            key={rung.strike.toString()}
            className={rung.strike === held ? "rung rung-held" : "rung"}
            data-close-above={i === closeAt ? "" : undefined}
          >
            {rung.strike === held && tag}
            <span className="rung-price num">{dollars(rung.strike)}</span>
            <span className="rung-side">{rung.side === "sell" ? "Sell" : "Buy"}</span>
          </li>
        ));
  return (
    <div className="ladder-object" aria-hidden={live === null}>
      <div className="ladder-head">
        <TickerBadge symbol={symbol} size="lg" />
        <div>
          <p className="ladder-symbol">{symbol}</p>
          <p className="ladder-sub">
            {live === null
              ? state.status === "loading"
                ? "Reading the price"
                : "Live price unavailable"
              : `${dollars(live.price)} at ${easternClock(live.updatedAt)}`}
          </p>
        </div>
      </div>
      <ol
        className="ladder-rungs"
        aria-label={`Prices on the ladder around ${symbol}'s current price`}
      >
        {rows}
      </ol>
      <p className="ladder-source">
        {live === null
          ? `An example ladder from Chainlink ${symbol}/USD`
          : `An example ladder around Chainlink ${symbol}/USD, round ${live.round & AGGREGATOR_ROUND}`}
      </p>
    </div>
  );
}

function Outcome({
  className,
  title,
  detail,
  icon,
}: {
  readonly className: string;
  readonly title: string;
  readonly detail: string;
  readonly icon: ReactNode;
}) {
  return (
    <div className={`outcome ${className}`}>
      {icon}
      <div>
        <p className="outcome-title">{title}</p>
        <p className="outcome-detail">{detail}</p>
      </div>
    </div>
  );
}

export function Hero() {
  const state = useFeed();
  const headline = useReveal<HTMLHeadingElement>();
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <p className="tag">Weekly pay for Stock Token holders on Robinhood Chain</p>
        <h1 id="hero-title" ref={headline} className="display-1 hero-title reveal">
          <span className="ghost">
            <Words text="Pick the price you'd sell at." />
          </span>
          <span>
            <Words text="Get paid while you wait for it." delay={6} />
          </span>
        </h1>
        <p className="lede hero-lede">
          Each week a buyer pays you for the right to buy your tokens at that price when the market
          closes Friday. If the stock closes above it, your tokens sell at exactly your price. If
          not, you keep them and the payment, and it renews for another week.
        </p>
        <div className="hero-actions">
          <a className="btn btn-brand btn-lg" href="/app/">
            Open the app
          </a>
          <a className="btn btn-outline btn-lg" href="#how">
            How it works
          </a>
        </div>
      </div>

      <div className="hero-stage">
        <svg
          className="orbits"
          viewBox="0 0 1200 560"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="orbit-fade" x1="0" x2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity="0" />
              <stop offset="0.5" stopColor="currentColor" stopOpacity="0.55" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <ellipse
            cx="600"
            cy="300"
            rx="520"
            ry="150"
            transform="rotate(-7 600 300)"
            className="orbit orbit-strong"
          />
          <ellipse
            cx="600"
            cy="300"
            rx="430"
            ry="205"
            transform="rotate(9 600 300)"
            className="orbit orbit-pale"
          />
          <ellipse
            cx="600"
            cy="300"
            rx="575"
            ry="235"
            transform="rotate(-2 600 300)"
            className="orbit orbit-dots"
          />
        </svg>
        <LadderObject state={state} />
        <Outcome
          className="outcome-a"
          title="Paid"
          detail="This week's payment, in USDG"
          icon={<TickerBadge symbol={CASH_SYMBOL} size="lg" />}
        />
        <Outcome
          className="outcome-b"
          title="Skipped"
          detail="The bid was under your least payment"
          icon={<span className="outcome-dot" />}
        />
        <Outcome
          className="outcome-c"
          title="Sold at your price"
          detail="Your tokens change hands"
          icon={<TickerBadge symbol={SHOWN?.symbol ?? "Stock Token"} size="lg" />}
        />
        <Outcome
          className="outcome-d"
          title="Renews next week"
          detail="Until it fills or you cancel"
          icon={<span className="outcome-dot outcome-dot-brand" />}
        />
      </div>

      <ul className="proof" aria-label="What Vayle runs on">
        <li>
          {markets.map((m) => (
            <TickerBadge key={m.token} symbol={m.symbol} size="md" />
          ))}
          Stock Tokens
        </li>
        <li>
          <TickerBadge symbol={CASH_SYMBOL} size="md" />
          Paid in USDG
        </li>
        <li>
          <svg className="glyph" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path d="M3 13.5 10 17l7-3.5M3 10l7 3.5 7-3.5M10 3 3 6.5 10 10l7-3.5L10 3Z" />
          </svg>
          On Robinhood Chain
        </li>
        <li>
          <svg className="glyph" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path d="M10 2.5 16.5 6.25v7.5L10 17.5l-6.5-3.75v-7.5L10 2.5Z" />
          </svg>
          Prices from Chainlink
        </li>
      </ul>
    </section>
  );
}
