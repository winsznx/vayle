import { NavLink } from "react-router";
import { useAsset } from "../useAsset.ts";
import { NavIcon, SECTIONS } from "./nav.tsx";

// The app's sections as a tab bar along the bottom, where the sidebar doesn't fit. Each keeps the
// market the page shows.
export function PhoneTabs() {
  const { link } = useAsset();
  return (
    <nav className="phone-tabs" aria-label="App">
      {SECTIONS.map((s) => (
        <NavLink
          key={s.to}
          to={link(s.to)}
          end={s.end}
          className={({ isActive }) => (isActive ? "phone-tab is-active" : "phone-tab")}
        >
          <NavIcon d={s.icon} />
          <span>{s.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
