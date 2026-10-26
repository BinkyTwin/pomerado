# Pomerado with a subscription instead of an API key

This fork adds model providers that answer through a local agent CLI you are already logged into,
so minting needs no `OPENAI_API_KEY`:

| Provider | Login used | How it calls the model |
| --- | --- | --- |
| `claude` | Claude Code (`claude auth status`) | Claude Agent SDK; Pomerado's tools are offered as real tools through an in-process MCP server, and each call is refused before it runs and handed back to Pomerado |
| `codex` | Codex (`codex login`) | `codex exec` with an output schema; the tool calls come back as constrained JSON |
| `openai` | `OPENAI_API_KEY` | Upstream behaviour (default) |

Pomerado names two models. The big one (`gpt-6-sol` upstream) mints; the small one
(`gpt-6-luna`) runs Guardian and the outcome reviewer. With `claude` they default to `opus` and
`sonnet`.

## Use

```sh
pnpm install && pnpm exec playwright install chromium && pnpm build

# Terminal mint
node dist/typescript/src/standalone/cli.js mint --provider claude --effect read \
  --url https://books.toscrape.com/ --intent "List the books: title, price, rating" --out ./books

# MCP server
node dist/typescript/src/standalone/mcp-cli.js mint --root ~/pomerado-integrations --provider claude

# Register the MCP server with Claude Code (plugin), Codex and OpenCode (T3 Code drives all three)
node dist/typescript/src/standalone/mcp-cli.js setup --root ~/pomerado-integrations --provider claude --headed
```

Options: `--big-model`, `--small-model`, `--effort low|medium|high|xhigh|max`, or the environment
variables `POMERADO_PROVIDER`, `POMERADO_BIG_MODEL`, `POMERADO_SMALL_MODEL`, `POMERADO_EFFORT`.
`--library patchright` uses Pomerado's patched Chromium, which sites with bot checks block less.
`POMERADO_DEBUG=1` logs each model call's duration and tool calls to stderr, and
`POMERADO_TRACE=/path/trace.jsonl` records each call's prompt tail, text, tool calls and
structured output.

Measured: a read mint of the books.toscrape.com catalogue with `--provider claude` (opus mints,
sonnet reviews) took 11 minutes and 58 model calls, and produced a working tool with a category
filter and paging.

## Claude Code plugin

`plugins/claude` is a plugin marketplace with one plugin, `pomerado-subscription`: the MCP server
plus a `pomerado` skill that tells the agent how to mint and connect integrations. T3 Code loads
Claude Code plugins' skills for its Claude threads.

`setup` writes the plugin's `.mcp.json` (it holds this checkout's paths, so it is not committed)
and installs the plugin. By default `setup` installs the plugin for Claude Code and registers the
server with Codex and OpenCode. `--agents claude` registers a plain user-scope server instead; use
one or the other, not both, or Claude Code gets two servers.

## Limits

- Each model call starts a CLI process: about 3 to 8 s of overhead per call, and a mint makes
  dozens to hundreds of calls. Expect 10 to 40 minutes per mint.
- Calls count against your subscription's usage limits.
- Pomerado's prompts are tuned for OpenAI models. Reasoning items, server-side compaction and
  prompt-cache prewarming are OpenAI features; these providers skip them. Guardian's own
  compaction is replaced by a summary the backend writes.
