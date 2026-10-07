import { useId, useState, type PointerEvent } from "react";
import { dollars, easternTime } from "../format.ts";
import type { PricePoint } from "../usePriceHistory.ts";
import "./dashboard.css";

// The feed's price over the last month, drawn as steps: each round holds until the next one lands,
// which is how the market sees it too. A dashed line marks this week's close, which set the
// strikes, and a dotted one marks each price the holder has an order at.

const WIDTH = 1000;
const HEIGHT = 260;
const PAD = 0.08;

interface Props {
  readonly points: readonly PricePoint[];
  readonly feedDecimals: number;
  // Chain time, so the last round's step runs up to now.
  readonly now: number;
  // This week's close and the holder's order prices, in USDG base units.
  readonly close: bigint | null;
  readonly marks: readonly bigint[];
  readonly usdgDecimals: number;
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "America/New_York",
});

// Plot coordinates only. Every figure shown is formatted from the chain's integers.
function asNumber(value: bigint, decimals: number): number {
  return Number(value) / 10 ** decimals;
}

function lowest(points: readonly PricePoint[], start: bigint): bigint {
  return points.reduce((low, p) => (p.answer < low ? p.answer : low), start);
}

function highest(points: readonly PricePoint[], start: bigint): bigint {
  return points.reduce((high, p) => (p.answer > high ? p.answer : high), start);
}

export function PriceChart({ points, feedDecimals, now, close, marks, usdgDecimals }: Props) {
  const gradient = useId();
  const [hover, setHover] = useState<PricePoint | null>(null);
  const first = points[0];
  if (first === undefined) return null;
  const last = points.at(-1) ?? first;

  const price = (p: PricePoint): number => asNumber(p.answer, feedDecimals);
  const low = lowest(points, first.answer);
  const high = highest(points, first.answer);
  const levels = [
    asNumber(low, feedDecimals),
    asNumber(high, feedDecimals),
    ...(close === null ? [] : [asNumber(close, usdgDecimals)]),
    ...marks.map((m) => asNumber(m, usdgDecimals)),
  ];
  const floor = Math.min(...levels);
  const ceiling = Math.max(...levels);
  const pad = Math.max((ceiling - floor) * PAD, ceiling * 0.002);
  const bottom = floor - pad;
  const top = ceiling + pad;
  const start = first.time;
  const end = Math.max(now, last.time + 1);
  const x = (time: number): number => ((time - start) / (end - start)) * WIDTH;
  const y = (value: number): number => HEIGHT - ((value - bottom) / (top - bottom)) * HEIGHT;
  const left = (time: number): string => `${(x(time) / WIDTH) * 100}%`;
  // The tip follows the pointer but stays inside the plot at either end.
  const tipLeft = (time: number): string =>
    `${Math.min(88, Math.max(12, (x(time) / WIDTH) * 100))}%`;
  const down = (value: number): string => `${(y(value) / HEIGHT) * 100}%`;

  const steps = points
    .slice(1)
    .map((p) => `H ${x(p.time)} V ${y(price(p))}`)
    .join(" ");
  const line = `M ${x(first.time)} ${y(price(first))} ${steps} H ${WIDTH}`;
  const area = `${line} V ${HEIGHT} H ${x(first.time)} Z`;

  // The round in force at the pointer: the last one that had landed by then.
  const onMove = (event: PointerEvent<HTMLDivElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    const time = start + ((event.clientX - box.left) / box.width) * (end - start);
    setHover(points.findLast((p) => p.time <= time) ?? first);
  };

  return (
    <figure className="chart">
      <figcaption className="visually-hidden">
        {`${points.length} feed rounds since ${easternTime(first.time)}, from ${dollars(low, feedDecimals)} to ${dollars(high, feedDecimals)}.`}
      </figcaption>
      <div
        className="chart-plot"
        onPointerMove={onMove}
        onPointerLeave={() => {
          setHover(null);
        }}
      >
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="chart-fill-top" />
              <stop offset="100%" className="chart-fill-bottom" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradient})`} />
          <path d={line} className="chart-line" />
        </svg>
        {close !== null && (
          <div
            className="chart-level chart-close"
            style={{ top: down(asNumber(close, usdgDecimals)) }}
          >
            <span className="close-pill num">Close {dollars(close, usdgDecimals)}</span>
          </div>
        )}
        {marks.map((mark) => (
          <div
            key={mark.toString()}
            className="chart-level chart-mark"
            style={{ top: down(asNumber(mark, usdgDecimals)) }}
          >
            <span className="chart-mark-label num">Your price {dollars(mark, usdgDecimals)}</span>
          </div>
        ))}
        {hover !== null && (
          <>
            <div className="chart-cursor" style={{ left: left(hover.time) }} />
            <div
              className="chart-dot"
              style={{ left: left(hover.time), top: down(price(hover)) }}
            />
            <div className="chart-tip" style={{ left: tipLeft(hover.time) }}>
              <span className="chart-tip-price num">{dollars(hover.answer, feedDecimals)}</span>
              <span className="chart-tip-time">{easternTime(hover.time)}</span>
            </div>
          </>
        )}
      </div>
      <div className="chart-axis" aria-hidden="true">
        <span>{DAY_FORMAT.format(new Date(first.time * 1000))}</span>
        <span>Now</span>
      </div>
    </figure>
  );
}
