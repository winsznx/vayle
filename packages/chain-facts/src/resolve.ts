import {
  BaseError,
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  hexToBigInt,
  http,
  keccak256,
  parseAbi,
  sliceHex,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { erc8056InterfaceIds, type Erc8056Interface } from "./erc8056.ts";
import { errorText } from "./rpc-errors.ts";
import {
  AmbiguousAddress,
  AssetNotActive,
  ChainIdMismatch,
  CodeSizeProbeFailed,
  DecimalsMismatch,
  DocsMismatch,
  DomainMismatch,
  FeedMismatch,
  InterfaceNotSupported,
  MissingRpcUrl,
  NonPositiveAnswer,
  SpecMismatch,
  UidMismatch,
} from "./errors.ts";
import type { ChainFacts } from "./facts.ts";
import {
  addressesOnPage,
  fetchJson,
  fetchText,
  hasUptimeFeed,
  pageStates,
  selectEquityFeed,
  selectRegistryAsset,
  SOURCES,
} from "./sources.ts";

export const EXPECTED_CHAIN_ID = 4663;
// Multicall3's address is the same on every chain it's deployed to, and so is its runtime code.
// Both are checked on chain on every run.
export const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");
export const MULTICALL3_RUNTIME_KECCAK =
  "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891";
// As listed at docs.robinhood.com/chain/connecting, and checked against that page on every run.
export const PUBLIC_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER_URL = "https://robinhoodchain.blockscout.com";
const ACTIVE = "ASSET_STATUS_ACTIVE";
const ARBSYS: Address = "0x0000000000000000000000000000000000000064";
// ArbSys reports 55 plus the ArbOS version.
const ARBOS_VERSION_OFFSET = 55n;

const stockTokenAbi = parseAbi([
  "function uid() view returns (bytes32)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function oraclePaused() view returns (bool)",
  "function paused() view returns (bool)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function ACCESS_CONTROLLED_REGISTRY() view returns (address)",
]);
const pausableAbi = parseAbi(["function paused() view returns (bool)"]);
const beaconAbi = parseAbi(["function implementation() view returns (address)"]);
const usdgAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function paused() view returns (bool)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function payoutGroupIdOf(address account) view returns (uint32)",
]);
const feedProxyAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function aggregator() view returns (address)",
  "function accessController() view returns (address)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);
const typeAndVersionAbi = parseAbi(["function typeAndVersion() view returns (string)"]);
const arbSysAbi = parseAbi(["function arbOSVersion() view returns (uint256)"]);

function eip1967Slot(label: string): Hex {
  return toHex(hexToBigInt(keccak256(toHex(label))) - 1n, { size: 32 });
}

export const IMPLEMENTATION_SLOT = eip1967Slot("eip1967.proxy.implementation");
export const BEACON_SLOT = eip1967Slot("eip1967.proxy.beacon");

const DOMAIN_TYPEHASH = keccak256(
  toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);

export function eip712DomainSeparator(
  name: string,
  version: string,
  chainId: number,
  verifyingContract: Address,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        DOMAIN_TYPEHASH,
        keccak256(toHex(name)),
        keccak256(toHex(version)),
        BigInt(chainId),
        verifyingContract,
      ],
    ),
  );
}

// Bisection ceilings and gas for the code size probes. Deploying a runtime costs 200 gas per byte,
// and the public RPC's eth_call gas cap stopped a 262,144-byte runtime probe with out of gas, so
// that ceiling stays at half. Init code costs about 4 gas per byte, so its ceiling can be higher.
const RUNTIME_CEILING = 1 << 17;
const INIT_CODE_CEILING = 1 << 18;
const CODE_SIZE_PROBE_GAS = 100_000_000n;

// Init code that deploys `size` zero bytes: PUSH3 size, PUSH1 0, RETURN.
export function zeroRuntimeInitCode(size: number): Hex {
  return `0x62${size.toString(16).padStart(6, "0")}6000f3`;
}

// Init code `size` bytes long that deploys nothing: STOP, then zero padding.
export function emptyInitCodeOfSize(size: number): Hex {
  return `0x${"00".repeat(size)}`;
}

// Whether a CREATE with this init code succeeds. Only the node's error for the limit being probed
// means no. Any other failure is thrown, so a flaky RPC can't shrink the result.
async function creates(
  client: PublicClient,
  block: bigint,
  initCode: Hex,
  limitError: RegExp,
): Promise<boolean> {
  try {
    await client.call({ data: initCode, blockNumber: block, gas: CODE_SIZE_PROBE_GAS });
    return true;
  } catch (error) {
    if (error instanceof BaseError && limitError.test(error.message)) return false;
    throw error;
  }
}

// The largest size `fits` accepts, by bisection below `ceiling`.
async function largestFitting(
  ceiling: number,
  fits: (size: number) => Promise<boolean>,
): Promise<number> {
  let fitting = 0;
  let tooBig = ceiling;
  if (await fits(tooBig)) {
    throw new CodeSizeProbeFailed(`${tooBig} bytes fit, so the limit is above the probe ceiling`);
  }
  while (tooBig - fitting > 1) {
    const mid = Math.floor((fitting + tooBig) / 2);
    if (await fits(mid)) fitting = mid;
    else tooBig = mid;
  }
  return fitting;
}

// The largest contract runtime and the largest init code the chain accepts.
async function codeSizeLimits(
  client: PublicClient,
  block: bigint,
): Promise<{ maxCodeSize: number; maxInitCodeSize: number }> {
  const maxCodeSize = await largestFitting(RUNTIME_CEILING, (size) =>
    creates(client, block, zeroRuntimeInitCode(size), /max code size exceeded/i),
  );
  const maxInitCodeSize = await largestFitting(INIT_CODE_CEILING, (size) =>
    creates(client, block, emptyInitCodeOfSize(size), /max initcode size exceeded/i),
  );
  return { maxCodeSize, maxInitCodeSize };
}

export function rpcClient(env: Readonly<Record<string, string | undefined>>): PublicClient {
  const url = env["ROBINHOOD_RPC_URL"];
  if (url === undefined || url === "") {
    throw new MissingRpcUrl("set ROBINHOOD_RPC_URL to a Robinhood Chain mainnet RPC");
  }
  return createPublicClient({ transport: http(url, { retryCount: 6, retryDelay: 500 }) });
}

async function addressInSlot(
  client: PublicClient,
  at: Address,
  slot: Hex,
  block: bigint,
): Promise<Address> {
  const word = await client.getStorageAt({ address: at, slot, blockNumber: block });
  return getAddress(sliceHex(word ?? "0x", 12, 32));
}

// An RPC without archive state, like the chain's public one, refuses reads at old blocks this way.
export function isMissingHistoricalState(error: unknown): boolean {
  return /historical state [0-9a-fx]* ?is not available/i.test(errorText(error));
}

// Where Multicall3 is and when it appeared: its code must match the canonical runtime, and the
// earliest block with code is found by bisection over archive state. Without archive state the
// creation block can't be checked again, so `knownCreated`, a value recorded earlier, stands, and
// a note says so.
async function multicall3(
  client: PublicClient,
  block: bigint,
  knownCreated: number | null,
): Promise<ChainFacts["multicall3"]> {
  const code = (await client.getCode({ address: MULTICALL3, blockNumber: block })) ?? "0x";
  if (code === "0x" || keccak256(code) !== MULTICALL3_RUNTIME_KECCAK) {
    throw new SpecMismatch(
      `${MULTICALL3} doesn't hold Multicall3's runtime code at block ${block}`,
    );
  }
  const facts = (created: number): ChainFacts["multicall3"] => ({
    address: MULTICALL3,
    blockCreated: created,
    runtimeKeccak: MULTICALL3_RUNTIME_KECCAK,
    sources: [SOURCES.multicall3],
  });
  const hasCode = async (at: bigint): Promise<boolean> =>
    ((await client.getCode({ address: MULTICALL3, blockNumber: at })) ?? "0x") !== "0x";
  let atGenesis: boolean;
  try {
    atGenesis = await hasCode(0n);
  } catch (error) {
    if (knownCreated === null || !isMissingHistoricalState(error)) throw error;
    console.warn(
      `multicall3.blockCreated not checked again: the RPC keeps no state at block 0. Keeping ${knownCreated}.`,
    );
    return facts(knownCreated);
  }
  let created = 0n;
  if (!atGenesis) {
    let low = 0n;
    let high = block;
    while (low + 1n < high) {
      const mid = (low + high) / 2n;
      if (await hasCode(mid)) high = mid;
      else low = mid;
    }
    created = high;
  }
  return facts(Number(created));
}

// `knownMulticall3Created` is the creation block a previous run recorded, used only when the RPC
// keeps no archive state to check it again.
export async function resolveFacts(
  client: PublicClient,
  now: Date,
  knownMulticall3Created: number | null = null,
): Promise<ChainFacts> {
  const latest = await client.getBlock({ blockTag: "latest" });
  const block = latest.number;
  const chainId = await client.getChainId();
  const connecting = await fetchText(SOURCES.chainConnecting);
  if (chainId !== EXPECTED_CHAIN_ID || !pageStates(connecting, String(EXPECTED_CHAIN_ID))) {
    throw new ChainIdMismatch(`RPC reports ${chainId}, docs state ${EXPECTED_CHAIN_ID}`);
  }
  for (const url of [PUBLIC_RPC_URL, EXPLORER_URL]) {
    if (!pageStates(connecting, url)) {
      throw new DocsMismatch(`${SOURCES.chainConnecting} no longer lists ${url}`);
    }
  }
  const arbOsRaw = await client.readContract({
    address: ARBSYS,
    abi: arbSysAbi,
    functionName: "arbOSVersion",
    blockNumber: block,
  });

  const registry = selectRegistryAsset(
    await fetchJson(SOURCES.stockTokenRegistry),
    "NVDA",
    EXPECTED_CHAIN_ID,
  );
  if (registry.status !== ACTIVE) {
    throw new AssetNotActive(`NVDA registry status is ${registry.status}`);
  }
  const nvda = { address: registry.address, abi: stockTokenAbi, blockNumber: block } as const;
  const uid = await client.readContract({ ...nvda, functionName: "uid" });
  if (uid.toLowerCase() !== registry.id.toLowerCase()) {
    throw new UidMismatch(`NVDA uid() ${uid} differs from registry id ${registry.id}`);
  }
  const nvdaDecimals = await client.readContract({ ...nvda, functionName: "decimals" });
  if (nvdaDecimals !== registry.decimals) {
    throw new DecimalsMismatch(`NVDA decimals() ${nvdaDecimals}, registry ${registry.decimals}`);
  }

  const ids = erc8056InterfaceIds();
  const spec = await fetchText(SOURCES.erc8056);
  for (const [key, id] of Object.entries(ids)) {
    if (!pageStates(spec, id)) throw new SpecMismatch(`${key} interface id ${id} not in the spec`);
  }
  const supports = {} as Record<Erc8056Interface, boolean>;
  for (const [key, id] of Object.entries(ids) as [Erc8056Interface, Hex][]) {
    supports[key] = await client.readContract({
      ...nvda,
      functionName: "supportsInterface",
      args: [id],
    });
  }
  if (!supports.core || !supports.pending) {
    throw new InterfaceNotSupported("NVDA lacks the ERC-8056 core or pending-multiplier interface");
  }
  const beacon = await addressInSlot(client, registry.address, BEACON_SLOT, block);
  const accessRegistry = await client.readContract({
    ...nvda,
    functionName: "ACCESS_CONTROLLED_REGISTRY",
  });

  const usdgPages = [SOURCES.robinhoodContracts, SOURCES.usdgIssuerContracts];
  const [contractsPage, issuerPage] = await Promise.all(usdgPages.map((url) => fetchText(url)));
  const onBoth = [...addressesOnPage(contractsPage ?? "")].filter((a) =>
    addressesOnPage(issuerPage ?? "").has(a),
  );
  const usdgCandidates: Address[] = [];
  for (const candidate of onBoth) {
    const symbol = await client
      .readContract({
        address: candidate,
        abi: usdgAbi,
        functionName: "symbol",
        blockNumber: block,
      })
      .catch(() => null);
    if (symbol === "USDG") usdgCandidates.push(candidate);
  }
  if (usdgCandidates.length !== 1 || usdgCandidates[0] === undefined) {
    throw new AmbiguousAddress(
      `${usdgCandidates.length} USDG candidates on both pages, expected 1`,
    );
  }
  const usdgAddress = usdgCandidates[0];
  const usdg = { address: usdgAddress, abi: usdgAbi, blockNumber: block } as const;
  const usdgName = await client.readContract({ ...usdg, functionName: "name" });
  const domainSeparator = await client.readContract({ ...usdg, functionName: "DOMAIN_SEPARATOR" });
  const expectedDomain = eip712DomainSeparator(usdgName, "1", EXPECTED_CHAIN_ID, usdgAddress);
  if (domainSeparator.toLowerCase() !== expectedDomain.toLowerCase()) {
    throw new DomainMismatch(`USDG DOMAIN_SEPARATOR doesn't match (${usdgName}, "1")`);
  }
  const rewardsFacet = await client
    .readContract({ ...usdg, functionName: "payoutGroupIdOf", args: [usdgAddress] })
    .then(() => true)
    .catch(() => false);

  const directory = await fetchJson(SOURCES.feedDirectory);
  const listed = selectEquityFeed(directory, "NVDA");
  const feed = { address: listed.proxy, abi: feedProxyAbi, blockNumber: block } as const;
  const feedDecimals = await client.readContract({ ...feed, functionName: "decimals" });
  const feedAggregator = await client.readContract({ ...feed, functionName: "aggregator" });
  if (feedDecimals !== listed.decimals || getAddress(feedAggregator) !== listed.aggregator) {
    throw new FeedMismatch(
      `proxy reports decimals ${feedDecimals} and aggregator ${feedAggregator}, directory lists ${listed.decimals} and ${listed.aggregator}`,
    );
  }
  const [roundId, answer, startedAt, updatedAt] = await client.readContract({
    ...feed,
    functionName: "latestRoundData",
  });
  if (answer <= 0n) throw new NonPositiveAnswer(`NVDA feed answer ${answer}`);

  return {
    schemaVersion: 1,
    network: "robinhood-mainnet",
    generatedAt: now.toISOString(),
    block: { number: block.toString(), hash: latest.hash, timestamp: Number(latest.timestamp) },
    chain: {
      chainId,
      arbOsVersion: Number(arbOsRaw - ARBOS_VERSION_OFFSET),
      ...(await codeSizeLimits(client, block)),
      publicRpcUrl: PUBLIC_RPC_URL,
      explorerUrl: EXPLORER_URL,
      sources: [SOURCES.chainConnecting, SOURCES.chainNode],
    },
    nvda: {
      address: registry.address,
      uid,
      name: await client.readContract({ ...nvda, functionName: "name" }),
      symbol: await client.readContract({ ...nvda, functionName: "symbol" }),
      decimals: nvdaDecimals,
      registryStatus: registry.status,
      uiMultiplier: (
        await client.readContract({ ...nvda, functionName: "uiMultiplier" })
      ).toString(),
      newUIMultiplier: (
        await client.readContract({ ...nvda, functionName: "newUIMultiplier" })
      ).toString(),
      effectiveAt: Number(await client.readContract({ ...nvda, functionName: "effectiveAt" })),
      oraclePaused: await client.readContract({ ...nvda, functionName: "oraclePaused" }),
      paused: await client.readContract({ ...nvda, functionName: "paused" }),
      interfaces: supports,
      beacon,
      implementation: getAddress(
        await client.readContract({
          address: beacon,
          abi: beaconAbi,
          functionName: "implementation",
          blockNumber: block,
        }),
      ),
      accessRegistry: getAddress(accessRegistry),
      accessRegistryPaused: await client.readContract({
        address: accessRegistry,
        abi: pausableAbi,
        functionName: "paused",
        blockNumber: block,
      }),
      sources: [SOURCES.stockTokenRegistry],
    },
    usdg: {
      address: usdgAddress,
      name: usdgName,
      symbol: "USDG",
      decimals: await client.readContract({ ...usdg, functionName: "decimals" }),
      paused: await client.readContract({ ...usdg, functionName: "paused" }),
      implementation: await addressInSlot(client, usdgAddress, IMPLEMENTATION_SLOT, block),
      domainSeparator,
      domainVersion: "1",
      rewardsFacet,
      sources: usdgPages,
    },
    nvdaUsdFeed: {
      name: listed.name,
      proxy: listed.proxy,
      svrProxy: listed.svrProxy,
      aggregator: listed.aggregator,
      // Zero means anyone may read the feed, Multicall3 included, which is how every Vayle client
      // batches its reads. A change here is drift, since batched feed reads would start failing.
      accessController: getAddress(
        await client.readContract({ ...feed, functionName: "accessController" }),
      ),
      aggregatorTypeAndVersion: await client.readContract({
        address: listed.aggregator,
        abi: typeAndVersionAbi,
        functionName: "typeAndVersion",
        blockNumber: block,
      }),
      description: await client.readContract({ ...feed, functionName: "description" }),
      decimals: feedDecimals,
      heartbeatSeconds: listed.heartbeatSeconds,
      deviationThresholdPercent: listed.deviationThresholdPercent,
      marketHours: listed.marketHours,
      latestRound: {
        roundId: roundId.toString(),
        answer: answer.toString(),
        startedAt: Number(startedAt),
        updatedAt: Number(updatedAt),
      },
      sources: [SOURCES.feedDirectory, SOURCES.feedDocs],
    },
    sequencerUptimeFeed: {
      available: hasUptimeFeed(directory),
      sources: [SOURCES.feedDirectory, SOURCES.sequencerFeeds],
    },
    multicall3: await multicall3(client, block, knownMulticall3Created),
    erc8056: { interfaceIds: ids, sources: [SOURCES.erc8056] },
  };
}
