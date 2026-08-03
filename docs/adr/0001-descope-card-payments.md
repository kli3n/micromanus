# Card payments (Stripe) descoped — coupon-only paywall

---
status: accepted (2026-08-03)
---

The Dr. Droid assignment names two paywall bypasses — the coupon `SID_DRDROID` or a real $5 test-mode card payment — and its "great outcome" rubric tier is exactly the functional card flow. We decided to ship coupon-only and permanently delete the payments phase (Stripe Checkout + idempotent webhook grant, formerly Phase 4 / PAY-07/08/09), accepting a "good outcome" submission cap in exchange for spending the remaining time on verification and reliability of the research loop — a submission that breaks anywhere disqualifies, while the card flow only upgrades the tier.

## Consequences

- The paywall's disabled "Pay with card / Soon" tile is removed (supersedes design decision D-17); the paywall offers the coupon path only.
- The credits ledger keeps its `ref_id` idempotency unique index even though no purchase rows will ever exist — it also backs coupon idempotency, and money-invariant migrations are never rewritten (project rule).
- UI Refinement (formerly Phase 5) renumbers to Phase 4 and depends directly on Phase 3.
- If this is ever revisited, the expensive groundwork already exists: append-only ledger, `ref_id` unique index, and RLS shipped in Phase 1 migrations; only the Checkout-session route, the webhook route, and paywall wiring were cut.
