import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <section className="card notice-card">
      <h2 className="h3">There&apos;s no page here</h2>
      <p className="muted">The link may be old, or the address mistyped.</p>
      <Link className="btn btn-ink" to="/">
        Go to the overview
      </Link>
    </section>
  );
}
