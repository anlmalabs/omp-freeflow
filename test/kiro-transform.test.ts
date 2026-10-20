import test from "node:test";
import assert from "node:assert/strict";
import { encodeEventFrame } from "../src/kiro-eventstream.ts";
import { kiroEventStreamToSSE } from "../src/kiro-transform.ts";

test("kiroEventStreamToSSE: converts assistantResponseEvent to SSE", async () => {
  const frames = [
    encodeEventFrame({ ":event-type": "assistantResponseEvent", ":message-type": "event" }, { content: "Hello " }),
    encodeEventFrame({ ":event-type": "assistantResponseEvent", ":message-type": "event" }, { content: "world" }),
    encodeEventFrame({ ":event-type": "metricsEvent", ":message-type": "event" }, { metricsEvent: { inputTokens: 10, outputTokens: 5 } }),
    encodeEventFrame({ ":event-type": "messageStopEvent", ":message-type": "event" }, { stopReason: "end_turn" }),
  ];
  const body = new Uint8Array(frames.reduce((a, f) => a + f.length, 0));
  let off = 0;
  for (const f of frames) { body.set(f, off); off += f.length; }

  const resp = new Response(body, { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } });
  const out = kiroEventStreamToSSE(resp, "kiro-test-model");
  assert.equal(out.status, 200);

  const text = await out.text();
  assert.ok(text.includes("Hello "), "should contain 'Hello '");
  assert.ok(text.includes("world"), "should contain 'world'");
  assert.ok(text.includes("data: [DONE]"), "should end with [DONE]");
  assert.ok(text.includes('"finish_reason":"stop"'), "should finish with stop");
});

test("kiroEventStreamToSSE: handles toolUseEvent", async () => {
  const frames = [
    encodeEventFrame({ ":event-type": "toolUseEvent", ":message-type": "event" }, { name: "get_weather", toolUseId: "t1", input: { city: "NYC" } }),
    encodeEventFrame({ ":event-type": "messageStopEvent", ":message-type": "event" }, { stopReason: "tool_use" }),
  ];
  const body = new Uint8Array(frames.reduce((a, f) => a + f.length, 0));
  let off = 0;
  for (const f of frames) { body.set(f, off); off += f.length; }

  const resp = new Response(body, { status: 200 });
  const out = kiroEventStreamToSSE(resp, "kiro-test-model");
  const text = await out.text();
  assert.ok(text.includes("get_weather"), "should contain tool name");
  assert.ok(text.includes("tool_calls"), "should contain tool_calls");
  assert.ok(text.includes("NYC"), "should contain tool args");
});

test("kiroEventStreamToSSE: content_filtered stop reports content_filter", async () => {
	const frames = [
		encodeEventFrame({ ":event-type": "assistantResponseEvent", ":message-type": "event" }, { content: "partial" }),
		encodeEventFrame({ ":event-type": "messageStopEvent", ":message-type": "event" }, { stopReason: "content_filtered" }),
	];
	const body = new Uint8Array(frames.reduce((a, f) => a + f.length, 0));
	let off = 0;
	for (const f of frames) { body.set(f, off); off += f.length; }

	const resp = new Response(body, { status: 200 });
	const out = kiroEventStreamToSSE(resp, "kiro-test-model");
	const text = await out.text();
	assert.ok(text.includes('"finish_reason":"content_filter"'), "should finish with content_filter");
	assert.ok(text.includes("data: [DONE]"), "should end with [DONE]");
});

test("kiroEventStreamToSSE: empty body returns error", async () => {
  const resp = new Response(null, { status: 200 });
  const out = kiroEventStreamToSSE(resp, "kiro-test-model");
  const text = await out.text();
  assert.ok(text.includes("did not include an EventStream body"), "should error on empty body");
});