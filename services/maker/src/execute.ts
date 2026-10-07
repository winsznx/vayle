import { vayleMarketAbi } from "@vayle/abi";
import {
  erc20Abi,
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

// The maker signs the digest the market itself computes, so the signed bytes can't drift from what
// the contract verifies.
async function signedQuote(clients: Clients, config: MakerConfig, terms: QuoteTerms) {
  const quote = {
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
  const digest = await clients.public.readContract({
    address: config.market,
    abi: vayleMarketAbi,
    functionName: "quoteDigest",
    args: [quote],
  });
  const signature: Hex = await clients.signer.sign({ hash: digest });
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
  const write = clients.wallet;
  switch (action.kind) {
    case "approve": {
      const { request } = await sim.simulateContract({
        address: action.token,
        abi: erc20Abi,
        functionName: "approve",
        args: [config.market, maxUint256],
        account,
      });
      return confirmed(clients, await write.writeContract(request));
    }
    case "withdraw": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "withdraw",
        args: [action.token, action.amount],
      });
      return confirmed(clients, await write.writeContract(request));
    }
    case "exercise": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "exercise",
        args: [action.series, action.amount],
      });
      return confirmed(clients, await write.writeContract(request));
    }
    case "register": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "seriesFor",
        args: [config.asset, BigInt(action.expiry), action.side, action.strike],
      });
      return confirmed(clients, await write.writeContract(request));
    }
    case "bid": {
      const { quote, signature } = await signedQuote(clients, config, action.quote);
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "submitBid",
        args: [quote, signature],
      });
      return confirmed(clients, await write.writeContract(request));
    }
    case "fill": {
      const { quote, signature } = await signedQuote(clients, config, action.quote);
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "fillQuote",
        args: [quote, signature, action.orderId, action.quote.maxAmount],
      });
      return confirmed(clients, await write.writeContract(request));
    }
  }
}
