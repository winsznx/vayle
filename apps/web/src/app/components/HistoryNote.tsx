import { useApp } from "../state.tsx";

// Where the history on a page comes from and how current it is, so a number read from an index or
// an older block never passes for one read just now.
export function HistoryNote() {
  const { history } = useApp();
  if (history.status === "idle") return null;
  let text: string;
  if (history.status === "off") {
    text = "History isn't shown in this build: it has no indexer and no deploy block to read from.";
  } else if (history.status === "loading") {
    text =
      history.source === "indexer"
        ? "Loading history from the indexer."
        : "Reading history from the chain. The first read goes back to the market's deploy.";
  } else if (history.status === "failed") {
    text = `History is unavailable right now: ${history.reason}`;
  } else {
    const from = history.source === "indexer" ? "the indexer" : "the chain";
    text = `History from ${from}, as of block ${history.toBlock.toString()}.`;
    if (history.problem !== null) text += ` The latest refresh failed: ${history.problem}`;
  }
  return <p className="history-note">{text}</p>;
}
