# PRD — MicroManus

**Product:** MicroManus — a deep-research AI agent with usage-based billing
**Author:** Mohanish
**Status:** v1.1 — design decisions ①–⑨ locked after grilling session (2026-07-18)
**Context:** Dr. Droid Product Engineer assignment (YC). Built without the 2–4 hour constraint; phased for learning depth and a working submission.

---

## 1. Overview

MicroManus is a web application where a user signs up with social login, passes a credit paywall (coupon or card payment), connects their own LLM API key, and chats with a research agent. The agent browses the internet in a think → act → observe loop, holds conversation context across turns, and can produce a PDF report as an artifact. Every model call is metered; a stats page shows per-chat cost broken down by input, output, and cache tokens.

**Primary success criterion:** a stranger receives the signup URL and completes the entire flow — signup, paywall, key setup, research chat, cost review — with zero explanation. A submission that fails anywhere disqualifies.

## 2. Goals and non-goals

**Goals**

- G1. End-to-end self-explanatory flow from signup to cost stats on a public URL.
- G2. A genuinely agentic research loop, not a single search-and-summarize call.
- G3. Accurate cost attribution per chat: input / output / cache-read / cache-write tokens, priced per selected model.
- G4. Bring-your-own-key against OpenAI-compatible endpoints; no pre-loaded keys.
- G5. (Phase 3, committed) Functional test-mode card payment — the "great outcome." Built on a branch after Phase 2 is deployable so a submittable URL always exists.

**Non-goals**

- No team/multi-user workspaces, no admin panel.
- No fine-grained per-token billing to the user's card; credits are the only billing unit.
- No file uploads into chat (out of assignment scope).
- No mobile-native app; responsive web only.

## 3. Users

Single persona: the reviewer (Siddarth or a delegate). Assume a technically fluent user who will deliberately probe edge cases — wrong coupon, refresh mid-payment, invalid API key, starting multiple chats, checking whether costs reconcile.

## 4. Scope and phasing

| Phase | Contents | Exit criterion |
|---|---|---|
| **0 — Skeleton** | Repo, Next.js app, Supabase project, GitHub + Google login, empty dashboard, deployed to Vercel | Live URL with working social login |
| **1 — MVP** | Coupon paywall + credits ledger, BYOK key management, model registry, threaded chat with streaming, minimal agent loop (Brave search tool), usage logging, cost/stats page | A friend completes the full flow unaided using the coupon |
| **2 — Deep research** | Multi-step planning, multi-query search, page fetching, inline citations, PDF report artifact, prompt caching enabled and metered | Agent produces a cited multi-source report as a downloadable PDF |
| **3 — Payments** | Stripe Checkout (test mode), webhook-driven credit grant, payment failure/refresh handling | Test card 4242… grants 5 credits reliably; webhook idempotent |

Each phase ends deployed and demoable. Submission is viable after Phase 2; Phase 3 upgrades it to the "great outcome."

## 5. Functional requirements

### 5.1 Authentication

- FR-1. Social login via GitHub and Google (Supabase Auth). No email/password.
- FR-2. All routes except the landing page require an authenticated session.
- FR-3. Sign-out available from every authenticated page.

### 5.2 Paywall and credits

- FR-4. Immediately after first login, the user lands on a paywall. No app functionality is reachable until credits > 0.
- FR-5. Coupon `SID_DRDROID` grants 5 credits. Validation is server-side; the coupon is single-use per user account.
- FR-6. (Phase 3) Stripe Checkout charges $5 in test mode; the webhook handler grants 5 credits on `checkout.session.completed`. Grant is idempotent (webhook retries must not double-credit).
- FR-7. Credits are stored as an append-only ledger (`credits_ledger`: +5 grant rows, −1 debit rows). Balance = SUM. Never a mutable balance column.
- FR-8. **Credit semantics: 1 credit = 1 agent run** (one user message that triggers the loop, regardless of iterations inside it). This definition is displayed on the paywall and next to the chat input.
- FR-9. Debit occurs when the run starts. At 0 credits the input is disabled with a clear message. If a run fails before the first model call completes, the credit is refunded. Client disconnect/refresh is NOT a failure — the run continues server-side (see FR-17a); the credit stays spent.
- FR-9a. Credits invariants are enforced in Postgres, not application code: debit via an atomic `debit_credit(user_id)` RPC (inserts −1 only if `SUM(delta) > 0`); coupon single-use via partial unique index `UNIQUE (user_id) WHERE reason = 'coupon'`; webhook idempotency via `UNIQUE (ref_id) WHERE reason = 'purchase'` (ref_id = Stripe checkout session ID). `profiles.coupon_redeemed` is display-only.

### 5.3 API key and model management (BYOK)

- FR-10. Settings page where the user adds: provider (Anthropic / OpenAI / Moonshot-Kimi / custom OpenAI-compatible), base URL (pre-filled per provider, editable), API key, and selects a model from the registry.
- FR-11. Keys are encrypted at rest with app-level AES-256-GCM (`node:crypto`; 32-byte secret in a Vercel env var; store nonce‖ciphertext‖tag). The database sees only ciphertext; decryption happens only inside the run handler. Keys are never sent to the browser after save; UI shows last 4 characters only (`key_last4` captured at save time).
- FR-12. A "Test key" button makes a 1-token call and reports success/failure before saving.
- FR-13. Model registry: 3–4 current models per provider (final list and prices verified against provider pricing pages at build time — do not trust memory). Each entry: model ID, display name, provider, adapter type, prices per 1M tokens for input / output / cache-read / cache-write (cache-write is explicitly 0 for non-Anthropic models — OpenAI/Kimi automatic caching has no write charge). First-class providers are Claude / OpenAI / Kimi only; the custom base-URL option is the universal BYOK escape hatch (covers DeepSeek etc.). Gemini is excluded: its context-length-tiered pricing breaks the flat per-model price schema.
- FR-14. Model selection is per-chat, chosen at chat creation, shown in the chat header. Cost is always computed against the model actually used.

### 5.4 Chat and threads

- FR-15. Users can create new chats, see a sidebar list of past chats (auto-titled from the first message), and reopen any chat with full history.
- FR-16. Within a chat, full conversation context is sent to the model on every turn.
- FR-17. Responses stream token-by-token (SSE). During tool execution, the UI shows a status line ("Searching: california forest fires 2026…") instead of dead air.
- FR-17a. Runs survive client disconnect: the loop continues server-side (Vercel `waitUntil`), and every assistant/tool message and usage event is persisted to Postgres per iteration — the DB is the source of truth; the SSE stream is only a live view. A reopened chat receives updates from a still-running agent via Supabase Realtime subscription (messages + run status by chat ID); SSE carries token deltas on the happy path only. Partial runs keep their real token spend on the stats page.
- FR-18. Markdown rendering in responses (headings, lists, tables, code, links).

### 5.5 Agent loop

- FR-19. The agent operates as: model call → if tool call requested, execute tool → append result → call model again → repeat, until the model returns a final text answer or the iteration cap (12) is hit.
- FR-20. Tools:
  - `web_search(query)` — Brave Search API, returns top results (title, URL, snippet).
  - `fetch_page(url)` — retrieves and extracts readable text from a URL, truncated to a token budget.
  - `create_pdf_report(title, markdown)` — renders markdown to PDF, uploads to Supabase Storage, returns a signed URL surfaced in chat as a downloadable artifact. Rendering is quarantined in a dedicated `/api/render-pdf` route (`puppeteer-core` + `@sparticuz/chromium`, lazy-imported, own `maxDuration`); a Chromium failure degrades gracefully — the tool returns the report as rendered markdown in-chat with a "PDF unavailable" note instead of failing the run. A hello-world PDF smoke test on Vercel is a Phase 0/1 exit item (retire the binary-in-serverless risk before Phase 2 depends on it).
- FR-21. (Phase 2) Deep-research behavior via system prompt: decompose the question into sub-questions, run multiple searches, fetch 3–6 sources, synthesize with inline citations `[1]`, and offer/produce a PDF report when the request implies a document deliverable.
- FR-22. (Phase 1 MVP behavior) Same loop, simpler system prompt: search when needed, answer with sources. The loop architecture is identical; only the prompt and iteration budget differ.
- FR-23. Prompt caching enabled where the provider supports it (Anthropic `cache_control` on the system prompt and conversation prefix; OpenAI/Kimi automatic prefix caching). Cache token counts captured from every response.

### 5.6 Usage and cost stats

- FR-24. Every model API call writes a `usage_events` row: chat ID, message ID, model, input tokens, output tokens, cache-read tokens, cache-write tokens, computed cost in USD, timestamp.
- FR-25. Stats page lists all chats with: title, model, message count, total cost, and a breakdown of cost by input / output / cache tokens. Plus an all-time total.
- FR-26. Drill-down per chat: per-run token and cost detail.
- FR-27. Costs are computed from the registry prices for the model on that specific call — never from the currently selected model.

## 6. Data model (Supabase / Postgres)

```
users            (managed by Supabase Auth)
profiles         user_id PK, display_name, coupon_redeemed bool
credits_ledger   id, user_id, delta int, reason enum(coupon|purchase|run_debit|refund), ref_id, created_at
user_api_keys    id, user_id, provider, base_url, encrypted_key, key_last4, created_at
chats            id, user_id, title, model_id, created_at
messages         id, chat_id, role enum(user|assistant|tool), content jsonb, created_at
usage_events     id, chat_id, message_id, model_id, input_tokens, output_tokens,
                 cache_read_tokens, cache_write_tokens, cost_usd numeric, created_at
```

Row Level Security on every table: `user_id = auth.uid()`.

## 7. Non-functional requirements

- NFR-1. Live public HTTPS URL (Vercel). No localhost, no repo-as-submission.
- NFR-2. Agent endpoint uses a streaming route handler on Vercel Fluid Compute with `maxDuration: 300`; the agent self-terminates at ~240s wall-clock with a graceful "ran out of budget" message (fires before the platform 504s), plus the hard iteration cap (12) and per-tool timeouts (page fetch ~10s). Timeout is designed behavior, not an accident. Railway/Fly is a documented escape hatch only if Phase 2 deep-research runs measurably exceed 5 minutes — not a plan.
- NFR-3. No LLM keys, Brave keys, or Stripe secrets in client code or the repo. All secrets in env vars; user keys encrypted at rest.
- NFR-4. Every failure state has a human-readable message: invalid coupon, invalid API key, provider 429/401, tool failure mid-loop, zero credits.
- NFR-5. Empty states designed: no chats yet, no key configured, no usage yet. The reviewer must never see a blank screen.

## 8. Key decisions and rationale

Decisions ①–⑨ finalized in the design-grilling session of 2026-07-18.

- **① Runtime — Vercel committed, timeout as designed behavior:** Fluid Compute `maxDuration: 300`; agent self-budget ~240s with graceful message. Eliminates the Railway hedge; one deploy, one platform. Escape hatch documented, not planned.
- **② Provider layer — normalized adapter seam from day one:** `adapter.run(messages, tools, model, credentials) → stream of {text-delta | tool-call | usage}` with normalized usage `{input, output, cacheRead, cacheWrite}`. Adapters are stateless and key-agnostic — credentials `{apiKey, baseURL}` injected per call. Phase 1 ships `openai-compat` only (OpenAI, Kimi, custom base URLs); `anthropic-native` drops in at Phase 2 because Anthropic's OpenAI-compat endpoint supports neither `cache_control` nor cache read/write usage fields — Claude caching would be silently absent and its cache column permanently zero. The seam is decided now so the loop never touches provider types; the second implementation lands when FR-23 is due.
- **③ Registry scope — 3 first-class providers + custom URL escape hatch:** Claude/OpenAI/Kimi with build-time-verified prices. DeepSeek reachable via custom base URL with zero registry debt; Gemini excluded (tiered pricing breaks flat price schema, third caching semantics, flakiest compat layer). Registry maps model → provider → adapter → prices.
- **④ Run lifecycle — run survives disconnect, DB is truth:** loop continues via `waitUntil`; per-iteration persistence of messages and usage events; stream is a view. The flagship 3-minute demo survives a tab close; partial runs show honest cost. Refund only for failure before the first completed model call.
- **⑤ Money correctness — invariants in Postgres, not app code:** atomic debit RPC + coupon partial unique index + Stripe `ref_id` unique index. Double-spend, coupon replay, and webhook double-credit become constraint violations (schema-impossible), not code paths that must be right. Less application code than check-then-insert. Coupon and card paths stack — the ledger naturally accumulates.
- **⑥ Ledger over balance column:** auditability, idempotent webhook handling, and the stats page falls out of the same table pattern.
- **⑦ Key encryption — app-level AES-256-GCM over Supabase Vault:** decryption key lives in Vercel env, a different system from the data; DB contents leak ≠ key leak. ~30 lines of boring `node:crypto`; Vault would let service-role DB access read plaintext.
- **⑧ Live view — Supabase Realtime for reconnect:** already-paid-for infra; handles refresh, multi-tab, second-tab-same-chat probes free. SSE keeps token-by-token deltas on the happy path; on reconnect the in-progress message appears complete when its iteration persists. Polling is the fallback with the same API shape.
- **⑨ PDF via headless Chromium, quarantined + fallback:** best typography-to-effort ratio (the PDF is the submission's "wow" artifact); isolated `/api/render-pdf` route so a Chromium failure degrades to markdown-in-chat instead of killing the run; smoke-tested on Vercel in Phase 0/1. Artifacts in Supabase Storage with signed URLs.
- **Debit-at-start with refund-on-early-failure:** prevents free runs via mid-stream disconnects while staying fair; disconnect ≠ failure (see ④).
- **Stack:** Next.js App Router + Supabase + Vercel. One repo, one deploy, native Supabase auth integration, deepest coding-agent training coverage.

## 9. Acceptance criteria (reviewer's path)

1. Open URL → sign up with Google → land on paywall. ✔
2. Enter wrong coupon → clear error. Enter `SID_DRDROID` → 5 credits shown. ✔
3. Add an API key, test it, pick a model. ✔
4. Ask: "Create a report explaining the recent forest fires in California, what's causing them and what can be done." → visible search/fetch steps → cited answer → PDF artifact downloads and opens. ✔
5. Start a second chat on a different model; ask a follow-up in chat 1 that requires earlier context → context held. ✔
6. Stats page: both chats listed, costs split by input/output/cache, numbers plausible against provider pricing. ✔
7. Spend credits to 0 → input disabled with explanation. ✔
8. (Phase 3) Pay $5 with test card 4242 4242 4242 4242 → 5 credits granted once, even if the webhook fires twice. ✔

## 10. Open questions

- OQ-1. Exact model list and pricing — verify current Claude / OpenAI / Kimi flagship + fast models and prices at build time.
- ~~OQ-2. Does the coupon and the card path stack?~~ **Resolved:** yes, credits accumulate — the ledger naturally stacks; a cap would be extra code for worse behavior.
- OQ-3. Brave Search free-tier rate limits vs deep-research query volume — measure in Phase 2; add per-run search cap if needed.
- OQ-4. Whether to show live "cost so far" inside the chat header (nice-to-have, Phase 2 stretch).

## 11. Out-of-band prerequisites

- Confirm the YC job listing is still open before investing hours (assignment's own condition).
- Accounts needed: Supabase, Vercel, Brave Search API, Stripe (test mode), GitHub OAuth app, Google Cloud OAuth consent screen.
- Recruit two friends for an unaided end-to-end test before submission.
