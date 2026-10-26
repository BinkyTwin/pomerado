import { describe, expect, it } from "vitest";
import type { AgentInputItem } from "@openai/agents";
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
    expect(transcript.text).toContain("[image #1 attached]");
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

describe("subscription provider", () => {
  it("maps Pomerado's two models to the backend's", async () => {
    const provider = subscriptionProvider({ backend: "claude", big: "opus", small: "haiku" });
    const big = await provider.getModel(solModel);
    const small = await provider.getModel(lunaModel);
    expect(big).not.toBe(small);
    expect(await provider.getModel(solModel)).toBe(big);
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
