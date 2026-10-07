import {
  encodeAbiParameters,
  getAddress,
  hexToBigInt,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import type { ForkClient } from "./anvil.ts";

// The NVDA/USD aggregator's storage. s_hotVars sits in slot 13 with latestAggregatorRoundId in bits
// 48 to 79, and s_transmissions is the mapping at slot 17, one word per round: the int192 answer
// in bits 0 to 191, observationsTimestamp in 192 to 223, recordedTimestamp in 224 to 255. Found by
// scanning mainnet storage at block 82077644 against latestRoundData, and checked against the live
// aggregator before every write.
const HOT_VARS_SLOT: Hex = toHex(13n, { size: 32 });
const TRANSMISSIONS_SLOT = 17n;
const ROUND_SHIFT = 48n;
const UINT32 = 0xffffffffn;
const INT192_BITS = 192n;
const INT192_MASK = (1n << INT192_BITS) - 1n;

export interface Transmission {
  readonly answer: bigint;
  readonly observedAt: number;
  readonly recordedAt: number;
}

export class FeedLayoutChanged extends Error {
  override readonly name = "FeedLayoutChanged";
}

export function roundInHotVars(word: bigint): number {
  return Number((word >> ROUND_SHIFT) & UINT32);
}

export function withRound(word: bigint, round: number): bigint {
  return (word & ~(UINT32 << ROUND_SHIFT)) | (BigInt(round) << ROUND_SHIFT);
}

export function decodeTransmission(word: bigint): Transmission {
  const low = word & INT192_MASK;
  const answer = low >> (INT192_BITS - 1n) === 1n ? low - (1n << INT192_BITS) : low;
  return {
    answer,
    observedAt: Number((word >> INT192_BITS) & UINT32),
    recordedAt: Number((word >> 224n) & UINT32),
  };
}

export function encodeTransmission(t: Transmission): bigint {
  return (
    (t.answer & INT192_MASK) |
    (BigInt(t.observedAt) << INT192_BITS) |
    (BigInt(t.recordedAt) << 224n)
  );
}

export function transmissionSlot(round: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      [BigInt(round), TRANSMISSIONS_SLOT],
    ),
  );
}

export interface FeedWrite {
  readonly aggregator: Address;
  readonly round: number;
  readonly copiedFrom: number;
  readonly answer: string;
  readonly at: number;
}

const feedAbi = parseAbi([
  "function aggregator() view returns (address)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);
// The proxy reports (phase << 64) | aggregator round.
const AGGREGATOR_ROUND = (1n << 64n) - 1n;

async function word(client: ForkClient, aggregator: Address, slot: Hex): Promise<bigint> {
  return hexToBigInt((await client.getStorageAt({ address: aggregator, slot })) ?? "0x0");
}

// The latest round as the proxy reports it, with the aggregator's own round number.
async function latest(client: ForkClient, proxy: Address): Promise<[number, bigint, number]> {
  const [round, answer, , updatedAt] = await client.readContract({
    address: proxy,
    abi: feedAbi,
    functionName: "latestRoundData",
  });
  return [Number(round & AGGREGATOR_ROUND), answer, Number(updatedAt)];
}

// Appends one round at `at` that repeats the latest real answer: a close the fork can prove, with
// no price anyone made up. `aggregator` is the one whose layout is described above, and the proxy
// must still point at it.
export async function writeCarriedForwardRound(
  client: ForkClient,
  proxy: Address,
  aggregator: Address,
  at: number,
): Promise<FeedWrite> {
  const current = await client.readContract({
    address: proxy,
    abi: feedAbi,
    functionName: "aggregator",
  });
  if (getAddress(current) !== aggregator) {
    throw new FeedLayoutChanged(`feed ${proxy} now reads aggregator ${current}, not ${aggregator}`);
  }
  const [round, answer, updatedAt] = await latest(client, proxy);
  const hotVars = await word(client, aggregator, HOT_VARS_SLOT);
  const stored = decodeTransmission(await word(client, aggregator, transmissionSlot(round)));
  if (
    roundInHotVars(hotVars) !== round ||
    stored.answer !== answer ||
    stored.recordedAt !== updatedAt
  ) {
    throw new FeedLayoutChanged(
      `aggregator ${aggregator} doesn't keep round ${round} where this tool writes rounds`,
    );
  }
  const next = round + 1;
  const value = encodeTransmission({ answer, observedAt: at, recordedAt: at });
  await client.setStorageAt({
    address: aggregator,
    index: transmissionSlot(next),
    value: toHex(value, { size: 32 }),
  });
  await client.setStorageAt({
    address: aggregator,
    index: HOT_VARS_SLOT,
    value: toHex(withRound(hotVars, next), { size: 32 }),
  });
  const [readRound, readAnswer, readAt] = await latest(client, proxy);
  if (readRound !== next || readAnswer !== answer || readAt !== at) {
    throw new FeedLayoutChanged(`round ${next} didn't read back through feed ${proxy}`);
  }
  return { aggregator, round: next, copiedFrom: round, answer: answer.toString(), at };
}
