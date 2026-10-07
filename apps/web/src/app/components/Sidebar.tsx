import { NavLink } from "react-router";
import { BrandMark } from "../../ui/BrandMark.tsx";
import { EXTERNAL_ICON, NavIcon, SECTIONS } from "../shell/nav.tsx";

const REPO = "https://github.com/winsznx/vayle";

export function Sidebar() {
  return (
    <aside className="sidebar">
      <a className="sidebar-brand" href="/" aria-label="Vayle home">
        <BrandMark />
      </a>
      <nav className="sidebar-nav" aria-label="App">
        {SECTIONS.map((s) => (
          <NavLink
            key={s.to}
            to={s.to}
            end={s.end}
            className={({ isActive }) => (isActive ? "sidebar-link is-active" : "sidebar-link")}
          >
            <NavIcon d={s.icon} />
            {s.label}
          </NavLink>
        ))}
        <a className="sidebar-link" href={`${REPO}/tree/main/apps/fallback`}>
          <NavIcon d={EXTERNAL_ICON} />
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
