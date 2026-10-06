import { getAddress, isAddress, type Address } from "viem";
import { AssetNotListed, FeedNotListed, SourceFetchFailed } from "./errors.ts";

export const SOURCES = {
  chainConnecting: "https://docs.robinhood.com/chain/connecting",
  chainNode: "https://docs.robinhood.com/chain/run-a-full-node",
  stockTokenRegistry: "https://api.robinhood.com/rhj/assets",
  robinhoodContracts: "https://docs.robinhood.com/chain/contracts",
  usdgIssuerContracts: "https://docs.paxos.com/guides/stablecoin/usdg/mainnet",
  feedDirectory: "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json",
  feedDocs: "https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood",
  sequencerFeeds: "https://docs.chain.link/data-feeds/l2-sequencer-feeds",
  erc8056: "https://eips.ethereum.org/EIPS/eip-8056",
} as const;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const ATTEMPTS = 5;
const TIMEOUT_MS = 20_000;

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchText(url: string): Promise<string> {
  let lastError = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.ok) return await response.text();
      lastError = `HTTP ${response.status}`;
      if (!RETRYABLE_STATUS.has(response.status)) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await pause(500 * 2 ** (attempt - 1));
  }
  throw new SourceFetchFailed(`${url}: ${lastError}`);
}

export async function fetchJson(url: string): Promise<unknown> {
  const text = await fetchText(url);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SourceFetchFailed(`${url}: response is not JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

export interface RegistryAsset {
  readonly id: string;
  readonly symbol: string;
  readonly address: Address;
  readonly decimals: number;
  readonly status: string;
}

// The registry lists each Stock Token once, with one deployment per chain.
export function selectRegistryAsset(json: unknown, symbol: string, chainId: number): RegistryAsset {
  const assets = isRecord(json) && Array.isArray(json["assets"]) ? json["assets"] : [];
  const matches: RegistryAsset[] = [];
  for (const asset of assets) {
    if (!isRecord(asset) || stringField(asset, "tokenSymbol") !== symbol) continue;
    const deployments = Array.isArray(asset["deployments"]) ? asset["deployments"] : [];
    for (const deployment of deployments) {
      if (!isRecord(deployment) || numberField(deployment, "chainId") !== chainId) continue;
      const address = stringField(deployment, "contractAddress");
      const id = stringField(asset, "id");
      const decimals = numberField(asset, "tokenDecimals");
      const status = stringField(asset, "status");
      if (
        address === undefined ||
        !isAddress(address) ||
        id === undefined ||
        decimals === undefined ||
        status === undefined
      ) {
        continue;
      }
      matches.push({ id, symbol, address: getAddress(address), decimals, status });
    }
  }
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new AssetNotListed(
      `${symbol} on chain ${chainId}: ${matches.length} registry entries, expected 1`,
    );
  }
  return matches[0];
}

export interface DirectoryFeed {
  readonly name: string;
  readonly proxy: Address;
  readonly svrProxy: Address | null;
  readonly aggregator: Address;
  readonly decimals: number;
  readonly heartbeatSeconds: number;
  readonly deviationThresholdPercent: number;
  readonly marketHours: string;
}

// Selects a tokenized-equity price feed by its base asset.
export function selectEquityFeed(json: unknown, baseAsset: string): DirectoryFeed {
  const entries = Array.isArray(json) ? json : [];
  const matches: DirectoryFeed[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry["docs"])) continue;
    const docs = entry["docs"];
    if (stringField(docs, "baseAsset") !== baseAsset) continue;
    if (stringField(docs, "productTypeCode") !== "primaryTokenizedPrice") continue;
    const name = stringField(entry, "name");
    const proxy = stringField(entry, "proxyAddress");
    const svrProxy = stringField(entry, "secondaryProxyAddress");
    const aggregator = stringField(entry, "contractAddress");
    const decimals = numberField(entry, "decimals");
    const heartbeat = numberField(entry, "heartbeat");
    const threshold = numberField(entry, "threshold");
    const marketHours = stringField(docs, "marketHours");
    if (
      name === undefined ||
      proxy === undefined ||
      !isAddress(proxy) ||
      aggregator === undefined ||
      !isAddress(aggregator) ||
      decimals === undefined ||
      heartbeat === undefined ||
      threshold === undefined ||
      marketHours === undefined
    ) {
      continue;
    }
    matches.push({
      name,
      proxy: getAddress(proxy),
      svrProxy: svrProxy !== undefined && isAddress(svrProxy) ? getAddress(svrProxy) : null,
      aggregator: getAddress(aggregator),
      decimals,
      heartbeatSeconds: heartbeat,
      deviationThresholdPercent: threshold,
      marketHours,
    });
  }
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new FeedNotListed(`${baseAsset}: ${matches.length} tokenized price feeds, expected 1`);
  }
  return matches[0];
}

export function hasUptimeFeed(json: unknown): boolean {
  const entries = Array.isArray(json) ? json : [];
  return entries.some((entry) => /uptime|sequencer/i.test(JSON.stringify(entry)));
}

// Every distinct 20-byte address written on a page, checksummed.
export function addressesOnPage(html: string): Set<Address> {
  const found = new Set<Address>();
  for (const match of html.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)) {
    found.add(getAddress(match[0]));
  }
  return found;
}

export function pageStates(html: string, text: string): boolean {
  return html.toLowerCase().includes(text.toLowerCase());
}
