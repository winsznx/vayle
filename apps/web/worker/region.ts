// Where new orders aren't offered. The lists are the Worker's vars, comma-separated: whole
// countries as ISO 3166-1 codes, and regions inside a country as country-region, ISO 3166-2, for
// places that are restricted while the rest of their country isn't. Cloudflare reports Tor exits as
// the country T1, since where they lead can't be known.

export interface RegionEnv {
  readonly RESTRICTED_COUNTRIES?: string;
  readonly RESTRICTED_REGIONS?: string;
}

function listOf(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim().toUpperCase())
      .filter((entry) => entry !== ""),
  );
}

export function restrictedHere(
  country: string | undefined,
  region: string | undefined,
  env: RegionEnv,
): boolean {
  if (country === undefined) return false;
  const code = country.toUpperCase();
  if (listOf(env.RESTRICTED_COUNTRIES).has(code)) return true;
  return (
    region !== undefined && listOf(env.RESTRICTED_REGIONS).has(`${code}-${region.toUpperCase()}`)
  );
}
