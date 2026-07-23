/**
 * scripts/refund.test.ts — early-failure refund invariant (PAY-06).
 *
 * Proves against the LIVE migrated Supabase project (migration 0002) that
 * public.refund_run:
 *   (A) refunds +1 and marks the run 'failed' when first_model_call_completed
 *       is false (the very first model call never returned);
 *   (B) is idempotent — a second refund_run is a no-op (SUM unchanged, exactly
 *       one 'refund' ledger row, blocked by credits_ledger_refund_once);
 *   (C) is a NO-OP once first_model_call_completed is true (disconnect ≠ failure,
 *       RESEARCH Pitfall 3) — balance unchanged, no refund row.
 *
 * start_run / refund_run are service_role-only (OQ-4) and take an explicit
 * p_user_id, so they are invoked through the admin (service-role) client. Users
 * and chats are cleaned up in finally.
 *
 * Run: `node --env-file-if-exists=.env.local scripts/refund.test.ts`.
 * Requires env: SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
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
const SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } } as const;
const MODEL = 'gpt-5.6-luna';

function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, noPersist);
}

async function makeUser(
  admin: SupabaseClient,
  tag: string,
): Promise<{ id: string; email: string }> {
  const email = `refund-probe-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const password = `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`createUser(${tag}) failed: ${error?.message ?? 'no user returned'}`);
  }
  return { id: data.user.id, email };
}

async function balanceOf(admin: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await admin
    .from('credits_ledger')
    .select('delta')
    .eq('user_id', userId);
  if (error) throw new Error(`balanceOf failed: ${error.message}`);
  return (data ?? []).reduce((sum: number, row: { delta: number }) => sum + row.delta, 0);
}

async function refundRowCount(admin: SupabaseClient, refId: string): Promise<number> {
  const { data, error } = await admin
    .from('credits_ledger')
    .select('id')
    .eq('reason', 'refund')
    .eq('ref_id', refId);
  if (error) throw new Error(`refundRowCount failed: ${error.message}`);
  return (data ?? []).length;
}

async function runStatus(admin: SupabaseClient, runId: string): Promise<string> {
  const { data, error } = await admin
    .from('runs')
    .select('status')
    .eq('id', runId)
    .single();
  if (error) throw new Error(`runStatus failed: ${error.message}`);
  return (data as { status: string }).status;
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

async function startRun(admin: SupabaseClient, userId: string, chatId: string): Promise<string> {
  const { data, error } = await admin.rpc('start_run', {
    p_user_id: userId,
    p_chat_id: chatId,
    p_model_id: MODEL,
  });
  if (error) throw new Error(`start_run failed: ${error.message}`);
  return data as string;
}

async function main(): Promise<void> {
  const admin = adminClient();
  let user: { id: string; email: string } | null = null;
  let chatId: string | null = null;

  try {
    user = await makeUser(admin, 'lifecycle');

    // Seed a positive balance (+5) via the admin ledger insert.
    const seed = await admin
      .from('credits_ledger')
      .insert({ user_id: user.id, delta: 5, reason: 'coupon', ref_id: 'seed' });
    if (seed.error) throw new Error(`seed balance failed: ${seed.error.message}`);

    const chat = await admin
      .from('chats')
      .insert({ user_id: user.id, model_id: MODEL, title: 'refund-probe' })
      .select('id')
      .single();
    if (chat.error) throw new Error(`insert chat failed: ${chat.error.message}`);
    chatId = (chat.data as { id: string }).id;

    assert((await balanceOf(admin, user.id)) === 5, 'seeded balance is 5');

    // ---- (A) refund when first model call never completed ----
    const run1 = await startRun(admin, user.id, chatId);
    console.log('run1 opened (start_run debits -1):');
    assert((await balanceOf(admin, user.id)) === 4, 'start_run debited -1 (balance 5 -> 4)');

    const refA = await admin.rpc('refund_run', { p_user_id: user.id, p_run_id: run1 });
    console.log('refund_run(run1), first_model_call_completed=false:');
    assert(refA.error === null, `refund succeeded (err: ${refA.error?.message ?? 'none'})`);
    assert((await balanceOf(admin, user.id)) === 5, 'refund restored +1 (balance 4 -> 5)');
    assert((await runStatus(admin, run1)) === 'failed', "run1 status set to 'failed'");
    assert((await refundRowCount(admin, run1)) === 1, 'exactly one refund ledger row for run1');

    // ---- (B) second refund is an idempotent no-op ----
    const refB = await admin.rpc('refund_run', { p_user_id: user.id, p_run_id: run1 });
    console.log('refund_run(run1) again (idempotent):');
    assert(refB.error === null, `second refund did not error (err: ${refB.error?.message ?? 'none'})`);
    assert((await balanceOf(admin, user.id)) === 5, 'balance unchanged at 5 after double-refund');
    assert((await refundRowCount(admin, run1)) === 1, 'still exactly one refund ledger row (double-refund blocked)');

    // ---- (C) no refund once the first model call completed ----
    const run2 = await startRun(admin, user.id, chatId);
    console.log('run2 opened (start_run debits -1):');
    assert((await balanceOf(admin, user.id)) === 4, 'start_run debited -1 (balance 5 -> 4)');

    const flip = await admin
      .from('runs')
      .update({ first_model_call_completed: true })
      .eq('id', run2);
    if (flip.error) throw new Error(`set first_model_call_completed failed: ${flip.error.message}`);

    const refC = await admin.rpc('refund_run', { p_user_id: user.id, p_run_id: run2 });
    console.log('refund_run(run2), first_model_call_completed=true:');
    assert(refC.error === null, `refund_run did not error (err: ${refC.error?.message ?? 'none'})`);
    assert((await balanceOf(admin, user.id)) === 4, 'balance unchanged at 4 (disconnect != refund)');
    assert((await refundRowCount(admin, run2)) === 0, 'no refund ledger row for a completed run');
  } finally {
    if (user) {
      // credits_ledger / chats / runs cascade on the auth.users delete.
      const { error } = await admin.auth.admin.deleteUser(user.id);
      if (error) console.error(`cleanup: deleteUser(${user.id}) failed: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\nREFUND REGRESSION FAILED (${failures.length} assertion(s)):`);
    for (const f of failures) console.error(` - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nREFUND REGRESSION PASSED: early-failure refund, idempotent, no refund after first call.');
}

main().catch((err: unknown) => {
  console.error('REFUND REGRESSION ERROR:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
