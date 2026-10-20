import test from "node:test";
import assert from "node:assert/strict";
import { crc32, parseEventFrame, encodeEventFrame } from "../src/kiro-eventstream.ts";

test("crc32: known value", () => {
  // Empty input CRC32 is 0x00000000
  assert.equal(crc32(new Uint8Array([])), 0);
  // "123456789" → 0xcbf43926
  const bytes = new TextEncoder().encode("123456789");
  assert.equal(crc32(bytes), 0xcbf43926);
});

test("encodeEventFrame/parseEventFrame: round-trip with headers and payload", () => {
  const frame = encodeEventFrame({ "x-test": "hello" }, { foo: 42, bar: "baz" });
  const parsed = parseEventFrame(frame);
  assert.equal(parsed.headers["x-test"], "hello");
  assert.deepEqual(parsed.payload, { foo: 42, bar: "baz" });
});

test("parseEventFrame: empty payload returns null", () => {
  const frame = encodeEventFrame({ "x": "y" }, null);
  const parsed = parseEventFrame(frame);
  assert.equal(Object.getPrototypeOf(parsed.headers), null);
  assert.equal(parsed.headers.x, "y");
  assert.equal(parsed.payload, null);
});

test("parseEventFrame: throws on CRC corruption", () => {
  const frame = encodeEventFrame({ "x": "y" }, { a: 1 });
  const bad = new Uint8Array(frame);
  bad[0] ^= 1;
  assert.throws(() => parseEventFrame(bad));
});

test("parseEventFrame: throws on truncated frame", () => {
  assert.throws(() => parseEventFrame(new Uint8Array(8)));
});

test("parseEventFrame: throws on length mismatch", () => {
  const frame = encodeEventFrame({}, { a: 1 });
  const bad = frame.subarray(0, frame.length - 1);
  assert.throws(() => parseEventFrame(bad));
});