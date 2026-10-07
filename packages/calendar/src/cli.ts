// Prints the next weekly boundaries after a time, with their creation deadlines, as the JSON the
// deploy script appends to the session calendar:
//   node src/cli.ts boundaries <after-unix-seconds> <count>
import { boundariesAfter } from "./index.ts";

class UsageError extends Error {
  override readonly name = "UsageError";
}

function main(args: readonly string[]): void {
  const [command, after, count] = args;
  const afterSeconds = Number(after);
  const howMany = Number(count);
  if (command !== "boundaries" || !Number.isInteger(afterSeconds) || !Number.isInteger(howMany)) {
    throw new UsageError("usage: cli.ts boundaries <after-unix-seconds> <count>");
  }
  console.log(JSON.stringify(boundariesAfter(afterSeconds, howMany), null, 2));
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
}
