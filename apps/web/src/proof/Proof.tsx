import { easternTime as eastern } from "../app/format.ts";
import { BrandMark } from "../ui/BrandMark.tsx";
import { ThemeToggle } from "../ui/ThemeToggle.tsx";
import { TokenLogo } from "../ui/TokenLogo.tsx";
import { REPO_URL } from "../links.ts";

// vayle.xyz/proof: what Vayle has done on mainnet, every line from deployments/proof.json, which
// tools/proof writes from the market's own events and the repository's CI. Nothing here is typed in
// by hand, so a reader can check each number against the chain or the run it names.

const EXPLORER = "https://robinhoodchain.blockscout.com";

interface Transaction {
  readonly hash: string;
  readonly block: number;
  readonly time: string;
  readonly events: readonly string[];
  readonly account: string | null;
  readonly team: string | null;
}

interface CiRun {
  readonly url: string;
  readonly commit: string;
  readonly finishedAt: string;
  readonly conclusion: string;
  readonly jobs: readonly { readonly name: string; readonly conclusion: string }[];
  readonly contractTests: { readonly passed: number; readonly failed: number } | null;
  readonly typescriptTests: { readonly passed: number; readonly failed: number } | null;
}

export interface ProofData {
  readonly generatedAt: string;
  readonly toBlock: number;
  readonly toBlockTime: number;
  readonly deployment: Readonly<Record<string, string | number>>;
  readonly team: readonly { readonly address: string; readonly label: string }[];
  readonly counts: Readonly<Record<string, number>>;
  readonly wallets: {
    readonly total: number;
    readonly team: number;
    readonly outside: number;
  };
  readonly transactions: readonly Transaction[];
  readonly markets: readonly { readonly symbol: string; readonly token: string }[];
  readonly marketCheck: {
    readonly block: string;
    readonly timestamp: number;
    readonly total: number;
    readonly passed: readonly string[];
  };
  readonly ci: CiRun | null;
}

// Each event's name as a holder would read it.
const EVENT_NAMES: Readonly<Record<string, string>> = {
  EpochCreated: "Week opened",
  SeriesRegistered: "Price listed",
  OrderPlaced: "Target set",
  OrderAmended: "Target changed",
  OrderUpdated: "Least payment changed",
  OrderCancelled: "Target stopped",
  QuoteFilled: "Paid by quote",
  OrderCommitted: "Written into the week",
  BidSubmitted: "Maker bid",
  BatchOpened: "Batch opened",
  BatchSealed: "Batch sealed",
  BatchFilled: "Paid by batch",
  BatchDone: "Batch done",
  Exercised: "Tokens delivered",
  SeriesFinalized: "Week finalized",
  OrderSettled: "Target settled",
  OrderClosed: "Target closed",
  Credited: "Credited",
  Withdrawn: "Withdrawn",
  TransferSingle: "Options moved",
  OwnershipTransferred: "Owner set",
  GuardianSet: "Guardian set",
  FeeSet: "Fee set",
  CapsSet: "Caps set",
  TeamOperatedSet: "Maker flagged team-operated",
  BatchBidderSet: "Maker approved for batches",
};

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function eventSummary(events: readonly string[]): string {
  const seen: string[] = [];
  for (const e of events) {
    const name = EVENT_NAMES[e] ?? e;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen.join(", ");
}

function Stat({ value, label }: { readonly value: number; readonly label: string }) {
  return (
    <div className="proof-stat">
      <p className="proof-stat-value num">{value.toLocaleString("en-US")}</p>
      <p className="proof-stat-label">{label}</p>
    </div>
  );
}

function Contracts({ data }: { readonly data: ProofData }) {
  const rows: [string, string][] = [
    ["Market", String(data.deployment["market"])],
    ["Token registry", String(data.deployment["registry"])],
    ["Session calendar", String(data.deployment["calendar"])],
    ["Price adapter", String(data.deployment["priceAdapter"])],
    ["Liveness checkpoint", String(data.deployment["liveness"])],
    ["Timelock, 8 days 6 hours", String(data.deployment["timelock"])],
  ];
  const owner = data.team.find((w) => w.label.startsWith("Owner"));
  if (owner !== undefined) rows.push([owner.label, owner.address]);
  return (
    <section className="proof-section" aria-labelledby="contracts">
      <h2 id="contracts">Contracts</h2>
      <p className="muted">
        Deployed at block {Number(data.deployment["block"]).toLocaleString("en-US")}, with every
        contract's source verified.
      </p>
      <dl className="proof-rows">
        {rows.map(([name, address]) => (
          <div key={address} className="proof-row">
            <dt>{name}</dt>
            <dd>
              <a className="mono" href={`${EXPLORER}/address/${address}`}>
                {address}
              </a>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Transactions({ data }: { readonly data: ProofData }) {
  return (
    <section className="proof-section" aria-labelledby="transactions">
      <h2 id="transactions">Every transaction</h2>
      <p className="muted">
        Every mainnet transaction that touched the market, newest first, with what it did.
      </p>
      {data.transactions.length === 0 ? (
        <p className="proof-empty">No transactions yet.</p>
      ) : (
        <ol className="proof-txs">
          {data.transactions.map((tx) => (
            <li key={tx.hash} className="proof-tx">
              <p className="proof-tx-what">{eventSummary(tx.events)}</p>
              <p className="proof-tx-who muted">
                {tx.team ?? (tx.account === null ? "Anyone" : short(tx.account))}
                {tx.team !== null && <span className="proof-team">Team</span>}
              </p>
              <p className="proof-tx-when muted num">{eastern(Date.parse(tx.time) / 1000)}</p>
              <a className="proof-tx-link mono" href={`${EXPLORER}/tx/${tx.hash}`}>
                {short(tx.hash)}
              </a>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Ci({ ci }: { readonly ci: CiRun | null }) {
  return (
    <section className="proof-section" aria-labelledby="ci">
      <h2 id="ci">Tests and CI</h2>
      {ci === null ? (
        <p className="proof-empty">No finished CI run was found.</p>
      ) : (
        <>
          <p className="muted">
            The latest finished run on main, at commit{" "}
            <span className="mono">{ci.commit.slice(0, 7)}</span>, finished{" "}
            {eastern(Date.parse(ci.finishedAt) / 1000)}. <a href={ci.url}>Open the run</a>
          </p>
          <div className="proof-stats">
            {ci.contractTests !== null && (
              <Stat value={ci.contractTests.passed} label="contract tests passed" />
            )}
            {ci.contractTests !== null && (
              <Stat value={ci.contractTests.failed} label="contract tests failed" />
            )}
            {ci.typescriptTests !== null && (
              <Stat value={ci.typescriptTests.passed} label="TypeScript tests passed" />
            )}
          </div>
          <ul className="proof-jobs">
            {ci.jobs.map((job) => (
              <li key={job.name}>
                <span className={job.conclusion === "success" ? "proof-ok" : "proof-bad"}>
                  {job.conclusion}
                </span>{" "}
                {job.name}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Markets({ data }: { readonly data: ProofData }) {
  const check = data.marketCheck;
  return (
    <section className="proof-section" aria-labelledby="markets">
      <h2 id="markets">Markets and the market check</h2>
      <p className="muted">
        Every Stock Token was checked for a price feed the contracts can read, its interfaces,
        pauses, feed freshness and depth. {check.passed.length} of {check.total} passed at block{" "}
        {Number(check.block).toLocaleString("en-US")}, on {eastern(check.timestamp)}.{" "}
        <a href="/app/markets">See every token</a>
      </p>
      <ul className="proof-markets">
        {data.markets.map((m) => (
          <li key={m.token}>
            <TokenLogo symbol={m.symbol} size="md" label />
            <a className="mono muted" href={`${EXPLORER}/token/${m.token}`}>
              {short(m.token)}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Team({ data }: { readonly data: ProofData }) {
  return (
    <section className="proof-section" aria-labelledby="team">
      <h2 id="team">The team's wallets</h2>
      <p className="muted">
        Every address the team controls. They're labeled Team above and left out of the outside
        count.
      </p>
      <dl className="proof-rows">
        {data.team.map((w) => (
          <div key={w.address} className="proof-row">
            <dt>{w.label}</dt>
            <dd>
              <a className="mono" href={`${EXPLORER}/address/${w.address}`}>
                {w.address}
              </a>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function Proof({ data }: { readonly data: ProofData | null }) {
  return (
    <div className="proof">
      <header className="proof-bar">
        <a href="/" aria-label="Vayle home">
          <BrandMark />
        </a>
        <div className="proof-bar-actions">
          <ThemeToggle />
          <a className="btn btn-ink btn-sm" href="/app/">
            Open app
          </a>
        </div>
      </header>
      <main className="proof-main">
        <h1 className="proof-title">Vayle on mainnet</h1>
        {data === null ? (
          <p className="proof-empty">The proof record hasn't been generated for this build.</p>
        ) : (
          <>
            <p className="proof-lede">
              Read from Robinhood Chain up to block {data.toBlock.toLocaleString("en-US")}, at{" "}
              {eastern(data.toBlockTime)}. Each line links to the chain or the run it comes from.
            </p>
            <div className="proof-stats">
              <Stat value={data.counts["OrderPlaced"] ?? 0} label="targets set" />
              <Stat
                value={(data.counts["QuoteFilled"] ?? 0) + (data.counts["BatchFilled"] ?? 0)}
                label="weekly payments"
              />
              <Stat value={data.counts["Exercised"] ?? 0} label="deliveries" />
              <Stat value={data.counts["OrderSettled"] ?? 0} label="settlements" />
              <Stat
                value={data.wallets.outside}
                label={`outside wallets, of ${String(data.wallets.total)}`}
              />
            </div>
            <Transactions data={data} />
            <Contracts data={data} />
            <Markets data={data} />
            <Ci ci={data.ci} />
            <Team data={data} />
          </>
        )}
        <p className="proof-foot muted">
          This page is built from <span className="mono">deployments/proof.json</span>, which{" "}
          <a href={`${REPO_URL}/tree/main/tools/proof`}>tools/proof</a> writes.
        </p>
      </main>
    </div>
  );
}
