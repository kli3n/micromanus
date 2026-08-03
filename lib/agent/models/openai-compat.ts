/**
 * lib/agent/models/openai-compat.ts — the openai-compat Model wrapper.
 *
 * Extracted verbatim from app/api/agent/run/route.ts (Phase-2 wrapper) so the
 * two provider wrappers live as diffable siblings of the same Model interface.
 * The create() call lives INSIDE the async generator so every provider error
 * surfaces inside the loop's guarded catch (centralizing the refund /
 * first-model-call logic), and the SDK is dynamic-imported so this module
 * imports cleanly under Vitest.
 *
 * Phase-3 addition (AI-SPEC New Risk #1): `choice.finish_reason` is now read
 * from the stream and yielded as `stopReason` alongside the usage chunk, so
 * the loop's clean-finish guard can detect `length` / `content_filter`
 * truncation instead of presenting a cut-off answer as a finished one.
 *
 * WR-03 (gap closure): the finish reason and the usage chunk are DECOUPLED.
 * Attaching stopReason only to the usage chunk left the clean-finish guard dead
 * on this project's own demo default — the free OpenRouter models do not honour
 * `stream_options.include_usage`, so no usage chunk ever arrives, no stop reason
 * is delivered, `lib/agent/loop.ts` sees `stopReason === undefined` (which it
 * treats as clean, by design, for lenient providers), and a
 * `finish_reason: "length"` truncation is presented as a finished answer. That
 * is Critical Failure Mode #3 silently disabled on exactly the path a reviewer
 * will use. The end-of-stream yield below closes it.
 */
import type OpenAINS from "openai";
import { fromOpenAI } from "@/lib/agent/adapter";
import type { Provider } from "@/lib/registry";
import type {
  ChatMessage,
  Model,
  ModelChunk,
  ToolCallRequest,
  ToolDefinition,
} from "@/lib/agent/loop";

/**
 * The CEILING on the completion cap for the openai-compat path (WR-03, second
 * half). It is a ceiling, not the cap itself — see `completionCapFor` below.
 *
 * This value is DELIBERATELY EQUAL to `MAX_TOKENS` in
 * `lib/agent/models/anthropic.ts`, and `tests/openai-compat-model.test.ts`
 * asserts strict equality against that import so the two wrappers cannot drift
 * apart. It is intentionally NOT imported from the anthropic module: that module
 * builds the Anthropic tool array at module scope, and the openai path has no
 * business loading it. The test is the anti-drift mechanism, not the import.
 *
 * Sized per AI-SPEC (overriding RESEARCH's 8192): the synthesis turn is a
 * long-form cited report condensing several ~20k-char page observations, so 8192
 * is a floor, not a default.
 */
export const MAX_COMPLETION_TOKENS = 16_384;

/**
 * The completion cap is DERIVED from the registry's recorded context window, and
 * is omitted entirely when that window is unknown (GW-04).
 *
 * WHY THIS IS NOT A FLAT RESERVATION ANY MORE. WR-03 made this path always send
 * `max_tokens: 16_384` where it had previously sent nothing. But the loop
 * deliberately accumulates page extracts capped at 20,000 characters EACH and
 * feeds them all back every turn, so by iteration 3-4 the prompt is tens of
 * thousands of tokens; reserving 16,384 on top of that is the classic
 * `prompt + max_tokens > context` rejection. That rejection lands AFTER the
 * first model call has already billed the run, and it surfaces through the 400
 * branch of `mapProviderError` as advice to start a new chat — misleading
 * advice, for a limit the APP chose rather than one the conversation reached.
 * A reservation nothing can prove fits is worse than no reservation at all.
 *
 * THE DERIVATION: at most a quarter of the recorded window, clamped to
 * `MAX_COMPLETION_TOKENS`. A quarter is deliberately conservative — it leaves
 * three quarters for the prompt, so the app's own reservation can never be the
 * reason a request is rejected. A window that is unknown, zero or negative is
 * treated as unknown and sends NO cap key, which restores the provider's own
 * default: exactly the pre-WR-03 behaviour on those ids.
 *
 * BLAST RADIUS — larger than "the demo path", and a reader who assumes otherwise
 * will mis-review this. As of this commit TEN of `lib/registry.ts`'s sixteen
 * entries record `contextTokens: null` and therefore lose the reservation: the
 * six free OpenRouter ids AND, less obviously, the four PAID OpenAI ids
 * (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4-mini`). That is
 * intended. The reservation was never verified to fit on the paid ids either, so
 * restoring the provider default is the correct behaviour there for precisely
 * the same reason it is on the free path. What still caps: the three Kimi ids,
 * whose recorded windows (1M, 256K, 256K) all yield a quarter above
 * `MAX_COMPLETION_TOKENS` and therefore clamp to 16,384 exactly as today. What
 * never reaches this code: the three Anthropic ids, which route through
 * `lib/agent/models/anthropic.ts`. Recording a real `contextTokens` value for an
 * OpenAI id later is all it takes to restore its cap — no code change — which is
 * why the number lives in the registry and not in this module.
 *
 * THE CAP'S PARAMETER NAME is provider-dependent and is still NOT guessed here.
 * OpenAI moved chat-completions to `max_completion_tokens`, and its
 * reasoning-capable models reject the older `max_tokens` spelling outright.
 * OpenRouter, Kimi and custom base URLs accept `max_tokens`. No OpenAI API key
 * exists in this project to verify either spelling live — that is already an
 * open entry in `.planning/STATE.md` § Blockers ("Verify GPT-5.6 family serves
 * on /v1/chat/completions"). Branching on the registry's provider string is the
 * honest handling; committing to a single guessed spelling would risk a 400 on
 * an untestable path.
 */
function completionCapFor(
  provider: Provider | undefined,
  contextTokens: number | null | undefined,
): Record<string, number> {
  if (typeof contextTokens !== "number" || !(contextTokens > 0)) return {};
  const cap = Math.min(MAX_COMPLETION_TOKENS, Math.floor(contextTokens / 4));
  return provider === "openai"
    ? { max_completion_tokens: cap }
    : { max_tokens: cap };
}

interface StreamPartLike {
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
  usage?: unknown;
}
interface OpenAiClientLike {
  chat: {
    completions: {
      create(req: Record<string, unknown>): Promise<AsyncIterable<StreamPartLike>>;
    };
  };
}

export function createOpenAiCompatModel(opts: {
  apiKey: string;
  baseURL: string;
  modelId: string;
  /** Selects the completion-cap parameter name — see completionCapFor above. */
  provider?: Provider;
  /**
   * The registry spec's context window, threaded from the route. `null` (ten of
   * sixteen registry entries) means unknown, and unknown means NO cap is sent —
   * see completionCapFor above.
   */
  contextTokens?: number | null;
  /** Test seam: inject a fake SDK client (tests/openai-compat-model.test.ts). */
  _clientFactory?: (apiKey: string, baseURL: string) => unknown;
}): Model {
  return {
    async *run(
      messages: ChatMessage[],
      tools?: ToolDefinition[],
    ): AsyncIterable<ModelChunk> {
      let client: OpenAiClientLike;
      if (opts._clientFactory) {
        client = opts._clientFactory(opts.apiKey, opts.baseURL) as OpenAiClientLike;
      } else {
        const OpenAI = (await import("openai")).default;
        client = new OpenAI({
          apiKey: opts.apiKey,
          baseURL: opts.baseURL,
        }) as unknown as OpenAiClientLike;
      }
      const stream = await client.chat.completions.create({
        model: opts.modelId,
        messages: messages as OpenAINS.Chat.Completions.ChatCompletionMessageParam[],
        tools: tools as OpenAINS.Chat.Completions.ChatCompletionTool[] | undefined,
        stream: true,
        stream_options: { include_usage: true },
        ...completionCapFor(opts.provider, opts.contextTokens),
      });
      // OpenAI streams tool_calls as indexed argument fragments — reassemble.
      const acc = new Map<number, { id: string; name: string; args: string }>();
      let finishReason: string | undefined;
      let sawUsage = false;
      for await (const part of stream) {
        const choice = part.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta?.content;
        if (delta) yield { delta };
        const tcs = choice?.delta?.tool_calls;
        if (tcs) {
          for (const tc of tcs) {
            const idx = tc.index ?? 0;
            const cur = acc.get(idx) ?? { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            acc.set(idx, cur);
          }
        }
        if (part.usage) {
          sawUsage = true;
          yield { usage: fromOpenAI(part.usage), stopReason: finishReason };
        }
      }
      if (acc.size > 0) {
        const toolCalls: ToolCallRequest[] = [...acc.values()]
          .filter((t) => t.name.length > 0)
          .map((t) => ({
            id: t.id || `call_${Math.random().toString(36).slice(2)}`,
            name: t.name,
            arguments: t.args,
          }));
        if (toolCalls.length > 0) yield { toolCalls };
      }
      // WR-03: providers that omit usage still get their finish reason to the
      // loop. Emitted AFTER the tool-call flush so neither signal swallows the
      // other, and only when no usage chunk carried it already (the loop keeps
      // the LAST stopReason it sees, so a duplicate would be harmless but
      // misleading). An absent finish reason stays absent — `undefined` is the
      // documented lenient-provider case the loop treats as clean.
      if (!sawUsage && finishReason) yield { stopReason: finishReason };
    },
  };
}
