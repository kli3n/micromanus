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
 * The explicit completion cap for the openai-compat path (WR-03, second half).
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
 * is a floor, not a default. Previously this path sent NO cap at all, which made
 * it both more likely to truncate than the Anthropic path and — pre-WR-03 — less
 * likely to notice.
 */
export const MAX_COMPLETION_TOKENS = 16_384;

/**
 * The cap's parameter NAME is provider-dependent and is NOT guessed here.
 *
 * OpenAI moved chat-completions to `max_completion_tokens`, and its
 * reasoning-capable models reject the older `max_tokens` spelling outright.
 * OpenRouter, Kimi and custom base URLs accept `max_tokens`. No OpenAI API key
 * exists in this project to verify either spelling live — that is already an
 * open entry in `.planning/STATE.md` § Blockers ("Verify GPT-5.6 family serves
 * on /v1/chat/completions"). Branching on the registry's provider string is the
 * honest handling; committing to a single guessed spelling would risk a 400 on
 * an untestable path.
 */
function completionCapFor(provider?: Provider): Record<string, number> {
  return provider === "openai"
    ? { max_completion_tokens: MAX_COMPLETION_TOKENS }
    : { max_tokens: MAX_COMPLETION_TOKENS };
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
        ...completionCapFor(opts.provider),
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
