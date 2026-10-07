import { BrandMark } from "../../ui/BrandMark.tsx";

const REPO = "https://github.com/winsznx/vayle";

function NavIcon({ d }: { readonly d: string }) {
  return (
    <svg className="nav-icon" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

export function Sidebar() {
  return (
    <aside className="sidebar">
      <a className="sidebar-brand" href="/" aria-label="Vayle home">
        <BrandMark />
      </a>
      <nav className="sidebar-nav" aria-label="App">
        <a className="sidebar-link is-active" href="#trade" aria-current="page">
          <NavIcon d="M4.5 4h9A1.5 1.5 0 0 1 15 5.5v8a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 3 13.5v-8A1.5 1.5 0 0 1 4.5 4ZM3 8h12M6.5 2.5v3M11.5 2.5v3" />
          This week
        </a>
        <a className="sidebar-link" href="#orders">
          <NavIcon d="M3.5 5h11M3.5 9h11M3.5 13h7" />
          Your orders
        </a>
        <a className="sidebar-link" href={`${REPO}/tree/main/apps/fallback`}>
          <NavIcon d="M7.5 4.5H5A1.5 1.5 0 0 0 3.5 6v7A1.5 1.5 0 0 0 5 14.5h7a1.5 1.5 0 0 0 1.5-1.5v-2.5M10 3.5h4.5V8M14.5 3.5 8 10" />
          Fallback page
        </a>
      </nav>
      <div className="sidebar-note">
        <p className="sidebar-note-title">Who&apos;s bidding</p>
        <p>
          Bids come from a maker the Vayle team operates, and the contract marks its address as
          team-operated.
        </p>
        <a href="/#safety">How Vayle stays safe</a>
      </div>
    </aside>
  );
}
