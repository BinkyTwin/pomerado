import type { Model, ModelProvider } from "@openai/agents";
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
        ? opencodeGoModel(name.replace(/^opencode-go\//, ""))
        : new ClaudeCodeModel({ model: name, ...shared });
  return {
    getModel: (requested) => {
      const name =
        requested === lunaModel
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
