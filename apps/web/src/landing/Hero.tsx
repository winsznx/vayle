import { useEffect, useState, type ReactNode } from "react";
import { dollars, easternClock } from "../app/format.ts";
import { ladderAround, type Rung } from "../app/week.ts";
import { TokenIcon } from "../ui/TokenIcon.tsx";
import { readFeed, type FeedPrice } from "./feed.ts";
import { useReveal, Words } from "./reveal.tsx";

// The listing's grid: strikes every $5 within 10% of the reference, as listed by the deploy script.
const STRIKE_TICK = 5_000_000n;
const STRIKE_RANGE_BPS = 1000;
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
    rpcUrl === "" ? { status: "unavailable" } : { status: "loading" },
  );
  useEffect(() => {
    if (rpcUrl === "") return;
    const controller = new AbortController();
    readFeed(rpcUrl, controller.signal).then(
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
  const live = state.status === "live" ? state.feed : null;
  const rungs =
    live === null ? [] : ladderAround(live.price, STRIKE_TICK, STRIKE_RANGE_BPS).slice(1, -1);
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
        <TokenIcon symbol="NVDA" size="lg" />
        <div>
          <p className="ladder-symbol">NVDA</p>
          <p className="ladder-sub">
            {live === null
              ? state.status === "loading"
                ? "Reading the price"
                : "Live price unavailable"
              : `${dollars(live.price)} at ${easternClock(live.updatedAt)}`}
          </p>
        </div>
      </div>
      <ol className="ladder-rungs" aria-label="Prices on the ladder around NVDA's current price">
        {rows}
      </ol>
      <p className="ladder-source">
        {live === null
          ? "An example ladder from Chainlink NVDA/USD"
          : `An example ladder around Chainlink NVDA/USD, round ${live.round & AGGREGATOR_ROUND}`}
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
        <p className="tag">Paid limit orders for NVDA on Robinhood Chain</p>
        <h1 id="hero-title" ref={headline} className="display-1 hero-title reveal">
          <span className="ghost">
            <Words text="Name your price for NVDA." />
          </span>
          <span>
            <Words text="Get paid while it waits." delay={5} />
          </span>
        </h1>
        <p className="lede hero-lede">
          Place one order at a price you choose. Each week it earns that week&apos;s premium, skips
          the week, or fills at exactly your price, settled in the actual token. It renews until it
          fills or you cancel.
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
          title="Earned"
          detail="This week's premium from the team-operated maker"
          icon={<TokenIcon symbol="USDG" size="lg" />}
        />
        <Outcome
          className="outcome-b"
          title="Skipped"
          detail="The bid was under your minimum"
          icon={<span className="outcome-dot" />}
        />
        <Outcome
          className="outcome-c"
          title="Filled at your price"
          detail="The actual token changes hands"
          icon={<TokenIcon symbol="NVDA" size="lg" />}
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
          <TokenIcon symbol="NVDA" size="md" />
          NVDA Stock Token
        </li>
        <li>
          <TokenIcon symbol="USDG" size="md" />
          Premium paid in USDG
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
