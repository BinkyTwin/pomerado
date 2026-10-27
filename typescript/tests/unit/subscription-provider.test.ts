import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentInputItem, ModelRequest } from "@openai/agents";
import { lunaModel, solModel } from "../../src/models/models.js";
import { subscriptionProvider } from "../../src/models/subscription/provider.js";
import {
  compactionPrefix,
  isCompactionTrigger,
  renderTranscript,
} from "../../src/models/subscription/transcript.js";
import { withCodexServer } from "../../src/standalone/setup.js";

describe("subscription transcript", () => {
  it("renders messages, calls, results and images in order", () => {
    const input = [
      { role: "user", content: "Find the price." },
      { type: "function_call", callId: "c1", name: "execute", arguments: '{"step":1}' },
      {
        type: "function_call_result",
        callId: "c1",
        name: "execute",
        status: "completed",
        output: [
          { type: "input_text", text: "Loaded." },
          { type: "input_image", image: "data:image/png;base64,AAAA" },
        ],
      },
      { role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done." }] },
    ] as AgentInputItem[];
    const transcript = renderTranscript(input);
    expect(transcript.images).toEqual([{ mediaType: "image/png", data: "AAAA" }]);
    const order = ["<user>", '<tool_call id="c1" name="execute">', '<tool_result id="c1"', "<assistant>"];
    const positions = order.map((marker) => transcript.text.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(transcript.text).toContain("[image 1 attached]");
  });

  it("reads its own compaction summaries and recognises the trigger", () => {
    const trigger = { type: "unknown", providerData: { type: "compaction_trigger" } } as AgentInputItem;
    expect(isCompactionTrigger(trigger)).toBe(true);
    const transcript = renderTranscript([
      { type: "compaction", encrypted_content: `${compactionPrefix}Checked page one.` },
      trigger,
    ] as AgentInputItem[]);
    expect(transcript.text).toContain("Checked page one.");
    expect(transcript.text).not.toContain("compaction_trigger");
  });
});

describe("subscription instructions", () => {
  it("moves developer messages, wrapped or not, into the instructions", async () => {
    const { splitInstructions } = await import("../../src/models/subscription/transcript.js");
    const split = splitInstructions("Base.", [
      { type: "unknown", providerData: { type: "message", role: "developer", content: [{ type: "input_text", text: "Skill." }] } },
      { role: "user", content: "Go." },
    ] as AgentInputItem[]);
    expect(split.instructions).toBe("Base.\n\nSkill.");
    expect(split.input).toHaveLength(1);
  });
});

describe("subscription provider", () => {
  it("maps Pomerado's two models to the backend's", async () => {
    const provider = subscriptionProvider({ backend: "claude", big: "opus", small: "haiku" });
    const big = await provider.getModel(solModel);
    const small = await provider.getModel(lunaModel);
    expect(big).not.toBe(small);
    expect(await provider.getModel(solModel)).toBe(big);
    expect(await provider.getModel("other-model")).not.toBe(big);
  });
});

describe("codex setup", () => {
  const options = {
    agents: ["codex"] as const,
    root: "/tmp/integrations",
    provider: "claude",
    headed: false,
    dryRun: true,
    name: "pomerado",
  };
  it("replaces an earlier table and its sub-tables, keeping the rest", () => {
    const before = [
      'model = "x"',
      "[mcp_servers.pomerado]",
      'command = "npx"',
      "[mcp_servers.pomerado.env]",
      'A = "1"',
      "[mcp_servers.other]",
      'command = "y"',
    ].join("\n");
    const after = withCodexServer(before, options);
    expect(after.match(/\[mcp_servers\.pomerado\]/g)).toHaveLength(1);
    expect(after).not.toContain("[mcp_servers.pomerado.env]");
    expect(after).toContain("[mcp_servers.other]");
    expect(after).toContain('"--provider", "claude"');
    expect(after).not.toContain("OPENAI_API_KEY");
  });
});

describe("opencode go chat requests", () => {
  it("preserves allowed tool restrictions in Chat Completions", async () => {
    const { chatRequest } = await import("../../src/models/subscription/opencode-go.js");
    const request = chatRequest({
      input: "Go",
      modelSettings: { providerData: { tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "read" }] } } },
      tools: [
        { type: "function", name: "read", description: "", parameters: {}, strict: false },
        { type: "function", name: "write", description: "", parameters: {}, strict: false },
      ] as unknown as ModelRequest["tools"],
      outputType: "text", handoffs: [], tracing: false,
    });
    expect(request.tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(request.modelSettings.toolChoice).toBe("required");
    expect(request.modelSettings.providerData?.["tool_choice"]).toBeUndefined();
    const unavailable = {
      ...request,
      modelSettings: { providerData: { tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "write" }] } } },
    } as ModelRequest;
    expect(() => chatRequest(unavailable)).toThrow("No supported tools remain");
    expect(chatRequest({
      ...unavailable,
      modelSettings: { providerData: { tool_choice: { type: "allowed_tools", mode: "auto", tools: [] } } },
    }).modelSettings.toolChoice).toBe("none");
  });

  it("drops OpenAI-only settings and items Chat Completions cannot carry", async () => {
    const { chatRequest } = await import("../../src/models/subscription/opencode-go.js");
    const request = chatRequest({
      input: [
        { type: "compaction", encrypted_content: `${compactionPrefix}Read page one.` },
        { type: "reasoning", content: [] },
        { role: "developer", content: [{ type: "input_text", text: "Policy." }] },
        {
          type: "unknown",
          providerData: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "Wrapped." }],
          },
        },
        { role: "user", content: "Go on." },
      ] as unknown as AgentInputItem[],
      modelSettings: {
        providerData: {
          prompt_cache_options: { mode: "explicit" },
          context_management: [{ type: "compaction" }],
          keep: true,
        },
      },
      tools: [
        { type: "apply_patch", name: "apply_patch" },
        { type: "function", name: "read", description: "", parameters: {}, strict: false },
      ] as unknown as ModelRequest["tools"],
      outputType: "text",
      handoffs: [],
      tracing: false,
    });
    expect(request.tools.map((tool) => tool.name)).toEqual(["read"]);
    expect(request.modelSettings.providerData).toEqual({ keep: true });
    const input = request.input as AgentInputItem[];
    expect(input).toHaveLength(4);
    expect(input[2]).toEqual({ role: "system", content: "Wrapped." });
    expect(JSON.stringify(input[0])).toContain("Read page one.");
    expect(input[1]).toEqual({ role: "system", content: "Policy." });
  });
});

describe("opencode go credentials", () => {
  it("reads the active database credential and falls back to the legacy file", async () => {
    const { opencodeGoKey } = await import("../../src/models/subscription/opencode-go.js");
    const root = mkdtempSync(join(tmpdir(), "pomerado-auth-test-"));
    const oldData = process.env["XDG_DATA_HOME"];
    const oldKey = process.env["OPENCODE_GO_API_KEY"];
    try {
      process.env["XDG_DATA_HOME"] = root;
      delete process.env["OPENCODE_GO_API_KEY"];
      mkdirSync(join(root, "opencode"));
      writeFileSync(join(root, "opencode", "auth.json"), JSON.stringify({ "opencode-go": { key: "legacy-fixture" } }));
      const db = new DatabaseSync(join(root, "opencode", "opencode.db"));
      db.exec("CREATE TABLE credential (integration_id TEXT, active INTEGER, time_updated INTEGER, value TEXT)");
      const insert = db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?)");
      insert.run("opencode-go", 0, 2, JSON.stringify({ key: "inactive-fixture" }));
      insert.run("opencode-go", 1, 1, JSON.stringify({ key: "active-fixture" }));
      db.close();
      expect(opencodeGoKey()).toBe("active-fixture");
      process.env["OPENCODE_GO_API_KEY"] = "environment-fixture";
      expect(opencodeGoKey()).toBe("environment-fixture");
      delete process.env["OPENCODE_GO_API_KEY"];
      const inactiveDb = new DatabaseSync(join(root, "opencode", "opencode.db"));
      inactiveDb.exec("UPDATE credential SET active = 0");
      inactiveDb.close();
      expect(opencodeGoKey()).toBe("legacy-fixture");
      rmSync(join(root, "opencode", "opencode.db"));
      expect(opencodeGoKey()).toBe("legacy-fixture");
    } finally {
      if (oldData === undefined) delete process.env["XDG_DATA_HOME"]; else process.env["XDG_DATA_HOME"] = oldData;
      if (oldKey === undefined) delete process.env["OPENCODE_GO_API_KEY"]; else process.env["OPENCODE_GO_API_KEY"] = oldKey;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
