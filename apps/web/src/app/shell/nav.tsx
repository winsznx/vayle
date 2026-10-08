// The app's sections, in the order the sidebar and the phone tab bar show them. Icons are drawn on
// the 18-unit grid as 1.5-unit strokes.

export interface Section {
  readonly to: string;
  readonly label: string;
  readonly icon: string;
  // Whether only the exact path counts as this section, not the paths under it.
  readonly end: boolean;
}

export const SECTIONS: readonly Section[] = [
  {
    to: "/",
    label: "Overview",
    icon: "M3 4.5A1.5 1.5 0 0 1 4.5 3h2A1.5 1.5 0 0 1 8 4.5v2A1.5 1.5 0 0 1 6.5 8h-2A1.5 1.5 0 0 1 3 6.5v-2ZM10 4.5A1.5 1.5 0 0 1 11.5 3h2A1.5 1.5 0 0 1 15 4.5v2A1.5 1.5 0 0 1 13.5 8h-2A1.5 1.5 0 0 1 10 6.5v-2ZM3 11.5A1.5 1.5 0 0 1 4.5 10h2A1.5 1.5 0 0 1 8 11.5v2A1.5 1.5 0 0 1 6.5 15h-2A1.5 1.5 0 0 1 3 13.5v-2ZM10 11.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5v2a1.5 1.5 0 0 1-1.5 1.5h-2a1.5 1.5 0 0 1-1.5-1.5v-2Z",
    end: true,
  },
  {
    to: "/trade",
    label: "Trade",
    icon: "M3 4.5A1.5 1.5 0 0 1 4.5 3H9l6 6-6 6-6-6V4.5ZM6.5 6.5h.01",
    end: false,
  },
  {
    to: "/markets",
    label: "Markets",
    icon: "M3 15h12M4.5 12.5V8.5M9 12.5V4.5M13.5 12.5V7",
    end: false,
  },
  { to: "/orders", label: "Targets", icon: "M3.5 5h11M3.5 9h11M3.5 13h7", end: false },
  {
    to: "/activity",
    label: "Activity",
    icon: "M9 15.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM9 5.5V9l2.5 1.5",
    end: false,
  },
  { to: "/market", label: "Status", icon: "M2.5 9h3l2-4.5 3 9 2-4.5h3", end: false },
];

export const EXTERNAL_ICON =
  "M7.5 4.5H5A1.5 1.5 0 0 0 3.5 6v7A1.5 1.5 0 0 0 5 14.5h7a1.5 1.5 0 0 0 1.5-1.5v-2.5M10 3.5h4.5V8M14.5 3.5 8 10";

export function NavIcon({ d }: { readonly d: string }) {
  return (
    <svg className="nav-icon" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}
