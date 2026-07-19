-- ============================================================================
-- 0001_auth_money.sql — MicroManus money + auth schema (RLS from birth)
--
-- Ships in ONE migration (D-04/D-05). Enforces the FR-9a money invariants at the
-- database layer so the reviewer's favorite exploits are schema-impossible, not
-- app-level code paths:
--   * cross-account read  -> RLS `user_id = auth.uid()` on every table (D-05/D-06)
--   * double-spend        -> append-only ledger + debit_credit() FOR UPDATE lock
--   * coupon replay       -> partial unique index (user_id) where reason='coupon'
--   * webhook double-credit-> partial unique index (ref_id) where reason='purchase'
--   * cross-user debit     -> debit_credit() derives identity from auth.uid()
--   * search-path hijack   -> `set search_path = ''` on all SECURITY DEFINER funcs
--
-- Balance = SUM(credits_ledger.delta). There is deliberately NO mutable balance
-- column (see .claude/CLAUDE.md "What NOT to Use"). Deferred-phase tables
-- (api_keys/chats/messages/runs/usage_events) and a physical `purchases` table are
-- intentionally NOT created here — idempotency lives on the ledger ref_id index
-- (FR-9a; RESEARCH Open Question A1).
-- ============================================================================

-- ============ profiles: exactly one row per auth user ============
create table public.profiles (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  display_name    text,
  coupon_redeemed boolean not null default false,     -- display-only mirror (FR-9a)
  created_at      timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
-- NO insert policy: rows are created only by the signup trigger below.

-- Auto-create a profile row on signup (else profiles is silently always empty —
-- the RLS-on-no-rows trap the probe asserts against). SECURITY DEFINER so it can
-- write through RLS; `set search_path = ''` prevents search-path hijack (T-1-05).
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'user_name',
      new.email
    )
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============ credits_ledger: append-only; balance = SUM(delta) ============
create type public.credit_reason as enum ('coupon', 'purchase', 'run_debit', 'refund');

create table public.credits_ledger (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  delta      integer not null,
  reason     public.credit_reason not null,
  ref_id     text,
  created_at timestamptz not null default now()
);

create index credits_ledger_user_idx on public.credits_ledger (user_id);

-- FR-9a invariants (schema-impossible to violate):
create unique index credits_ledger_coupon_once     -- one coupon redemption per user
  on public.credits_ledger (user_id) where reason = 'coupon';
create unique index credits_ledger_purchase_once    -- Stripe webhook idempotency (Phase 4)
  on public.credits_ledger (ref_id)  where reason = 'purchase';

alter table public.credits_ledger enable row level security;

create policy "ledger_select_own" on public.credits_ledger
  for select to authenticated
  using ((select auth.uid()) = user_id);
-- NO insert/update/delete policy for authenticated: writes go only through
-- SECURITY DEFINER RPCs (debit) and the service-role client (grants/webhook).

-- ============ atomic debit (FR-9a): -1 iff SUM(delta) > 0, race-proof ============
-- Takes NO user parameter — identity is auth.uid() inside the function (T-1-04b).
-- Serializes concurrent debits per user via FOR UPDATE on the single profiles row
-- (guaranteed to exist by on_auth_user_created), closing the double-spend window
-- that an app-level check-then-insert would leave open under READ COMMITTED.
create function public.debit_credit()
returns integer                              -- returns the new balance
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid := auth.uid();
  v_balance integer;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- serialize concurrent debits for this user (one profiles row per user)
  perform 1 from public.profiles where user_id = v_user for update;

  select coalesce(sum(delta), 0) into v_balance
    from public.credits_ledger where user_id = v_user;

  if v_balance <= 0 then
    raise exception 'insufficient_credits' using errcode = 'P0001';
  end if;

  insert into public.credits_ledger (user_id, delta, reason)
  values (v_user, -1, 'run_debit');

  return v_balance - 1;
end;
$$;

revoke all on function public.debit_credit() from public;
grant execute on function public.debit_credit() to authenticated;

-- ============ coupons: global catalog (no user_id) ============
-- RLS ENABLED with NO authenticated policy -> deny-all to clients (reference
-- table, T-1-11). Redemption happens only through a SECURITY DEFINER RPC in
-- Phase 2 / the service-role client, never a direct client read.
create table public.coupons (
  code       text primary key,
  credits    integer not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.coupons enable row level security;
-- (intentionally no policy: clients get an empty deny-all result set)

insert into public.coupons (code, credits) values ('SID_DRDROID', 5);
