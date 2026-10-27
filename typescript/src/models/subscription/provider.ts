import { appendFileSync } from "node:fs";
import type { Model, ModelProvider, ModelRequest } from "@openai/agents";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { lunaModel, solModel } from "../models.js";
import { ClaudeCodeModel } from "./claude-code.js";
import { CodexModel } from "./codex.js";
import { opencodeGoModel } from "./opencode-go.js";

/**
 * Model providers that answer through a local subscription CLI instead of an API key. Pomerado
 * names two models: the big one (`solModel`) mints and the small one (`lunaModel`) reviews. Each
 * maps to a model of the chosen backend.
 */
export type SubscriptionBackend = "claude" | "codex" | "opencode";

export interface SubscriptionOptions {
  readonly backend: SubscriptionBackend;
  /** The backend model that stands in for `solModel`. */
  readonly big?: string;
  /** The backend model that stands in for `lunaModel`. */
  readonly small?: string;
  readonly effort?: EffortLevel;
  readonly debug?: boolean;
}

const defaults: Record<SubscriptionBackend, { big: string; small: string }> = {
  claude: { big: "opus", small: "sonnet" },
  // Codex picks its configured model when none is named.
  codex: { big: "", small: "" },
  // Go serves the small model Pomerado was tuned for.
  opencode: { big: "kimi-k3.1-pro", small: lunaModel },
};

/**
 * Records metadata only; prompts, tool arguments, responses and errors can contain secrets.
 */
const traced = (model: Model, name: string, debug: boolean): Model => {
  const trace = process.env["POMERADO_TRACE"];
  if (!trace && !debug) return model;
  const record = (request: ModelRequest, started: number, result: Record<string, unknown>) => {
    if (debug) {
      const output = result["output"] as { type: string; name?: string }[] | undefined;
      process.stderr.write(
        `[${name}] ${Date.now() - started}ms ${result["error"] === undefined ? `out=${(output ?? []).map((item) => item.name ?? item.type).join(",") || "-"}` : "error"}\n`,
      );
    }
    if (trace)
      appendFileSync(
        trace,
        `${JSON.stringify({
          at: new Date().toISOString(),
          model: name,
          ms: Date.now() - started,
          tools: request.tools.map((tool) => tool.name),
          output: (result["output"] as { type: string; name?: string }[] | undefined)?.map((item) => ({ type: item.type, name: item.name })),
          failed: result["error"] !== undefined,
        })}\n`,
        { mode: 0o600 },
      );
  };
  const getResponse = async (request: ModelRequest) => {
    const started = Date.now();
    try {
      const response = await model.getResponse(request);
      record(request, started, { output: response.output });
      return response;
    } catch (error) {
      record(request, started, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
  return { getResponse, getStreamedResponse: (request) => model.getStreamedResponse(request) };
};

export const subscriptionProvider = (options: SubscriptionOptions): ModelProvider => {
  const names = defaults[options.backend];
  const models = new Map<string, Model>();
  const shared = {
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    ...(options.debug === undefined ? {} : { debug: options.debug }),
  };
  const make = (name: string): Model =>
    options.backend === "codex"
      ? new CodexModel({ ...(name === "" ? {} : { model: name }), ...shared })
      : options.backend === "opencode"
        ? traced(opencodeGoModel(name.replace(/^opencode-go\//, "")), name, options.debug ?? false)
        : new ClaudeCodeModel({ model: name, ...shared });
  return {
    getModel: (requested) => {
      const name = requested === lunaModel
        ? (options.small ?? names.small)
        : requested === solModel || requested === undefined
          ? (options.big ?? names.big)
          : requested;
      let model = models.get(name);
      if (model === undefined) {
        model = make(name);
        models.set(name, model);
      }
      return model;
    },
  };
};
