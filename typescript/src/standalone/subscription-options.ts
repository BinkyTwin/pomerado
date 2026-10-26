import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { subscriptionProvider } from "../models/subscription/provider.js";
import type { PomeradoOptions } from "./contracts.js";

const effortLevels = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * The model providers a command line chose. `openai`, or none, keeps the default: the OpenAI API
 * with OPENAI_API_KEY. `claude` answers every model call through the local Claude Code login, `codex` through
 * the local Codex login, `opencode` through an OpenCode Go subscription's key.
 */
export const subscriptionOptions = (choice: {
  readonly provider: string | undefined;
  readonly big: string | undefined;
  readonly small: string | undefined;
  readonly effort: string | undefined;
  readonly debug: boolean;
}): Pick<PomeradoOptions, "minterProvider" | "guardianProvider" | "outcomeReviewerProvider"> => {
  const provider = choice.provider?.trim().toLowerCase();
  if (provider === undefined || provider === "" || provider === "openai") return {};
  if (provider !== "claude" && provider !== "codex" && provider !== "opencode")
    throw new Error(`Unknown provider ${choice.provider}. Choose openai, claude, codex or opencode.`);
  const effort = effortLevels.find((level) => level === choice.effort);
  if (choice.effort !== undefined && choice.effort !== "" && effort === undefined)
    throw new Error(`Unknown effort ${choice.effort}. Choose ${effortLevels.join(", ")}.`);
  const shared = subscriptionProvider({
    backend: provider,
    ...(choice.big ? { big: choice.big } : {}),
    ...(choice.small ? { small: choice.small } : {}),
    ...(effort === undefined ? {} : { effort: effort satisfies EffortLevel }),
    debug: choice.debug,
  });
  return { minterProvider: shared, guardianProvider: shared, outcomeReviewerProvider: shared };
};
