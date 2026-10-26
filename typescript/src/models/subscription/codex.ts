import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Usage,
  type AgentOutputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@openai/agents";
import { compactionPrefix, isCompactionTrigger, renderTranscript } from "./transcript.js";

/**
 * A Model that answers through the local Codex login (a ChatGPT subscription), via `codex exec`.
 * Codex cannot be handed function tools, so each turn asks for one JSON object, constrained by an
 * output schema, naming the tool calls to make or the reply to give; Codex's own sandbox stays
 * read-only and its instructions forbid using its tools.
 */
export interface CodexModelOptions {
  readonly model?: string;
  readonly effort?: string;
  readonly debug?: boolean;
}

interface Decision {
  readonly message: string;
  readonly tool_calls: readonly { readonly name: string; readonly arguments_json: string }[];
}

const decisionSchema = (names: readonly string[]) => ({
  type: "object",
  additionalProperties: false,
  required: ["message", "tool_calls"],
  properties: {
    message: { type: "string" },
    tool_calls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "arguments_json"],
        properties: {
          name: names.length === 0 ? { type: "string" } : { type: "string", enum: [...names] },
          arguments_json: { type: "string" },
        },
      },
    },
  },
});

const run = (args: readonly string[], stdin: string, signal: AbortSignal | undefined) =>
  new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const stop = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", stop);
      resolve({ code, stderr, stdout });
    });
    child.stdin.end(stdin);
  });

const usageOf = (jsonl: string) => {
  const usage = new Usage({ requests: 1 });
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"turn.completed"')) continue;
    try {
      const event = JSON.parse(line) as { usage?: { input_tokens?: number; output_tokens?: number } };
      usage.inputTokens += event.usage?.input_tokens ?? 0;
      usage.outputTokens += event.usage?.output_tokens ?? 0;
      usage.totalTokens = usage.inputTokens + usage.outputTokens;
    } catch {
      // Not an event line.
    }
  }
  return usage;
};

export class CodexModel implements Model {
  constructor(private readonly options: CodexModelOptions) {}

  private async ask(prompt: string, schema: unknown, request: ModelRequest) {
    const directory = await mkdtemp(join(tmpdir(), "pomerado-codex-"));
    const started = Date.now();
    try {
      const schemaFile = join(directory, "schema.json");
      const lastFile = join(directory, "last.txt");
      await writeFile(schemaFile, JSON.stringify(schema));
      const effort = this.options.effort ?? request.modelSettings.reasoning?.effort ?? undefined;
      const result = await run(
        [
          "exec",
          "--json",
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--cd",
          directory,
          "--output-schema",
          schemaFile,
          "-o",
          lastFile,
          ...(this.options.model === undefined ? [] : ["-m", this.options.model]),
          ...(effort == null ? [] : ["-c", `model_reasoning_effort="${effort}"`]),
          "-",
        ],
        prompt,
        request.signal,
      );
      if (result.code !== 0)
        throw new Error(`codex exec failed (${result.code}): ${result.stderr.slice(-800)}`);
      const text = await readFile(lastFile, "utf8");
      if (this.options.debug)
        process.stderr.write(`[codex ${this.options.model ?? "default"}] ${Date.now() - started}ms\n`);
      return { text, usage: usageOf(result.stdout) };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const input = request.input;
    const cacheOptions: unknown = request.modelSettings.providerData?.["prompt_cache_options"];
    if (cacheOptions !== null && typeof cacheOptions === "object" && Reflect.get(cacheOptions, "prewarm") === true)
      return { usage: new Usage({ requests: 1 }), output: [], responseId: randomUUID() };
    if (typeof input !== "string" && isCompactionTrigger(input.at(-1))) {
      const transcript = renderTranscript(input.slice(0, -1));
      const summary = await this.ask(
        `Summarise this conversation for your own later use: every decision, every fact the host returned that still matters, open questions and what remains to do. Put the summary in "message" and leave "tool_calls" empty.\n\n<transcript>\n${transcript.text}\n</transcript>`,
        decisionSchema([]),
        request,
      );
      const decision = JSON.parse(summary.text) as Decision;
      return {
        usage: summary.usage,
        output: [{ type: "compaction", encrypted_content: compactionPrefix + decision.message }],
        responseId: randomUUID(),
      };
    }
    const tools =
      request.modelSettings.toolChoice === "none"
        ? []
        : request.tools.flatMap((tool) => (tool.type === "function" ? [tool] : []));
    const transcript = renderTranscript(input);
    const replyFormat =
      request.outputType === "text"
        ? "plain text"
        : `one JSON value matching this schema, written as a string: ${JSON.stringify(request.outputType.schema)}`;
    const prompt = [
      "<instructions>",
      request.systemInstructions ?? "",
      "</instructions>",
      "",
      "You are the model behind a host program and must not use your own shell, file or web tools.",
      "The host's tools are listed below; to act, name the calls in tool_calls (several when they",
      "are independent), each with its arguments as a JSON object encoded in arguments_json. The",
      `host runs them and continues the conversation. To reply instead, leave tool_calls empty and put ${replyFormat} in message.`,
      "",
      "<host_tools>",
      ...tools.map((tool) => JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      "</host_tools>",
      "",
      "Earlier <assistant> turns and <tool_call> entries are yours; <tool_result> entries came from the host. Produce only your next turn.",
      "<transcript>",
      transcript.text,
      "</transcript>",
    ].join("\n");
    const answer = await this.ask(prompt, decisionSchema(tools.map((tool) => tool.name)), request);
    const decision = JSON.parse(answer.text) as Decision;
    const output: AgentOutputItem[] = [];
    if (decision.message.trim() !== "")
      output.push({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: decision.message }],
      });
    for (const call of decision.tool_calls)
      output.push({
        type: "function_call",
        callId: `call_${randomUUID()}`,
        name: call.name,
        arguments: call.arguments_json,
        status: "completed",
      });
    return { usage: answer.usage, output, responseId: randomUUID() };
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
