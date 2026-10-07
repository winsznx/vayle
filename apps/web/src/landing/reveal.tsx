import { Fragment, useEffect, useRef, type RefObject } from "react";

// Headings rise out of a blur, word by word, the first time they scroll into view. The browser's
// IntersectionObserver is the external system here; CSS does the motion and turns it off under
// reduced motion.

const STAGGER_MS = 55;

export function useReveal<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);
  return ref;
}

// Plain text as words that reveal one after another, starting `delay` words in. The space sits
// outside each word, since an inline-block drops its own trailing whitespace.
export function Words({ text, delay = 0 }: { readonly text: string; readonly delay?: number }) {
  const words = text.split(" ");
  return words.map((word, i) => (
    <Fragment key={`${word}-${i}`}>
      <span className="word" style={{ transitionDelay: `${(delay + i) * STAGGER_MS}ms` }}>
        {word}
      </span>
      {i < words.length - 1 ? " " : null}
    </Fragment>
  ));
}
