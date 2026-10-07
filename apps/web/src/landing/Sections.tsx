import { useEffect, useRef, useState, type ReactNode } from "react";
import { TokenIcon } from "../ui/TokenIcon.tsx";
import { useReveal, Words } from "./reveal.tsx";

function Icon({ d }: { readonly d: string }) {
  return (
    <svg className="line-icon" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

const ICON_TAG = "M3 4.5A1.5 1.5 0 0 1 4.5 3H9l6 6-6 6-6-6V4.5ZM6.5 6.5h.01";
const ICON_TICKET =
  "M3 5.5A1.5 1.5 0 0 1 4.5 4h9A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 3 12.5v-7ZM6 8h6M6 10.5h3.5";
const ICON_RENEW =
  "M14.5 7.5A5.75 5.75 0 0 0 4 5.5M3.5 10.5A5.75 5.75 0 0 0 14 12.5M4 2.75V5.5h2.75M14 15.25V12.5h-2.75";
const ICON_CHECK = "M4 9.5 7.25 12.75 14 6";
const ICON_DASH = "M5 9h8";

function Heading({
  children,
  className,
  id,
}: {
  readonly children: string;
  readonly className: string;
  readonly id?: string;
}) {
  const ref = useReveal<HTMLHeadingElement>();
  return (
    <h2 ref={ref} id={id} className={`${className} reveal`}>
      <Words text={children} />
    </h2>
  );
}

export function Statement() {
  return (
    <section className="statement" aria-labelledby="statement-title">
      <span className="sticker sticker-a chip chip-earned">Earned</span>
      <span className="sticker sticker-b chip">Skipped</span>
      <span className="sticker sticker-c chip chip-brand">Filled at your price</span>
      <p className="tag tag-soft">How a week works</p>
      <Heading id="statement-title" className="display-2 statement-title">
        One price. Three outcomes. Every week.
      </Heading>
    </section>
  );
}

function Vignette({ children }: { readonly children: ReactNode }) {
  return (
    <div className="vignette" aria-hidden="true">
      {children}
    </div>
  );
}

export function HowItWorks() {
  return (
    <section id="how" className="how" aria-labelledby="how-title">
      <div className="split">
        <Heading className="h1">Built for holders, not options traders</Heading>
        <p className="lede">
          Underneath, each order is a fully collateralized weekly option. You never pick strikes,
          expiries or assignment rules. You choose a price and an amount, and Vayle runs the week.
        </p>
      </div>
      <h2 id="how-title" className="visually-hidden">
        How it works
      </h2>
      <ol className="steps">
        <li className="step">
          <span className="step-icon">
            <Icon d={ICON_TAG} />
          </span>
          <h3 className="h3">Pick a price</h3>
          <p className="muted">
            This week&apos;s prices sit every $5 within 10% of the last close. Above it you sell,
            below it you buy.
          </p>
          <Vignette>
            <div className="mini-ladder">
              <span className="mini-rung" />
              <span className="mini-rung mini-rung-held">Your price</span>
              <span className="mini-rung" />
              <span className="mini-close">Close</span>
              <span className="mini-rung" />
              <span className="mini-rung" />
            </div>
          </Vignette>
        </li>
        <li className="step">
          <span className="step-icon">
            <Icon d={ICON_TICKET} />
          </span>
          <h3 className="h3">Place one order</h3>
          <p className="muted">
            Lock the NVDA you&apos;d sell or the USDG you&apos;d spend, and set the least
            you&apos;ll accept for a week.
          </p>
          <Vignette>
            <div className="mini-ticket">
              <span className="mini-field">
                <TokenIcon symbol="NVDA" size="sm" />
                <span className="mini-bar" />
                NVDA
              </span>
              <span className="mini-field">
                <TokenIcon symbol="USDG" size="sm" />
                <span className="mini-bar mini-bar-short" />
                USDG
              </span>
              <span className="mini-button">Place order</span>
            </div>
          </Vignette>
        </li>
        <li className="step">
          <span className="step-icon">
            <Icon d={ICON_RENEW} />
          </span>
          <h3 className="h3">Let it run</h3>
          <p className="muted">
            Each week it earns that week&apos;s premium, skips if the bid is under your minimum, or
            fills at your price. It renews until it fills or you cancel.
          </p>
          <Vignette>
            <div className="mini-weeks">
              <span className="mini-week mini-week-earned">Earned</span>
              <span className="mini-week mini-week-earned">Earned</span>
              <span className="mini-week">Skipped</span>
              <span className="mini-week mini-week-earned">Earned</span>
              <span className="mini-week mini-week-filled">Filled</span>
            </div>
          </Vignette>
        </li>
      </ol>
    </section>
  );
}

const STAGES = [
  {
    when: "Weekly close",
    title: "The close sets the prices",
    body: "NVDA's close fixes this week's ladder. Options from last week can be exercised for the next two hours.",
  },
  {
    when: "Two hours later",
    title: "The maker bids",
    body: "The team-operated maker bids on each price that has orders. Your minimum decides whether you take it.",
  },
  {
    when: "Four hours later",
    title: "The batch fills",
    body: "Every order at a price fills at one clearing bid, shared pro rata. The premium is yours to withdraw right away.",
  },
  {
    when: "Through the week",
    title: "Your price holds",
    body: "If NVDA closes the week past your price, the maker can take the order at exactly that price, in the actual token, for at least two hours after the close.",
  },
  {
    when: "Next close",
    title: "It renews",
    body: "Unless it filled or you cancelled, the order moves into the next week on its own.",
  },
] as const;

// Each stage card reports itself as current once it crosses the middle of the screen; the sticky
// diagram on the left follows along.
export function TheWeek() {
  const [current, setCurrent] = useState(0);
  const cards = useRef<(HTMLLIElement | null)[]>([]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = cards.current.findIndex((card) => card === entry.target);
          if (index !== -1) setCurrent(index);
        }
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    for (const card of cards.current) if (card !== null) observer.observe(card);
    return () => {
      observer.disconnect();
    };
  }, []);
  return (
    <section id="week" className="week" aria-labelledby="week-title">
      <div className="week-sticky">
        <p className="tag tag-soft">The week</p>
        <Heading className="h1">From one weekly close to the next</Heading>
        <ol className="week-track" aria-hidden="true">
          {STAGES.map((stage, i) => (
            <li
              key={stage.when}
              className={
                i === current
                  ? "track-node is-current"
                  : i < current
                    ? "track-node is-past"
                    : "track-node"
              }
            >
              <span className="track-dot" />
              <span className="track-when">{stage.when}</span>
            </li>
          ))}
        </ol>
      </div>
      <h2 id="week-title" className="visually-hidden">
        The week
      </h2>
      <ol className="week-cards">
        {STAGES.map((stage, i) => (
          <li
            key={stage.when}
            ref={(node) => {
              cards.current[i] = node;
            }}
            className={i === current ? "week-card is-current" : "week-card"}
          >
            <p className="week-when">{stage.when}</p>
            <h3 className="h2">{stage.title}</h3>
            <p className="lede">{stage.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

// Generic categories only, each row true as written, including the one where Vayle gives
// something up: it fills after the weekly close, not the moment the price is touched.
const ROWS: readonly {
  label: string;
  plain: boolean | "varies";
  options: boolean | "varies";
  vayle: boolean;
}[] = [
  { label: "Pays you while it waits", plain: false, options: true, vayle: true },
  { label: "No options knowledge needed", plain: true, options: false, vayle: true },
  { label: "Settles in the actual token", plain: true, options: "varies", vayle: true },
  { label: "Fully collateralized, no margin calls", plain: true, options: "varies", vayle: true },
  { label: "Exit without the venue's website", plain: "varies", options: "varies", vayle: true },
  { label: "Fills the moment the price is reached", plain: true, options: "varies", vayle: false },
];

function Mark({ value }: { readonly value: boolean | "varies" }) {
  if (value === "varies") return <span className="cell-varies">Varies</span>;
  return (
    <span className={value ? "cell-yes" : "cell-no"}>
      <Icon d={value ? ICON_CHECK : ICON_DASH} />
      <span className="visually-hidden">{value ? "Yes" : "No"}</span>
    </span>
  );
}

export function Compare() {
  return (
    <section className="compare band" aria-labelledby="compare-title">
      <svg
        className="band-curves"
        viewBox="0 0 1200 600"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d="M-40 120C260 40 520 260 760 180S1120 20 1260 90" />
        <path d="M-40 520C300 600 620 360 900 470S1160 560 1260 500" />
      </svg>
      <div className="compare-head">
        <h2 id="compare-title" className="h1">
          A paid limit order, not an options account
        </h2>
        <p className="lede">The parts of options that pay, without the parts that need a desk.</p>
      </div>
      <div className="compare-table" role="table" aria-label="Vayle compared">
        <div className="compare-row compare-row-head" role="row">
          <span role="columnheader">
            <span className="visually-hidden">Feature</span>
          </span>
          <span role="columnheader">A plain limit order</span>
          <span role="columnheader">Selling options yourself</span>
          <span role="columnheader" className="col-vayle">
            Vayle
          </span>
        </div>
        {ROWS.map((row) => (
          <div key={row.label} className="compare-row" role="row">
            <span role="rowheader">{row.label}</span>
            <span role="cell">
              <Mark value={row.plain} />
            </span>
            <span role="cell">
              <Mark value={row.options} />
            </span>
            <span role="cell" className="col-vayle">
              <Mark value={row.vayle} />
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Safety() {
  return (
    <section id="safety" className="safety" aria-labelledby="safety-title">
      <div className="split">
        <Heading className="h1">What holds it together</Heading>
        <p className="lede">
          Every rule below is enforced by the contracts on Robinhood Chain, not by a promise on this
          page.
        </p>
      </div>
      <h2 id="safety-title" className="visually-hidden">
        Safety
      </h2>
      <ul className="bento">
        <li className="bento-card bento-lead">
          <h3 className="h2">Every order is fully collateralized</h3>
          <p>
            The NVDA you&apos;d sell or the USDG you&apos;d spend is locked when you place the
            order. There&apos;s no margin and nothing to liquidate.
          </p>
          <div className="lead-art" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
        </li>
        <li className="bento-card">
          <h3 className="h3">The actual token moves</h3>
          <p className="muted">When an order fills, NVDA changes hands. Nothing settles in cash.</p>
        </li>
        <li className="bento-card">
          <h3 className="h3">Every week is onchain</h3>
          <p className="muted">
            Prices, bids, fills and settlements are contract events anyone can check.
          </p>
        </li>
        <li className="bento-card">
          <h3 className="h3">Leave without us</h3>
          <p className="muted">
            A one-file fallback page settles, cancels and withdraws through your own wallet, with no
            Vayle server involved.
          </p>
        </li>
        <li className="bento-card">
          <h3 className="h3">The maker is ours, and says so</h3>
          <p className="muted">
            Bids come from a maker the Vayle team operates, and the contract marks its address as
            team-operated.
          </p>
        </li>
        <li className="bento-card">
          <h3 className="h3">Every stop has a limit</h3>
          <p className="muted">
            A pause stops new orders, never exits or withdrawals. An emergency halt freezes
            everything for up to 72 hours unless the timelocked owner renews it, and exercise
            windows stretch by however long it lasted. Order sizes are capped while Vayle is young.
          </p>
        </li>
      </ul>
    </section>
  );
}

export function Closing() {
  return (
    <section className="closing band" aria-labelledby="closing-title">
      <svg
        className="band-curves"
        viewBox="0 0 1200 520"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d="M-60 80C240 -10 420 220 640 160S1040 40 1260 140" />
        <path d="M-60 470C260 540 540 320 820 400S1120 500 1260 430" />
      </svg>
      <div className="closing-copy">
        <h2 id="closing-title" className="display-2">
          Put your price on this week&apos;s ladder
        </h2>
        <p className="lede">
          Connect a wallet that holds NVDA or USDG on Robinhood Chain to begin.
        </p>
        <div className="hero-actions">
          <a className="btn btn-brand btn-lg" href="/app/">
            Open the app
          </a>
          <a className="btn btn-on-band btn-lg" href="#risks">
            Read the risks
          </a>
        </div>
      </div>
      <div className="closing-art" aria-hidden="true">
        <div className="float-order">
          <TokenIcon symbol="NVDA" size="lg" />
          <div>
            <p className="float-title">Sell NVDA</p>
            <p className="float-detail">At your price, renews weekly</p>
          </div>
        </div>
        <div className="float-token float-token-a">
          <TokenIcon symbol="NVDA" size="hero" />
        </div>
        <div className="float-token float-token-b">
          <TokenIcon symbol="USDG" size="xl" />
        </div>
      </div>
    </section>
  );
}
