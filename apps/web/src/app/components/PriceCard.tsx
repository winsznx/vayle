import { TickerBadge } from "../../ui/TickerBadge.tsx";
import type { AppConfig } from "../config.ts";
import { easternTime, feedDollars } from "../format.ts";
import type { AssetView } from "../useMarket.ts";
import type { PriceHistory } from "../usePriceHistory.ts";
import { hasBatch, referenceLabel } from "../week.ts";
import { AssetSwitcher } from "./AssetSwitcher.tsx";
import { PriceChart } from "./PriceChart.tsx";
import "./dashboard.css";

// One Stock Token as the market prices it: the feed's latest answer, how far it has moved since
// this week's reference set the strikes, and the last month of the feed's rounds. With more than
// one market listed, the switcher picks which.

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
  readonly asset: AssetView;
  // Chain time.
  readonly now: number;
  readonly history: PriceHistory;
  // The prices the holder has active orders at, in USDG base units.
  readonly marks: readonly bigint[];
}

export function PriceCard({ config, asset, now, history, marks }: Props) {
  const { market, epoch } = asset;
  const close = epoch?.referencePrice ?? null;
  const change =
    close === null
      ? null
      : changeSince(asset.feedAnswer, asset.feedDecimals, close, config.usdgDecimals);
  const latest = history.status === "ready" ? history.points.at(-1) : undefined;
  // A week without a batch takes its reference at its opening, not at a close.
  const since = epoch !== null && !hasBatch(epoch) ? "this week's opening" : "this week's close";
  return (
    <section className="card price-card" aria-label={`${market.symbol} price`}>
      {config.markets.length > 1 && <AssetSwitcher />}
      <div className="price-head">
        <div className="price-asset">
          <TickerBadge symbol={market.symbol} size="lg" />
          <div>
            <p className="price-symbol">{market.symbol}</p>
            <p className="price-name">Stock Token on Robinhood Chain</p>
          </div>
        </div>
        <div className="price-now">
          <p className="price-figure num">{feedDollars(asset.feedAnswer, asset.feedDecimals)}</p>
          {change !== null && (
            <p className={change.up ? "price-change is-up" : "price-change is-down"}>
              <span className="num">{change.text}</span> since {since}
            </p>
          )}
        </div>
      </div>
      {history.status === "ready" ? (
        <PriceChart
          points={history.points}
          feedDecimals={history.decimals}
          now={now}
          close={close}
          closeLabel={epoch === null ? "Close" : referenceLabel(epoch)}
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
        Chainlink {market.symbol}/USD feed
        {latest === undefined ? "" : `, last updated ${easternTime(latest.time)}`}
      </p>
    </section>
  );
}
