import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, getAddress, parseAbi, zeroAddress } from "viem";
import { SourceMismatch } from "../src/errors.ts";
import {
  addressListedFor,
  quote,
  selectUniswapContracts,
  sortPair,
  v4Pool,
  v4PoolId,
  type Route,
  type UniswapContracts,
} from "../src/uniswap.ts";

const NVDA = getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");

function record(protocol: string, contract: string, address: string, extra = {}): object {
  return { protocol, contract, address, chainId: 4663, env: "mainnet", status: "active", ...extra };
}

const RECORDS = [
  record("v2", "UniswapV2Factory", "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f"),
  record("v2", "UniswapV2Router02", "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba"),
  record("v3", "UniswapV3Factory", "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA"),
  record("v3", "QuoterV2", "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7"),
  record("v4", "PoolManager", "0x8366a39CC670B4001A1121B8F6A443A643e40951"),
  record("v4", "V4Quoter", "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94"),
  record("v4", "StateView", "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b"),
  record("v4", "PositionManager", "0x58daec3116aae6D93017bAAea7749052E8a04fA7"),
  record("v4", "PoolManager", "0x000000000004444c5dc75cB358380D2e3dE08A90", { chainId: 1 }),
  record("v4", "V4Quoter", "0x0000000000000000000000000000000000000001", { status: "deprecated" }),
];

describe("selectUniswapContracts", () => {
  it("takes each contract's one active mainnet record on the chain", () => {
    // #given
    const json = { records: RECORDS };
    // #when
    const contracts = selectUniswapContracts(json, 4663);
    // #then
    assert.deepEqual(
      [contracts.v4PoolManager, contracts.v4Quoter],
      [
        getAddress("0x8366a39CC670B4001A1121B8F6A443A643e40951"),
        getAddress("0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94"),
      ],
    );
  });

  it("refuses a feed with two active records for one contract", () => {
    // #given
    const json = {
      records: [...RECORDS, record("v3", "QuoterV2", "0x0000000000000000000000000000000000000002")],
    };
    // #when
    const select = (): UniswapContracts => selectUniswapContracts(json, 4663);
    // #then
    assert.throws(select, SourceMismatch);
  });
});

describe("addressListedFor", () => {
  it("reads a symbol's address out of a token contracts page", () => {
    // #given
    const html = `<tr><td>WETH</td><td><code>${WETH}</code></td></tr><tr><td>USDG</td><td>${USDG}</td></tr>`;
    // #when
    const found = [
      addressListedFor(html, "WETH"),
      addressListedFor(html, "USDG"),
      addressListedFor(html, "DAI"),
    ];
    // #then
    assert.deepEqual(found, [WETH, USDG, null]);
  });
});

describe("v4 pool IDs", () => {
  it("hashes NVDA/USDG at 0.01% and tick spacing 1 to the ID the state view answers for", () => {
    // #given
    // getSlot0 returned a live price for this ID at block 82831211.
    const [currency0, currency1] = sortPair(NVDA, USDG);
    // #when
    const id = v4PoolId(currency0, currency1, { fee: 100, tickSpacing: 1, hooks: zeroAddress });
    // #then
    assert.equal(id, "0x6444a8e0b267406a15db74ca00c4a24bdfa81ed3180f5b6d0851f8ed6f4f29c5");
  });

  it("puts native ETH first in every pair", () => {
    // #given
    const shape = { fee: 500, tickSpacing: 10, hooks: zeroAddress };
    // #when
    const pool = v4Pool(USDG, zeroAddress, shape);
    // #then
    assert.deepEqual([pool.currency0, pool.currency1], [zeroAddress, USDG]);
  });
});

describe("quote", () => {
  const contracts = selectUniswapContracts({ records: RECORDS }, 4663);

  it("prices a two-hop v3 sale through QuoterV2's packed path", () => {
    // #given
    const route: Route = {
      protocol: "uniswap-v3",
      path: [NVDA, WETH, USDG],
      pools: [
        {
          protocol: "uniswap-v3",
          id: zeroAddress,
          currency0: WETH,
          currency1: NVDA,
          fee: 500,
          tickSpacing: 10,
          hooks: null,
        },
        {
          protocol: "uniswap-v3",
          id: zeroAddress,
          currency0: WETH,
          currency1: USDG,
          fee: 3000,
          tickSpacing: 60,
          hooks: null,
        },
      ],
    };
    // #when
    const probe = quote(contracts, route, 10n ** 18n);
    const decoded = decodeFunctionData({
      abi: parseAbi(["function quoteExactInput(bytes path, uint256 amountIn)"]),
      data: probe.call.data,
    });
    // #then
    assert.deepEqual(decoded.args, [
      `${NVDA}0001f4${WETH.slice(2)}000bb8${USDG.slice(2)}`.toLowerCase(),
      10n ** 18n,
    ]);
  });

  it("sells one-for-zero in a v4 pool where USDG sorts below the token", () => {
    // #given
    const pool = v4Pool(NVDA, USDG, { fee: 100, tickSpacing: 1, hooks: zeroAddress });
    const route: Route = { protocol: "uniswap-v4", path: [NVDA, USDG], pools: [pool] };
    // #when
    const probe = quote(contracts, route, 5n);
    const decoded = decodeFunctionData({
      abi: parseAbi([
        "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
        "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
        "function quoteExactInputSingle(QuoteExactSingleParams params)",
      ]),
      data: probe.call.data,
    });
    // #then
    assert.equal(decoded.args[0].zeroForOne, false);
  });
});
