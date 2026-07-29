/**
 * scripts/rls-probe.ts — RLS cross-account isolation probe (D-06 / success criterion 4).
 *
 * Proves, against the LIVE provisioned Supabase project, that:
 *   (a) account B cannot read account A's credits_ledger / profiles rows,
 *   (b) account B CAN read its own rows (distinguishes a real policy from the
 *       RLS-enabled-but-no-policy silent-empty trap — Pitfall D), and
 *   (c) the anon key with NO user token reads zero rows (RLS default-deny).
 *
 * Run: `npm run test:rls` (node runs this .ts directly via type-stripping).
 * Requires env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 * (NEXT_PUBLIC_* fallbacks accepted). NEVER hard-code secrets here.
 *
 * DEFERRED: cannot pass until Plan 01-02 provisions the project + migration is
 * applied. Exits non-zero on any assertion failure; cleans up both users.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

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

/** Service-role client (bypasses RLS) for setup + teardown only. */
function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, noPersist);
}

/** Create a confirmed ephemeral user; the signup trigger provisions its profile. */
async function makeUser(
  admin: SupabaseClient,
  tag: string,
): Promise<{ id: string; email: string; password: string }> {
  const email = `rls-probe-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
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

/** A user-scoped client whose JWT makes auth.uid() resolve to this user under RLS. */
async function userClient(email: string, password: string): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, ANON_KEY, noPersist);
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signInWithPassword failed: ${error.message}`);
  return client;
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

async function main(): Promise<void> {
  const admin = adminClient();
  let userA: { id: string; email: string; password: string } | null = null;
  let userB: { id: string; email: string; password: string } | null = null;

  try {
    userA = await makeUser(admin, 'a');
    userB = await makeUser(admin, 'b');

    // Seed one coupon-grant ledger row per user (service role bypasses RLS).
    for (const u of [userA, userB]) {
      const { error } = await admin
        .from('credits_ledger')
        .insert({ user_id: u.id, delta: 5, reason: 'coupon' });
      if (error) throw new Error(`seed ledger failed: ${error.message}`);
    }

    const bClient = await userClient(userB.email, userB.password);
    const anonOnly = createClient(SUPABASE_URL, ANON_KEY, noPersist);

    console.log('credits_ledger:');
    // (a) B asking explicitly for A's rows -> RLS filters them out.
    const bReadsA = await bClient.from('credits_ledger').select('*').eq('user_id', userA.id);
    if (bReadsA.error) throw new Error(`B->A ledger read errored: ${bReadsA.error.message}`);
    assert((bReadsA.data?.length ?? -1) === 0, "B reads 0 of A's credits_ledger rows");

    // (b) B reading its own rows -> non-zero (proves a real policy exists).
    const bReadsOwn = await bClient.from('credits_ledger').select('*');
    if (bReadsOwn.error) throw new Error(`B own ledger read errored: ${bReadsOwn.error.message}`);
    assert((bReadsOwn.data?.length ?? 0) > 0, "B reads >0 of its OWN credits_ledger rows (not the silent-empty trap)");

    // (c) anon key, no user token -> default deny.
    const anonReads = await anonOnly.from('credits_ledger').select('*');
    assert((anonReads.data?.length ?? -1) === 0, 'anon-only (no user token) reads 0 credits_ledger rows');

    console.log('profiles:');
    // (a) for profiles
    const bReadsAProfile = await bClient.from('profiles').select('*').eq('user_id', userA.id);
    if (bReadsAProfile.error) throw new Error(`B->A profile read errored: ${bReadsAProfile.error.message}`);
    assert((bReadsAProfile.data?.length ?? -1) === 0, "B reads 0 of A's profiles rows");

    // (b) for profiles — B sees its own profile (created by the signup trigger).
    const bReadsOwnProfile = await bClient.from('profiles').select('*');
    if (bReadsOwnProfile.error) throw new Error(`B own profile read errored: ${bReadsOwnProfile.error.message}`);
    assert((bReadsOwnProfile.data?.length ?? 0) > 0, "B reads its OWN profiles row (handle_new_user trigger fired)");

    // ---- artifacts (T-3-03 / migration 0006): cross-account isolation. ----
    // Seed one chat + one artifact per user (service role bypasses RLS).
    // Deleting the users in cleanup cascades chats → artifacts.
    for (const u of [userA, userB]) {
      const { data: chat, error: chatErr } = await admin
        .from('chats')
        .insert({ user_id: u.id, model_id: 'gpt-5.6-luna', title: 'rls probe chat' })
        .select('id')
        .single();
      if (chatErr || !chat) throw new Error(`seed chat failed: ${chatErr?.message ?? 'no row'}`);
      const { error: artErr } = await admin.from('artifacts').insert({
        chat_id: chat.id,
        user_id: u.id,
        title: 'rls probe artifact',
        status: 'pending',
      });
      if (artErr) throw new Error(`seed artifact failed: ${artErr.message}`);
    }

    console.log('artifacts:');
    // (a) B asking explicitly for A's artifacts -> RLS filters them out (never 403).
    const bReadsAArtifacts = await bClient.from('artifacts').select('*').eq('user_id', userA.id);
    if (bReadsAArtifacts.error) throw new Error(`B->A artifacts read errored: ${bReadsAArtifacts.error.message}`);
    assert((bReadsAArtifacts.data?.length ?? -1) === 0, "B reads 0 of A's artifacts rows");

    // (b) B reading its own artifacts -> non-zero (a real policy, not silent-empty).
    const bReadsOwnArtifacts = await bClient.from('artifacts').select('*');
    if (bReadsOwnArtifacts.error) throw new Error(`B own artifacts read errored: ${bReadsOwnArtifacts.error.message}`);
    assert(
      (bReadsOwnArtifacts.data?.length ?? 0) > 0,
      'B reads >0 of its OWN artifacts rows (not the silent-empty trap)',
    );

    // (c) anon key, no user token -> default deny.
    const anonArtifacts = await anonOnly.from('artifacts').select('*');
    assert((anonArtifacts.data?.length ?? -1) === 0, 'anon-only (no user token) reads 0 artifacts rows');
  } finally {
    for (const u of [userA, userB]) {
      if (u) {
        const { error } = await admin.auth.admin.deleteUser(u.id);
        if (error) console.error(`cleanup: deleteUser(${u.id}) failed: ${error.message}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error(`\nRLS PROBE FAILED (${failures.length} assertion(s)):`);
    for (const f of failures) console.error(` - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nRLS PROBE PASSED: cross-account isolation holds; own-row reads work; anon is default-deny.');
}

main().catch((err: unknown) => {
  console.error('RLS PROBE ERROR:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
