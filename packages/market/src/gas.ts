// Gas limits for Vayle calls. Every state change checkpoints the chain's liveness first, and what
// that costs depends on the clock: it writes only in a new second, and records a gap only after
// five quiet minutes. Settlement calls can also record a newly observed issuer pause. A
// transaction lands at least a block after its estimate, so the limit leaves room for those
// writes, plus a quarter more for state that moves in between. Unused gas isn't charged.
export const GAS_HEADROOM = 100_000n;

export function withGasMargin(estimate: bigint): bigint {
  return estimate + estimate / 4n + GAS_HEADROOM;
}
