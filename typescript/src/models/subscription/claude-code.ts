import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  query,
  type EffortLevel,
  type McpSdkServerConfigWithInstance,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  Usage,
  type AgentOutputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@openai/agents";
import {
  compactionPrefix,
  isCompactionTrigger,
  renderTranscript,
  turnPrompt,
  type Transcript,
} from "./transcript.js";

/**
 * A Model that answers through the local Claude Code login (a Claude subscription), via the
 * Claude Agent SDK. Claude Code's own tools are off: the request's function tools are offered
 * through an in-process MCP server, and every call Claude makes to them is refused before it runs
 * and returned to the Agents SDK as a function call, which the host then runs itself.
 */
export interface ClaudeCodeModelOptions {
  /** A Claude Code model name or alias: `opus`, `sonnet`, `claude-opus-5-5`, ... */
  readonly model: string;
  /** Overrides the effort the request asks for. */
  readonly effort?: EffortLevel;
  /** Logs each call's timing and outcome to stderr. */
  readonly debug?: boolean;
}

/** The MCP server name, so Claude sees tools as `mcp__host__<name>`. */
const server = "host";
const prefix = `mcp__${server}__`;
/** A host tool's own name, whether Claude called it with the MCP prefix or bare. */
const hostName = (name: string) => (name.startsWith(prefix) ? name.slice(prefix.length) : name);

const efforts: Record<string, EffortLevel> = {
  none: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

interface FunctionToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

const functionTools = (request: ModelRequest): FunctionToolSpec[] =>
  request.tools.flatMap((tool) =>
    tool.type === "function"
      ? [
          {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as unknown as Record<string, unknown>,
          },
        ]
      : [],
  );

/** An MCP server that lists the request's tools and never runs them. */
const hostServer = (tools: readonly FunctionToolSpec[]): McpSdkServerConfigWithInstance => {
  const instance = new McpServer({ name: server, version: "1.0.0" });
  instance.server.registerCapabilities({ tools: {} });
  instance.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: "object", ...tool.parameters } as {
        type: "object";
        [key: string]: unknown;
      },
    })),
  }));
  instance.server.setRequestHandler(CallToolRequestSchema, () => ({
    isError: true,
    content: [{ type: "text", text: "The host runs this tool; this call was not run here." }],
  }));
  return { type: "sdk", name: server, instance };
};

const userMessage = (text: string, transcript: Transcript): SDKUserMessage => ({
  type: "user",
  parent_tool_use_id: null,
  message: {
    role: "user",
    content: [
      { type: "text", text },
      ...transcript.images.map((image) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: image.mediaType as "image/png",
          data: image.data,
        },
      })),
    ],
  },
});

async function* once<T>(value: T) {
  yield value;
}

interface Turn {
  readonly text: string;
  readonly calls: { readonly id: string; readonly name: string; readonly input: unknown }[];
  readonly structured: unknown;
  readonly usage: Usage;
}

const summaryInstructions =
  "Summarise the conversation below for your own later use: keep every decision, every fact the host returned that still matters, open questions, and what remains to do. Write plain text only.";

export class ClaudeCodeModel implements Model {
  constructor(private readonly options: ClaudeCodeModelOptions) {}

  private async turn(
    systemPrompt: string,
    prompt: SDKUserMessage,
    tools: readonly FunctionToolSpec[],
    request: ModelRequest,
    schema: Record<string, unknown> | undefined,
  ): Promise<Turn> {
    const abort = new AbortController();
    const signal = request.signal;
    const stop = () => abort.abort(signal?.reason);
    signal?.addEventListener("abort", stop, { once: true });
    const requested = request.modelSettings.reasoning?.effort;
    const effort =
      this.options.effort ?? (requested == null ? undefined : efforts[requested]) ?? undefined;
    const names = new Set(tools.map((tool) => tool.name));
    const calls: { id: string; name: string; input: unknown }[] = [];
    const texts: string[] = [];
    let structured: unknown;
    const usage = new Usage();
    const started = Date.now();
    try {
      const stream = query({
        prompt: once(prompt),
        options: {
          model: this.options.model,
          systemPrompt,
          tools: [],
          // Pomerado's instructions name its tools bare; Claude sees them under the MCP prefix.
          toolAliases: Object.fromEntries(tools.map((tool) => [tool.name, prefix + tool.name])),
          ...(tools.length === 0 ? {} : { mcpServers: { [server]: hostServer(tools) } }),
          ...(effort === undefined ? {} : { effort }),
          ...(schema === undefined ? {} : { outputFormat: { type: "json_schema", schema } }),
          settingSources: [],
          persistSession: false,
          permissionMode: "default",
          maxTurns: schema === undefined ? 2 : 4,
          abortController: abort,
          env: {
            ...process.env,
            ENABLE_TOOL_SEARCH: "false",
            CLAUDE_AGENT_SDK_CLIENT_APP: "pomerado-subscription/0.1",
          },
          canUseTool: async (toolName, _input, { toolUseID }) => {
            // Host tools are returned to the Agents SDK; anything else (the structured output
            // carrier) runs in Claude Code.
            if (names.has(hostName(toolName)))
              return {
                behavior: "deny",
                message: "Sent to the host.",
                interrupt: true,
                toolUseID,
              };
            return { behavior: "allow", toolUseID };
          },
        },
      });
      for await (const message of stream) {
        if (message.type === "assistant" && message.parent_tool_use_id === null) {
          for (const block of message.message.content) {
            if (block.type === "text") texts.push(block.text);
            else if (block.type === "tool_use" && names.has(hostName(block.name)))
              calls.push({ id: block.id, name: hostName(block.name), input: block.input });
          }
        } else if (message.type === "user" && calls.length > 0) {
          // The refusals came back: the turn's calls are all known.
          break;
        } else if (message.type === "result") {
          usage.add(
            new Usage({
              requests: 1,
              inputTokens:
                message.usage.input_tokens +
                (message.usage.cache_read_input_tokens ?? 0) +
                (message.usage.cache_creation_input_tokens ?? 0),
              outputTokens: message.usage.output_tokens,
            }),
          );
          if (message.subtype === "success") structured = message.structured_output;
          else if (calls.length === 0)
            throw new Error(`Claude Code ended with ${message.subtype}`);
          break;
        }
      }
    } finally {
      signal?.removeEventListener("abort", stop);
      abort.abort();
    }
    if (this.options.debug)
      process.stderr.write(
        `[claude-code ${this.options.model}] ${Date.now() - started}ms calls=${calls.map((c) => c.name).join(",") || "-"} text=${texts.join("").length}\n`,
      );
    const trace = process.env["POMERADO_TRACE"];
    if (trace)
      appendFileSync(
        trace,
        `${JSON.stringify({
          at: new Date().toISOString(),
          model: this.options.model,
          ms: Date.now() - started,
          tools: tools.map((tool) => tool.name),
          schema: schema !== undefined,
          promptTail: JSON.stringify(prompt.message.content).slice(-3000),
          text: texts.join("\n"),
          calls,
          structured,
        })}\n`,
      );
    return { text: texts.join("\n").trim(), calls, structured, usage };
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const input = request.input;
    // A prewarm only prepares an API prompt cache; Claude Code caches on its own.
    const cacheOptions: unknown = request.modelSettings.providerData?.["prompt_cache_options"];
    if (cacheOptions !== null && typeof cacheOptions === "object" && Reflect.get(cacheOptions, "prewarm") === true)
      return { usage: new Usage({ requests: 1 }), output: [], responseId: randomUUID() };
    if (typeof input !== "string" && isCompactionTrigger(input.at(-1))) {
      const transcript = renderTranscript(input.slice(0, -1));
      const summary = await this.turn(
        summaryInstructions,
        userMessage(`<transcript>\n${transcript.text}\n</transcript>`, transcript),
        [],
        request,
        undefined,
      );
      return {
        usage: summary.usage,
        output: [{ type: "compaction", encrypted_content: compactionPrefix + summary.text }],
        responseId: randomUUID(),
      };
    }
    const tools = functionTools(request);
    const transcript = renderTranscript(input);
    const schema = request.outputType === "text" ? undefined : request.outputType.schema;
    const offered = request.modelSettings.toolChoice === "none" ? [] : tools;
    const turn = await this.turn(
      request.systemInstructions ?? "",
      userMessage(turnPrompt(transcript, offered.length > 0), transcript),
      offered,
      request,
      schema as Record<string, unknown> | undefined,
    );
    const output: AgentOutputItem[] = [];
    const text =
      turn.calls.length === 0 && turn.structured !== undefined
        ? JSON.stringify(turn.structured)
        : turn.text;
    if (text !== "")
      output.push({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      });
    for (const call of turn.calls)
      output.push({
        type: "function_call",
        callId: call.id,
        name: call.name,
        arguments: JSON.stringify(call.input ?? {}),
        status: "completed",
      });
    return { usage: turn.usage, output, responseId: randomUUID() };
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const response = await this.getResponse(request);
    yield {
      type: "response_done",
      response: {
        id: response.responseId ?? randomUUID(),
        usage: {
          requests: 1,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
        },
        output: response.output,
      },
    } as StreamEvent;
  }
}
