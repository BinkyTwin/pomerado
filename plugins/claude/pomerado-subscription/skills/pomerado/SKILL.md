---
name: pomerado
description: Turn a website task into a reusable MCP integration with the Pomerado MCP (mint, get_job, provide_input, cancel_job), running on the user's Claude subscription. Use when the user wants a repeatable tool for a site without an API — listing search results, extracting offers, filling a form — or asks to "mint", "create an integration" or "make a tool for" a website.
---

# Pomerado (subscription edition)

The `pomerado` MCP builds a local MCP integration from a website and a task. Every model call it
makes (the minter and its Guardian reviewer) goes through the local Claude Code login, so no API
key is needed. Minting is slow: expect 5 to 30 minutes and many model calls. Running a minted
integration afterwards makes no model call and takes seconds.

## Mint

1. Agree on the task with the user. Choose `effect: "read"` for anything that only reads pages.
   Ask the user before choosing `"write"` (anything that submits, books, buys or posts).
2. Call `mint` with:
   - `name`: lowercase directory name with underscores, e.g. `mobile_de_search`.
   - `url`: the page to start from.
   - `intent`: what the tool does and what it returns, in one or two precise sentences. Name the
     inputs the tool should take (e.g. make, model, max price) and the fields it returns.
   - `effect`: `read` or `write`.
3. `mint` returns a job ID. Poll with `get_job`. When the job asks a question, relay it to the
   user and answer with `provide_input` using the job's `request_id`. Answers, passwords included,
   reach the model, so say so before collecting secrets.
4. Stop a job with `cancel_job` if the user changes their mind.

## Use the integration

A finished mint writes a directory under the mint root (default `~/pomerado-integrations/<name>`)
with a `README.md` listing the add command for each MCP client, and an `mcp.json` entry. Register
it (for Claude Code: `claude mcp add-json -s user <name> '<entry from mcp.json>'`), then restart
the agent. The integration exposes one tool named after it, with arguments under `input`, plus
`get_job`, `provide_input` and `cancel_job` for long runs.

## Models

`POMERADO_BIG_MODEL` (default `opus`) mints; `POMERADO_SMALL_MODEL` (default `sonnet`) reviews.
`POMERADO_EFFORT` (`low`..`max`) overrides the reasoning effort. Set them in the environment
before starting the agent.
