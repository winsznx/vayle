// deployments/market-check.json, built into the app as a chunk of its own that loads only when a
// page asks for it, or nothing when the build had no such file. The market check is published on
// its own schedule, so a build without it is fine: the glob matches the one file when it's there
// and nothing when it isn't.
const files = import.meta.glob<unknown>("../../../../deployments/market-check.json", {
  import: "default",
});

const load = Object.values(files)[0];

// The file's contents, or null when the build had none.
export function loadMarketCheck(): Promise<unknown> {
  return load === undefined ? Promise.resolve(null) : load();
}
