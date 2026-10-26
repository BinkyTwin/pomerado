import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";
import {
  OpenAIChatCompletionsModel,
  OpenAIResponsesModel,
  Usage,
  type AgentInputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@openai/agents";
import { compactionPrefix, isCompactionTrigger, renderTranscript } from "./transcript.js";

/**
 * Models from an OpenCode Go subscription, called on Go's own API with the subscription's key.
 * GPT and Grok models speak the Responses API, which the Agents SDK uses as it would OpenAI's.
 * Chat Completions models (GLM, Kimi, DeepSeek, ...) get function tools, and the OpenAI-only
 * parts of Pomerado's requests are taken out first.
 */
const baseURL = "https://opencode.ai/inference/go/openai/v1";
const userAgent = "pomerado-subscription/0.1";

/** Go's Responses models, from its documentation; every other model listed there but the Messages and Gemini ones speaks Chat Completions. */
const responsesModels = /^(gpt-|grok-|muse-)/;
const unsupportedModels = /^(claude-|minimax-m3$|qwen3\.[78]-|gemini-)/;

/** The key from OPENCODE_GO_API_KEY, else the one `opencode auth login` stored. */
export const opencodeGoKey = () => {
  const fromEnvironment = process.env["OPENCODE_GO_API_KEY"];
  if (fromEnvironment) return fromEnvironment;
  const data = process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
  try {
    const auth = JSON.parse(readFileSync(join(data, "opencode", "auth.json"), "utf8")) as Record<
      string,
      { key?: string } | undefined
    >;
    const key = auth["opencode-go"]?.key;
    if (key) return key;
  } catch {
    // No stored login.
  }
  throw new Error(
    "No OpenCode Go key. Set OPENCODE_GO_API_KEY or run `opencode auth login` and choose OpenCode Go.",
  );
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** What Chat Completions can carry: earlier summaries become user messages, reasoning goes. */
const chatInput = (input: string | AgentInputItem[]): string | AgentInputItem[] =>
  typeof input === "string"
    ? input
    : input.flatMap((item): AgentInputItem[] => {
        if (item.type === "reasoning" || isCompactionTrigger(item)) return [];
        if (item.type === "compaction") {
          const summary = String(record(item)["encrypted_content"] ?? "");
          return [
            {
              role: "user",
              type: "message",
              content: `<earlier_conversation_summary>\n${summary.startsWith(compactionPrefix) ? summary.slice(compactionPrefix.length) : "[unreadable earlier summary]"}\n</earlier_conversation_summary>`,
            },
          ];
        }
        return [item];
      });

/** The request without the OpenAI-only settings Pomerado adds for prompt caching and compaction. */
export const chatRequest = (request: ModelRequest): ModelRequest => {
  const {
    prompt_cache_options: _cache,
    context_management: _compaction,
    ...providerData
  } = request.modelSettings.providerData ?? {};
  const { promptCacheOptions: _options, ...settings } = request.modelSettings as typeof request.modelSettings & {
    promptCacheOptions?: unknown;
  };
  return {
    ...request,
    input: chatInput(request.input),
    modelSettings: { ...settings, providerData },
  };
};

/** A Chat Completions model that also answers Pomerado's prewarms and compaction requests. */
class ChatModel implements Model {
  constructor(private readonly inner: OpenAIChatCompletionsModel) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const cacheOptions: unknown = request.modelSettings.providerData?.["prompt_cache_options"];
    if (record(cacheOptions)["prewarm"] === true)
      return { usage: new Usage({ requests: 1 }), output: [], responseId: randomUUID() };
    const input = request.input;
    if (typeof input !== "string" && isCompactionTrigger(input.at(-1))) {
      const transcript = renderTranscript(input.slice(0, -1));
      const response = await this.inner.getResponse(
        chatRequest({
          ...request,
          systemInstructions:
            "Summarise the conversation for your own later use: every decision, every fact the host returned that still matters, open questions and what remains to do. Plain text only.",
          input: `<transcript>\n${transcript.text}\n</transcript>`,
          tools: [],
          outputType: "text",
        }),
      );
      const text = response.output
        .flatMap((item): unknown[] => {
          const content = record(item)["content"];
          return item.type === "message" && Array.isArray(content) ? content : [];
        })
        .map((part) => {
          const entry = record(part);
          return entry["type"] === "output_text" ? String(entry["text"] ?? "") : "";
        })
        .join("");
      return {
        usage: response.usage,
        output: [{ type: "compaction", encrypted_content: compactionPrefix + text }],
        responseId: randomUUID(),
      };
    }
    return this.inner.getResponse(chatRequest(request));
  }

  getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    return this.inner.getStreamedResponse(chatRequest(request));
  }
}

export const opencodeGoModel = (name: string): Model => {
  if (unsupportedModels.test(name))
    throw new Error(
      `OpenCode Go serves ${name} on its Messages or Gemini API, which this provider does not use yet. Choose a Chat Completions or Responses model.`,
    );
  const client = new OpenAI({
    apiKey: opencodeGoKey(),
    baseURL,
    // One session per process: Go asks for a stable session header per conversation.
    defaultHeaders: { "User-Agent": userAgent, "x-opencode-session": randomUUID() },
  });
  return responsesModels.test(name)
    ? new OpenAIResponsesModel(client, name)
    : new ChatModel(new OpenAIChatCompletionsModel(client, name));
};
