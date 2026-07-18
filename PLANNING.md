# MicroManus — Build Plan

MicroManus is a deep-research AI agent with usage-based billing: sign up with GitHub or Google, unlock 5 credits with a coupon or a $5 test payment, connect your own LLM API key, and ask research questions. The agent searches the web in a think → act → observe loop, cites its sources, and can deliver a downloadable PDF report. A stats page shows exactly what every chat cost, broken down by input, output, and cache tokens.

Built for the Dr. Droid Product Engineer assignment. Every milestone below ends with a live, working deployment.

## Milestones

### 1 — Skeleton
A live site you can sign into with GitHub or Google. Behind the scenes, the database foundation (accounts, credits, chats, usage tracking) is in place with security rules, and the PDF rendering engine is proven to work in production.

**Done when:** a stranger can open the URL, sign in, and reach the app.

### 2 — MVP Core Loop
The full product on the coupon path: hit the paywall, redeem the coupon for 5 credits, add your API key (with a "test key" check), pick a model, and chat with an agent that searches the web and streams its answer live. Closing the tab doesn't kill a running task. A stats page breaks down what each chat cost.

**Done when:** a friend completes the whole flow without any help.

### 3 — Deep Research
The agent grows up: it breaks big questions into sub-questions, searches multiple angles, reads 3–6 sources, answers with numbered citations, and produces a polished PDF report you can download. Prompt caching is active and its savings show up on the stats page.

**Done when:** "Create a report on the California forest fires" yields a cited, downloadable PDF.

### 4 — Payments
The credit card path goes live (test mode): pay $5 through Stripe Checkout and receive 5 credits — reliably, exactly once, even if Stripe retries behind the scenes. Coupon and card credits stack.

**Done when:** the test card grants credits and nothing double-charges or double-credits.

## Stack

Next.js · Supabase (auth, database, realtime, storage) · Vercel · Stripe (test mode) · Brave Search — bring-your-own-key for Anthropic, OpenAI, and Kimi models.

---
*Milestone status and details are tracked internally; this document is the high-level map.*
