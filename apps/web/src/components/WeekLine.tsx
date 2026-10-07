import type { AppConfig } from "../config.ts";
import { dollars, easternClock, easternTime, feedDollars } from "../format.ts";
import type { MarketView } from "../useMarket.ts";
import { BID_WINDOW, bidOpensAt, phase } from "../week.ts";

export function WeekLine({
  config,
  view,
}: {
  readonly config: AppConfig;
  readonly view: MarketView;
}) {
  const e = view.epoch;
  if (e === null) {
    return (
      <p className="weekline">
        {config.assetSymbol} is at {feedDollars(view.feedAnswer, view.feedDecimals)}. The first week
        opens at the next weekly close.
      </p>
    );
  }
  const where = phase(e, view.now);
  const next =
    where === "settling"
      ? `Bids for this week open at ${easternClock(bidOpensAt(e))}, and the batch starts at ${easternClock(bidOpensAt(e) + BID_WINDOW)}.`
      : where === "expired"
        ? `This week ended ${easternTime(e.expiry)}. Next week's prices are set at that close.`
        : `This week ends ${easternTime(e.expiry)}.`;
  return (
    <p className="weekline">
      {config.assetSymbol} closed at {dollars(e.referencePrice)} on {easternTime(e.opening)}. {next}
    </p>
  );
}
