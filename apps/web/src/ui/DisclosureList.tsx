import type { Disclosure } from "../disclosures.ts";

// The owner's disclosures as a list, in the order the file gives them. A titled item leads with its
// title; a plain line is just the line.
export function DisclosureList({
  items,
  className,
}: {
  readonly items: readonly Disclosure[];
  readonly className: string;
}) {
  return (
    <ol className={className}>
      {items.map((item, i) => (
        <li key={i}>
          {item.title === null ? (
            item.body
          ) : (
            <>
              <span className="disclosure-title">{item.title}</span> {item.body}
            </>
          )}
        </li>
      ))}
    </ol>
  );
}
