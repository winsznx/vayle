import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import type { Call, Probe } from "./rpc.ts";

// Every contract read the check makes, each as calldata for aggregate3 and a decoder for the
// answer.

const stockTokenAbi = parseAbi([
  "function uid() view returns (bytes32)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function oraclePaused() view returns (bool)",
  "function paused() view returns (bool)",
  "function ACCESS_CONTROLLED_REGISTRY() view returns (address)",
]);

const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const feedAbi = parseAbi([
  "function accessController() view returns (address)",
  "function decimals() view returns (uint8)",
  "function aggregator() view returns (address)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export interface Round {
  readonly roundId: bigint;
  readonly answer: bigint;
  readonly updatedAt: number;
}

function call(target: Address, data: Hex): Call {
  return { target, data };
}

export const token = {
  uid: (at: Address): Probe<Hex> => ({
    call: call(at, encodeFunctionData({ abi: stockTokenAbi, functionName: "uid" })),
    decode: (data) => decodeFunctionResult({ abi: stockTokenAbi, functionName: "uid", data }),
  }),
  name: (at: Address): Probe<string> => ({
    call: call(at, encodeFunctionData({ abi: stockTokenAbi, functionName: "name" })),
    decode: (data) => decodeFunctionResult({ abi: stockTokenAbi, functionName: "name", data }),
  }),
  decimals: (at: Address): Probe<number> => ({
    call: call(at, encodeFunctionData({ abi: stockTokenAbi, functionName: "decimals" })),
    decode: (data) => decodeFunctionResult({ abi: stockTokenAbi, functionName: "decimals", data }),
  }),
  supportsInterface: (at: Address, id: Hex): Probe<boolean> => ({
    call: call(
      at,
      encodeFunctionData({ abi: stockTokenAbi, functionName: "supportsInterface", args: [id] }),
    ),
    decode: (data) =>
      decodeFunctionResult({ abi: stockTokenAbi, functionName: "supportsInterface", data }),
  }),
  uiMultiplier: (at: Address): Probe<bigint> => ({
    call: call(at, encodeFunctionData({ abi: stockTokenAbi, functionName: "uiMultiplier" })),
    decode: (data) =>
      decodeFunctionResult({ abi: stockTokenAbi, functionName: "uiMultiplier", data }),
  }),
  newUIMultiplier: (at: Address): Probe<bigint> => ({
    call: call(at, encodeFunctionData({ abi: stockTokenAbi, functionName: "newUIMultiplier" })),
    decode: (data) =>
      decodeFunctionResult({ abi: stockTokenAbi, functionName: "newUIMultiplier", data }),
  }),
  effectiveAt: (at: Address): Probe<bigint> => ({
    call: call(at, encodeFunctionData({ abi: stockTokenAbi, functionName: "effectiveAt" })),
    decode: (data) =>
      decodeFunctionResult({ abi: stockTokenAbi, functionName: "effectiveAt", data }),
  }),
  oraclePaused: (at: Address): Probe<boolean> => ({
    call: call(at, encodeFunctionData({ abi: stockTokenAbi, functionName: "oraclePaused" })),
    decode: (data) =>
      decodeFunctionResult({ abi: stockTokenAbi, functionName: "oraclePaused", data }),
  }),
  paused: (at: Address): Probe<boolean> => ({
    call: call(at, encodeFunctionData({ abi: stockTokenAbi, functionName: "paused" })),
    decode: (data) => decodeFunctionResult({ abi: stockTokenAbi, functionName: "paused", data }),
  }),
  accessRegistry: (at: Address): Probe<Address> => ({
    call: call(
      at,
      encodeFunctionData({ abi: stockTokenAbi, functionName: "ACCESS_CONTROLLED_REGISTRY" }),
    ),
    decode: (data) =>
      decodeFunctionResult({
        abi: stockTokenAbi,
        functionName: "ACCESS_CONTROLLED_REGISTRY",
        data,
      }),
  }),
};

export const erc20 = {
  symbol: (at: Address): Probe<string> => ({
    call: call(at, encodeFunctionData({ abi: erc20Abi, functionName: "symbol" })),
    decode: (data) => decodeFunctionResult({ abi: erc20Abi, functionName: "symbol", data }),
  }),
  decimals: (at: Address): Probe<number> => ({
    call: call(at, encodeFunctionData({ abi: erc20Abi, functionName: "decimals" })),
    decode: (data) => decodeFunctionResult({ abi: erc20Abi, functionName: "decimals", data }),
  }),
};

function round([roundId, answer, , updatedAt]: readonly [
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
]): Round {
  return { roundId, answer, updatedAt: Number(updatedAt) };
}

export const feed = {
  accessController: (at: Address): Probe<Address> => ({
    call: call(at, encodeFunctionData({ abi: feedAbi, functionName: "accessController" })),
    decode: (data) =>
      decodeFunctionResult({ abi: feedAbi, functionName: "accessController", data }),
  }),
  decimals: (at: Address): Probe<number> => ({
    call: call(at, encodeFunctionData({ abi: feedAbi, functionName: "decimals" })),
    decode: (data) => decodeFunctionResult({ abi: feedAbi, functionName: "decimals", data }),
  }),
  aggregator: (at: Address): Probe<Address> => ({
    call: call(at, encodeFunctionData({ abi: feedAbi, functionName: "aggregator" })),
    decode: (data) => decodeFunctionResult({ abi: feedAbi, functionName: "aggregator", data }),
  }),
  latestRoundData: (at: Address): Probe<Round> => ({
    call: call(at, encodeFunctionData({ abi: feedAbi, functionName: "latestRoundData" })),
    decode: (data) =>
      round(decodeFunctionResult({ abi: feedAbi, functionName: "latestRoundData", data })),
  }),
  getRoundData: (at: Address, roundId: bigint): Probe<Round> => ({
    call: call(
      at,
      encodeFunctionData({ abi: feedAbi, functionName: "getRoundData", args: [roundId] }),
    ),
    decode: (data) =>
      round(decodeFunctionResult({ abi: feedAbi, functionName: "getRoundData", data })),
  }),
};
