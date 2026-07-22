# MicroManus

A deep-research AI agent with bring-your-own-key (BYOK) model access and metered prompt caching. Sign in, connect your own LLM API key, and ask research questions — the agent searches the web in a think → act → observe loop and can produce a cited PDF report. Every model call is metered and shown on a per-chat cost breakdown.

## Status: MVP in progress

Only the skeleton is built and deployed so far:

- GitHub / Google sign-in (Supabase Auth)
- Session guard on every route except the landing page, plus sign-out
- Database schema with RLS and money invariants (credits ledger, atomic debit RPC, coupon/purchase unique indexes)
- A working PDF-rendering route (`/api/render-pdf`) via Chromium

**Under development:** paywall/credits UI, BYOK key management, model registry, chat + agent loop, deep-research behavior, prompt caching, stats page, Stripe payments.

## Stack

Next.js (App Router) · Supabase (auth, Postgres, RLS, storage, realtime) · Vercel · Tailwind CSS · Puppeteer + `@sparticuz/chromium` for PDF rendering. BYOK support planned for Anthropic, OpenAI, and Kimi.

## Running locally

```bash
npm install
npm run dev
```

Requires a `.env.local` with Supabase project credentials (URL, anon key, service-role key) and an encryption key for stored API keys — see `docs/CONFIGURATION.md`

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
