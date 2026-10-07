import { BrandMark } from "../../ui/BrandMark.tsx";
import { ThemeToggle } from "../../ui/ThemeToggle.tsx";
import { ConnectButton } from "../shell/ConnectButton.tsx";

export function TopBar({ title }: { readonly title: string }) {
  return (
    <header className="topbar">
      <a className="topbar-brand" href="/" aria-label="Vayle home">
        <BrandMark />
      </a>
      <h1 className="topbar-title h2">{title}</h1>
      <div className="topbar-actions">
        <ThemeToggle />
        <ConnectButton />
      </div>
    </header>
  );
}
