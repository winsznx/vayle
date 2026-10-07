import { vayleMarketAbi } from "@vayle/abi";
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";

// Every write a holder or a long holder makes, as a call any wallet can send. The app and the
// fallback page both build their transactions here, so they use the same contract paths.

export interface Call {
  readonly to: Address;
  readonly data: Hex;
}

export const CALL = 0;
export const PUT = 1;

export interface OrderParams {
  readonly asset: Address;
  readonly side: typeof CALL | typeof PUT;
  // USDG base units per raw token, on the strike tick.
  readonly target: bigint;
  // USDG base units per raw token, on the price tick.
  readonly minPremium: bigint;
  // Raw token units, whole lots.
  readonly size: bigint;
  readonly flip: boolean;
  readonly flipTarget: bigint;
}

export function approve(token: Address, spender: Address, amount: bigint): Call {
  return {
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  };
}

export function placeOrder(market: Address, p: OrderParams): Call {
  return {
    to: market,
    data: encodeFunctionData({ abi: vayleMarketAbi, functionName: "placeOrder", args: [p] }),
  };
}

export function updateOrder(
  market: Address,
  id: bigint,
  minPremium: bigint,
  flip: boolean,
  flipTarget: bigint,
): Call {
  return {
    to: market,
    data: encodeFunctionData({
      abi: vayleMarketAbi,
      functionName: "updateOrder",
      args: [id, minPremium, flip, flipTarget],
    }),
  };
}

export function cancelOrder(market: Address, id: bigint): Call {
  return {
    to: market,
    data: encodeFunctionData({ abi: vayleMarketAbi, functionName: "cancelOrder", args: [id] }),
  };
}

export function settleOrder(market: Address, id: bigint): Call {
  return {
    to: market,
    data: encodeFunctionData({ abi: vayleMarketAbi, functionName: "settleOrder", args: [id] }),
  };
}

export function finalize(market: Address, series: bigint): Call {
  return {
    to: market,
    data: encodeFunctionData({ abi: vayleMarketAbi, functionName: "finalize", args: [series] }),
  };
}

export function exercise(market: Address, series: bigint, amount: bigint): Call {
  return {
    to: market,
    data: encodeFunctionData({
      abi: vayleMarketAbi,
      functionName: "exercise",
      args: [series, amount],
    }),
  };
}

export function withdraw(market: Address, token: Address, amount: bigint): Call {
  return {
    to: market,
    data: encodeFunctionData({
      abi: vayleMarketAbi,
      functionName: "withdraw",
      args: [token, amount],
    }),
  };
}
