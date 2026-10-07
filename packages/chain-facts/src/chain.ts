import { defineChain, getAddress, type Chain } from "viem";
import { robinhood } from "viem/chains";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };

// Robinhood Chain as every Vayle client describes it to viem, from the verified chain facts.
// contracts.multicall3 is what lets a client fold reads made together into one Multicall3 call; a
// chain without it sends one eth_call per read. The RPC listed is the public one, because it's what
// a wallet is offered when it adds the chain. Clients put their own RPC in their transport. viem's
// entry for this network supplies only the name and native currency.
export const robinhoodChain: Chain = defineChain({
  id: facts.chain.chainId,
  name: robinhood.name,
  nativeCurrency: robinhood.nativeCurrency,
  rpcUrls: { default: { http: [facts.chain.publicRpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: facts.chain.explorerUrl } },
  contracts: {
    multicall3: {
      address: getAddress(facts.multicall3.address),
      blockCreated: facts.multicall3.blockCreated,
    },
  },
});
