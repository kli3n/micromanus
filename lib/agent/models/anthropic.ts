/**
 * lib/agent/models/anthropic.ts — the anthropic-NATIVE Model wrapper (D-48/D-49).
 *
 * NEVER call Anthropic through the OpenAI-compat /v1/chat/completions shim: it
 * silently drops `cache_control` and returns no cache usage fields, so the
 * cache columns would be zero forever with code that compiles and reviews
 * clean (CM-3 — the trap the adapter seam exists to isolate).
 *
 * Only TYPES are imported from the SDK at module scope; the runtime client is
 * dynamic-imported inside the generator (Vitest-clean, matching the existing
 * route discipline) or injected via the `_clientFactory` test seam.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { fromAnthropic } from "@/lib/agent/adapter";
import {
  TOOL_DEFINITIONS,
  type ChatMessage,
  type Model,
  type ModelChunk,
  type ToolCallRequest,
  type ToolDefinition,
} from "@/lib/agent/loop";

/**
 * max_tokens — set EXPLICITLY and generously (AI-SPEC overrides RESEARCH's
 * 8192). The synthesis turn is a long-form cited report condensing several
 * ~20k-char page observations, so 8192 is a floor, not a default. Paired with
 * the loop's stopReason clean-finish guard — never ship one without the other
 * (silent truncation is Critical Failure Mode #3).
 */
export const MAX_TOKENS = 16_384;

/**
 * Tool translation hoisted to MODULE SCOPE (AI-SPEC New Risk #2, sub-note).
 * `tools` occupy cache-prefix position 0, so ANY variation invalidates all
 * three cache tiers on every turn and cache-read stays 0 forever. A
 * per-request .map() over a frozen const is deterministic, but only
 * incidentally byte-stable; hoisting makes the property structural. Never
 * append a tool conditionally.
 */
export function translateTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    // Same JSON Schema object the OpenAI path passes as `parameters` — the
    // shape is identical, only the key and the wrapper differ.
    input_schema: t.function.parameters as Anthropic.Tool["input_schema"],
  }));
}
const ANTHROPIC_TOOLS: Anthropic.Tool[] = translateTools(TOOL_DEFINITIONS);

/** Identity fast-path: the loop always passes TOOL_DEFINITIONS, so reuse one array. */
export function anthropicToolsFor(
  tools?: ToolDefinition[],
): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools === TOOL_DEFINITIONS ? ANTHROPIC_TOOLS : translateTools(tools);
}

// ---- Structural client types so the test seam can inject a fake SDK client. ----
interface StreamEventLike {
  type: string;
  delta?: { type?: string; text?: string };
}
interface FinalMessageLike {
  content: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string | null;
  usage?: unknown;
}
interface MessageStreamLike extends AsyncIterable<StreamEventLike> {
  finalMessage(): Promise<FinalMessageLike>;
  abort(): void;
}
interface AnthropicClientLike {
  messages: { stream(req: Record<string, unknown>): MessageStreamLike };
}

export function createAnthropicModel(opts: {
  apiKey: string;
  baseURL: string; // "https://api.anthropic.com" — the SDK appends /v1/messages
  modelId: string; // claude-opus-4-8 | claude-sonnet-4-6 | claude-haiku-4-5
  /** Test seam: inject a fake SDK client (tests/anthropic-model.test.ts). */
  _clientFactory?: (apiKey: string, baseURL: string) => unknown;
}): Model {
  return {
    async *run(
      messages: ChatMessage[],
      tools?: ToolDefinition[],
    ): AsyncIterable<ModelChunk> {
      let client: AnthropicClientLike;
      if (opts._clientFactory) {
        client = opts._clientFactory(opts.apiKey, opts.baseURL) as AnthropicClientLike;
      } else {
        const AnthropicSDK = (await import("@anthropic-ai/sdk")).default;
        client = new AnthropicSDK({
          apiKey: opts.apiKey,
          baseURL: opts.baseURL,
        }) as unknown as AnthropicClientLike;
      }

      // (1) SYSTEM IS A TOP-LEVEL PARAM, never messages[0]. A role:"system"
      //     entry inside `messages` is rejected by the Messages API. Passed as
      //     an ARRAY of blocks so cache_control can attach (D-49 breakpoint 1).
      //     Because the render order is tools -> system -> messages, this ONE
      //     breakpoint caches the tool definitions AND the system prompt
      //     together.
      //
      //     WR-05: the empty-text-block invariant runs in BOTH directions. An
      //     empty text block is a 400 and is documented un-cacheable (E1b /
      //     D-59), so such blocks are filtered out of `messages` at (2) AND are
      //     never CONSTRUCTED here. When there is no system text the `system`
      //     parameter is omitted from the request entirely (see the conditional
      //     spread at (4)) — never sent as a block with empty text, and never as
      //     a present-but-undefined key. Consequence: cache breakpoint 1 is
      //     absent in that case, by design, because there is nothing there worth
      //     caching. Breakpoint 2 is unaffected.
      //
      //     The .trim() is INERT on the live path and must stay inert:
      //     DEEP_RESEARCH_SYSTEM has no leading or trailing whitespace and
      //     tests/prompt.test.ts pins its sha256, so the cached bytes for the
      //     real prompt are unchanged (D-49 byte stability).
      const systemText = messages.find((m) => m.role === "system")?.content?.trim() ?? "";
      const system: Anthropic.TextBlockParam[] | undefined =
        systemText.length > 0
          ? [
              {
                type: "text",
                text: systemText,
                cache_control: { type: "ephemeral" }, // default 5m TTL — do NOT use "1h"
              },
            ]
          : undefined;

      // (2) Drop the system entry AND any empty/whitespace-only message.
      //     Empty text blocks are a 400 (E1b / D-59) and are documented as
      //     un-cacheable. Belt-and-braces to the route-level history filter —
      //     and it MUST run before the breakpoint-2 index is computed, or
      //     breakpoint 2 lands on a message that was dropped.
      const convo = messages.filter(
        (m) => m.role !== "system" && m.content.trim().length > 0,
      );

      // (3) D-49 breakpoint 2: last content block of the LAST replayed message.
      //     Positional by convention — ChatMessage is {role, content} and
      //     cannot express a block-level cache_control (New Risk #2). The
      //     POSITION is pinned in tests/anthropic-model.test.ts against history
      //     that has been through the real D-57/D-59 filter.
      const apiMessages: Anthropic.MessageParam[] = convo.map((m, i) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: [
          {
            type: "text" as const,
            text: m.content,
            ...(i === convo.length - 1
              ? { cache_control: { type: "ephemeral" as const } }
              : {}),
          },
        ],
      }));

      // (4) NO temperature / top_p / top_k and NO `thinking`: all 400 on
      //     claude-opus-4-8 (still accepted on claude-haiku-4-5). Omitting
      //     `thinking` leaves it off on all three registry models — thinking
      //     tokens have no NormalizedUsage column and thinking blocks would
      //     have to be echoed back verbatim next turn, which the flat
      //     ChatMessage seam cannot carry.
      const anthropicTools = anthropicToolsFor(tools);
      const stream = client.messages.stream({
        model: opts.modelId,
        max_tokens: MAX_TOKENS,
        // Conditional spread, NOT `system` — the key must be ABSENT, not present
        // with an undefined value, when there is no system text (WR-05).
        ...(system ? { system } : {}),
        messages: apiMessages,
        ...(anthropicTools ? { tools: anthropicTools } : {}),
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          yield { delta: event.delta.text ?? "" };
        }
        // input_json_delta fragments are deliberately NOT accumulated here:
        // finalMessage() returns tool_use.input already parsed as an object.
        // (Never `break` out of this loop without calling stream.abort().)
      }

      // (5) THE LOAD-BEARING CALL (Correction C4). Usage is split across
      //     events: message_start.message.usage carries input_tokens + BOTH
      //     cache fields with a placeholder output_tokens, while
      //     message_delta.usage is cumulative but VARIABLY SHAPED (sometimes
      //     all four fields, sometimes only {output_tokens}). Reading either
      //     alone zeroes a column — the silent failure RSCH-05 exists to
      //     prevent. finalMessage() merges both AND hands back parsed tool
      //     inputs.
      const msg = await stream.finalMessage();

      const toolCalls: ToolCallRequest[] = msg.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: b.id ?? "", // toolu_…
          name: b.name ?? "",
          arguments: JSON.stringify(b.input ?? {}), // loop.ts re-parses + zod-validates
        }));

      if (toolCalls.length > 0) yield { toolCalls };
      // stopReason travels with usage on the final chunk (truncation guard).
      yield { usage: fromAnthropic(msg.usage), stopReason: msg.stop_reason ?? undefined };
    },
  };
}
