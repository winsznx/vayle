import { BrandMark } from "../ui/BrandMark.tsx";

// What /app shows when the build can't reach a market: before the contracts are deployed, the
// build names no market and the app says so plainly. Any other missing setting is a broken build.
export function Standby({ missing }: { readonly missing: readonly string[] }) {
  const beforeLaunch = missing.length === 1 && missing[0] === "VITE_MARKET";
  return (
    <main className="standby">
      <section className="standby-card">
        <a href="/" className="standby-brand" aria-label="Vayle home">
          <BrandMark />
        </a>
        {beforeLaunch ? (
          <>
            <h1 className="h2">Vayle isn&apos;t open yet</h1>
            <p className="muted">
              The market&apos;s contracts aren&apos;t deployed on Robinhood Chain yet. Once they
              are, this is where you&apos;ll place orders, see what they earn and withdraw.
            </p>
          </>
        ) : (
          <>
            <h1 className="h2">Vayle isn&apos;t set up</h1>
            <p className="muted">
              This build is missing settings it needs to reach the market: {missing.join(", ")}.
            </p>
          </>
        )}
        <a className="btn btn-ink standby-home" href="/">
          Back to the home page
        </a>
      </section>
    </main>
  );
}
