// OpenAI → Kiro (CodeWhisperer) request builder.
//
// Ported in simplified form from 9router's open-sse/translator/request/openai-to-kiro.js.
// Freeflow is a dumb relay: it does not run 9router's thinking/agentic suffix
// machinery (AGENTS.md says host pi-ai owns thinking/normalization), session
// replay, or canonicalization. This module converts OpenAI Chat Completions
// messages to Kiro's conversationState format.

const randomUUID = (): string => globalThis.crypto.randomUUID();

function safeJSONParse(str: unknown, fallback: unknown): unknown {
  if (typeof str !== "string") return str ?? fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

interface KiroImage {
  format: string;
  source: { bytes: string };
}

interface KiroToolResult {
  toolUseId: string;
  status: string;
  content: { text: string }[];
}

interface KiroUserInputMessage {
  content: string;
  modelId: string;
  origin: string;
  images?: KiroImage[];
  userInputMessageContext?: { toolResults?: KiroToolResult[]; tools?: unknown[] };
}

interface KiroAssistantResponseMessage {
  content: string;
  toolUses?: { toolUseId: string; name: string; input: unknown }[];
}

interface KiroUserMessage {
  userInputMessage: KiroUserInputMessage;
}

interface KiroAssistantMessage {
  assistantResponseMessage: KiroAssistantResponseMessage;
}

type KiroMessage = KiroUserMessage | KiroAssistantMessage;

function parseDataUri(url: string): { mimeType: string; base64: string } | null {
  const m = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mimeType: m[1], base64: m[2] };
}

function kiroEmptyUserContent(hasToolResults: boolean): string {
  return hasToolResults ? "Tool results provided." : "continue";
}

function convertMessages(messages: unknown[]): { history: KiroMessage[]; currentMessage: KiroMessage | null } {
  let history: KiroMessage[] = [];
  let currentMessage: KiroMessage | null = null;

  let pendingUserContent: string[] = [];
  let pendingAssistantContent: string[] = [];
  let pendingToolResults: KiroToolResult[] = [];
  let pendingImages: KiroImage[] = [];
  let currentRole: string | null = null;

  const flushPending = () => {
    if (currentRole === "user") {
      const content = pendingUserContent.join("\n\n").trim() || kiroEmptyUserContent(pendingToolResults.length > 0);
      const userMsg: KiroUserMessage = {
        userInputMessage: { content, modelId: "", origin: "AI_EDITOR" },
      };
      if (pendingImages.length > 0) userMsg.userInputMessage.images = pendingImages;
      if (pendingToolResults.length > 0) {
        userMsg.userInputMessage.userInputMessageContext = { toolResults: pendingToolResults };
      }
      history.push(userMsg);
      currentMessage = userMsg;
      pendingUserContent = [];
      pendingToolResults = [];
      pendingImages = [];
    } else if (currentRole === "assistant") {
      const content = pendingAssistantContent.join("\n\n").trim() || "...";
      history.push({ assistantResponseMessage: { content } } as KiroAssistantMessage);
      pendingAssistantContent = [];
    }
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as Record<string, unknown>;
    let role = msg.role as string;
    const wasSystem = role === "system";
    if (role === "system" || role === "tool") role = "user";

    if (role !== currentRole && currentRole !== null) flushPending();
    currentRole = role;

    if (role === "user") {
      let content = "";
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        for (const c of msg.content as Record<string, unknown>[]) {
          if (c.type === "text" || c.text) {
            textParts.push((c.text as string) || "");
          } else if (c.type === "image_url") {
            const url = (c.image_url as { url?: string })?.url || "";
            const parsed = parseDataUri(url);
            if (parsed) {
              const format = parsed.mimeType.split("/")[1] || parsed.mimeType;
              pendingImages.push({ format, source: { bytes: parsed.base64 } });
            } else if (url.startsWith("http://") || url.startsWith("https://")) {
              textParts.push(`[Image: ${url}]`);
            }
          } else if (c.type === "image") {
            const src = c.source as { type?: string; data?: string; media_type?: string } | undefined;
            if (src?.type === "base64" && src.data) {
              const mediaType = src.media_type || "image/png";
              const format = mediaType.split("/")[1] || mediaType;
              pendingImages.push({ format, source: { bytes: src.data } });
            }
          }
        }
        content = textParts.join("\n");

        const toolResultBlocks = (Array.isArray(msg.content) ? msg.content : []).filter((c: Record<string, unknown>) => c.type === "tool_result");
        if (toolResultBlocks.length > 0) {
          toolResultBlocks.forEach((block: Record<string, unknown>) => {
            const text = Array.isArray(block.content)
              ? (block.content as Record<string, unknown>[]).map((c) => (c.text as string) || "").join("\n")
              : (typeof block.content === "string" ? block.content : "");
            pendingToolResults.push({
              toolUseId: block.tool_use_id as string,
              status: block.is_error ? "error" : "success",
              content: [{ text }],
            });
          });
        }
      }

      if (msg.role === "tool") {
        const toolContent = typeof msg.content === "string" ? msg.content : "";
        pendingToolResults.push({
          toolUseId: msg.tool_call_id as string,
          status: (msg.is_error || msg.status === "error") ? "error" : "success",
          content: [{ text: toolContent }],
        });
      } else if (content) {
        pendingUserContent.push(wasSystem ? `<instructions>\n${content}\n</instructions>` : content);
      }
    } else if (role === "assistant") {
      let textContent = "";
      let toolUses: unknown[] = [];

      if (Array.isArray(msg.content)) {
        const textBlocks = (msg.content as Record<string, unknown>[]).filter((c) => c.type === "text");
        textContent = textBlocks.map((b) => b.text).join("\n").trim();
        const toolUseBlocks = (msg.content as Record<string, unknown>[]).filter((c) => c.type === "tool_use");
        toolUses = toolUseBlocks;
      } else if (typeof msg.content === "string") {
        textContent = msg.content.trim();
      }

      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        toolUses = msg.tool_calls as unknown[];
      }

      if (textContent) pendingAssistantContent.push(textContent);

      if (toolUses.length > 0) {
        flushPending();
        const lastMsg = history[history.length - 1] as KiroAssistantMessage | undefined;
        if (lastMsg?.assistantResponseMessage) {
          lastMsg.assistantResponseMessage.toolUses = (toolUses as Record<string, unknown>[]).map((tc) => {
            if (tc.function) {
              const fn = tc.function as Record<string, unknown>;
              return {
                toolUseId: (tc.id as string) || randomUUID(),
                name: fn.name as string,
                input: safeJSONParse(fn.arguments, {}),
              };
            }
            return {
              toolUseId: (tc.id as string) || randomUUID(),
              name: tc.name as string,
              input: tc.input || {},
            };
          });
        }
        currentRole = null;
      }
    }
  }

  if (currentRole !== null) flushPending();

  for (let i = history.length - 1; i >= 0; i--) {
    if ("userInputMessage" in history[i]) {
      currentMessage = history.splice(i, 1)[0];
      break;
    }
  }

  history.forEach((item) => {
    const u = (item as KiroUserMessage).userInputMessage;
    if (u?.userInputMessageContext && Object.keys(u.userInputMessageContext).length === 0) {
      delete u.userInputMessageContext;
    }
    if (u && !u.modelId) u.modelId = "";
  });

  const mergedHistory: KiroMessage[] = [];
  for (let i = 0; i < history.length; i++) {
    const current = history[i] as KiroUserMessage | KiroAssistantMessage;
    if ("userInputMessage" in current && mergedHistory.length > 0 && "userInputMessage" in mergedHistory[mergedHistory.length - 1]) {
      const prev = mergedHistory[mergedHistory.length - 1] as KiroUserMessage;
      prev.userInputMessage.content += "\n\n" + (current as KiroUserMessage).userInputMessage.content;
      const prevCtx = prev.userInputMessage.userInputMessageContext;
      const curCtx = (current as KiroUserMessage).userInputMessage.userInputMessageContext;
      if (curCtx) {
        if (!prevCtx) {
          prev.userInputMessage.userInputMessageContext = curCtx;
        } else {
          if (curCtx.toolResults?.length) {
            prevCtx.toolResults = [...(prevCtx.toolResults || []), ...curCtx.toolResults];
          }
          if (curCtx.tools?.length) {
            prevCtx.tools = [...(prevCtx.tools || []), ...curCtx.tools];
          }
        }
      }
    } else {
      mergedHistory.push(current);
    }
  }

  if (!currentMessage) {
    currentMessage = { userInputMessage: { content: "", modelId: "", origin: "AI_EDITOR" } };
  }

  return { history: mergedHistory, currentMessage };
}

function normalizeToolSpecs(tools: unknown): unknown[] {
  if (!Array.isArray(tools)) return [];
  const specs: unknown[] = [];
  const usedNames = new Set<string>();
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) continue;
    const t = tool as Record<string, unknown>;
    const fn = (typeof t.function === "object" && t.function !== null) ? t.function as Record<string, unknown> : t;
    const rawName = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!rawName) continue;
    if (usedNames.has(rawName)) continue;
    usedNames.add(rawName);
    const rawDesc = typeof fn.description === "string" ? fn.description : `Tool: ${rawName}`;
    const schema = fn.parameters ?? fn.input_schema ?? {};
    specs.push({
      toolSpecification: { name: rawName, description: rawDesc.slice(0, 10000), inputSchema: { json: schema } },
    });
  }
  return specs;

}

export interface KiroPayloadOptions {
  profileArn?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

export function buildKiroPayload(
  model: string,
  body: { messages?: unknown[]; tools?: unknown[]; max_tokens?: number; max_completion_tokens?: number; max_output_tokens?: number; temperature?: number; top_p?: number },
  options: KiroPayloadOptions = {},
): Record<string, unknown> {
  const messages = body.messages || [];
  const { history, currentMessage } = convertMessages(messages);

  const conversationId = randomUUID();
  const currentMsg = currentMessage && "userInputMessage" in currentMessage ? currentMessage.userInputMessage : null;
  if (currentMsg && !currentMsg.modelId) currentMsg.modelId = model;

  const toolSpecs = normalizeToolSpecs(body.tools);

  const payload: Record<string, unknown> = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId,
      currentMessage: {
        userInputMessage: {
          content: currentMsg?.content || "",
          modelId: model,
          origin: "AI_EDITOR",
          ...(currentMsg?.images?.length ? { images: currentMsg.images } : {}),
          userInputMessageContext: {
            ...(currentMsg?.userInputMessageContext?.toolResults?.length ? { toolResults: currentMsg.userInputMessageContext.toolResults } : {}),
            ...(toolSpecs.length > 0 ? { tools: toolSpecs } : {}),
          },
        },
      },
      history,
    },
  };

  // Clean up empty context
  const ctx = (payload.conversationState as Record<string, unknown>).currentMessage as Record<string, unknown>;
  const um = ctx.userInputMessage as Record<string, unknown>;
  if (um.userInputMessageContext && Object.keys(um.userInputMessageContext as object).length === 0) {
    delete um.userInputMessageContext;
  }

  if (options.profileArn) payload.profileArn = options.profileArn;

  // The output cap reaches this lane under three spellings: chat sends
  // `max_tokens`, the Responses path sends `max_output_tokens` and hosts may
  // send `max_completion_tokens`. Dropping one of them leaves upstream to pick
  // its own default length, so resolve all of them here.
  const maxTokens = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens ?? options.maxTokens;
  const temperature = body.temperature ?? options.temperature;
  const topP = body.top_p ?? options.topP;
  if (maxTokens || temperature !== undefined || topP !== undefined) {
    const inferenceConfig: Record<string, unknown> = {};
    if (maxTokens) inferenceConfig.maxTokens = maxTokens;
    if (temperature !== undefined) inferenceConfig.temperature = temperature;
    if (topP !== undefined) inferenceConfig.topP = topP;
    payload.inferenceConfig = inferenceConfig;
  }

  return payload;
}