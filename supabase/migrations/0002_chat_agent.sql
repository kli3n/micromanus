-- ============================================================================
-- 0002_chat_agent.sql — MicroManus chat/agent schema + money RPCs (additive)
--
-- ADDITIVE ONLY: this migration creates new objects and NEVER alters any 0001
-- object. It extends the Phase-1 money invariants to the run lifecycle, keeping
-- the reviewer's favorite exploits schema-impossible rather than app-level:
--   * cross-account read   -> RLS `(select auth.uid()) = user_id` on every table
--   * double-spend on run   -> start_run() FOR UPDATE lock + append-only ledger
--   * coupon replay         -> existing credits_ledger_coupon_once partial index
--   * double-refund         -> new credits_ledger_refund_once partial index
--   * ciphertext exfiltration-> REVOKE select (iv,ct,tag) on user_api_keys
--   * search-path hijack    -> `set search_path = ''` on every SECURITY DEFINER fn
--
-- Balance = SUM(credits_ledger.delta). There is deliberately NO mutable balance
-- column on any table (see .claude/CLAUDE.md "What NOT to Use").
--
-- OQ-4 RATIONALE (why start_run / refund_run take an explicit p_user_id and are
-- service_role-only, unlike debit_credit/redeem_coupon which use auth.uid()):
--   The agent run handler performs run-lifecycle writes inside the Vercel
--   `waitUntil` background path, where the request (and thus auth.uid()) may have
--   ended and is unreliable. The verified user_id is captured from getClaims() at
--   request entry and passed in explicitly. EXECUTE is revoked from authenticated
--   + public (granted to service_role only), so no user can invoke these with a
--   forged p_user_id — only the trusted backend can. redeem_coupon stays an
--   auth.uid()-based foreground call (the paywall) grantable to authenticated.
-- ============================================================================

-- ============ run lifecycle status ============
create type public.run_status as enum
  ('running', 'succeeded', 'failed', 'budget_exhausted');

-- ============ user_api_keys: one encrypted key per (user, provider) — KEY-03 ==
create table public.user_api_keys (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  provider   text not null,
  base_url   text,
  iv         text not null,
  ct         text not null,
  tag        text not null,
  last4      text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One key per provider per user; save replaces (D-23 upsert on this target).
create unique index user_api_keys_user_provider_uk
  on public.user_api_keys (user_id, provider);

alter table public.user_api_keys enable row level security;

create policy "user_api_keys_select_own" on public.user_api_keys
  for select to authenticated
  using ((select auth.uid()) = user_id);
-- NO insert/update/delete policy for authenticated: writes flow only through the
-- service-role client / SECURITY DEFINER RPCs.

-- Ciphertext is NEVER client-readable even under the row policy: only last4 +
-- metadata are selectable by authenticated (KEY-03 / T-2-02).
revoke select (iv, ct, tag) on public.user_api_keys from authenticated;

-- ============ chats ============
create table public.chats (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  title      text,
  model_id   text not null,
  created_at timestamptz not null default now()
);

alter table public.chats enable row level security;

create policy "chats_select_own" on public.chats
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ============ runs ============
create table public.runs (
  id                         uuid primary key default gen_random_uuid(),
  chat_id                    uuid not null references public.chats(id) on delete cascade,
  user_id                    uuid not null references auth.users(id) on delete cascade,
  model_id                   text not null,
  status                     public.run_status not null default 'running',
  first_model_call_completed boolean not null default false,
  iterations                 integer not null default 0,
  started_at                 timestamptz not null default now(),
  ended_at                   timestamptz
);

alter table public.runs enable row level security;

create policy "runs_select_own" on public.runs
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ============ messages ============
create table public.messages (
  id         uuid primary key default gen_random_uuid(),
  chat_id    uuid not null references public.chats(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  run_id     uuid references public.runs(id) on delete set null,
  role       text not null,
  content    text,
  created_at timestamptz not null default now()
);

alter table public.messages enable row level security;

create policy "messages_select_own" on public.messages
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ============ usage_events: tokens + EVENT-TIME per-1M prices (STAT-01/04) ====
create table public.usage_events (
  id                       bigint generated always as identity primary key,
  run_id                   uuid not null references public.runs(id) on delete cascade,
  chat_id                  uuid not null references public.chats(id) on delete cascade,
  user_id                  uuid not null references auth.users(id) on delete cascade,
  model_id                 text,
  input_tokens             integer not null default 0,
  output_tokens            integer not null default 0,
  cache_read_tokens        integer not null default 0,
  cache_write_tokens       integer not null default 0,
  input_price_per_1m       numeric not null,
  output_price_per_1m      numeric not null,
  cache_read_price_per_1m  numeric not null,
  cache_write_price_per_1m numeric not null,
  cost_usd                 numeric not null default 0,
  created_at               timestamptz not null default now()
);

alter table public.usage_events enable row level security;

create policy "usage_events_select_own" on public.usage_events
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ============ refund idempotency (double-refund schema-impossible) ============
create unique index credits_ledger_refund_once
  on public.credits_ledger (ref_id) where reason = 'refund';

-- ============ redeem_coupon: auth.uid()-based paywall foreground call (PAY-02/03)
-- The existing credits_ledger_coupon_once index makes replay a unique_violation.
create function public.redeem_coupon(p_code text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid := auth.uid();
  v_credits int;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select credits into v_credits
    from public.coupons where code = p_code and is_active;
  if v_credits is null then
    raise exception 'invalid_code' using errcode = 'P0002';
  end if;

  insert into public.credits_ledger (user_id, delta, reason, ref_id)
  values (v_user, v_credits, 'coupon', p_code);   -- coupon_once index → 23505 on replay

  update public.profiles set coupon_redeemed = true where user_id = v_user;
  return v_credits;
exception when unique_violation then
  raise exception 'already_redeemed' using errcode = 'P0003';
end;
$$;

revoke all on function public.redeem_coupon(text) from public;
grant execute on function public.redeem_coupon(text) to authenticated;

-- ============ start_run: atomic -1 debit + run open (PAY-05, service_role only)
-- Takes an explicit verified p_user_id (OQ-4). FOR UPDATE on the single profiles
-- row serializes concurrent starts, closing the double-spend window.
create function public.start_run(p_user_id uuid, p_chat_id uuid, p_model_id text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance int;
  v_run     uuid;
begin
  perform 1 from public.profiles where user_id = p_user_id for update;

  select coalesce(sum(delta), 0) into v_balance
    from public.credits_ledger where user_id = p_user_id;
  if v_balance <= 0 then
    raise exception 'insufficient_credits' using errcode = 'P0001';
  end if;

  insert into public.runs (chat_id, user_id, model_id)
  values (p_chat_id, p_user_id, p_model_id)
  returning id into v_run;

  insert into public.credits_ledger (user_id, delta, reason, ref_id)
  values (p_user_id, -1, 'run_debit', v_run::text);

  return v_run;
end;
$$;

revoke all on function public.start_run(uuid, uuid, text) from public;
revoke all on function public.start_run(uuid, uuid, text) from authenticated;
grant execute on function public.start_run(uuid, uuid, text) to service_role;

-- ============ refund_run: idempotent +1 iff first model call never completed ===
-- (PAY-06, service_role only). Disconnect ≠ failure: refund only when the very
-- first model call never returned. Idempotent via credits_ledger_refund_once.
create function public.refund_run(p_user_id uuid, p_run_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_first_done boolean;
begin
  select first_model_call_completed into v_first_done
    from public.runs where id = p_run_id and user_id = p_user_id for update;
  if not found then
    raise exception 'run_not_found';
  end if;
  if v_first_done then
    return;   -- not refundable: a model call completed (disconnect ≠ failure)
  end if;

  insert into public.credits_ledger (user_id, delta, reason, ref_id)
  values (p_user_id, 1, 'refund', p_run_id::text)
  on conflict (ref_id) where reason = 'refund' do nothing;   -- idempotent

  update public.runs set status = 'failed', ended_at = now() where id = p_run_id;
end;
$$;

revoke all on function public.refund_run(uuid, uuid) from public;
revoke all on function public.refund_run(uuid, uuid) from authenticated;
grant execute on function public.refund_run(uuid, uuid) to service_role;

-- ============ Realtime: reopen/reconnect depends on the publication (Pitfall 8)
alter publication supabase_realtime add table public.messages, public.runs;
