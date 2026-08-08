import { describe, expect, it } from "vitest";
import {
  createOpenAiCompatModel,
  MAX_COMPLETION_TOKENS,
} from "@/lib/agent/models/openai-compat";
import { MAX_TOKENS } from "@/lib/agent/models/anthropic";
import { fromOpenAI } from "@/lib/agent/adapter";
import { TOOL_DEFINITIONS, type ChatMessage, type Model, type ModelChunk } from "@/lib/agent/loop";
import type { Provider } from "@/lib/registry";

/**
 * tests/openai-compat-model.test.ts — the openai-compat wrapper's first
 * dedicated suite (WR-03).
 *
 * The load-bearing assertion here is that `stopReason` reaches the loop even
 * when the provider never sends a usage chunk: the free OpenRouter models that
 * are this project's demo default do NOT honour
 * `stream_options.include_usage`, so a wrapper that only ever yields the finish
 * reason alongside usage leaves the loop's clean-finish guard permanently dead
 * on exactly the path a reviewer will use — a `finish_reason: "length"`
 * truncation presented as a finished answer (Critical Failure Mode #3).
 *
 * Fixture style mirrors tests/anthropic-model.test.ts: a fake client injected
 * through the wrapper's `_clientFactory` seam, capturing the BUILT request.
 */

interface StreamPart {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: Record<string, unknown>;
}

interface CapturedRequest {
  model: string;
  messages: unknown;
  stream: boolean;
  [key: string]: unknown;
}

const OPENAI_USAGE = {
  prompt_tokens: 1200,
  completion_tokens: 420,
  prompt_tokens_details: { cached_tokens: 800 },
};

/** A text delta part; `finish` attaches a finish_reason to the same part. */
function textPart(content: string, finish?: string): StreamPart {
  return {
    choices: [{ delta: { content }, ...(finish ? { finish_reason: finish } : {}) }],
  };
}

function makeModel(
  parts: StreamPart[],
  provider?: Provider,
  contextTokens?: number | null,
): { model: Model; captured: { request?: CapturedRequest } } {
  const captured: { request?: CapturedRequest } = {};
  const client = {
    chat: {
      completions: {
        create(req: CapturedRequest) {
          captured.request = req;
          return Promise.resolve({
            // eslint-disable-next-line @typescript-eslint/require-await
            async *[Symbol.asyncIterator]() {
              for (const p of parts) yield p;
            },
          });
        },
      },
    },
  };
  const model = createOpenAiCompatModel({
    apiKey: "sk-test",
    baseURL: "https://openrouter.ai/api/v1",
    modelId: "inclusionai/ling-3.0-tiny:free",
    ...(provider ? { provider } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    _clientFactory: () => client,
  });
  return { model, captured };
}

async function collect(model: Model, messages: ChatMessage[]): Promise<ModelChunk[]> {
  const out: ModelChunk[] = [];
  for await (const chunk of model.run(messages, TOOL_DEFINITIONS)) out.push(chunk);
  return out;
}

const CONVO: ChatMessage[] = [
  { role: "system", content: "You are a research agent." },
  { role: "user", content: "What changed in EU AI policy recently?" },
];

describe("createOpenAiCompatModel — finish reason delivery (WR-03)", () => {
  it("delivers stopReason 'length' from a stream that sent NO usage chunk", async () => {
    // The exact demo-default shape: deltas + finish_reason, never any usage.
    const { model } = makeModel([
      textPart("A truncated mid-sentence answ"),
      textPart("", "length"),
    ]);
    const chunks = await collect(model, CONVO);
    const stopChunks = chunks.filter((c) => c.stopReason !== undefined);
    expect(stopChunks).toHaveLength(1);
    expect(stopChunks[0].stopReason).toBe("length");
    // No usage was reported, so the stop-reason-only chunk carries none.
    expect(stopChunks[0].usage).toBeUndefined();
  });

  it("still yields usage and stopReason together exactly once when usage IS sent", async () => {
    const { model } = makeModel([
      textPart("Clean answer."),
      { choices: [{ finish_reason: "stop", delta: {} }], usage: OPENAI_USAGE },
    ]);
    const chunks = await collect(model, CONVO);
    const stopChunks = chunks.filter((c) => c.stopReason !== undefined);
    // Exactly one — no duplicate stop-reason-only chunk appended afterwards.
    expect(stopChunks).toHaveLength(1);
    expect(stopChunks[0].stopReason).toBe("stop");
    expect(stopChunks[0].usage).toEqual(fromOpenAI(OPENAI_USAGE));
    const usageChunks = chunks.filter((c) => c.usage !== undefined);
    expect(usageChunks).toHaveLength(1);
  });

  it("yields NO stopReason chunk when the stream ends with neither usage nor a finish reason", async () => {
    const { model } = makeModel([textPart("Clean answer."), textPart(" Done.")]);
    const chunks = await collect(model, CONVO);
    expect(chunks.filter((c) => c.stopReason !== undefined)).toHaveLength(0);
    // An absent stop reason stays undefined — tests/loop.test.ts pins that the
    // loop treats undefined as clean, so this must NOT become an empty string.
    expect(chunks.map((c) => c.delta)).toEqual(["Clean answer.", " Done."]);
  });

  it("yields BOTH the reassembled toolCalls chunk and the stopReason chunk — neither swallows the other", async () => {
    const { model } = makeModel([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "web_search", arguments: '{"que' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'ry":"EU AI Act"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);
    const chunks = await collect(model, CONVO);
    const toolIdx = chunks.findIndex((c) => c.toolCalls !== undefined);
    const stopIdx = chunks.findIndex((c) => c.stopReason !== undefined);
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(chunks[toolIdx].toolCalls).toEqual([
      { id: "call_1", name: "web_search", arguments: '{"query":"EU AI Act"}' },
    ]);
    expect(chunks[stopIdx].stopReason).toBe("tool_calls");
    // Tool calls flush first, then the stop reason closes the turn.
    expect(toolIdx).toBeLessThan(stopIdx);
  });
});

describe("createOpenAiCompatModel — explicit completion cap (WR-03)", () => {
  // GW-04: each cap test now STATES the precondition that justifies its cap —
  // a recorded 200_000-token window, whose quarter (50_000) clamps to
  // MAX_COMPLETION_TOKENS. The expectations are unchanged; only the input that
  // makes them true is now explicit instead of assumed.
  it("sends the cap as max_tokens for a non-openai provider", async () => {
    const { model, captured } = makeModel([textPart("hi", "stop")], "openrouter", 200_000);
    await collect(model, CONVO);
    const req = captured.request!;
    // Literal AND constant: the literal keeps this from passing vacuously if the
    // constant were ever absent (undefined === undefined).
    expect(req.max_tokens).toBe(16_384);
    expect(req.max_tokens).toBe(MAX_COMPLETION_TOKENS);
    expect("max_completion_tokens" in req).toBe(false);
  });

  it("sends the cap as max_completion_tokens for provider 'openai', and NOT max_tokens", async () => {
    const { model, captured } = makeModel([textPart("hi", "stop")], "openai", 200_000);
    await collect(model, CONVO);
    const req = captured.request!;
    expect(req.max_completion_tokens).toBe(16_384);
    expect(req.max_completion_tokens).toBe(MAX_COMPLETION_TOKENS);
    expect("max_tokens" in req).toBe(false);
  });

  it("pins the openai-compat cap strictly equal to MAX_TOKENS from the anthropic wrapper (no drift)", () => {
    expect(MAX_COMPLETION_TOKENS).toBe(MAX_TOKENS);
    expect(MAX_COMPLETION_TOKENS).toBe(16_384);
  });
});

/**
 * GW-04. WR-03 began sending an unconditional 16_384-token reservation on a
 * path that previously sent none. TEN of the registry's sixteen entries record
 * `contextTokens: null` — the six free OpenRouter ids AND the four paid OpenAI
 * ids — and the loop feeds back page extracts capped at 20_000 characters each,
 * so by iteration 3-4 `prompt + max_tokens > context` is a real, billed 400 that
 * the app's own reservation caused. These tests pin that an unknown window means
 * no cap at all.
 */
describe("createOpenAiCompatModel — the cap is DERIVED from the context window (GW-04)", () => {
  it.each([
    ["null (the ten unknown-window registry entries)", null as number | null],
    ["absent", undefined],
  ])("sends NEITHER cap key when contextTokens is %s", async (_label, ctx) => {
    const { model, captured } = makeModel([textPart("hi", "stop")], "openrouter", ctx);
    await collect(model, CONVO);
    const req = captured.request!;
    expect("max_tokens" in req).toBe(false);
    expect("max_completion_tokens" in req).toBe(false);
  });

  it("sends no cap key for provider 'openai' either when the window is unknown", async () => {
    // The paid OpenAI ids record contextTokens: null too — the blast radius is
    // ten entries, not the six OpenRouter ones.
    const { model, captured } = makeModel([textPart("hi", "stop")], "openai", null);
    await collect(model, CONVO);
    const req = captured.request!;
    expect("max_completion_tokens" in req).toBe(false);
    expect("max_tokens" in req).toBe(false);
  });

  it("reserves a QUARTER of a small recorded window rather than the flat maximum", async () => {
    const { model, captured } = makeModel([textPart("hi", "stop")], "openrouter", 32_000);
    await collect(model, CONVO);
    expect(captured.request!.max_tokens).toBe(8_000);
  });

  it.each([
    ["1M (kimi-k3)", 1_000_000],
    ["256K (kimi-k2.6 / k2.7-code)", 256_000],
  ])("still clamps a %s window to MAX_COMPLETION_TOKENS", async (_label, ctx) => {
    const { model, captured } = makeModel([textPart("hi", "stop")], "kimi", ctx);
    await collect(model, CONVO);
    expect(captured.request!.max_tokens).toBe(MAX_COMPLETION_TOKENS);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
  ])("treats a %s window as unknown, never as a zero reservation", async (_label, ctx) => {
    const { model, captured } = makeModel([textPart("hi", "stop")], "openrouter", ctx);
    await collect(model, CONVO);
    const req = captured.request!;
    expect("max_tokens" in req).toBe(false);
    expect("max_completion_tokens" in req).toBe(false);
  });
});
