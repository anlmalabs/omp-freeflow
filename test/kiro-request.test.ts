import test from "node:test";
import assert from "node:assert/strict";
import { buildKiroPayload } from "../src/kiro-request.ts";

test("buildKiroPayload: converts simple user message", () => {
  const payload = buildKiroPayload("claude-sonnet-4", {
    messages: [{ role: "user", content: "Hello" }],
  }) as any;
  assert.ok(payload.conversationState, "has conversationState");
  assert.equal(payload.conversationState.currentMessage.userInputMessage.content, "Hello");
  assert.equal(payload.conversationState.currentMessage.userInputMessage.modelId, "claude-sonnet-4");
  assert.ok(payload.conversationState.conversationId, "has conversationId");
});

test("buildKiroPayload: handles system + user", () => {
  const payload = buildKiroPayload("claude-sonnet-4", {
    messages: [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hi" },
    ],
  }) as any;
  const history = payload.conversationState.history;
  // system gets merged into user turn as <instructions>
  assert.ok(payload.conversationState.currentMessage.userInputMessage.content.includes("Hi"), "contains user content");
});

test("buildKiroPayload: handles tool calls in assistant", () => {
  const payload = buildKiroPayload("claude-sonnet-4", {
    messages: [
      { role: "user", content: "What's the weather?" },
      { role: "assistant", content: "", tool_calls: [{ id: "t1", function: { name: "get_weather", arguments: '{"city":"NYC"}' } }] },
      { role: "tool", tool_call_id: "t1", content: "72F sunny" },
      { role: "user", content: "Thanks" },
    ],
  }) as any;
  assert.ok(payload.conversationState, "has conversationState");
  // Should have history with tool use
  const allMsgs = JSON.stringify(payload.conversationState);
  assert.ok(allMsgs.includes("get_weather"), "contains tool name");
  assert.ok(allMsgs.includes("72F sunny"), "contains tool result");
});

test("buildKiroPayload: profileArn and inferenceConfig", () => {
  const payload = buildKiroPayload("claude-sonnet-4", {
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 1000,
    temperature: 0.7,
  }, { profileArn: "arn:aws:..." }) as any;
  assert.equal(payload.profileArn, "arn:aws:...");
  assert.equal(payload.inferenceConfig.maxTokens, 1000);
  assert.equal(payload.inferenceConfig.temperature, 0.7);
});

test("buildKiroPayload: output cap honours every spelling", () => {
  const responses = buildKiroPayload("claude-sonnet-4", {
    messages: [{ role: "user", content: "Hi" }],
    max_output_tokens: 1234,
  }) as any;
  assert.equal(responses.inferenceConfig.maxTokens, 1234);

  const completion = buildKiroPayload("claude-sonnet-4", {
    messages: [{ role: "user", content: "Hi" }],
    max_completion_tokens: 4321,
  }) as any;
  assert.equal(completion.inferenceConfig.maxTokens, 4321);

  const explicit = buildKiroPayload("claude-sonnet-4", {
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 999,
    max_completion_tokens: 4321,
    max_output_tokens: 1234,
  }) as any;
  assert.equal(explicit.inferenceConfig.maxTokens, 999);
});

test("buildKiroPayload: includes tool specs from body.tools", () => {
  const payload = buildKiroPayload("claude-sonnet-4", {
    messages: [{ role: "user", content: "What's the weather?" }],
    tools: [{ type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
  }) as Record<string, unknown>;
  const um = ((payload.conversationState as Record<string, unknown>).currentMessage as Record<string, unknown>).userInputMessage as Record<string, unknown>;
  const ctx = um.userInputMessageContext as Record<string, unknown>;
  assert.ok(Array.isArray(ctx.tools), "tools array present");
  assert.equal((ctx.tools as unknown[]).length, 1);
  const spec = (ctx.tools as Record<string, unknown>[])[0] as Record<string, unknown>;
  assert.ok(spec.toolSpecification, "has toolSpecification");
  assert.equal((spec.toolSpecification as Record<string, unknown>).name, "get_weather");
});