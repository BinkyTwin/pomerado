import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Registers the Pomerado minting MCP with the local agents T3 Code drives: Claude Code (user
 * scope), Codex and OpenCode. Each file it changes is backed up first, beside the original.
 * The server runs this checkout's MCP with the chosen provider, so a Claude provider needs no key.
 */
export interface SetupOptions {
  readonly agents: readonly Agent[];
  readonly root: string;
  readonly provider: string;
  readonly headed: boolean;
  readonly dryRun: boolean;
  readonly name: string;
}

export const agents = ["claude", "codex", "opencode", "claude-plugin"] as const;
export type Agent = (typeof agents)[number];

const mcpCli = resolve(dirname(fileURLToPath(import.meta.url)), "mcp-cli.js");

/** The `node` on PATH, which survives upgrades, or this process's own binary. */
const nodeCommand = (() => {
  try {
    return execFileSync("which", ["node"], { encoding: "utf8" }).trim() || process.execPath;
  } catch {
    return process.execPath;
  }
})();

const serverArgs = (options: SetupOptions) => [
  mcpCli,
  "mint",
  "--root",
  options.root,
  "--provider",
  options.provider,
  ...(options.headed ? ["--headed"] : []),
];

const backup = (path: string) => {
  if (!existsSync(path)) return;
  const copy = `${path}.bak-pomerado-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(path, copy);
  return copy;
};

const tomlString = (value: string) => JSON.stringify(value);

/** Replaces the `[mcp_servers.<name>]` table, and its sub-tables, or appends one. */
export const withCodexServer = (text: string, options: SetupOptions) => {
  const header = `[mcp_servers.${options.name}]`;
  const lines = text.split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      skipping = trimmed === header || trimmed.startsWith(`[mcp_servers.${options.name}.`);
    }
    if (!skipping) kept.push(line);
  }
  const needsKey = options.provider === "openai";
  const table = [
    header,
    `command = ${tomlString(nodeCommand)}`,
    `args = [${serverArgs(options).map(tomlString).join(", ")}]`,
    ...(needsKey ? [`env_vars = ["OPENAI_API_KEY"]`] : []),
    "startup_timeout_sec = 60",
    "tool_timeout_sec = 3600",
  ];
  return `${kept.join("\n").trimEnd()}\n\n${table.join("\n")}\n`;
};

const setupClaude = (options: SetupOptions) => {
  const entry = {
    type: "stdio",
    command: nodeCommand,
    args: serverArgs(options),
    ...(options.provider === "openai" ? { env: { OPENAI_API_KEY: "${OPENAI_API_KEY:-}" } } : {}),
  };
  if (options.dryRun) return `claude mcp add-json -s user ${options.name} '${JSON.stringify(entry)}'`;
  try {
    execFileSync("claude", ["mcp", "remove", "-s", "user", options.name], { stdio: "ignore" });
  } catch {
    // Not registered yet.
  }
  execFileSync("claude", ["mcp", "add-json", "-s", "user", options.name, JSON.stringify(entry)], {
    stdio: "ignore",
  });
  return "registered in Claude Code (user scope)";
};

const setupCodex = (options: SetupOptions) => {
  const path = join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "config.toml");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const next = withCodexServer(text, options);
  if (options.dryRun) return `${path}:\n${next.slice(next.indexOf(`[mcp_servers.${options.name}]`))}`;
  const saved = backup(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return `${path}${saved === undefined ? "" : ` (backup ${saved})`}`;
};

const setupOpencode = (options: SetupOptions) => {
  const path = join(homedir(), ".config", "opencode", "opencode.json");
  const config = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : { $schema: "https://opencode.ai/config.json" };
  const mcp = (config["mcp"] ?? {}) as Record<string, unknown>;
  mcp[options.name] = {
    type: "local",
    enabled: true,
    command: [nodeCommand, ...serverArgs(options)],
    ...(options.provider === "openai"
      ? { environment: { OPENAI_API_KEY: "{env:OPENAI_API_KEY}" } }
      : {}),
  };
  config["mcp"] = mcp;
  const next = `${JSON.stringify(config, null, 2)}\n`;
  if (options.dryRun) return `${path}: mcp.${options.name} = ${JSON.stringify(mcp[options.name])}`;
  const saved = backup(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return `${path}${saved === undefined ? "" : ` (backup ${saved})`}`;
};

/**
 * Writes the Claude Code plugin's MCP entry for this checkout, which holds local paths and so is
 * not committed, then installs the plugin from its local marketplace.
 */
const setupClaudePlugin = (options: SetupOptions) => {
  const marketplace = resolve(dirname(mcpCli), "../../../../plugins/claude");
  const path = join(marketplace, "pomerado-subscription", ".mcp.json");
  const entry = {
    mcpServers: {
      [options.name]: {
        type: "stdio",
        command: nodeCommand,
        args: serverArgs(options),
        ...(options.provider === "openai"
          ? { env: { OPENAI_API_KEY: "${OPENAI_API_KEY:-}" } }
          : {}),
      },
    },
  };
  if (options.dryRun) return `${path}: ${JSON.stringify(entry)}`;
  writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`);
  const claude = (...args: string[]) => execFileSync("claude", args, { stdio: "ignore" });
  try {
    claude("plugin", "marketplace", "add", marketplace);
  } catch {
    claude("plugin", "marketplace", "update", "pomerado-subscription");
  }
  try {
    claude("plugin", "uninstall", "pomerado-subscription@pomerado-subscription");
  } catch {
    // Not installed yet.
  }
  claude("plugin", "install", "pomerado-subscription@pomerado-subscription");
  return `plugin installed from ${marketplace}`;
};

const steps: Record<Agent, (options: SetupOptions) => string> = {
  claude: setupClaude,
  codex: setupCodex,
  opencode: setupOpencode,
  "claude-plugin": setupClaudePlugin,
};

export const runSetup = (options: SetupOptions) =>
  options.agents.map((agent) => {
    try {
      return `${agent}: ${steps[agent](options)}`;
    } catch (error) {
      return `${agent}: failed, ${error instanceof Error ? error.message : String(error)}`;
    }
  });
