import { BaseError } from "viem";

// Error text that's safe to log or post to an alert channel. A private RPC carries its key in its
// URL, and viem writes the URL into its error messages, so every URL keeps its origin and loses
// its path and query, where the key sits.
const URL_IN_TEXT = /\b((?:https?|wss?):\/\/[^\s/?#"'<>]+)[^\s"'<>]*/gi;

export function withoutUrlPaths(text: string): string {
  return text.replace(URL_IN_TEXT, "$1/…");
}

// One line: the error's name and what it says, with viem's short message and details in place of
// its full message, which lists the request it sent.
export function errorText(error: unknown): string {
  let text: string;
  if (error instanceof BaseError) {
    text = `${error.name}: ${error.shortMessage}${error.details === "" ? "" : ` (${error.details})`}`;
  } else if (error instanceof Error) {
    text = `${error.name}: ${error.message}`;
  } else {
    text = String(error);
  }
  return withoutUrlPaths(text).replace(/\s+/g, " ").trim();
}

// The same, as an error to throw where a runtime would log the original whole.
export function redacted(error: unknown): Error {
  return new Error(errorText(error));
}
