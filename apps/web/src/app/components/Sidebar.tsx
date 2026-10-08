import { NavLink } from "react-router";
import { BrandMark } from "../../ui/BrandMark.tsx";
import { EXTERNAL_ICON, NavIcon, SECTIONS } from "../shell/nav.tsx";
import { useAsset } from "../useAsset.ts";

const REPO = "https://github.com/winsznx/vayle";

export function Sidebar() {
  const { link } = useAsset();
  return (
    <aside className="sidebar">
      <a className="sidebar-brand" href="/" aria-label="Vayle home">
        <BrandMark />
      </a>
      <nav className="sidebar-nav" aria-label="App">
        {SECTIONS.map((s) => (
          <NavLink
            key={s.to}
            to={link(s.to)}
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
        <p className="sidebar-note-title">Who&apos;s buying</p>
        <p>The buyer is currently one market maker operated by Vayle.</p>
        <a href="/#risks">Read the risks</a>
      </div>
    </aside>
  );
}
