import { withdraw, type Call } from "@vayle/market";
import type { Run } from "../App.tsx";
import type { AppConfig } from "../config.ts";
import { tokens, usdgAmount } from "../format.ts";
import type { AccountView } from "../useMarket.ts";

export function WithdrawStrip(props: {
  readonly config: AppConfig;
  readonly account: AccountView;
  readonly run: Run;
  readonly busy: boolean;
}) {
  const { config, account, run, busy } = props;
  const parts: string[] = [];
  const calls: Call[] = [];
  if (account.claimableAsset > 0n) {
    parts.push(tokens(account.claimableAsset, config.assetSymbol, config.assetDecimals));
    calls.push(withdraw(config.market, config.asset, account.claimableAsset));
  }
  if (account.claimableUsdg > 0n) {
    parts.push(usdgAmount(account.claimableUsdg, config.usdgDecimals));
    calls.push(withdraw(config.market, config.usdg, account.claimableUsdg));
  }
  if (calls.length === 0) return null;
  return (
    <aside className="withdraw" aria-label="Ready to withdraw">
      <p>
        Ready to withdraw <strong>{parts.join(" and ")}</strong>
      </p>
      <button type="button" disabled={busy} onClick={() => void run("Withdraw", calls)}>
        Withdraw
      </button>
    </aside>
  );
}
