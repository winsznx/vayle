import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };

// The ticker of USDG, the token every target is paid in and every buy target locks, from the chain
// facts.
export const CASH_SYMBOL: string = facts.usdg.symbol;
