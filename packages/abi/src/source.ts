// The contracts whose ABIs are generated, and the module each one becomes.

export const DEPLOYABLES = [
  "VayleMarket",
  "LivenessCheckpoint",
  "SessionCalendar",
  "StockTokenRegistry",
  "PriceAdapter",
] as const;

export function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export function moduleSource(name: string, abi: unknown): string {
  const constName = `${name.charAt(0).toLowerCase()}${name.slice(1)}Abi`;
  return [
    `// Generated from contracts/out/${name}.sol/${name}.json by src/generate.ts. Don't edit.`,
    `export const ${constName} = ${JSON.stringify(abi, null, 2)} as const;`,
    "",
  ].join("\n");
}
