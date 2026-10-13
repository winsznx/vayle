import assert from "node:assert/strict";
import { describe, it } from "node:test";
import signedOff from "../disclosures.signed-off.json" with { type: "json" };
import { parseDisclosures } from "../src/disclosures.ts";

// The risk lines the owner signed off, in their order. The landing shows the file built in, and the
// app shows the same file once it's published as /disclosures.json.
const SIGNED_OFF = [
  "Once you're paid for a week, your tokens stay locked until that week settles after Friday's close. You can't sell them during the week, even if the price falls.",
  "Only Friday's close counts. A price reached during the week doesn't fill your target.",
  "If the stock closes above your price, you sell at your price and miss any gain above it.",
  "The weekly payment doesn't protect you from a fall. If the stock drops, you still hold your tokens.",
  "Some weeks may have no buyer at your price. Those weeks pay nothing and your target carries over.",
  "If the stock closes below your buy target, you buy at that price, even if the close is lower.",
  "The buyer is currently one market maker operated by Vayle.",
  "The contracts are unaudited.",
  "Stock Tokens aren't available everywhere, and Vayle blocks new targets where they're restricted.",
  "The close that counts is the price feed's last price at or before 4:00 PM ET on Friday, or at the earlier close before a market holiday, and it can differ slightly from the exchange's official close.",
  "Stock Tokens and USDG have issuers who can pause them. A pause can delay settlement.",
  "In an emergency the market can be halted for up to 72 hours at a time, and settlement waits until it ends.",
  "Only lock what you can leave locked for a week or more.",
  "Not affiliated with the issuers of the assets shown.",
];

describe("parseDisclosures", () => {
  it("reads a list of plain lines", () => {
    // #when
    const items = parseDisclosures(["First line.", "Second line."]);
    // #then
    assert.deepEqual(items, [
      { title: null, body: "First line." },
      { title: null, body: "Second line." },
    ]);
  });

  it("still reads items with a title and a body", () => {
    // #when
    const items = parseDisclosures([{ title: "Local fork", body: "Nothing here is real money." }]);
    // #then
    assert.deepEqual(items, [{ title: "Local fork", body: "Nothing here is real money." }]);
  });

  it("refuses the whole file when any item is blank or malformed", () => {
    // #when
    const results = [
      parseDisclosures([]),
      parseDisclosures({ lines: ["A line."] }),
      parseDisclosures(["A line.", "  "]),
      parseDisclosures(["A line.", { title: "No body" }]),
      parseDisclosures(["A line.", 7]),
    ];
    // #then
    assert.deepEqual(results, [null, null, null, null, null]);
  });
});

describe("the signed-off disclosures file", () => {
  it("holds exactly the fourteen signed-off lines, in order, as plain lines", () => {
    // #when
    const items = parseDisclosures(signedOff);
    // #then
    assert.deepEqual(
      items,
      SIGNED_OFF.map((body) => ({ title: null, body })),
    );
  });
});
