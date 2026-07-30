import { describe, expect, it } from "vitest";
import { createAnthropicModel, MAX_TOKENS } from "@/lib/agent/models/anthropic";
import { DEEP_RESEARCH_SYSTEM } from "@/lib/agent/prompt";
import { fromAnthropic } from "@/lib/agent/adapter";
import { TOOL_DEFINITIONS, type ChatMessage, type Model, type ModelChunk } from "@/lib/agent/loop";
import { filterProviderHistory } from "@/app/api/agent/run/route";

/**
 * tests/anthropic-model.test.ts — pins the BUILT Anthropic request shape (D-48/D-49).
 *
 * The cache-breakpoint invariant is positional and invisible in the type system
 * (AI-SPEC New Risk #2), so these tests assert the two breakpoint POSITIONS
 * against history that has been through the REAL D-57/D-59 filter function
 * (filterProviderHistory from the route module) — never a hand-built literal.
 */

interface CacheableBlock {
  type: string;
  text?: string;
  cache_control?: { type: string };
}

interface CapturedRequest {
  model: string;
  max_tokens: number;
  system: CacheableBlock[];
  messages: Array<{ role: string; content: CacheableBlock[] }>;
  tools?: Array<{ name: string; description: string; input_schema: unknown }>;
  [key: string]: unknown;
}

interface FakeFinalMessage {
  content: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
  stop_reason: string | null;
  usage: Record<string, unknown>;
}

const DEFAULT_USAGE = {
  input_tokens: 1200,
  output_tokens: 420,
  cache_read_input_tokens: 8000,
  cache_creation_input_tokens: 0,
};

function makeFake(
  finalOverrides: Partial<FakeFinalMessage> = {},
  deltas: string[] = [],
) {
  const captured: { request?: CapturedRequest } = {};
  const finalMsg: FakeFinalMessage = {
    content: [],
    stop_reason: "end_turn",
    usage: DEFAULT_USAGE,
    ...finalOverrides,
  };
  const client = {
    messages: {
      stream(req: CapturedRequest) {
        captured.request = req;
        return {
          // eslint-disable-next-line @typescript-eslint/require-await
          async *[Symbol.asyncIterator]() {
            for (const d of deltas) {
              yield {
                type: "content_block_delta",
                delta: { type: "text_delta", text: d },
              };
            }
          },
          async finalMessage() {
            return finalMsg;
          },
          abort() {},
        };
      },
    },
  };
  return { client, captured };
}

function makeModel(
  finalOverrides: Partial<FakeFinalMessage> = {},
  deltas: string[] = [],
): { model: Model; captured: { request?: CapturedRequest } } {
  const { client, captured } = makeFake(finalOverrides, deltas);
  const model = createAnthropicModel({
    apiKey: "sk-ant-test",
    baseURL: "https://api.anthropic.com",
    modelId: "claude-sonnet-4-6",
    _clientFactory: () => client,
  });
  return { model, captured };
}

async function collect(model: Model, messages: ChatMessage[]): Promise<ModelChunk[]> {
  const out: ModelChunk[] = [];
  for await (const chunk of model.run(messages, TOOL_DEFINITIONS)) out.push(chunk);
  return out;
}

/** The standard message array the route builds: system + replayed history + new user. */
const STANDARD: ChatMessage[] = [
  { role: "system", content: DEEP_RESEARCH_SYSTEM },
  { role: "user", content: "What changed in EU AI policy recently?" },
  { role: "assistant", content: "Here is an earlier answer." },
  { role: "user", content: "And what do analysts expect next?" },
];

describe("createAnthropicModel — request shape (D-48/D-49)", () => {
  it("sends model, max_tokens 16384, and system as a one-element cache_control'd TextBlockParam array", async () => {
    const { model, captured } = makeModel();
    await collect(model, STANDARD);
    const req = captured.request!;
    expect(req.model).toBe("claude-sonnet-4-6");
    expect(req.max_tokens).toBe(16_384);
    expect(req.max_tokens).toBe(MAX_TOKENS);
    // Breakpoint 1: the system prompt is a TOP-LEVEL param, one block, cached.
    expect(Array.isArray(req.system)).toBe(true);
    expect(req.system).toHaveLength(1);
    expect(req.system[0].type).toBe("text");
    expect(req.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("system[0].text is byte-identical to DEEP_RESEARCH_SYSTEM for the standard message array", async () => {
    const { model, captured } = makeModel();
    await collect(model, STANDARD);
    expect(captured.request!.system[0].text).toBe(DEEP_RESEARCH_SYSTEM);
  });

  it("sends NO temperature, top_p, top_k, or thinking keys (400 on claude-opus-4-8)", async () => {
    const { model, captured } = makeModel();
    await collect(model, STANDARD);
    const req = captured.request!;
    expect("temperature" in req).toBe(false);
    expect("top_p" in req).toBe(false);
    expect("top_k" in req).toBe(false);
    expect("thinking" in req).toBe(false);
  });

  it("translates tools to the flat Anthropic {name, description, input_schema} shape", async () => {
    const { model, captured } = makeModel();
    await collect(model, STANDARD);
    const tools = captured.request!.tools!;
    expect(tools).toHaveLength(TOOL_DEFINITIONS.length);
    for (let i = 0; i < tools.length; i++) {
      expect(tools[i].name).toBe(TOOL_DEFINITIONS[i].function.name);
      expect(tools[i].description).toBe(TOOL_DEFINITIONS[i].function.description);
      expect(tools[i].input_schema).toEqual(TOOL_DEFINITIONS[i].function.parameters);
      // Flat shape — never the OpenAI {type, function:{...}} wrapper.
      expect("function" in (tools[i] as Record<string, unknown>)).toBe(false);
      expect("parameters" in (tools[i] as Record<string, unknown>)).toBe(false);
    }
  });

  it("never places a role:'system' entry inside messages, and every message is a content-block array", async () => {
    const { model, captured } = makeModel();
    await collect(model, STANDARD);
    const msgs = captured.request!.messages;
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) {
      expect(m.role).not.toBe("system");
      expect(Array.isArray(m.content)).toBe(true);
      for (const block of m.content) expect(block.type).toBe("text");
    }
  });

  it("breakpoint 2: ONLY the last content block of the LAST message carries cache_control", async () => {
    const { model, captured } = makeModel();
    await collect(model, STANDARD);
    const msgs = captured.request!.messages;
    for (let i = 0; i < msgs.length; i++) {
      const blocks = msgs[i].content;
      for (let j = 0; j < blocks.length; j++) {
        const isLastBlockOfLastMessage =
          i === msgs.length - 1 && j === blocks.length - 1;
        if (isLastBlockOfLastMessage) {
          expect(blocks[j].cache_control).toEqual({ type: "ephemeral" });
        } else {
          expect(blocks[j].cache_control).toBeUndefined();
        }
      }
    }
  });

  it("drops empty/whitespace messages BEFORE computing the breakpoint-2 index (belt-and-braces to D-59)", async () => {
    const { model, captured } = makeModel();
    // A trailing whitespace-only assistant row fed DIRECTLY to the wrapper: the
    // wrapper's own filter must drop it so breakpoint 2 lands on the real last
    // message, not on a message that was dropped.
    await collect(model, [
      ...STANDARD,
      { role: "assistant", content: "   " },
    ]);
    const msgs = captured.request!.messages;
    expect(msgs).toHaveLength(3); // 4 standard minus the system entry
    const last = msgs[msgs.length - 1];
    expect(last.content[last.content.length - 1].text).toBe(
      "And what do analysts expect next?",
    );
    expect(last.content[last.content.length - 1].cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("breakpoint positions hold for history that went through the REAL filterProviderHistory (New Risk #2)", async () => {
    // Raw DB rows exactly as route.ts reads them — including the two poison rows.
    const rows: Array<{ role: string; content: string | null }> = [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "tool", content: '{"tool":"web_search","state":"done"}' }, // D-57
      { role: "assistant", content: "" }, // D-59 (abandoned run)
      { role: "user", content: "Second question" },
      { role: "assistant", content: null }, // D-59 (null content)
    ];
    const filtered = filterProviderHistory(rows);
    const providerMessages: ChatMessage[] = [
      { role: "system", content: DEEP_RESEARCH_SYSTEM },
      ...filtered,
      { role: "user", content: "Third question" },
    ];

    const { model, captured } = makeModel();
    await collect(model, providerMessages);
    const msgs = captured.request!.messages;

    // The tool row and both empty assistant rows never reach the provider.
    expect(JSON.stringify(msgs)).not.toContain("web_search");
    expect(msgs.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "user",
    ]);
    // Breakpoint 2 = the last content block of the actual last replayed message.
    const last = msgs[msgs.length - 1];
    expect(last.content[last.content.length - 1].text).toBe("Third question");
    expect(last.content[last.content.length - 1].cache_control).toEqual({
      type: "ephemeral",
    });
    // And nothing else carries a breakpoint.
    const flagged = msgs.flatMap((m) => m.content).filter((b) => b.cache_control);
    expect(flagged).toHaveLength(1);
  });
});

describe("createAnthropicModel — the system parameter is omitted, never empty (WR-05)", () => {
  /**
   * An empty text block is BOTH a 400 and un-cacheable (E1b / D-59). The file
   * already filters empty blocks out of `messages`; these tests extend the same
   * invariant to the block the wrapper builds itself for cache breakpoint 1.
   * Asserted by KEY PRESENCE — `system: undefined` would still serialize the key
   * and is not the contract.
   */
  const asRecord = (req: CapturedRequest): Record<string, unknown> =>
    req as unknown as Record<string, unknown>;

  it("keeps the one-element cache_control'd system array byte-identical to DEEP_RESEARCH_SYSTEM for the standard array", async () => {
    const { model, captured } = makeModel();
    await collect(model, STANDARD);
    const req = captured.request!;
    expect(Array.isArray(req.system)).toBe(true);
    expect(req.system).toHaveLength(1);
    expect(req.system[0].text).toBe(DEEP_RESEARCH_SYSTEM);
    expect(req.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("omits the system KEY entirely when the message array contains no system entry", async () => {
    const { model, captured } = makeModel();
    await collect(model, [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Second question" },
    ]);
    expect("system" in asRecord(captured.request!)).toBe(false);
  });

  it("omits the system KEY when the system entry's content is whitespace-only", async () => {
    const { model, captured } = makeModel();
    await collect(model, [
      { role: "system", content: "   \n\t  " },
      { role: "user", content: "First question" },
    ]);
    expect("system" in asRecord(captured.request!)).toBe(false);
  });

  it("the no-system request is otherwise fully valid, and breakpoint 2 still lands on the last block of the last message", async () => {
    const { model, captured } = makeModel();
    await collect(model, [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Third question" },
    ]);
    const req = captured.request!;
    expect(req.model).toBe("claude-sonnet-4-6");
    expect(req.max_tokens).toBe(MAX_TOKENS);
    expect(req.tools).toHaveLength(TOOL_DEFINITIONS.length);
    for (const m of req.messages) {
      expect(m.role).not.toBe("system");
      expect(Array.isArray(m.content)).toBe(true);
    }
    // Breakpoint 1 is absent BY DESIGN here (nothing worth caching); breakpoint
    // 2 is unaffected and still the single flagged block.
    const last = req.messages[req.messages.length - 1];
    expect(last.content[last.content.length - 1].text).toBe("Third question");
    expect(last.content[last.content.length - 1].cache_control).toEqual({
      type: "ephemeral",
    });
    const flagged = req.messages.flatMap((m) => m.content).filter((b) => b.cache_control);
    expect(flagged).toHaveLength(1);
  });
});

describe("createAnthropicModel — stream consumption (Correction C4)", () => {
  it("yields text_delta events as {delta} chunks in order", async () => {
    const { model } = makeModel({}, ["Hello ", "world"]);
    const chunks = await collect(model, STANDARD);
    const deltas = chunks.filter((c) => c.delta).map((c) => c.delta);
    expect(deltas).toEqual(["Hello ", "world"]);
  });

  it("surfaces finalMessage().stop_reason as ModelChunk.stopReason on the final chunk", async () => {
    const { model } = makeModel({ stop_reason: "max_tokens" });
    const chunks = await collect(model, STANDARD);
    const final = chunks[chunks.length - 1];
    expect(final.stopReason).toBe("max_tokens");
    expect(final.usage).toBeDefined();
  });

  it("maps tool_use blocks to ToolCallRequest with arguments = JSON.stringify(input)", async () => {
    const input = { query: "EU AI Act enforcement" };
    const { model } = makeModel({
      stop_reason: "tool_use",
      content: [
        { type: "text" },
        { type: "tool_use", id: "toolu_01abc", name: "web_search", input },
      ],
    });
    const chunks = await collect(model, STANDARD);
    const toolChunk = chunks.find((c) => c.toolCalls);
    expect(toolChunk).toBeDefined();
    expect(toolChunk!.toolCalls).toEqual([
      { id: "toolu_01abc", name: "web_search", arguments: JSON.stringify(input) },
    ]);
  });

  it("usage flows through fromAnthropic — cache columns mapped, NO subtraction", async () => {
    const { model } = makeModel();
    const chunks = await collect(model, STANDARD);
    const usageChunk = chunks.find((c) => c.usage);
    expect(usageChunk!.usage).toEqual(fromAnthropic(DEFAULT_USAGE));
    expect(usageChunk!.usage!.inputTokens).toBe(1200); // stays 1200 — no subtraction
    expect(usageChunk!.usage!.cacheReadTokens).toBe(8000);
  });
});

describe("filterProviderHistory (shared seam — D-57/D-59)", () => {
  it("drops role='tool' rows and empty/null-content rows, preserving order and roles", () => {
    const filtered = filterProviderHistory([
      { role: "user", content: "keep me" },
      { role: "tool", content: '{"state":"running"}' },
      { role: "assistant", content: "" },
      { role: "assistant", content: "also keep me" },
      { role: "assistant", content: null },
    ]);
    expect(filtered).toEqual([
      { role: "user", content: "keep me" },
      { role: "assistant", content: "also keep me" },
    ]);
  });
});
