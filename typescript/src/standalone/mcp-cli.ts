#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Effect, Exit, Scope } from "effect";
import { localError, localPromise } from "../execution/local-path.js";
import { readIntegration } from "./artifact-files.js";
import { prepareIntegration } from "./mcp-package.js";
import { makeIntegrationMcp, makePomeradoMcp } from "./mcp-server.js";
import type { PomeradoOptions } from "./contracts.js";
import { subscriptionOptions } from "./subscription-options.js";
import { agents, runSetup, type Agent } from "./setup.js";

const usage = `Pomerado MCP

  pomerado-mcp mint [--root DIRECTORY]
  pomerado-mcp serve --artifact DIRECTORY
  pomerado-mcp setup [--root DIRECTORY] [--provider NAME] [--agents claude-plugin,codex,opencode]
                     [--headed] [--name NAME] [--dry-run]

Setup registers the minting MCP with Claude Code (as a plugin with a skill, or with --agents
claude as a plain user-scope server), Codex and OpenCode, which T3 Code drives.
It backs up each file it changes. The provider defaults to claude.

Options
  --endpoint URL     Attach to native Playwright
  --headed           Show local Chromium
  --library NAME     playwright (default) or patchright, which sites with bot checks block less
  --provider NAME    openai (default, needs OPENAI_API_KEY) claude (your Claude Code
                     login) or codex (your Codex login)
  --big-model NAME   The provider's model for minting (claude: opus)
  --small-model NAME The provider's model for Guardian and outcome review (claude: sonnet)
  --effort LEVEL     low, medium, high, xhigh or max, for every model call

POMERADO_PROVIDER, POMERADO_BIG_MODEL, POMERADO_SMALL_MODEL and POMERADO_EFFORT set the same.

The mint root defaults to ./integrations. Supply model credentials in the environment to
mint. Serving makes no model request and needs no model credentials.
Stdout is reserved for MCP. Human questions use provide_input through your MCP client.
`;

const waitForDisconnect = Effect.async<void>((resume) => {
  const done = () => resume(Effect.void);
  process.stdin.once("end", done);
  process.stdin.once("close", done);
  process.stdin.once("error", done);
  process.once("SIGINT", done);
  process.once("SIGTERM", done);
  if (process.stdin.readableEnded || process.stdin.destroyed) done();
  return Effect.sync(() => {
    process.stdin.off("end", done);
    process.stdin.off("close", done);
    process.stdin.off("error", done);
    process.off("SIGINT", done);
    process.off("SIGTERM", done);
  });
});

export const runMcpCli = (
  args: readonly string[] = process.argv.slice(2),
  options: Omit<PomeradoOptions, "ask"> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { values, positionals } = yield* Effect.try({
        try: () =>
          parseArgs({
            args: [...args],
            allowPositionals: true,
            options: {
              help: { type: "boolean", short: "h" },
              root: { type: "string" },
              artifact: { type: "string" },
              endpoint: { type: "string" },
              headed: { type: "boolean" },
              library: { type: "string" },
              provider: { type: "string" },
              "big-model": { type: "string" },
              "small-model": { type: "string" },
              effort: { type: "string" },
              agents: { type: "string" },
              name: { type: "string" },
              "dry-run": { type: "boolean" },
            },
          }),
        catch: localError,
      });
      if (values.help) {
        process.stderr.write(usage);
        return;
      }
      const mode = positionals[0];
      if (mode === "setup" && positionals.length === 1) {
        // The plugin and the user-scope entry would give Claude Code two servers.
        const chosen = (values.agents ?? "claude-plugin,codex,opencode")
          .split(",")
          .map((agent) => agent.trim())
          .filter((agent) => agent !== "");
        const unknown = chosen.filter((agent) => !agents.some((known) => known === agent));
        if (unknown.length > 0)
          return yield* Effect.fail(new Error(`Unknown agents ${unknown.join(", ")}.`));
        const lines = runSetup({
          agents: chosen as Agent[],
          root: resolve(values.root ?? "integrations"),
          provider: values.provider ?? "claude",
          headed: values.headed ?? false,
          dryRun: values["dry-run"] ?? false,
          name: values.name ?? "pomerado",
        });
        process.stderr.write(`${lines.join("\n")}\nRestart your agents to load the server.\n`);
        return;
      }
      if (positionals.length !== 1 || (mode !== "mint" && mode !== "serve"))
        return yield* Effect.fail(new Error("Choose mint, serve or setup. See --help."));
      const providers = yield* Effect.try({
        try: () =>
          subscriptionOptions({
            provider: values.provider ?? process.env["POMERADO_PROVIDER"],
            big: values["big-model"] ?? process.env["POMERADO_BIG_MODEL"],
            small: values["small-model"] ?? process.env["POMERADO_SMALL_MODEL"],
            effort: values.effort ?? process.env["POMERADO_EFFORT"],
            debug: process.env["POMERADO_DEBUG"] !== undefined,
          }),
        catch: localError,
      });
      const pomerado = {
        ...providers,
        ...options,
        browser: {
          ...options.browser,
          ...(values.headed === undefined ? {} : { headless: !values.headed }),
          ...(values.endpoint === undefined ? {} : { endpoint: values.endpoint }),
          ...(values.library === undefined ? {} : { library: values.library as "playwright" }),
        },
      };
      const directory = values.artifact === undefined ? undefined : resolve(values.artifact);
      const integration =
        mode === "serve"
          ? yield* directory === undefined
              ? Effect.fail(new Error("--artifact is required."))
              : readIntegration(directory)
          : undefined;
      const scope = yield* Effect.scope;
      const create = () =>
        integration === undefined
          ? makePomeradoMcp({
              pomerado,
              prepare: (request, name) =>
                prepareIntegration({
                  root: resolve(values.root ?? "integrations"),
                  name,
                  request,
                }),
            })
          : makeIntegrationMcp({
              ...integration,
              ...(directory === undefined ? {} : { directory }),
              pomerado,
            });
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          serveStdio(() => Effect.runPromise(Effect.provideService(create(), Scope.Scope, scope)), {
            onerror: () => process.stderr.write("Pomerado MCP transport failed.\n"),
          }),
        ),
        (server) => localPromise(() => server.close()).pipe(Effect.orDie),
      );
      yield* waitForDisconnect;
    }),
  );

export const startMcpCli = (
  args: readonly string[] = process.argv.slice(2),
  options: Omit<PomeradoOptions, "ask"> = {},
): void => {
  Effect.runCallback(runMcpCli(args, options), {
    onExit: (result) => {
      if (Exit.isFailure(result)) {
        process.stderr.write("Pomerado MCP failed. Check its local configuration.\n");
        process.exitCode = 1;
      }
    },
  });
};

/** npm links a bin to this file, so the entry path counts once its links are resolved. */
const isEntrypoint = (path: string | undefined) => {
  if (path === undefined) return false;
  try {
    return pathToFileURL(realpathSync(path)).href === import.meta.url;
  } catch {
    return false;
  }
};

if (isEntrypoint(process.argv[1])) startMcpCli();
