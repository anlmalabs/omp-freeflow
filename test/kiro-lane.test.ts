/**
 * End-to-end for the Kiro lane: the real proxy, a stub Kiro upstream answering
 * in binary AWS EventStream, and the assertions that matter for the lane:
 *
 *  - the request carries the out-of-band bearer token and the EventStream Accept
 *    header, and the payload is Kiro's conversationState shape (not OpenAI's);
 *  - the caller's SSE comes back OpenAI-shaped and holds the text the stub's
 *    assistantResponseEvent frames carried;
 *  - a Kiro model never rides the relay pool;
 *  - without the env token the lane answers 501 rather than firing anonymous.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startProxy, isRelayEligibleModel } from "../src/proxy.ts";
import { KIRO_TOKEN_ENV } from "../src/config.ts";
import { encodeEventFrame } from "../src/kiro-eventstream.ts";
import { authHeaders } from "./_auth.ts";
import {
 _resetFreeTierHintForTest,
 _resetUpstreamHealthForTest,
} from "../src/upstream-health.ts";

const KIRO_MODEL = "claude-opus-5.5";
const DUMMY_TOKEN = "kiro-test-bearer-token-abc123";
const EVENTSTREAM_CT = "application/vnd.amazon.eventstream";

/** Concatenated frame bytes: what a real Kiro EventStream body looks like. */
function eventStreamBody(frames: Uint8Array[]): Buffer {
 const total = frames.reduce((sum, f) => sum + f.length, 0);
 const out = Buffer.allocUnsafe(total);
 let offset = 0;
 for (const f of frames) {
  out.set(f, offset);
  offset += f.length;
 }
 return out;
}

/** A stub success turn: two text frames then a stop. */
function stubFrames(): Buffer {
 return eventStreamBody([
  encodeEventFrame({ ":event-type": "assistantResponseEvent", ":message-type": "event" }, { content: "Kiro says " }),
  encodeEventFrame({ ":event-type": "assistantResponseEvent", ":message-type": "event" }, { content: "hello" }),
  encodeEventFrame({ ":event-type": "messageStopEvent", ":message-type": "event" }, { stopReason: "end_turn" }),
 ]);
}

/** A stub turn that calls the caller's `find` tool once, then stops. */
function stubToolCallFrames(): Buffer {
 return eventStreamBody([
  encodeEventFrame(
   { ":event-type": "toolUseEvent", ":message-type": "event" },
   { name: "find", toolUseId: "t1", input: { pattern: "*.ts" } },
  ),
  encodeEventFrame({ ":event-type": "messageStopEvent", ":message-type": "event" }, { stopReason: "tool_use" }),
 ]);
}

/** Tool names recovered from an aggregated chat-completions answer. */
function toolCallNames(raw: string): string[] {
 const parsed: unknown = JSON.parse(raw);
 if (typeof parsed !== "object" || parsed === null || !("choices" in parsed)) {
  throw new Error("aggregated answer has no choices");
 }
 const choices = parsed.choices;
 if (!Array.isArray(choices) || choices.length === 0) throw new Error("aggregated answer has no choices");
 const message = choices[0];
 if (typeof message !== "object" || message === null || !("message" in message) || typeof message.message !== "object") {
  throw new Error("aggregated answer has no message");
 }
 const toolCalls = message.message.tool_calls;
 if (!Array.isArray(toolCalls)) return [];
 return toolCalls.map((call: unknown) => {
  if (typeof call === "object" && call !== null && "function" in call) {
   const fn = call.function;
   if (typeof fn === "object" && fn !== null && "name" in fn && typeof fn.name === "string") return fn.name;
  }
  return "";
 });
}

/** Which port the stub server bound to, from its listen address. */
function portOf(address: unknown): number {
 if (typeof address !== "object" || address === null || !("port" in address)) return 0;
 const port = address.port;
 return typeof port === "number" ? port : 0;
}

function postJson(
 port: number,
 path: string,
 payload: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
 const { promise, resolve, reject } = Promise.withResolvers<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
 }>();
 const data = JSON.stringify(payload);
 const req = http.request({
  hostname: "127.0.0.1",
  port,
  path,
  method: "POST",
  headers: {
   "content-type": "application/json",
   "content-length": Buffer.byteLength(data),
   ...authHeaders(),
  },
 });
 req.on("response", (res) => {
  const chunks: Buffer[] = [];
  res.on("data", (c) => {
   const chunk = c as Buffer; // node 'data' events deliver Buffers
   chunks.push(chunk);
  });
  res.on("end", () =>
   resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
  );
 });
 req.on("error", reject);
 req.write(data);
 req.end();
 return promise;
}

/** First assistant message text out of an aggregated chat-completions body. */
function firstAssistantText(raw: string): string {
 const parsed: unknown = JSON.parse(raw);
 if (typeof parsed !== "object" || parsed === null || !("choices" in parsed)) {
  throw new Error("aggregated answer has no choices");
 }
 const choices = parsed.choices;
 if (!Array.isArray(choices) || choices.length === 0) {
  throw new Error("aggregated answer has no choices");
 }
 const first = choices[0];
 if (typeof first !== "object" || first === null || !("message" in first) || typeof first.message !== "object") {
  throw new Error("aggregated answer has no message");
 }
 return typeof first.message.content === "string" ? first.message.content : "";
}

/** Tool names the proxy put into the upstream Kiro payload. */
function upstreamToolNames(upstream: Record<string, unknown>): string[] {
 const conversationState = upstream.conversationState;
 if (typeof conversationState !== "object" || conversationState === null) return [];
 const currentMessage = (conversationState as Record<string, unknown>).currentMessage;
 if (typeof currentMessage !== "object" || currentMessage === null) return [];
 const userInputMessage = (currentMessage as Record<string, unknown>).userInputMessage;
 if (typeof userInputMessage !== "object" || userInputMessage === null) return [];
 const ctx = (userInputMessage as Record<string, unknown>).userInputMessageContext;
 if (typeof ctx !== "object" || ctx === null) return [];
 const tools = (ctx as Record<string, unknown>).tools;
 if (!Array.isArray(tools)) return [];
 return tools.map((tool: unknown) => {
  if (typeof tool !== "object" || tool === null) return "";
  const spec = (tool as Record<string, unknown>).toolSpecification;
  if (typeof spec !== "object" || spec === null) return "";
  const name = (spec as Record<string, unknown>).name;
  return typeof name === "string" ? name : "";
 });
}

/**
 * Start the real proxy with the Kiro lane's upstream redirected at a local
 * stub server, drive the client flow, then tear everything down.
 * `respond` writes the stub's reply; `capture` collects what upstream saw.
 */
async function withKiroStub(
 proxyPort: number,
 respond: (res: http.ServerResponse) => void,
 client: (port: number) => Promise<void>,
 capture?: { headers?: http.IncomingHttpHeaders; bodies?: Array<Record<string, unknown>>; calls?: number },
): Promise<void> {
 _resetUpstreamHealthForTest();
 _resetFreeTierHintForTest();
 const stub = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => {
   const chunk = c as Buffer; // node 'data' events deliver Buffers
   chunks.push(chunk);
  });
  req.on("end", () => {
   if (capture) {
    capture.headers = req.headers;
    capture.calls = (capture.calls ?? 0) + 1;
    const received = JSON.parse(Buffer.concat(chunks).toString());
    if (typeof received === "object" && received !== null && !Array.isArray(received)) {
     capture.bodies?.push(received as Record<string, unknown>);
    }
   }
   respond(res);
  });
 });
 await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", () => resolve()));
 const stubPort = portOf(stub.address());
 // The Kiro lane fetches through fetchWithSystemCA, which tries the global
 // fetch first: redirecting it at the stub exercises the real handler.
 const realFetch = globalThis.fetch;
 globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
  const target = new URL(String(url));
  return realFetch(`http://127.0.0.1:${stubPort}${target.pathname}`, init);
 }) as typeof fetch;
 const { server, port } = await startProxy(proxyPort);
 try {
  await client(port ?? proxyPort);
 } finally {
  globalThis.fetch = realFetch;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  _resetUpstreamHealthForTest();
  _resetFreeTierHintForTest();
 }
}

const savedToken = process.env[KIRO_TOKEN_ENV];

test.beforeEach(() => {
 process.env[KIRO_TOKEN_ENV] = DUMMY_TOKEN;
});

test.afterEach(() => {
 if (savedToken === undefined) delete process.env[KIRO_TOKEN_ENV];
 else process.env[KIRO_TOKEN_ENV] = savedToken;
});

test("kiro lane: EventStream upstream reaches the caller as OpenAI-shaped SSE", async () => {
 const capture: { bodies?: Array<Record<string, unknown>> } = { bodies: [] };
 await withKiroStub(
  29471,
  (res) => {
   res.writeHead(200, { "content-type": EVENTSTREAM_CT });
   res.end(stubFrames());
  },
  async (port) => {
   const res = await postJson(port, "/v1/chat/completions", {
    model: KIRO_MODEL,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
   });
   assert.equal(res.status, 200);
   assert.match(res.headers["content-type"] ?? "", /text\/event-stream/, "client must receive SSE, not EventStream");
   assert.ok(res.body.includes("Kiro says "), "first frame's text must survive the decode");
   assert.ok(res.body.includes("hello"), "second frame's text must survive the decode");
   assert.ok(res.body.includes("data: [DONE]"), "stream must terminate");
   assert.ok(!res.body.includes("assistantResponseEvent"), "no raw EventStream event names may leak to the client");
   assert.ok(res.body.includes(`"model":"${KIRO_MODEL}"`), "chunks must carry the requested model");
  },
  capture,
 );
 assert.equal(capture.bodies?.length, 1, "exactly one upstream call");
 const upstream = capture.bodies?.[0];
 if (upstream === undefined) throw new Error("the stub must have seen a body");
 // Kiro's conversationState shape, not the caller's OpenAI shape.
 assert.ok("conversationState" in upstream, "payload must be Kiro conversationState");
 assert.equal(upstream.stream, true, "the lane always asks upstream to stream");
 assert.ok(!("messages" in upstream), "the OpenAI messages array must not be forwarded verbatim");
});

test("kiro lane: the request carries the out-of-band token and the EventStream Accept header", async () => {
 const capture: { headers?: http.IncomingHttpHeaders } = {};
 await withKiroStub(
  29472,
  (res) => {
   res.writeHead(200, { "content-type": EVENTSTREAM_CT });
   res.end(stubFrames());
  },
  async (port) => {
   const res = await postJson(port, "/v1/chat/completions", {
    model: KIRO_MODEL,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
   });
   assert.equal(res.status, 200);
   const headers = capture.headers ?? {};
   assert.equal(headers["x-amz-sso-bearer"], DUMMY_TOKEN, "upstream must receive the env bearer token");
   assert.equal(headers["accept"], EVENTSTREAM_CT, "upstream must be asked for an EventStream body");
   assert.equal(headers["x-amzn-kiro-agent-mode"], "spec", "spec agent mode must be requested");
  },
  capture,
 );
});

test("kiro lane: a non-streaming caller gets the aggregated JSON answer", async () => {
 await withKiroStub(
  29473,
  (res) => {
   res.writeHead(200, { "content-type": EVENTSTREAM_CT });
   res.end(stubFrames());
  },
  async (port) => {
   const res = await postJson(port, "/v1/chat/completions", {
    model: KIRO_MODEL,
    messages: [{ role: "user", content: "hi" }],
    stream: false,
   });
   assert.equal(res.status, 200);
   assert.match(res.headers["content-type"] ?? "", /application\/json/);
   assert.equal(firstAssistantText(res.body), "Kiro says hello", "aggregated content must match the frames");
  },
 );
});

test("kiro lane: an upstream non-2xx is forwarded faithfully for the requested model", async () => {
 const upstreamError = JSON.stringify({ error: { message: "token expired", type: "unauthorized" } });
 const capture: { calls?: number } = {};
 await withKiroStub(
  29474,
  (res) => {
   res.writeHead(401, { "content-type": "application/json" });
   res.end(upstreamError);
  },
  async (port) => {
   const res = await postJson(port, "/v1/chat/completions", {
    model: KIRO_MODEL,
    messages: [{ role: "user", content: "hi" }],
    stream: false,
   });
   assert.equal(res.status, 401, "the upstream status must surface unchanged");
   assert.equal(res.body, upstreamError, "the authentic upstream error body must reach the caller");
  },
  capture,
 );
 assert.equal(capture.calls, 1, "a failed Kiro call must never be retried on another model");
});

test("kiro lane: no env token answers 501 without any upstream call", async () => {
 delete process.env[KIRO_TOKEN_ENV];
 const capture: { calls?: number } = {};
 await withKiroStub(
  29475,
  (res) => {
   res.writeHead(200, { "content-type": EVENTSTREAM_CT });
   res.end(stubFrames());
  },
  async (port) => {
   const res = await postJson(port, "/v1/chat/completions", {
    model: KIRO_MODEL,
    messages: [{ role: "user", content: "hi" }],
    stream: false,
   });
   assert.equal(res.status, 501, "a missing credential is not_implemented, not an anonymous 403");
  },
  capture,
 );
 assert.equal(capture.calls ?? 0, 0, "no token means no upstream request at all");
});

test("kiro lane: a Kiro model is never relay-eligible", () => {
 assert.equal(isRelayEligibleModel("claude-opus-5.5"), false, "Kiro is direct-only and never rides the relay pool");
});

test("kiro lane: a caller tool named find reaches the client as find, unrenamed", async () => {
 // Other lanes rename the caller's `find` to `glob` upstream and restore the
 // name on the way back. Kiro forwards tool names verbatim
 // (normalizeToolSpecs does not sanitize), so applying a find->glob restore
 // here would rename a tool the caller never renamed. The name must survive
 // the round-trip exactly as the caller registered it.
 const capture: { bodies?: Array<Record<string, unknown>> } = { bodies: [] };
 await withKiroStub(
  29476,
  (res) => {
   res.writeHead(200, { "content-type": EVENTSTREAM_CT });
   res.end(stubToolCallFrames());
  },
  async (port) => {
   const res = await postJson(port, "/v1/chat/completions", {
    model: KIRO_MODEL,
    messages: [{ role: "user", content: "find the files" }],
    stream: false,
    tools: [
     {
      type: "function",
      function: { name: "find", description: "Find files by name", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
     },
    ],
   });
   assert.equal(res.status, 200);
   assert.deepEqual(toolCallNames(res.body), ["find"], "the caller's find tool must not be renamed to glob");
  },
  capture,
 );
 const upstream = capture.bodies?.[0];
 if (upstream === undefined) throw new Error("the stub must have seen a body");
 // Kiro's own payload carries the tool spec under its bare name too.
 const conversationState = upstream.conversationState;
 assert.ok(
  typeof conversationState === "object" && conversationState !== null,
  "payload must carry a conversationState",
 );
});

test("kiro lane: the caller's tools reach upstream verbatim and nothing is injected", async () => {
 // The OpenCode Zen fingerprint renames the caller's `find` to `glob` and
 // injects the placeholder sextet {bash, glob, grep, read, edit, write}.
 // Kiro is a direct-only lane and passes no restore map, so any such rewrite
 // would strand a tool call the host never registered. Assert on what the
 // stub RECEIVED, not on what the stub answered.
 const withTool: { bodies?: Array<Record<string, unknown>> } = { bodies: [] };
 await withKiroStub(
  29477,
  (res) => {
   res.writeHead(200, { "content-type": EVENTSTREAM_CT });
   res.end(stubFrames());
  },
  async (port) => {
   const res = await postJson(port, "/v1/chat/completions", {
    model: KIRO_MODEL,
    messages: [{ role: "user", content: "find the files" }],
    stream: false,
    tools: [
     {
      type: "function",
      function: { name: "find", description: "Find files by name", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
     },
    ],
   });
   assert.equal(res.status, 200);
  },
  withTool,
 );
 const upstreamWithTool = withTool.bodies?.[0];
 if (upstreamWithTool === undefined) throw new Error("the stub must have seen a body");
 assert.deepEqual(
  upstreamToolNames(upstreamWithTool),
  ["find"],
  "the caller's own tool name must reach upstream, renamed to nothing and joined by no placeholder",
 );

 const withoutTool: { bodies?: Array<Record<string, unknown>> } = { bodies: [] };
 await withKiroStub(
  29478,
  (res) => {
   res.writeHead(200, { "content-type": EVENTSTREAM_CT });
   res.end(stubFrames());
  },
  async (port) => {
   const res = await postJson(port, "/v1/chat/completions", {
    model: KIRO_MODEL,
    messages: [{ role: "user", content: "hi" }],
    stream: false,
   });
   assert.equal(res.status, 200);
  },
  withoutTool,
 );
 const upstreamWithoutTool = withoutTool.bodies?.[0];
 if (upstreamWithoutTool === undefined) throw new Error("the stub must have seen a body");
 assert.deepEqual(
  upstreamToolNames(upstreamWithoutTool),
  [],
  "a request that declared no tool must reach upstream with no tool specs at all",
 );
});
