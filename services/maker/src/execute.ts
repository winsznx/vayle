import { vayleMarketAbi } from "@vayle/abi";
import { withGasMargin } from "@vayle/market";
import {
  erc20Abi,
  hashTypedData,
  maxUint256,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { MakerConfig } from "./config.ts";
import { DigestMismatch } from "./errors.ts";
import type { MakerAction, QuoteTerms } from "./plan.ts";

export interface Clients {
  readonly public: PublicClient;
  readonly wallet: WalletClient<Transport, Chain, Account>;
  readonly signer: PrivateKeyAccount;
}

const ANY_TAKER: Address = "0x0000000000000000000000000000000000000000";
let lastNonce = 0n;

// Unique and increasing for this maker, so a quote can never collide with an earlier one.
function nextNonce(): bigint {
  const now = BigInt(Date.now()) * 1000n;
  lastNonce = now > lastNonce ? now : lastNonce + 1n;
  return lastNonce;
}

async function confirmed(clients: Clients, hash: Hash): Promise<Hash> {
  await clients.public.waitForTransactionReceipt({ hash });
  return hash;
}

type Request = Parameters<Clients["wallet"]["writeContract"]>[0];

// Sends with a gas limit over the estimate, since what a call costs depends on the second it
// lands in (withGasMargin).
async function sent(clients: Clients, request: Request): Promise<Hash> {
  const { address, abi, functionName, args } = request;
  const gas = withGasMargin(
    await clients.public.estimateContractGas({
      address,
      abi,
      functionName,
      account: clients.wallet.account,
      ...(args === undefined ? {} : { args }),
    }),
  );
  return confirmed(clients, await clients.wallet.writeContract({ ...request, gas }));
}

const QUOTE_TYPES = {
  Quote: [
    { name: "maker", type: "address" },
    { name: "taker", type: "address" },
    { name: "series", type: "uint256" },
    { name: "premium", type: "uint256" },
    { name: "maxFeeBps", type: "uint16" },
    { name: "maxAmount", type: "uint256" },
    { name: "minFill", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export interface Quote {
  readonly maker: Address;
  readonly taker: Address;
  readonly series: bigint;
  readonly premium: bigint;
  readonly maxFeeBps: number;
  readonly maxAmount: bigint;
  readonly minFill: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
}

// The quote as EIP-712 typed data, bound to this chain and this market by the domain.
export function quoteTypedData(config: Pick<MakerConfig, "chainId" | "market">, quote: Quote) {
  return {
    domain: {
      name: "Vayle",
      version: "1",
      chainId: config.chainId,
      verifyingContract: config.market,
    },
    types: QUOTE_TYPES,
    primaryType: "Quote",
    message: quote,
  } as const;
}

// The maker hashes the quote itself and signs that, so an RPC can't hand it the digest of some
// other quote to sign. It still asks the market for its digest and refuses to sign when the two
// differ, which catches an RPC that lies and a market whose domain isn't the one expected.
export async function signedQuote(
  clients: Pick<Clients, "public" | "signer">,
  config: Pick<MakerConfig, "chainId" | "market">,
  terms: QuoteTerms,
): Promise<{ quote: Quote; signature: Hex }> {
  const quote: Quote = {
    maker: clients.signer.address,
    taker: ANY_TAKER,
    series: terms.series,
    premium: terms.premium,
    maxFeeBps: terms.maxFeeBps,
    maxAmount: terms.maxAmount,
    minFill: terms.minFill,
    nonce: nextNonce(),
    deadline: BigInt(terms.deadline),
  };
  const typed = quoteTypedData(config, quote);
  const digest = hashTypedData(typed);
  const reported = await clients.public.readContract({
    address: config.market,
    abi: vayleMarketAbi,
    functionName: "quoteDigest",
    args: [quote],
  });
  if (reported !== digest) {
    throw new DigestMismatch(
      `the market reports quote digest ${reported}, the maker computed ${digest}`,
    );
  }
  const signature = await clients.signer.signTypedData(typed);
  return { quote, signature };
}

// Simulates first, so a call that would revert is never sent, then waits for the receipt.
export async function execute(
  clients: Clients,
  config: MakerConfig,
  action: MakerAction,
): Promise<Hash> {
  const { account } = clients.wallet;
  const market = { address: config.market, abi: vayleMarketAbi, account } as const;
  const sim = clients.public;
  switch (action.kind) {
    case "approve": {
      const { request } = await sim.simulateContract({
        address: action.token,
        abi: erc20Abi,
        functionName: "approve",
        args: [config.market, maxUint256],
        account,
      });
      return sent(clients, request);
    }
    case "withdraw": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "withdraw",
        args: [action.token, action.amount],
      });
      return sent(clients, request);
    }
    case "exercise": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "exercise",
        args: [action.series, action.amount],
      });
      return sent(clients, request);
    }
    case "register": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "seriesFor",
        args: [config.asset, BigInt(action.expiry), action.side, action.strike],
      });
      return sent(clients, request);
    }
    case "bid": {
      const { quote, signature } = await signedQuote(clients, config, action.quote);
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "submitBid",
        args: [quote, signature],
      });
      return sent(clients, request);
    }
    case "fill": {
      const { quote, signature } = await signedQuote(clients, config, action.quote);
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "fillQuote",
        args: [quote, signature, action.orderId, action.quote.maxAmount],
      });
      return sent(clients, request);
    }
  }
}
