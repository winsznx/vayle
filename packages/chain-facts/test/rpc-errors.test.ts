import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpRequestError } from "viem";
import { errorText, withoutUrlPaths } from "../src/rpc-errors.ts";

const KEY = "0123456789abcdef0123456789abcdef";

describe("withoutUrlPaths", () => {
  it("keeps a URL's origin and drops the path that carries a key", () => {
    // #when
    const text = withoutUrlPaths(`failed at https://node.example.com/${KEY}/ just now`);
    // #then
    assert.equal(text, "failed at https://node.example.com/… just now");
  });

  it("drops a key passed in the query too", () => {
    // #when
    const text = withoutUrlPaths(`wss://node.example.com/ws?apikey=${KEY}`);
    // #then
    assert.equal(text, "wss://node.example.com/…");
  });

  it("leaves text without a URL alone", () => {
    // #when
    const text = withoutUrlPaths("execution reverted: NotNearAClose");
    // #then
    assert.equal(text, "execution reverted: NotNearAClose");
  });
});

describe("errorText", () => {
  it("never repeats the URL of a failed RPC request", () => {
    // #given
    const error = new HttpRequestError({
      url: `https://node.example.com/${KEY}/`,
      status: 429,
      body: { method: "eth_call" },
      details: "Too Many Requests",
    });
    // #when
    const text = errorText(error);
    // #then
    assert.equal(text.includes(KEY), false);
  });

  it("names the error and keeps what it says on one line", () => {
    // #when
    const text = errorText(new RangeError("the RPC refused\nblocks 1 to 2"));
    // #then
    assert.equal(text, "RangeError: the RPC refused blocks 1 to 2");
  });
});
