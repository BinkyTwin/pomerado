# Pomerado on your subscription

[Pomerado](https://github.com/Pomerado/pomerado) turns a website and a task into a reusable MCP
integration. Upstream, every model call goes to the OpenAI API, so minting needs an
`OPENAI_API_KEY` with access to `gpt-6-sol` and `gpt-6-luna`.

This fork adds model providers that answer through a subscription you already pay for:

| Provider | Uses | How it calls the model | Status |
| --- | --- | --- | --- |
| `claude` | Your Claude Code login (Pro/Max) | Claude Agent SDK. Pomerado's tools are offered as real tools through an in-process MCP server; each call is stopped before it runs and handed back to Pomerado, which runs it | Tested end to end |
| `opencode` | Your OpenCode Go key | Go's own API: Responses for GPT/Grok models, Chat Completions for GLM, Kimi, DeepSeek and the rest | Written, not yet tested end to end |
| `codex` | Your Codex login (ChatGPT plan) | `codex exec` with an output schema; tool calls come back as constrained JSON | Written, not yet tested end to end |
| `openai` | `OPENAI_API_KEY` | Upstream behaviour | Default |

Pomerado names two models: the big one (`gpt-6-sol` upstream) mints, the small one
(`gpt-6-luna`) runs Guardian, the safety reviewer, and the outcome reviewer.

| Provider | Big (minting) | Small (review) |
| --- | --- | --- |
| `claude` | `opus` | `sonnet` |
| `opencode` | `kimi-k3.1-pro` | `gpt-6-luna` |
| `codex` | Codex's configured model | Codex's configured model |

Measured: a read mint of the books.toscrape.com catalogue with `--provider claude` took
11 minutes and 58 model calls, and produced a working tool with a category filter and paging.

## Install

Requires Node 24, pnpm, and the CLI of the provider you choose, logged in.

```sh
git clone -b subscription-providers https://github.com/BinkyTwin/pomerado.git pomerado-subscription
cd pomerado-subscription
pnpm install && pnpm exec playwright install chromium && pnpm build
```

### Connect it to your agents

`setup` registers the minting MCP with Claude Code (as a plugin, with a skill that teaches the
agent how to mint), Codex and OpenCode. It backs up every file it changes. T3 Code drives all
three agents, so this is also how you use it from T3 Code.

```sh
node dist/typescript/src/standalone/mcp-cli.js setup \
  --root ~/pomerado-integrations --provider claude --headed
```

Restart your agents, then ask one to mint, for example: "Use Pomerado to make a read tool for
books.toscrape.com that lists the books with title, price and rating."

`--agents claude-plugin,codex,opencode` picks the agents (that list is the default);
`--agents claude` registers a plain user-scope server for Claude Code instead of the plugin. Use
one or the other for Claude Code, not both. `--dry-run` prints what would change.

### Or run it from the terminal

```sh
node dist/typescript/src/standalone/cli.js mint --provider claude --effect read \
  --url https://books.toscrape.com/ --intent "List the books: title, price, rating" --out ./books
node dist/typescript/src/standalone/cli.js run --artifact ./books --url https://books.toscrape.com/
```

## Options

| Flag | Environment | Meaning |
| --- | --- | --- |
| `--provider` | `POMERADO_PROVIDER` | `openai`, `claude`, `opencode` or `codex` |
| `--big-model` | `POMERADO_BIG_MODEL` | The minting model |
| `--small-model` | `POMERADO_SMALL_MODEL` | The review model |
| `--effort` | `POMERADO_EFFORT` | `low`, `medium`, `high`, `xhigh` or `max` for every call (`claude`, `codex`) |
| `--library patchright` | | Pomerado's patched Chromium, which bot checks block less |
| | `OPENCODE_GO_API_KEY` | The Go key; without it, the key `opencode auth login` stored |
| | `POMERADO_DEBUG=1` | Logs each model call's duration and tool calls to stderr |
| | `POMERADO_TRACE=file.jsonl` | Records each `claude` call: prompt tail, text, tool calls, structured output |

## Limits

- `claude` and `codex` start a CLI process per model call: 3 to 8 s of overhead, and a mint
  makes dozens to hundreds of calls. Expect 10 to 40 minutes per mint. Running a minted tool
  makes no model call.
- Calls count against your plan's usage limits. Use your own subscription for your own work, and
  follow your provider's terms. OpenCode Go asks direct callers for coding-agent-like traffic,
  their own user agent and a session header, which this provider sends.
- Pomerado's prompts are tuned for OpenAI models. Reasoning items, server-side compaction and
  prompt-cache prewarming are OpenAI features that `claude`, `codex` and Go's Chat Completions
  models skip; Guardian's compaction becomes a summary the model writes.
- OpenCode Go's Messages-API models (Claude Haiku, Qwen 3.7/3.8, MiniMax M3) and Gemini are not
  supported yet.

## How the `claude` provider works

The Agents SDK resends the whole conversation on every call. The provider renders it as one
transcript prompt, starts Claude Code with its own tools turned off and Pomerado's tools served by
an in-process MCP server, and lets Claude answer. When Claude calls a Pomerado tool, the
permission callback refuses the call before it runs and ends the turn; the provider returns the
call to the Agents SDK as a function call, and Pomerado runs it as it would for GPT. A structured
output (Guardian's decisions) comes from Claude Code's JSON-schema output. The code is in
`typescript/src/models/subscription/`.

## Credits

All of Pomerado is the work of its authors, under the MIT licence. This fork only adds the
providers, the setup command and the Claude Code plugin.
