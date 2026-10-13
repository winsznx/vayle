import { useEffect, useState } from "react";
import { BrandMark } from "../ui/BrandMark.tsx";
import { ThemeToggle } from "../ui/ThemeToggle.tsx";
import { Hero } from "./Hero.tsx";
import { Closing, Compare, HowItWorks, Risks, Safety, Statement, TheWeek } from "./Sections.tsx";
import { FALLBACK_URL, REPO_URL } from "../links.ts";

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
        <p className="muted">Weekly pay for Stock Token holders on Robinhood Chain.</p>
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
          <a href={`${REPO_URL}/blob/main/SECURITY.md`}>Security</a>
        </div>
        <div>
          <p className="footer-title">Build</p>
          <a href={REPO_URL}>Source code</a>
          <a href={FALLBACK_URL}>Fallback page</a>
        </div>
      </nav>
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
        <Risks />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}
