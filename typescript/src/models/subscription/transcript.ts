import type { AgentInputItem } from "@openai/agents";

/**
 * A subscription CLI takes one prompt per call, while the Agents SDK resends the whole
 * conversation as Responses items. The transcript is that conversation rendered as text, with
 * images kept aside so a backend that reads images can attach them.
 */
export interface TranscriptImage {
  readonly mediaType: string;
  readonly data: string;
}

export interface Transcript {
  readonly text: string;
  readonly images: readonly TranscriptImage[];
}

/** Marks the summary a compaction left, so the next call reads it as earlier context. */
export const compactionPrefix = "pomerado-subscription-summary:";

/** The Guardian session's request for a compaction: its last input item. */
export const isCompactionTrigger = (item: AgentInputItem | undefined) =>
  item !== undefined &&
  item.type === "unknown" &&
  Reflect.get(item.providerData ?? {}, "type") === "compaction_trigger";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

const dataUrl = /^data:([^;,]+);base64,(.*)$/s;

const imageOf = (value: unknown): TranscriptImage | undefined => {
  if (typeof value === "string") {
    const match = dataUrl.exec(value);
    return match?.[1] !== undefined && match[2] !== undefined
      ? { mediaType: match[1], data: match[2] }
      : undefined;
  }
  const entry = record(value);
  const data = entry["data"];
  if (typeof data === "string")
    return {
      mediaType: typeof entry["mediaType"] === "string" ? entry["mediaType"] : "image/png",
      data,
    };
  if (data instanceof Uint8Array)
    return {
      mediaType: typeof entry["mediaType"] === "string" ? entry["mediaType"] : "image/png",
      data: Buffer.from(data).toString("base64"),
    };
  return undefined;
};

/** Renders one content part, collecting its image when it has one. */
const part = (value: unknown, images: TranscriptImage[]): string => {
  if (typeof value === "string") return value;
  const entry = record(value);
  switch (entry["type"]) {
    case "input_text":
    case "output_text":
    case "text":
    case "reasoning_text":
      return typeof entry["text"] === "string" ? entry["text"] : "";
    case "refusal":
      return `[refusal] ${String(entry["refusal"] ?? "")}`;
    case "input_image":
    case "image": {
      const image = imageOf(entry["image"]);
      if (image === undefined) return "[image unavailable]";
      images.push(image);
      return `[image #${images.length} attached]`;
    }
    case "input_file":
    case "file":
      return `[file ${String(record(entry["file"])["filename"] ?? entry["filename"] ?? "")}]`;
    default:
      return JSON.stringify(value);
  }
};

const content = (value: unknown, images: TranscriptImage[]) =>
  Array.isArray(value) ? value.map((entry) => part(entry, images)).join("\n") : part(value, images);

/** Renders the conversation in the order the SDK sent it. */
export const renderTranscript = (input: string | readonly AgentInputItem[]): Transcript => {
  if (typeof input === "string") return { text: `<user>\n${input}\n</user>`, images: [] };
  const images: TranscriptImage[] = [];
  const blocks: string[] = [];
  for (const item of input) {
    const entry = record(item);
    const type = entry["type"] ?? "message";
    if (type === "message" || (type === undefined && "role" in entry)) {
      const role = String(entry["role"] ?? "user");
      blocks.push(`<${role}>\n${content(entry["content"], images)}\n</${role}>`);
    } else if (type === "function_call") {
      blocks.push(
        `<tool_call id="${String(entry["callId"])}" name="${String(entry["name"])}">\n${String(entry["arguments"] ?? "")}\n</tool_call>`,
      );
    } else if (type === "function_call_result") {
      blocks.push(
        `<tool_result id="${String(entry["callId"])}" name="${String(entry["name"])}">\n${content(entry["output"], images)}\n</tool_result>`,
      );
    } else if (type === "compaction") {
      const summary = String(entry["encrypted_content"] ?? "");
      blocks.push(
        `<earlier_conversation_summary>\n${summary.startsWith(compactionPrefix) ? summary.slice(compactionPrefix.length) : "[an earlier provider's compaction, unreadable here]"}\n</earlier_conversation_summary>`,
      );
    } else if (type === "reasoning") {
      // Reasoning from an earlier turn is the model's own; its text, when any, is context.
      const text = content(entry["content"], images);
      if (text.trim() !== "") blocks.push(`<your_earlier_reasoning>\n${text}\n</your_earlier_reasoning>`);
    } else if (isCompactionTrigger(item)) {
      continue;
    } else {
      blocks.push(`<item type="${String(type)}">\n${JSON.stringify(entry)}\n</item>`);
    }
  }
  return { text: blocks.join("\n\n"), images };
};

/** Frames the transcript as the next turn the backend must produce. */
export const turnPrompt = (transcript: Transcript, hasTools: boolean) =>
  [
    "You are the model behind a host program. The conversation so far is the transcript below,",
    "in order. Earlier <assistant> turns and <tool_call> entries are yours; <tool_result> entries",
    "are what the host returned. Produce only your next turn.",
    hasTools
      ? "To act, call the tools you have (several at once when they are independent); the host runs them and replies. Reply with plain text only when the instructions say a text reply is the right ending. Never write a tool call as text."
      : "Reply with your answer.",
    "",
    "<transcript>",
    transcript.text,
    "</transcript>",
  ].join("\n");
