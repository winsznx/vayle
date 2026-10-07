# Units

`@vayle/units` is the TypeScript twin of the contracts' raw-unit arithmetic in [`contracts/src/libraries/Units.sol`](../../contracts/src/libraries/Units.sol), plus the display conversions and number parsing the [web app](../../apps/web/README.md) and the [fallback page](../../apps/fallback/README.md) need. Amounts are token base units, prices are USDG base units per whole raw token, and shares only appear on screen, through the token's UI multiplier. Every amount and price is a `bigint`, so nothing goes through floating point.

## Exports

| Export                                    | What it does                                                                                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `value(amount, price, rawUnit, rounding)` | USDG base units for an amount at a price, rounded down or up as asked                                                                                             |
| `valueExact(amount, price, rawUnit)`      | The same, throwing `InexactValue` instead of rounding, as the contracts do when they settle                                                                       |
| `fee(premium, feeBps)`                    | The protocol fee on a premium, rounded up because the payer covers it                                                                                             |
| `isWholeLots`, `isOnTick`, `gridIsExact`  | The lot, tick and grid checks the contracts make                                                                                                                  |
| `toShares`, `pricePerShare`               | For display only, a raw amount in shares and a price per raw token per share, using the 18-decimal UI multiplier, rounded down                                    |
| `formatFixed`, `parseFixed`               | Fixed-point text, and the exact reverse for what a person types. `parseFixed` returns null instead of rounding when the text has more places than the unit holds. |
| `BPS`, `MULTIPLIER_SCALE`                 | 10,000 basis points, and the multiplier's 10^18 scale                                                                                                             |

## Tests

```sh
pnpm --filter @vayle/units test
```

Property tests with fast-check check that values on the grid are exact, that rounding down and up bracket the exact product, that the fee rounds up, the lot and tick rules, that display never shows more shares than a raw amount converts to, and that formatting and parsing round-trip and refuse anything they'd have to round.
