// Kiro EventStream → OpenAI SSE transform.
//
// Ported in simplified form from 9router's executors/kiro.js
// `transformEventStreamToSSE`. Freeflow is a dumb relay: it does not run the
// integrity/retry/repair machinery that 9router owns (those are 9router's
// value-add and conflict with AGENTS.md's "host pi-ai owns thinking/normalization").
// This module extracts content, reasoning, and tool calls from EventStream frames
// and emits OpenAI-compatible SSE chunks.

import { parseEventFrame } from "./kiro-eventstream.ts";

const encoder = new TextEncoder();
const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

function sseChunk(id: string, created: number, model: string, delta: Record<string, unknown>, finishReason: string | null = null, usage?: unknown): Uint8Array {
  const obj: Record<string, unknown> = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) obj.usage = usage;
  return encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
}

function normalizeStopReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const r = raw.toLowerCase();
  if (r === "end_turn" || r === "end" || r === "stop") return "end_turn";
  if (r === "tool_use" || r === "tool_calls") return "tool_use";
  if (r === "max_tokens" || r === "length") return "max_tokens";
  if (r === "content_filtered") return "content_filtered";
  return null;
}

export function kiroEventStreamToSSE(response: Response, model: string): Response {
  const responseId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  if (!response.body) {
    const err = encoder.encode(`data: ${JSON.stringify({ error: { message: "Kiro response did not include an EventStream body" } })}\n\n`);
    return new Response(err, { status: response.status, headers: { ...SSE_HEADERS } });
  }

  const reader = response.body.getReader();
  const state = {
    buffer: new Uint8Array(0),
    chunkIndex: 0,
    toolCounter: 0,
    tools: new Map<string, { id: string; name: string; inputChunks: string[]; inputObject?: unknown; inputKind?: string }>(),
    inThinking: false,
    hasReasoning: false,
    hasToolCalls: false,
    stopReason: null as string | null,
    finished: false,
    usage: null as Record<string, unknown> | null,
  };

  const emitDelta = (controller: ReadableStreamDefaultController, delta: Record<string, unknown>) => {
    if (state.chunkIndex === 0) delta = { role: "assistant", ...delta };
    state.chunkIndex++;
    controller.enqueue(sseChunk(responseId, created, model, delta));
  };

  const processEvent = (event: { headers: Record<string, unknown>; payload: unknown | null }, controller: ReadableStreamDefaultController) => {
    const messageType = event.headers[":message-type"];
    if (messageType === "error" || messageType === "exception") {
      const msg = (typeof event.payload === "object" && event.payload !== null && "message" in event.payload && typeof (event.payload as { message: unknown }).message === "string")
        ? (event.payload as { message: string }).message
        : `Kiro upstream sent an EventStream ${messageType}`;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`));
      return false;
    }

    const eventType = (event.headers[":event-type"] as string) || "";
    const payload = event.payload;

    if (eventType === "assistantResponseEvent" && typeof (payload as { content?: unknown })?.content === "string") {
      let content = (payload as { content: string }).content;
      if (state.inThinking) {
        const end = content.indexOf("</thinking>");
        if (end < 0) {
          content = "";
        } else {
          state.inThinking = false;
          content = content.slice(end + 11).replace(/^\n/u, "");
        }
      } else {
        const start = content.indexOf("<thinking>");
        if (start >= 0) {
          const end = content.indexOf("</thinking>", start + 10);
          if (end < 0) {
            state.inThinking = true;
            content = content.slice(0, start);
          } else {
            content = content.slice(0, start) + content.slice(end + 11).replace(/^\n/u, "");
          }
        }
      }
      if (content || !state.hasReasoning) {
        emitDelta(controller, { content });
      }
    } else if (eventType === "reasoningContentEvent") {
      const value = (typeof payload === "object" && payload !== null && "reasoningContentEvent" in payload)
        ? (payload as { reasoningContentEvent: unknown }).reasoningContentEvent
        : payload;
      const content = typeof value === "string" ? value : (typeof value === "object" && value !== null && "text" in value && typeof (value as { text: unknown }).text === "string")
        ? (value as { text: string }).text
        : (typeof value === "object" && value !== null && "content" in value && typeof (value as { content: unknown }).content === "string")
          ? (value as { content: string }).content
          : "";
      if (content) {
        state.hasReasoning = true;
        emitDelta(controller, { reasoning_content: content });
      }
    } else if (eventType === "codeEvent" && typeof (payload as { content?: unknown })?.content === "string") {
      const content = (payload as { content: string }).content;
      emitDelta(controller, { content });
    } else if (eventType === "toolUseEvent") {
      state.hasToolCalls = true;
      const values = Array.isArray(payload) ? payload : [payload];
      for (const value of values) {
        if (typeof value !== "object" || value === null) continue;
        const v = value as Record<string, unknown>;
        const name = typeof v.name === "string" ? v.name.trim() : "";
        if (!name) continue;
        let id: string;
        if (v.toolUseId == null) {
          id = `call_${created}_${state.tools.size + 1}`;
        } else if (typeof v.toolUseId !== "string" || !v.toolUseId.trim()) {
          continue;
        } else {
          id = v.toolUseId;
        }
        let tool = state.tools.get(id);
        if (!tool) {
          tool = { id, name, inputChunks: [] };
          state.tools.set(id, tool);
        }
        const input = v.input;
        if (input !== undefined) {
          if (typeof input === "string") {
            tool.inputChunks.push(input);
          } else if (typeof input === "object" && input !== null && !Array.isArray(input)) {
            tool.inputObject = input;
            tool.inputKind = "object";
          }
        }
      }
    } else if (eventType === "messageStopEvent" || eventType === "metadataEvent" || eventType === "MetadataEvent") {
      const meta = eventType.startsWith("meta")
        ? (typeof payload === "object" && payload !== null && "metadataEvent" in payload
          ? (payload as { metadataEvent: unknown }).metadataEvent
          : typeof payload === "object" && payload !== null && "metadata" in payload
            ? (payload as { metadata: unknown }).metadata
            : payload)
        : payload;
      const reason = normalizeStopReason(
        (typeof meta === "object" && meta !== null && "stopReason" in meta)
          ? (meta as { stopReason: unknown }).stopReason
          : (typeof meta === "object" && meta !== null && "stop_reason" in meta)
            ? (meta as { stop_reason: unknown }).stop_reason
            : null
      );
      if (reason) state.stopReason = reason;
    } else if (eventType === "metricsEvent") {
      const metrics = (typeof payload === "object" && payload !== null && "metricsEvent" in payload)
        ? (payload as { metricsEvent: unknown }).metricsEvent
        : payload;
      const m = (typeof metrics === "object" && metrics !== null) ? metrics as Record<string, unknown> : {};
      const prompt = Number(m.inputTokens) || 0;
      const completion = Number(m.outputTokens) || 0;
      if (prompt || completion) {
        state.usage = {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: prompt + completion,
        };
      }
    }
    return true;
  };

  const stream = new ReadableStream({
    start: async (controller) => {
      try {
        while (!state.finished) {
          const { done, value } = await reader.read();
          if (done) break;
          const combined = new Uint8Array(state.buffer.byteLength + value.byteLength);
          combined.set(state.buffer);
          combined.set(value, state.buffer.byteLength);
          state.buffer = combined;

          while (state.buffer.byteLength >= 12) {
            const view = new DataView(state.buffer.buffer, state.buffer.byteOffset);
            const totalLength = view.getUint32(0, false);
            if (totalLength < 16 || totalLength > 24 * 1024 * 1024) break;
            if (state.buffer.byteLength < totalLength) break;
            const frame = state.buffer.slice(0, totalLength);
            state.buffer = state.buffer.slice(totalLength);
            let event;
            try {
              event = parseEventFrame(frame);
            } catch {
              state.finished = true;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: "Kiro EventStream frame parse error" } })}\n\n`));
              break;
            }
            if (!processEvent(event, controller)) {
              state.finished = true;
              break;
            }
          }
        }
        // Truncated frame at EOF guard
        if (state.buffer.byteLength > 0 && !state.finished) {
          state.finished = true;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: "Kiro EventStream ended with a truncated frame" } })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        // Emit buffered tool calls
        if (!state.finished) {
          for (const tool of state.tools.values()) {
            const index = state.toolCounter++;
            let args = "";
            if (tool.inputKind === "object" && tool.inputObject !== undefined) {
              args = JSON.stringify(tool.inputObject);
            } else if (tool.inputChunks.length > 0) {
              try { args = JSON.stringify(JSON.parse(tool.inputChunks.join(""))); }
              catch { args = tool.inputChunks.join(""); }
            }
            emitDelta(controller, {
              tool_calls: [{ index, id: tool.id, type: "function", function: { name: tool.name, arguments: "" } }],
            });
            emitDelta(controller, {
              tool_calls: [{ index, function: { arguments: args } }],
            });
            state.hasToolCalls = true;
          }
          state.tools.clear();
        }
        // Finish
        if (!state.finished) {
          const finishReason = state.stopReason === "tool_use" || state.hasToolCalls
            ? "tool_calls"
            : state.stopReason === "max_tokens"
              ? "length"
              : state.stopReason === "content_filtered"
                ? "content_filter"
                : "stop";
          controller.enqueue(sseChunk(responseId, created, model, {}, finishReason, state.usage));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          state.finished = true;
        }
        controller.close();
      } catch (error) {
        if (!state.finished) {
          const msg = error instanceof Error ? error.message : "Kiro stream error";
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        controller.close();
      }
    },
    cancel() {
      return reader.cancel();
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: { ...SSE_HEADERS },
  });
}