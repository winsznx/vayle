import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { restrictedHere } from "../worker/region.ts";

const env = { RESTRICTED_COUNTRIES: "US, cu,T1", RESTRICTED_REGIONS: "UA-43" };

describe("restrictedHere", () => {
  it("restricts a listed country", () => {
    // #when
    const restricted = restrictedHere("US", "CA", env);
    // #then
    assert.equal(restricted, true);
  });

  it("reads the lists without regard to case or spaces", () => {
    // #when
    const restricted = restrictedHere("cu", undefined, env);
    // #then
    assert.equal(restricted, true);
  });

  it("restricts a listed region of a country that's otherwise open", () => {
    // #when
    const results = [restrictedHere("UA", "43", env), restrictedHere("UA", "30", env)];
    // #then
    assert.deepEqual(results, [true, false]);
  });

  it("restricts Tor exits, which Cloudflare reports as T1", () => {
    // #when
    const restricted = restrictedHere("T1", undefined, env);
    // #then
    assert.equal(restricted, true);
  });

  it("leaves a request with no country open, as on a dev server", () => {
    // #when
    const restricted = restrictedHere(undefined, undefined, env);
    // #then
    assert.equal(restricted, false);
  });

  it("restricts nothing when the lists are empty", () => {
    // #when
    const restricted = restrictedHere("US", undefined, {});
    // #then
    assert.equal(restricted, false);
  });
});
