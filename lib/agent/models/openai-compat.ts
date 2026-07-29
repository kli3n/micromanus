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
 */
import type OpenAINS from "openai";
import { fromOpenAI } from "@/lib/agent/adapter";
import type {
  ChatMessage,
  Model,
  ModelChunk,
  ToolCallRequest,
  ToolDefinition,
} from "@/lib/agent/loop";

export function createOpenAiCompatModel(opts: {
  apiKey: string;
  baseURL: string;
  modelId: string;
}): Model {
  return {
    async *run(
      messages: ChatMessage[],
      tools?: ToolDefinition[],
    ): AsyncIterable<ModelChunk> {
      const OpenAI = (await import("openai")).default;
      const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
      const stream = await client.chat.completions.create({
        model: opts.modelId,
        messages: messages as OpenAINS.Chat.Completions.ChatCompletionMessageParam[],
        tools: tools as OpenAINS.Chat.Completions.ChatCompletionTool[] | undefined,
        stream: true,
        stream_options: { include_usage: true },
      });
      // OpenAI streams tool_calls as indexed argument fragments — reassemble.
      const acc = new Map<number, { id: string; name: string; args: string }>();
      let finishReason: string | undefined;
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
        if (part.usage) yield { usage: fromOpenAI(part.usage), stopReason: finishReason };
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
    },
  };
}
