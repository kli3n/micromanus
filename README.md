# MicroManus

A deep-research AI agent with bring-your-own-key (BYOK) model access and per-call cost metering. Sign in, redeem a credit coupon, connect your own LLM API key, and ask research questions — the agent searches the web in a think → act → observe loop and streams its answer back. Every model call is metered from provider-reported usage and broken down per chat.

## Status

**Phase 1 (Skeleton) and Phase 2 (MVP Core Loop) are complete.** The full loop works end to end: sign in → paywall → key setup → streaming research chat → cost review. Phase 3 (Deep Research) is next.

### What works today

**Auth & access**

- GitHub / Google sign-in via Supabase Auth, session refresh in `proxy.ts`
- Every route outside the landing page redirects unauthenticated visitors; sign-out from anywhere

**Credits & paywall**

- Coupon redemption gates the app: `SID_DRDROID` grants 5 credits (`DEV_TEST_100` grants 100 for testing)
- Single-use is enforced per *(user, coupon)* by a Postgres unique index — distinct coupons stack, replaying the same coupon is rejected with a specific error
- Money invariants live in the database, not the app: append-only `credits_ledger`, `debit_credit` / `start_run` / `refund_run` RPCs, partial unique indexes (migrations `0001`–`0005`)
- 1 credit = 1 agent run; balance stays visible, and the input is disabled with a clear message at 0

**BYOK keys & model registry**

- Keys are AES-256-GCM encrypted server-side and only ever returned as `{provider, base_url, last4}` — ciphertext never leaves the server
- Base URL is pre-filled per provider and editable; a 1-token test probe must succeed before a key can be saved
- Priced model registry (`lib/registry.ts`) with input / output / cache-read / cache-write rates per 1M tokens. OpenAI, Kimi, OpenRouter (free models), and custom base URLs are selectable; providers without a saved key are greyed out
- Claude models are listed but **not** selectable yet — they need the native `cache_control` adapter (Phase 3); the OpenAI-compat shim silently drops cache usage, so it is deliberately not used for Anthropic
- OpenRouter free models have a saturation fallback: a 429 emits a `rate_limited` event and offers an inline model chooser with a 10s auto-switch countdown

**Chat & agent loop**

- Token-by-token SSE streaming with tool-status lines and markdown (GFM) rendering
- Chats are auto-titled by truncation (no LLM call), listed in a sidebar ordered by last activity, and reopen with full history
- Closing the tab or losing the network does not kill a run — `waitUntil` keeps the loop persisting, and the thread settles via Supabase Realtime plus a run-status poll on reconnect
- A run that fails before its first model call refunds its credit automatically; a disconnect is not a failure
- The agent loop (`lib/agent/loop.ts`) is bounded at 12 iterations and a 240s self-budget under Fluid Compute's 300s cap, so it degrades gracefully instead of hitting a platform timeout
- Tools: `web_search` (SerpAPI, throttled to ≥1 req/s) and `fetch_page` (SSRF-guarded, Readability + linkedom extraction). Tool failures become human-readable observations — they never throw out of the loop

**Cost stats**

- `/app/stats` is a zero-JS server component: per-chat cost broken down by input / output / cache-read / cache-write tokens, a per-run drill-down showing the prices used at event time, and an all-time total
- Costs come from provider-reported `usage` objects and prices stored on each usage event — never from client-side token estimates

**PDF**

- `/api/render-pdf` renders a PDF with Chromium on Vercel. This is still the de-risking smoke route (plus a test button in the shell), not yet the research-report artifact.

### Not built yet

- **Phase 3 — Deep Research:** sub-question decomposition, inline citations with a sources list, the PDF report artifact, prompt caching + cache-savings metering, and the Anthropic-native adapter
- **Phase 4 — Payments:** Stripe test-mode Checkout and the idempotent webhook credit grant (the ledger and `ref_id` idempotency index that make it safe already exist)
- **Phase 5:** a dedicated UI refinement pass

## Stack

Next.js 16 (App Router) · React 19 · Supabase (Auth, Postgres, RLS, Realtime) · Tailwind CSS v4 · Vercel (Fluid Compute) · `openai` SDK v6 for the OpenAI-compatible adapter · Zod 4 · react-markdown + remark-gfm · `@mozilla/readability` + linkedom for page extraction · `@vercel/functions` for `waitUntil` · puppeteer-core + `@sparticuz/chromium` for PDF rendering.

## Running locally

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env.local` and fill in:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (RLS-protected, safe in the browser) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only; used by the run handler for attributed writes |
| `API_KEY_ENC_KEY` | 32-byte AES-256-GCM key encrypting stored user API keys |
| `SERPAPI_API_KEY` | Backs the agent's `web_search` tool |

Only the two `NEXT_PUBLIC_*` vars are required to boot; the rest are server-only and must never carry a `NEXT_PUBLIC_` prefix.

Database schema lives in `supabase/migrations/` — apply it with `supabase db push`.

Other scripts:

```bash
npm run build        # production build
npm run lint          # lint
npm run typecheck     # type-check
npm test              # unit tests (vitest)
npm run test:rls      # RLS isolation probe (needs .env.local)
npm run test:money    # credit-debit concurrency probe (needs .env.local)
npm run test:guard    # auth guard probe (needs .env.local)
```

## License

Apache License 2.0 — see [LICENSE](LICENSE).
