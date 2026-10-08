import { getAddress, type Address, type Hex } from "viem";
import {
  judgeErc8056,
  judgeFeed,
  judgeMultiplier,
  judgePauses,
  judgeUid,
  notRun,
} from "./checks.ts";
import type { Listed } from "./listing.ts";
import { feed, token, type Round } from "./probes.ts";
import type { Handle, Read, Rpc } from "./rpc.ts";
import type {
  Erc8056Check,
  FeedCheck,
  MultiplierCheck,
  PausesCheck,
  Status,
  UidCheck,
} from "./types.ts";

// The cheap checks on every listed token, in two calls' worth of batches: the token's and its
// feed's reads, then the pause flag of each access registry the tokens name.

const ACTIVE = "ASSET_STATUS_ACTIVE";
// Simple getters through a beacon proxy cost about 10,000 gas each, so 800 to a call stays far
// under the node's eth_call gas cap of about 50M.
const READS_PER_CALL = 800;

export type InterfaceIds = Readonly<Record<"core" | "balances" | "pending" | "conversion", Hex>>;

export interface CheapResult {
  readonly listed: Listed;
  readonly name: string | null;
  readonly uid: Hex | null;
  readonly decimals: number;
  readonly latestRound: Round | null;
  readonly feedDecimals: number | null;
  readonly feed: FeedCheck;
  readonly erc8056: Erc8056Check;
  readonly multiplier: MultiplierCheck;
  readonly pauses: PausesCheck;
  readonly uidCheck: UidCheck;
}

interface TokenHandles {
  readonly name: Handle<string>;
  readonly uid: Handle<Hex>;
  readonly decimals: Handle<number>;
  readonly core: Handle<boolean>;
  readonly balances: Handle<boolean>;
  readonly pending: Handle<boolean>;
  readonly conversion: Handle<boolean>;
  readonly uiMultiplier: Handle<bigint>;
  readonly newUIMultiplier: Handle<bigint>;
  readonly effectiveAt: Handle<bigint>;
  readonly oraclePaused: Handle<boolean>;
  readonly paused: Handle<boolean>;
  readonly accessRegistry: Handle<Address>;
  readonly feed: {
    readonly accessController: Handle<Address>;
    readonly decimals: Handle<number>;
    readonly aggregator: Handle<Address>;
    readonly latestRound: Handle<Round>;
  } | null;
}

export function cheapPassed(result: CheapResult): boolean {
  const statuses: Status[] = [
    result.feed.status,
    result.erc8056.status,
    result.multiplier.status,
    result.pauses.status,
    result.uidCheck.status,
  ];
  return statuses.every((s) => s === "pass");
}

const unavailable = (error: string): Read<never> => ({ ok: false, kind: "unavailable", error });

export async function runCheapChecks(
  rpc: Rpc,
  listed: readonly Listed[],
  interfaceIds: InterfaceIds,
  now: number,
): Promise<CheapResult[]> {
  const batch = rpc.batch({ perCall: READS_PER_CALL });
  const handles: TokenHandles[] = listed.map(({ asset, feed: listing }) => {
    const at = asset.address;
    return {
      name: batch.add(token.name(at)),
      uid: batch.add(token.uid(at)),
      decimals: batch.add(token.decimals(at)),
      core: batch.add(token.supportsInterface(at, interfaceIds.core)),
      balances: batch.add(token.supportsInterface(at, interfaceIds.balances)),
      pending: batch.add(token.supportsInterface(at, interfaceIds.pending)),
      conversion: batch.add(token.supportsInterface(at, interfaceIds.conversion)),
      uiMultiplier: batch.add(token.uiMultiplier(at)),
      newUIMultiplier: batch.add(token.newUIMultiplier(at)),
      effectiveAt: batch.add(token.effectiveAt(at)),
      oraclePaused: batch.add(token.oraclePaused(at)),
      paused: batch.add(token.paused(at)),
      accessRegistry: batch.add(token.accessRegistry(at)),
      feed:
        typeof listing === "string"
          ? null
          : {
              accessController: batch.add(feed.accessController(listing.proxy)),
              decimals: batch.add(feed.decimals(listing.proxy)),
              aggregator: batch.add(feed.aggregator(listing.proxy)),
              latestRound: batch.add(feed.latestRoundData(listing.proxy)),
            },
    };
  });
  await batch.run();

  // Each access registry once, however many tokens name it.
  const registries = new Map<Address, Handle<boolean>>();
  const registryBatch = rpc.batch({ perCall: READS_PER_CALL });
  for (const h of handles) {
    const registry = h.accessRegistry.read();
    if (registry.ok && !registries.has(getAddress(registry.value))) {
      registries.set(getAddress(registry.value), registryBatch.add(token.paused(registry.value)));
    }
  }
  await registryBatch.run();

  return listed.map((item, i) => {
    const h = handles[i];
    if (h === undefined) throw new Error("a token lost its reads");
    const registry = h.accessRegistry.read();
    const registryPaused: Read<boolean> = registry.ok
      ? (registries.get(getAddress(registry.value))?.read() ?? unavailable("not read"))
      : registry.kind === "reverted"
        ? { ok: false, kind: "reverted", error: `ACCESS_CONTROLLED_REGISTRY() ${registry.error}` }
        : registry;
    const feedReads =
      h.feed === null
        ? null
        : {
            accessController: h.feed.accessController.read(),
            decimals: h.feed.decimals.read(),
            aggregator: h.feed.aggregator.read(),
            latestRound: h.feed.latestRound.read(),
          };
    const name = h.name.read();
    const uid = h.uid.read();
    const decimals = h.decimals.read();
    const latestRound = feedReads?.latestRound.ok === true ? feedReads.latestRound.value : null;
    const feedDecimals = feedReads?.decimals.ok === true ? feedReads.decimals.value : null;
    const base = {
      listed: item,
      name: name.ok ? name.value : null,
      uid: uid.ok ? uid.value : null,
      decimals: decimals.ok ? decimals.value : item.asset.decimals,
      latestRound,
      feedDecimals,
    };
    if (item.asset.status !== ACTIVE) {
      const reason = `the registry lists the token as ${item.asset.status}`;
      return {
        ...base,
        feed: {
          ...notRun(reason),
          proxy: null,
          heartbeatSeconds: null,
          deviationThresholdPercent: null,
          marketHours: null,
        },
        erc8056: { ...notRun(reason), core: null, balances: null, pending: null, conversion: null },
        multiplier: {
          ...notRun(reason),
          uiMultiplier: null,
          newUIMultiplier: null,
          effectiveAt: null,
        },
        pauses: { ...notRun(reason), oraclePaused: null, paused: null, registryPaused: null },
        uidCheck: notRun(reason),
      };
    }
    return {
      ...base,
      feed: judgeFeed(item.feed, feedReads),
      erc8056: judgeErc8056({
        core: h.core.read(),
        balances: h.balances.read(),
        pending: h.pending.read(),
        conversion: h.conversion.read(),
      }),
      multiplier: judgeMultiplier(
        {
          uiMultiplier: h.uiMultiplier.read(),
          newUIMultiplier: h.newUIMultiplier.read(),
          effectiveAt: h.effectiveAt.read(),
        },
        now,
      ),
      pauses: judgePauses({
        oraclePaused: h.oraclePaused.read(),
        paused: h.paused.read(),
        registryPaused,
      }),
      uidCheck: judgeUid({ uid, decimals }, item.asset.id, item.asset.decimals),
    };
  });
}
