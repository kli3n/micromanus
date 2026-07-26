/**
 * scripts/coupon.test.ts — coupon per-(user, coupon) single-use invariant (PAY-02 / PAY-03).
 *
 * Proves against the LIVE migrated Supabase project (migration 0004) that
 * coupons are one redemption per (user, coupon): DISTINCT coupons stack, the
 * SAME coupon replayed by one account is still blocked. Specifically,
 * public.redeem_coupon:
 *   1. A fresh user redeeming 'SID_DRDROID' gets 5 credits (SUM(delta) 0 → 5);
 *      replaying SID_DRDROID errors 'already_redeemed'; the SAME user then
 *      stacks 'DEV_TEST_100' (+100 → 105) because it is a DISTINCT coupon
 *      (0004 redefined credits_ledger_coupon_once to (user_id, ref_id)); and
 *      replaying DEV_TEST_100 errors 'already_redeemed' (23505), balance stays 105.
 *   2. A different fresh user redeeming an unknown code errors 'invalid_code'.
 *
 * redeem_coupon derives identity from auth.uid() and is granted to authenticated,
 * so it is invoked through the USER (signed-in) client. Balances are asserted via
 * the service-role admin client. Users are cleaned up in finally.
 *
 * Run: `node --env-file-if-exists=.env.local scripts/coupon.test.ts`.
 * Requires env: SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL, SUPABASE_ANON_KEY/
 * NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function requireEnv(...names: string[]): string {
  for (const n of names) {
    const raw = process.env[n];
    if (raw == null) continue;
    const v = raw.trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    if (v.length > 0) return v;
  }
  throw new Error(
    `Missing required env var (one of: ${names.join(', ')}). ` +
      `Set it from the provisioned Supabase project before running.`,
  );
}

const SUPABASE_URL = requireEnv('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
const ANON_KEY = requireEnv('SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
const SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } } as const;

function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, noPersist);
}

async function makeUser(
  admin: SupabaseClient,
  tag: string,
): Promise<{ id: string; email: string; password: string }> {
  const email = `coupon-probe-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const password = `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`createUser(${tag}) failed: ${error?.message ?? 'no user returned'}`);
  }
  return { id: data.user.id, email, password };
}

async function userClient(email: string, password: string): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, ANON_KEY, noPersist);
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signInWithPassword failed: ${error.message}`);
  return client;
}

async function balanceOf(admin: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await admin
    .from('credits_ledger')
    .select('delta')
    .eq('user_id', userId);
  if (error) throw new Error(`balanceOf failed: ${error.message}`);
  return (data ?? []).reduce((sum: number, row: { delta: number }) => sum + row.delta, 0);
}

const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  PASS: ${msg}`);
  } else {
    failures.push(msg);
    console.error(`  FAIL: ${msg}`);
  }
}

const includes = (msg: string | undefined, needle: string): boolean =>
  (msg ?? '').toLowerCase().includes(needle);

async function main(): Promise<void> {
  const admin = adminClient();
  let uRedeem: { id: string; email: string; password: string } | null = null;
  let uBad: { id: string; email: string; password: string } | null = null;

  try {
    // ---- Scenario 1: valid redeem grants 5 once; replay rejected ----
    uRedeem = await makeUser(admin, 'redeem');
    const before = await balanceOf(admin, uRedeem.id);
    assert(before === 0, `fresh user starts at balance 0 (got ${before})`);

    const rClient = await userClient(uRedeem.email, uRedeem.password);
    const first = await rClient.rpc('redeem_coupon', { p_code: 'SID_DRDROID' });
    console.log('redeem SID_DRDROID (first time):');
    assert(first.error === null, `first redeem succeeded (err: ${first.error?.message ?? 'none'})`);
    assert(first.data === 5, `first redeem returned 5 credits (got ${JSON.stringify(first.data)})`);
    const afterFirst = await balanceOf(admin, uRedeem.id);
    assert(afterFirst === 5, `SUM(delta) moved 0 -> 5 (got ${afterFirst})`);

    const second = await rClient.rpc('redeem_coupon', { p_code: 'SID_DRDROID' });
    console.log('redeem SID_DRDROID (replay):');
    assert(second.error !== null, 'replay redeem returned an error (did not succeed)');
    assert(
      includes(second.error?.message, 'already_redeemed'),
      `replay error is already_redeemed (got: ${second.error?.message ?? 'none'})`,
    );
    const afterReplay = await balanceOf(admin, uRedeem.id);
    assert(afterReplay === 5, `balance unchanged at 5 after blocked replay (got ${afterReplay})`);

    // ---- Scenario 1b: a DISTINCT coupon stacks for the SAME user (per-(user, coupon)) ----
    const stack = await rClient.rpc('redeem_coupon', { p_code: 'DEV_TEST_100' });
    console.log('redeem DEV_TEST_100 (distinct coupon, same user):');
    assert(stack.error === null, `distinct-coupon redeem succeeded (err: ${stack.error?.message ?? 'none'})`);
    assert(stack.data === 100, `distinct-coupon redeem returned 100 credits (got ${JSON.stringify(stack.data)})`);
    const afterStack = await balanceOf(admin, uRedeem.id);
    assert(afterStack === 105, `distinct coupons stack: SUM(delta) 5 -> 105 (got ${afterStack})`);

    // ---- Scenario 1c: replaying the SAME distinct coupon is still blocked ----
    const stackReplay = await rClient.rpc('redeem_coupon', { p_code: 'DEV_TEST_100' });
    console.log('redeem DEV_TEST_100 (replay):');
    assert(stackReplay.error !== null, 'DEV_TEST_100 replay returned an error (did not succeed)');
    assert(
      includes(stackReplay.error?.message, 'already_redeemed'),
      `DEV_TEST_100 replay error is already_redeemed (got: ${stackReplay.error?.message ?? 'none'})`,
    );
    const afterStackReplay = await balanceOf(admin, uRedeem.id);
    assert(afterStackReplay === 105, `balance unchanged at 105 after blocked DEV_TEST_100 replay (got ${afterStackReplay})`);

    // ---- Scenario 2: unknown code rejected with invalid_code ----
    uBad = await makeUser(admin, 'badcode');
    const bClient = await userClient(uBad.email, uBad.password);
    const bad = await bClient.rpc('redeem_coupon', { p_code: 'NOPE' });
    console.log('redeem NOPE (unknown code):');
    assert(bad.error !== null, 'unknown-code redeem returned an error (did not succeed)');
    assert(
      includes(bad.error?.message, 'invalid_code'),
      `error is invalid_code (got: ${bad.error?.message ?? 'none'})`,
    );
    const badBalance = await balanceOf(admin, uBad.id);
    assert(badBalance === 0, `unknown-code user still at 0 (got ${badBalance})`);
  } finally {
    for (const u of [uRedeem, uBad]) {
      if (u) {
        const { error } = await admin.auth.admin.deleteUser(u.id);
        if (error) console.error(`cleanup: deleteUser(${u.id}) failed: ${error.message}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error(`\nCOUPON REGRESSION FAILED (${failures.length} assertion(s)):`);
    for (const f of failures) console.error(` - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nCOUPON REGRESSION PASSED: grant + replay blocked, distinct coupons stack (SID_DRDROID+DEV_TEST_100 → 105), same-coupon replay blocked, invalid code rejected.');
}

main().catch((err: unknown) => {
  console.error('COUPON REGRESSION ERROR:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
