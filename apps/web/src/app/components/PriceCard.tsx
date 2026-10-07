import { TokenIcon } from "../../ui/TokenIcon.tsx";
import type { AppConfig } from "../config.ts";
import { easternTime, feedDollars } from "../format.ts";
import type { MarketView } from "../useMarket.ts";
import type { PriceHistory } from "../usePriceHistory.ts";
import { PriceChart } from "./PriceChart.tsx";
import "./dashboard.css";

// NVDA as the market prices it: the feed's latest answer, how far it has moved since this week's
// close set the strikes, and the last month of the feed's rounds.

interface Change {
  readonly text: string;
  readonly up: boolean;
}

// The move from the close to the latest answer, cut to hundredths of a percent.
function changeSince(
  answer: bigint,
  feedDecimals: number,
  close: bigint,
  usdgDecimals: number,
): Change | null {
  if (close === 0n) return null;
  const latest = (answer * 10n ** BigInt(usdgDecimals)) / 10n ** BigInt(feedDecimals);
  const bps = ((latest - close) * 10_000n) / close;
  const size = bps < 0n ? -bps : bps;
  const percent = `${(size / 100n).toString()}.${(size % 100n).toString().padStart(2, "0")}%`;
  return { text: `${bps < 0n ? "−" : "+"}${percent}`, up: bps >= 0n };
}

interface Props {
  readonly config: AppConfig;
  readonly view: MarketView;
  readonly history: PriceHistory;
  // The prices the holder has active orders at, in USDG base units.
  readonly marks: readonly bigint[];
}

export function PriceCard({ config, view, history, marks }: Props) {
  const close = view.epoch?.referencePrice ?? null;
  const change =
    close === null
      ? null
      : changeSince(view.feedAnswer, view.feedDecimals, close, config.usdgDecimals);
  const latest = history.status === "ready" ? history.points.at(-1) : undefined;
  return (
    <section className="card price-card" aria-label={`${config.assetSymbol} price`}>
      <div className="price-head">
        <div className="price-asset">
          <TokenIcon symbol="NVDA" size="lg" />
          <div>
            <p className="price-symbol">{config.assetSymbol}</p>
            <p className="price-name">Stock Token on Robinhood Chain</p>
          </div>
        </div>
        <div className="price-now">
          <p className="price-figure num">{feedDollars(view.feedAnswer, view.feedDecimals)}</p>
          {change !== null && (
            <p className={change.up ? "price-change is-up" : "price-change is-down"}>
              <span className="num">{change.text}</span> since this week&apos;s close
            </p>
          )}
        </div>
      </div>
      {history.status === "ready" ? (
        <PriceChart
          points={history.points}
          feedDecimals={history.decimals}
          now={view.now}
          close={close}
          marks={marks}
          usdgDecimals={config.usdgDecimals}
        />
      ) : (
        <p className="price-chart-state">
          {history.status === "loading"
            ? "Reading the feed's last month of rounds."
            : `The price history can't be read right now: ${history.reason}`}
        </p>
      )}
      <p className="price-source">
        Chainlink {config.assetSymbol}/USD feed
        {latest === undefined ? "" : `, last updated ${easternTime(latest.time)}`}
      </p>
    </section>
  );
}
