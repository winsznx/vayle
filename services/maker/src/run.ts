import { errorText } from "@vayle/chain-facts/rpc-errors";
import type { Address } from "viem";
import type { MakerConfig } from "./config.ts";
import { execute, type Clients } from "./execute.ts";
import { marketPrices, type PriceVerdict } from "./guard.ts";
import { plan, type MakerAction } from "./plan.ts";
import { feedSessions } from "./sessions.ts";
import { readSnapshot, type MarketNote } from "./snapshot.ts";

// Whether a market could bid and quote this run, and if not, why.
export interface MarketPrice {
  readonly symbol: string;
  readonly token: Address;
  readonly verdict: PriceVerdict;
}

export interface RunResult {
  readonly prices: readonly MarketPrice[];
  readonly sent: readonly MakerAction[];
  readonly failed: readonly { readonly action: MakerAction; readonly reason: string }[];
  // Markets left out of the run, and why.
  readonly notes: readonly MarketNote[];
}

// One run: read, judge each market's price, plan, act. A failed action is logged and reconsidered by
// the next run, and a market left out is logged with the reason.
export async function runOnce(config: MakerConfig, clients: Clients): Promise<RunResult> {
  const { snapshot, notes } = await readSnapshot(clients.public, config, clients.signer.address);
  for (const note of notes) console.warn(`maker: ${note.symbol} ${note.text}`);
  const prices = marketPrices(snapshot.markets, config.usdgDecimals, feedSessions, snapshot.now);
  for (const { market } of snapshot.markets) {
    const verdict = prices.get(market.token);
    if (verdict !== undefined && !verdict.usable) {
      console.warn(
        `maker: no bids or quotes for ${market.symbol} this run. ${verdict.reason}: ${verdict.detail}`,
      );
    }
  }
  const failed: { action: MakerAction; reason: string }[] = [];
  const sent: MakerAction[] = [];
  for (const action of plan(snapshot, config.pricing, prices)) {
    try {
      await execute(clients, config, action);
      sent.push(action);
    } catch (error) {
      const reason = errorText(error);
      console.error(`maker: ${action.kind} failed`, reason);
      failed.push({ action, reason });
    }
  }
  return {
    prices: snapshot.markets.flatMap(({ market }) => {
      const verdict = prices.get(market.token);
      return verdict === undefined ? [] : [{ symbol: market.symbol, token: market.token, verdict }];
    }),
    sent,
    failed,
    notes,
  };
}
