import { useEffect, useState } from "react";
import { BrandMark } from "../ui/BrandMark.tsx";
import { ThemeToggle } from "../ui/ThemeToggle.tsx";
import { Hero } from "./Hero.tsx";
import { Closing, Compare, HowItWorks, Safety, Statement, TheWeek } from "./Sections.tsx";

const REPO = "https://github.com/winsznx/vayle";

// The bar turns solid once the page has scrolled, so it never sits on top of the hero's art.
function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = (): void => {
      setScrolled(window.scrollY > 8);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  return scrolled;
}

function Nav() {
  const scrolled = useScrolled();
  return (
    <header className={scrolled ? "nav is-scrolled" : "nav"}>
      <a href="/" aria-label="Vayle home">
        <BrandMark />
      </a>
      <nav className="nav-links" aria-label="Sections">
        <a href="#how">How it works</a>
        <a href="#week">The week</a>
        <a href="#safety">Safety</a>
        <a href="#risks">Risks</a>
      </nav>
      <div className="nav-actions">
        <ThemeToggle />
        <a className="btn btn-ink btn-sm" href="/app/">
          Open app
        </a>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-panel footer-brand">
        <BrandMark />
        <p className="muted">Paid limit orders for Stock Tokens on Robinhood Chain.</p>
        <a className="btn btn-ink" href="/app/">
          Open the app
        </a>
      </div>
      <nav className="footer-panel footer-links" aria-label="Footer">
        <div>
          <p className="footer-title">Product</p>
          <a href="/app/">App</a>
          <a href="#how">How it works</a>
          <a href="#week">The week</a>
        </div>
        <div>
          <p className="footer-title">Safety</p>
          <a href="#safety">What holds it together</a>
          <a href="#risks">Risks</a>
          <a href={`${REPO}/blob/main/SECURITY.md`}>Security</a>
        </div>
        <div>
          <p className="footer-title">Build</p>
          <a href={REPO}>Source code</a>
          <a href={`${REPO}/tree/main/apps/fallback`}>Fallback page</a>
        </div>
      </nav>
      <div id="risks" className="footer-panel footer-risks">
        <p className="footer-title">Risks</p>
        <p className="muted">
          An order can fill when you&apos;d rather it hadn&apos;t, and a week can pay nothing. A
          fill depends on the maker taking it in the window after the close. Prices come from an
          oracle, the tokens have issuers who can pause them, an emergency halt can freeze the
          market for up to 72 hours, and the contracts are new. Only use what you can afford to have
          locked for a week or more.
        </p>
      </div>
      <p className="footer-base muted">
        <span>© 2026 Vayle</span>
        <span>Not affiliated with the issuers of the assets shown.</span>
      </p>
    </footer>
  );
}

export function Landing() {
  return (
    <div className="sheet">
      <Nav />
      <main>
        <Hero />
        <Statement />
        <HowItWorks />
        <TheWeek />
        <Compare />
        <Safety />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}
