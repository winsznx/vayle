import {
  livenessCheckpointAbi,
  sessionCalendarAbi,
  stockTokenRegistryAbi,
  vayleMarketAbi,
} from "@vayle/abi";
import { parseEventLogs, type Address, type Hash, type PublicClient } from "viem";
import type { MarketAddresses } from "./config.ts";

export interface ChainEvent {
  readonly name: string;
  readonly address: Address;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly transactionHash: Hash;
  readonly args: Readonly<Record<string, unknown>>;
}

const ABI = [
  ...vayleMarketAbi,
  ...livenessCheckpointAbi,
  ...sessionCalendarAbi,
  ...stockTokenRegistryAbi,
] as const;

// Logs from the market's contracts in [fromBlock, toBlock], decoded. Logs that don't decode
// against the generated ABIs are dropped, which only happens for events the watcher never alerts on.
export async function readEvents(
  client: PublicClient,
  addresses: MarketAddresses,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<ChainEvent[]> {
  const logs = await client.getLogs({
    address: [addresses.market, addresses.liveness, addresses.calendar, addresses.registry],
    fromBlock,
    toBlock,
  });
  return parseEventLogs({ abi: ABI, logs }).map((log) => ({
    name: log.eventName,
    address: log.address,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
    transactionHash: log.transactionHash,
    args: log.args as Readonly<Record<string, unknown>>,
  }));
}
