-- ============================================================================
-- 0004_coupon_per_user_per_coupon.sql — coupons are one-per-(user, coupon) (approved)
--
-- WHY: 0001/FR-9a shipped `credits_ledger_coupon_once = UNIQUE (user_id) WHERE
-- reason='coupon'`, which under the MVP's SINGLE-coupon assumption (only
-- SID_DRDROID) correctly meant "each account redeems the coupon once" (FR-5).
-- With a SECOND coupon that same index over-restricts to "one coupon EVER per
-- account", locking out anyone who already redeemed SID_DRDROID. This
-- user-approved change redefines the invariant to one redemption per
-- (user, coupon): an account may redeem each DISTINCT coupon once; replaying the
-- SAME coupon is still schema-impossible. Supersedes FR-9a's (user_id)-only index.
--
-- ref_id IS the coupon code on coupon-reason rows (redeem_coupon inserts
-- ref_id = p_code), so (user_id, ref_id) uniqueness = one redemption per
-- (user, coupon). The redeem_coupon RPC is unchanged: a same-coupon replay still
-- raises unique_violation (23505) → mapped to 'already_redeemed'; a different
-- coupon no longer conflicts and stacks in the append-only ledger.
--
-- SCOPE: only the coupon uniqueness index changes, plus one seed row. Every other
-- money invariant (append-only ledger, debit_credit/start_run/refund_run,
-- credits_ledger_purchase_once, RLS, profiles.coupon_redeemed) is untouched.
-- ============================================================================

-- 1. Redefine the coupon single-use invariant: per-user  ->  per-(user, coupon).
drop index if exists public.credits_ledger_coupon_once;
create unique index credits_ledger_coupon_once on public.credits_ledger (user_id, ref_id) where reason = 'coupon';

-- 2. Seed the dev/test coupon (idempotent). Now redeemable even by accounts that
--    already redeemed SID_DRDROID, because coupons are per-(user, coupon).
insert into public.coupons (code, credits) values ('DEV_TEST_100', 100)
  on conflict (code) do nothing;
