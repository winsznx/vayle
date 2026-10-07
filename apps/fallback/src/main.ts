import { livenessCheckpointAbi, vayleMarketAbi } from "@vayle/abi";
import {
  approve,
  cancelOrder,
  claimable,
  exercise,
  finalize,
  finalizeBlockedUntil,
  ordersOf,
  seriesState,
  settleOrder,
  withdraw,
  withGasMargin,
  type Call,
  type NextStep,
  type OrderState,
  type SeriesState,
} from "@vayle/market";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  numberToHex,
  type Address,
  type PublicClient,
} from "viem";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { button, field, h } from "./dom.ts";
import {
  amount,
  calldata,
  checkExercise,
  moment,
  orderLine,
  type HeldOpen,
  type Position,
  type Units,
} from "./view.ts";
import { watchWallets, type Wallet } from "./wallets.ts";

const chain = defineChain({
  id: facts.chain.chainId,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  // Reads go through the wallet, or an RPC typed into the page. Nothing is built in.
  rpcUrls: { default: { http: [] } },
});
const asset = getAddress(facts.nvda.address);
const usdg = getAddress(facts.usdg.address);
const units: Units = {
  assetSymbol: facts.nvda.symbol,
  assetDecimals: facts.nvda.decimals,
  usdgDecimals: facts.usdg.decimals,
};
const connectingDocs = facts.chain.sources.find((source) => source.endsWith("/connecting")) ?? "";

// The market from the deployment record when this build has one. #market=0x... in the URL wins.
const records = import.meta.glob<{ readonly market?: string }>(
  "../../../deployments/vayle-robinhood-mainnet.json",
  { eager: true, import: "default" },
);
const recordedMarket = Object.values(records)[0]?.market ?? "";

class NotAMarket extends Error {
  override readonly name = "NotAMarket";
}

interface Read {
  readonly now: bigint;
  readonly account: Address;
  readonly market: Address;
  readonly orders: readonly OrderState[];
  readonly series: ReadonlyMap<bigint, SeriesState>;
  readonly held: ReadonlyMap<bigint, HeldOpen>;
  readonly claimableAsset: bigint;
  readonly claimableUsdg: bigint;
}

interface Exercise {
  readonly series: bigint;
  readonly position: Position;
  readonly asset: Address;
  readonly summary: string;
  readonly calls: readonly Call[];
}

interface State {
  wallets: readonly Wallet[];
  wallet: Wallet | null;
  account: Address | null;
  chainId: number | null;
  marketText: string;
  rpcText: string;
  addressText: string;
  read: Read | null;
  problem: string | null;
  busy: boolean;
  log: string[];
  seriesText: string;
  amountText: string;
  exercise: Exercise | null;
  exerciseProblem: string | null;
}

const state: State = {
  wallets: [],
  wallet: null,
  account: null,
  chainId: null,
  marketText: new URLSearchParams(location.hash.slice(1)).get("market") ?? recordedMarket,
  rpcText: "",
  addressText: "",
  read: null,
  problem: null,
  busy: false,
  log: [],
  seriesText: "",
  amountText: "",
  exercise: null,
  exerciseProblem: null,
};

function describe(error: unknown): string {
  return error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error);
}

function note(message: string): void {
  const time = new Date().toISOString().slice(11, 19);
  state.log = [`${time} UTC  ${message}`, ...state.log].slice(0, 50);
}

function typedAddress(text: string): Address | null {
  const trimmed = text.trim();
  return isAddress(trimmed) ? getAddress(trimmed) : null;
}

// Where reads come from: the connected wallet, or an RPC and an address typed into the page.
function source(): { readonly client: PublicClient; readonly account: Address } | null {
  if (state.wallet !== null && state.account !== null) {
    return {
      client: createPublicClient({ chain, transport: custom(state.wallet.provider) }),
      account: state.account,
    };
  }
  const account = typedAddress(state.addressText);
  if (state.rpcText.trim() === "" || account === null) return null;
  return { client: createPublicClient({ chain, transport: http(state.rpcText.trim()) }), account };
}

async function readMarket(client: PublicClient, market: Address, owner: Address): Promise<Read> {
  const chainId = await client.getChainId();
  if (chainId !== chain.id) {
    throw new NotAMarket(
      `That's chain ${chainId}. Vayle is on Robinhood Chain, chain ${chain.id}.`,
    );
  }
  const code = await client.getCode({ address: market });
  if (code === undefined || code === "0x") {
    throw new NotAMarket(`There's no contract at ${market}. Check the market address.`);
  }
  try {
    await client.readContract({ address: market, abi: vayleMarketAbi, functionName: "orderCount" });
  } catch (error) {
    throw new NotAMarket(`${market} isn't a Vayle market.`, { cause: error });
  }
  const [block, orders, claimableAsset, claimableUsdg] = await Promise.all([
    client.getBlock({ blockTag: "latest" }),
    ordersOf(client, market, owner),
    claimable(client, market, owner, asset),
    claimable(client, market, owner, usdg),
  ]);
  const ids = [...new Set(orders.filter((o) => o.series !== 0n).map((o) => o.series))];
  const series = new Map(
    await Promise.all(ids.map(async (id) => [id, await seriesState(client, market, id)] as const)),
  );
  const held = new Map<bigint, HeldOpen>();
  const due = [...series.values()].filter((s) => !s.settled && block.timestamp >= s.windowEnd);
  if (due.length > 0) {
    const [liveness, cap] = await Promise.all([
      client.readContract({ address: market, abi: vayleMarketAbi, functionName: "liveness" }),
      client.readContract({
        address: market,
        abi: vayleMarketAbi,
        functionName: "LIVENESS_EXTENSION_CAP",
      }),
    ]);
    const [lastSeen, threshold] = await Promise.all([
      client.readContract({
        address: liveness,
        abi: livenessCheckpointAbi,
        functionName: "lastSeen",
      }),
      client.readContract({
        address: liveness,
        abi: livenessCheckpointAbi,
        functionName: "GAP_THRESHOLD",
      }),
    ]);
    const quietSince = block.timestamp - lastSeen > threshold ? lastSeen : null;
    for (const s of due) {
      const until = await finalizeBlockedUntil(client, market, owner, s.id);
      if (until !== null) held.set(s.id, { until, quietSince, latest: s.windowEnd + cap });
    }
  }
  return {
    now: block.timestamp,
    account: owner,
    market,
    orders,
    series,
    held,
    claimableAsset,
    claimableUsdg,
  };
}

async function load(): Promise<void> {
  state.read = null;
  state.problem = null;
  state.exercise = null;
  const from = source();
  const market = typedAddress(state.marketText);
  if (from === null) {
    render();
    return;
  }
  if (market === null) {
    state.problem = "Enter the Vayle market's address.";
    render();
    return;
  }
  state.busy = true;
  render();
  try {
    state.read = await readMarket(from.client, market, from.account);
    history.replaceState(null, "", `#market=${market}`);
  } catch (error) {
    state.problem = describe(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function connect(wallet: Wallet): Promise<void> {
  try {
    const accounts = await wallet.provider.request({ method: "eth_requestAccounts" });
    const chainId = await wallet.provider.request({ method: "eth_chainId" });
    const first = accounts[0];
    if (first === undefined) throw new Error("The wallet didn't share an account.");
    state.wallet = wallet;
    state.account = getAddress(first);
    state.chainId = Number(chainId);
    wallet.provider.on("accountsChanged", (next) => {
      const account = next[0];
      state.account = account === undefined ? null : getAddress(account);
      void load();
    });
    wallet.provider.on("chainChanged", (next) => {
      state.chainId = Number(next);
      void load();
    });
    note(`Connected ${wallet.name} as ${state.account}.`);
  } catch (error) {
    note(`Couldn't connect ${wallet.name}: ${describe(error)}`);
  }
  await load();
}

async function switchChain(wallet: Wallet): Promise<void> {
  try {
    await wallet.provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: numberToHex(chain.id) }],
    });
  } catch (error) {
    note(
      `The wallet didn't switch: ${describe(error)}. Add Robinhood Chain to it first: ${connectingDocs}`,
    );
    render();
  }
}

// Sends each call after the one before it confirms, then reads everything again.
async function send(label: string, calls: readonly Call[]): Promise<void> {
  const { wallet, account } = state;
  if (wallet === null || account === null) return;
  const walletClient = createWalletClient({ account, chain, transport: custom(wallet.provider) });
  const client = createPublicClient({ chain, transport: custom(wallet.provider) });
  state.busy = true;
  note(
    `${label}: confirm ${calls.length === 1 ? "it" : `${calls.length} transactions`} in the wallet.`,
  );
  render();
  try {
    for (const call of calls) {
      const estimate = await client.estimateGas({ account, to: call.to, data: call.data });
      const hash = await walletClient.sendTransaction({
        account,
        chain,
        to: call.to,
        data: call.data,
        gas: withGasMargin(estimate),
      });
      note(`${label}: sent ${hash}.`);
      render();
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    }
    note(`${label}: done.`);
  } catch (error) {
    note(`${label} didn't go through: ${describe(error)}`);
  } finally {
    state.busy = false;
    await load();
  }
}

function orderAction(
  market: Address,
  order: OrderState,
  step: NextStep,
): { readonly label: string; readonly calls: readonly Call[] } | null {
  if (step === "settle") {
    return { label: `Settle order ${order.id}`, calls: [settleOrder(market, order.id)] };
  }
  if (step === "finalize-then-settle") {
    return {
      label: `Finalize and settle order ${order.id}`,
      calls: [finalize(market, order.series), settleOrder(market, order.id)],
    };
  }
  if (step === "cancel") {
    return { label: `Cancel order ${order.id}`, calls: [cancelOrder(market, order.id)] };
  }
  return null;
}

// A button that sends the calls when a wallet is connected, and their calldata either way.
function action(label: string, calls: readonly Call[]): HTMLElement {
  const canSend = state.wallet !== null && state.account !== null;
  return h(
    "div",
    { class: "action" },
    canSend &&
      button(
        label,
        () => {
          void send(label, calls);
        },
        state.busy,
      ),
    h("details", {}, h("summary", {}, "Calldata"), h("pre", {}, calldata(calls))),
  );
}

async function prepareExercise(): Promise<void> {
  state.exercise = null;
  state.exerciseProblem = null;
  const from = source();
  const read = state.read;
  if (from === null || read === null) {
    state.exerciseProblem = "Read the market first.";
    render();
    return;
  }
  let id: bigint;
  try {
    id = BigInt(state.seriesText.trim());
  } catch (error) {
    state.exerciseProblem = `Enter the series ID in decimal or 0x hex (${describe(error)}).`;
    render();
    return;
  }
  try {
    const { client } = from;
    const [key, series, balance] = await Promise.all([
      client.readContract({
        address: read.market,
        abi: vayleMarketAbi,
        functionName: "seriesKey",
        args: [id],
      }),
      seriesState(client, read.market, id),
      client.readContract({
        address: read.market,
        abi: vayleMarketAbi,
        functionName: "balanceOf",
        args: [read.account, id],
      }),
    ]);
    const epoch = await client.readContract({
      address: read.market,
      abi: vayleMarketAbi,
      functionName: "epoch",
      args: [key.asset, key.expiry],
    });
    const position: Position = { series, balance, lot: epoch.lot, rawUnit: epoch.rawUnit };
    const check = checkExercise(position, state.amountText, read.now, units);
    if (!check.ok) {
      state.exerciseProblem = check.problem;
      render();
      return;
    }
    const payToken = check.pays.token === "usdg" ? usdg : key.asset;
    const allowance = await client.readContract({
      address: payToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [read.account, read.market],
    });
    const exerciseCall = exercise(read.market, id, check.amount);
    const calls =
      allowance < check.pays.amount
        ? [approve(payToken, read.market, check.pays.amount), exerciseCall]
        : [exerciseCall];
    const exercised = amount(check.amount, units.assetDecimals, units.assetSymbol);
    const strikeValue = amount(check.strikeValue, units.usdgDecimals, "USDG");
    const summary =
      series.side === 0
        ? `Exercising ${exercised} of this call pays ${strikeValue} and credits ${exercised} to withdraw.`
        : `Exercising ${exercised} of this put delivers ${exercised} and credits ${strikeValue} to withdraw.`;
    state.exercise = { series: id, position, asset: key.asset, summary, calls };
  } catch (error) {
    state.exerciseProblem = describe(error);
  }
  render();
}

function walletSection(): HTMLElement {
  const parts: (Node | string)[] = [];
  if (state.wallet !== null && state.account !== null) {
    parts.push(h("p", {}, `Connected ${state.wallet.name} as `, h("code", {}, state.account), "."));
    if (state.chainId !== chain.id) {
      const wallet = state.wallet;
      parts.push(
        h(
          "p",
          {},
          `The wallet is on chain ${state.chainId ?? "unknown"}, not Robinhood Chain (${chain.id}).`,
        ),
        button("Switch to Robinhood Chain", () => {
          void switchChain(wallet);
        }),
      );
    }
    return h("section", {}, h("h2", {}, "Wallet"), ...parts);
  }
  if (state.wallets.length === 0) {
    parts.push(
      h(
        "p",
        {},
        "No browser wallet found. You can still read with an RPC below and send the calldata from any wallet.",
      ),
    );
  } else {
    for (const wallet of state.wallets) {
      parts.push(
        button(`Connect ${wallet.name}`, () => {
          void connect(wallet);
        }),
      );
    }
  }
  const typed = state.addressText !== "" || state.rpcText !== "";
  parts.push(
    h(
      "details",
      typed ? { open: "" } : {},
      h("summary", {}, "Read without a wallet"),
      h(
        "p",
        {},
        "Reads go to the RPC you enter. Actions show their calldata to send from elsewhere.",
      ),
      field("Your address", state.addressText, (value) => {
        state.addressText = value;
      }),
      field("Robinhood Chain RPC URL", state.rpcText, (value) => {
        state.rpcText = value;
      }),
    ),
  );
  return h("section", {}, h("h2", {}, "Wallet"), ...parts);
}

function marketSection(): HTMLElement {
  return h(
    "section",
    {},
    h("h2", {}, "Market"),
    field("Market address", state.marketText, (value) => {
      state.marketText = value;
    }),
    button(
      state.read === null ? "Read" : "Read again",
      () => {
        void load();
      },
      state.busy,
    ),
    state.busy && h("p", {}, "Reading…"),
    state.problem !== null && h("p", { class: "problem", role: "alert" }, state.problem),
    state.read !== null &&
      h(
        "p",
        {},
        `Read at chain time ${moment(state.read.now)} for `,
        h("code", {}, state.read.account),
        ".",
      ),
  );
}

function ordersSection(read: Read): HTMLElement {
  if (read.orders.length === 0) {
    return h(
      "section",
      {},
      h("h2", {}, "Orders"),
      h("p", {}, "This address has no orders in this market."),
    );
  }
  const rows = read.orders.map((order) => {
    const series = order.series === 0n ? null : (read.series.get(order.series) ?? null);
    const line = orderLine(order, series, read.now, units, read.held.get(order.series) ?? null);
    const next = orderAction(read.market, order, line.step);
    return h(
      "li",
      {},
      h("p", {}, h("strong", {}, `Order ${order.id}. `), line.what),
      h("p", {}, line.state),
      next === null
        ? h(
            "p",
            { class: "quiet" },
            line.step === "wait" ? "Nothing to do yet." : "Nothing left to do.",
          )
        : action(next.label, next.calls),
    );
  });
  return h("section", {}, h("h2", {}, "Orders"), h("ol", { class: "orders" }, ...rows));
}

function withdrawSection(read: Read): HTMLElement {
  const items: HTMLElement[] = [];
  if (read.claimableAsset > 0n) {
    const shown = amount(read.claimableAsset, units.assetDecimals, units.assetSymbol);
    items.push(action(`Withdraw ${shown}`, [withdraw(read.market, asset, read.claimableAsset)]));
  }
  if (read.claimableUsdg > 0n) {
    const shown = amount(read.claimableUsdg, units.usdgDecimals, "USDG");
    items.push(action(`Withdraw ${shown}`, [withdraw(read.market, usdg, read.claimableUsdg)]));
  }
  return h(
    "section",
    {},
    h("h2", {}, "Withdraw"),
    ...(items.length === 0 ? [h("p", {}, "Nothing to withdraw.")] : items),
  );
}

function exerciseSection(): HTMLElement {
  const prepared = state.exercise;
  return h(
    "section",
    {},
    h("h2", {}, "Exercise"),
    h(
      "p",
      {},
      "For an account that holds options in a series, during that series' exercise window.",
    ),
    field("Series ID", state.seriesText, (value) => {
      state.seriesText = value;
    }),
    field(`Amount of ${units.assetSymbol}`, state.amountText, (value) => {
      state.amountText = value;
    }),
    button(
      "Check",
      () => {
        void prepareExercise();
      },
      state.busy,
    ),
    state.exerciseProblem !== null &&
      h("p", { class: "problem", role: "alert" }, state.exerciseProblem),
    prepared !== null &&
      h(
        "div",
        {},
        h(
          "p",
          {},
          `This account holds ${amount(prepared.position.balance, units.assetDecimals, units.assetSymbol)} in the series. Its window ends ${moment(prepared.position.series.windowEnd)}.`,
        ),
        h("p", {}, prepared.summary),
        action("Exercise", prepared.calls),
      ),
  );
}

function logSection(): HTMLElement {
  return h(
    "section",
    {},
    h("h2", {}, "Activity"),
    state.log.length === 0
      ? h("p", { class: "quiet" }, "Nothing yet.")
      : h("ol", { class: "log", reversed: "" }, ...state.log.map((line) => h("li", {}, line))),
  );
}

function render(): void {
  const app = document.getElementById("app");
  if (app === null) return;
  const read = state.read;
  app.replaceChildren(
    walletSection(),
    marketSection(),
    ...(read === null ? [] : [ordersSection(read), withdrawSection(read)]),
    exerciseSection(),
    logSection(),
  );
}

watchWallets((wallets) => {
  state.wallets = wallets;
  render();
});
