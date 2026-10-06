import { DOCS_DIR } from "./config.ts";

const NOT_AFTER_ALNUM = "(?<![A-Za-z0-9])";
const NOT_BEFORE_ALNUM = "(?![A-Za-z0-9])";
const WORD_GAP = "[\\s_-]*";

// Unicode-mode regexes reject escapes of non-syntax characters, so only syntax characters are escaped.
export function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

// A term matches when it doesn't touch a letter or digit on either side. Underscores count as
// separators, so SNAKE_CASE identifiers still match. Between the words of a multi-word term, any run
// of spaces, hyphens or underscores matches, and so does no separator at all.
export function termPattern(term: string, caseSensitive: boolean): RegExp {
  const words = term.trim().split(/\s+/).map(escapeRegExp);
  const flags = caseSensitive ? "gu" : "giu";
  return new RegExp(`${NOT_AFTER_ALNUM}${words.join(WORD_GAP)}${NOT_BEFORE_ALNUM}`, flags);
}

// A reference to the private docs folder: the folder name and a slash at a line start, or after
// whitespace, a quote, a backtick, "(" or "[", with an optional leading slash; or after "./" or "../".
// A slash that follows another path segment doesn't count, so a dependency's own folder of the same
// name passes.
export const PRIVATE_PATH: RegExp = new RegExp(
  String.raw`(?:^|[\s'"\x60(\[])\/?${DOCS_DIR}\/|\.\.?\/${DOCS_DIR}\/`,
  "gm",
);
