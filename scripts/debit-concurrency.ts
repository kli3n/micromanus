/**
 * scripts/debit-concurrency.ts — double-spend + zero-balance debit regression.
 *
 * Proves the FR-9a atomicity invariant against the LIVE provisioned Supabase
 * project:
 *   1. A user seeded to balance = 1, hit by N parallel debit_credit() calls,
 *      has EXACTLY ONE succeed (new balance 0); the rest reject with
 *      'insufficient_credits'. Final SUM(delta) is 0 — never negative.
 *   2. A fresh user at balance 0 has a single debit_credit() reject with
 *      'insufficient_credits'.
 *
 * The debit_credit RPC takes no user argument — identity is auth.uid() inside the
 * function. Scenario 3 (added in Plan 02-01) exercises the service_role-only
 * start_run(p_user_id, p_chat_id, p_model_id) RPC from migration 0002, which takes
 * an explicit p_user_id (OQ-4) and performs the same FOR UPDATE debit while opening
 * a run. This mirrors the ephemeral-user + user-client helper shape used by
 * scripts/rls-probe.ts (kept self-contained so each probe runs standalone via `node`).
 *
 * Run: `npm run test:money`.
 * Requires env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
 * Exits non-zero on any violation; cleans up in finally.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const PARALLEL_DEBITS = 5;
const PARALLEL_RUNS = 5;
const MODEL = 'gpt-5.6-luna';

function requireEnv(...names: string[]): string {
  for (const n of names) {
    const raw = process.env[n];
    if (raw == null) continue;
    // Sanitize: trim whitespace/CR and strip surrounding quotes that a
    // `vercel env pull` + Node --env-file value can carry (common Windows papercut).
    const v = raw.trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    if (v.length > 0) return v;
  }
  throw new Error(
    `Missing required env var (one of: ${names.join(', ')}). ` +
      `Set it from the provisioned Supabase project (Plan 01-02) before running.`,
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
  const email = `debit-probe-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
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

const isInsufficient = (msg: string | undefined): boolean =>
  (msg ?? '').toLowerCase().includes('insufficient_credits');

async function runsCount(admin: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await admin
    .from('runs')
    .select('id')
    .eq('user_id', userId);
  if (error) throw new Error(`runsCount failed: ${error.message}`);
  return (data ?? []).length;
}

async function main(): Promise<void> {
  const admin = adminClient();
  let uConcurrent: { id: string; email: string; password: string } | null = null;
  let uZero: { id: string; email: string; password: string } | null = null;
  let uStartRun: { id: string; email: string; password: string } | null = null;

  try {
    // ---- Scenario 1: N parallel debits at balance 1 -> exactly one wins ----
    uConcurrent = await makeUser(admin, 'concurrent');
    const seed = await admin
      .from('credits_ledger')
      .insert({ user_id: uConcurrent.id, delta: 1, reason: 'refund' });
    if (seed.error) throw new Error(`seed balance=1 failed: ${seed.error.message}`);

    const cClient = await userClient(uConcurrent.email, uConcurrent.password);

    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL_DEBITS }, () => cClient.rpc('debit_credit')),
    );

    let successCount = 0;
    let insufficientCount = 0;
    let otherErrors = 0;
    for (const r of results) {
      if (r.status === 'rejected') {
        otherErrors++;
        continue;
      }
      const { data, error } = r.value;
      if (!error) {
        successCount++;
        assert(data === 0, `winning debit returned new balance 0 (got ${JSON.stringify(data)})`);
      } else if (isInsufficient(error.message)) {
        insufficientCount++;
      } else {
        otherErrors++;
        console.error(`  unexpected rpc error: ${error.message}`);
      }
    }

    console.log(`concurrent debits @ balance 1 (N=${PARALLEL_DEBITS}):`);
    assert(successCount === 1, `exactly one debit succeeded (got ${successCount})`);
    assert(
      insufficientCount === PARALLEL_DEBITS - 1,
      `the other ${PARALLEL_DEBITS - 1} rejected with insufficient_credits (got ${insufficientCount})`,
    );
    assert(otherErrors === 0, `no unexpected errors (got ${otherErrors})`);

    const finalBalance = await balanceOf(admin, uConcurrent.id);
    assert(finalBalance === 0, `final SUM(delta) is 0, never negative (got ${finalBalance})`);

    // ---- Scenario 2: fresh user at balance 0 -> single debit rejects ----
    uZero = await makeUser(admin, 'zero');
    const zClient = await userClient(uZero.email, uZero.password);
    const zeroResult = await zClient.rpc('debit_credit');
    console.log('single debit @ balance 0:');
    assert(zeroResult.error !== null, 'debit at balance 0 returned an error (did not succeed)');
    assert(
      isInsufficient(zeroResult.error?.message),
      `error is insufficient_credits (got: ${zeroResult.error?.message ?? 'none'})`,
    );
    const zeroBalance = await balanceOf(admin, uZero.id);
    assert(zeroBalance === 0, `balance-0 user still at 0 after rejected debit (got ${zeroBalance})`);

    // ---- Scenario 3: N parallel start_run() at balance 1 -> exactly one wins ----
    // start_run is service_role-only and debits -1 while opening a run (0002).
    uStartRun = await makeUser(admin, 'startrun');
    const seedRun = await admin
      .from('credits_ledger')
      .insert({ user_id: uStartRun.id, delta: 1, reason: 'refund', ref_id: `seed-${uStartRun.id}` });
    if (seedRun.error) throw new Error(`seed start_run balance=1 failed: ${seedRun.error.message}`);

    const chat = await admin
      .from('chats')
      .insert({ user_id: uStartRun.id, model_id: MODEL, title: 'start_run-probe' })
      .select('id')
      .single();
    if (chat.error) throw new Error(`insert chat failed: ${chat.error.message}`);
    const chatId = (chat.data as { id: string }).id;

    const runResults = await Promise.allSettled(
      Array.from({ length: PARALLEL_RUNS }, () =>
        admin.rpc('start_run', {
          p_user_id: uStartRun!.id,
          p_chat_id: chatId,
          p_model_id: MODEL,
        }),
      ),
    );

    let runSuccess = 0;
    let runInsufficient = 0;
    let runOther = 0;
    for (const r of runResults) {
      if (r.status === 'rejected') {
        runOther++;
        continue;
      }
      const { data, error } = r.value;
      if (!error) {
        runSuccess++;
        assert(typeof data === 'string' && data.length > 0, `winning start_run returned a run uuid (got ${JSON.stringify(data)})`);
      } else if (isInsufficient(error.message)) {
        runInsufficient++;
      } else {
        runOther++;
        console.error(`  unexpected start_run error: ${error.message}`);
      }
    }

    console.log(`concurrent start_run @ balance 1 (N=${PARALLEL_RUNS}):`);
    assert(runSuccess === 1, `exactly one start_run succeeded (got ${runSuccess})`);
    assert(
      runInsufficient === PARALLEL_RUNS - 1,
      `the other ${PARALLEL_RUNS - 1} rejected with insufficient_credits (got ${runInsufficient})`,
    );
    assert(runOther === 0, `no unexpected start_run errors (got ${runOther})`);

    const runBalance = await balanceOf(admin, uStartRun.id);
    assert(runBalance === 0, `final SUM(delta) is 0, never negative (got ${runBalance})`);
    const runRows = await runsCount(admin, uStartRun.id);
    assert(runRows === 1, `exactly one runs row exists for the user (got ${runRows})`);
  } finally {
    for (const u of [uConcurrent, uZero, uStartRun]) {
      if (u) {
        const { error } = await admin.auth.admin.deleteUser(u.id);
        if (error) console.error(`cleanup: deleteUser(${u.id}) failed: ${error.message}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error(`\nDEBIT REGRESSION FAILED (${failures.length} assertion(s)):`);
    for (const f of failures) console.error(` - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nDEBIT REGRESSION PASSED: no double-spend under concurrency (debit_credit + start_run); zero-balance debit rejected.');
}

main().catch((err: unknown) => {
  console.error('DEBIT REGRESSION ERROR:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
