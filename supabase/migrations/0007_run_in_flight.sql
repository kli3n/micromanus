-- ============================================================================
-- 0007_run_in_flight.sql — one question produces exactly one debit, enforced in
-- Postgres (review GC-01)
--
-- ADDITIVE AND FORWARD-ONLY: this migration replaces the body of
-- public.start_run in place and adds one index. It NEVER alters any 0001–0006
-- object, and no already-pushed migration file is edited.
--
-- WHAT THIS CLOSES. Before this migration the "one user question -> one
-- start_run debit" invariant was enforced ONLY by a browser closure
-- (lib/chat/run-guard.ts). start_run's FOR UPDATE lock on the profiles row
-- prevents an OVERDRAFT, not a DUPLICATE: it serializes concurrent starts and
-- refuses at balance <= 0, but nothing stopped a SECOND request arriving after
-- the first had fully returned from debiting again. Three bypasses were
-- documented — a second tab loaded before the run started, a replayed curl with
-- no client involved at all, and a reload in the narrow window between the
-- debit and the assistant-row insert. That is the app-level check-then-insert
-- shape PROJECT.md forbids, moved one layer further out into JavaScript.
--
-- THREE PARTS, AND WHY NONE OF THEM IS REDUNDANT. Do not remove one because
-- another looks sufficient:
--
--   1. THE IN-FLIGHT `exists` CHECK inside the function is the branch the
--      client actually hits. It is the only one of the three that can carry a
--      named condition (P0002 -> run_in_flight) and therefore the only one that
--      produces usable user-facing copy instead of a raw constraint error.
--
--   2. THE PARTIAL UNIQUE INDEX on (chat_id) where status = 'running' is the
--      fail-closed backstop. It holds for ANY caller — including one that does
--      not exist yet and skips this RPC entirely — and it states the money
--      invariant in the schema, which is where PROJECT.md says money invariants
--      belong. Alone it would be unsafe, which is why it was sequenced behind
--      GW-01 (plan 03-14, a refused terminal status write is now loggable) and
--      GW-02 (plan 03-15, the client in-flight signal is age-bounded).
--
--   3. THE PER-CHAT REAPER is what makes the index genuinely safe rather than
--      merely sequenced behind those two. A partial unique index predicate must
--      be IMMUTABLE in Postgres and now() is only STABLE, so the age bound
--      CANNOT live in the index. Without a reaper, a chat that once wedged at
--      'running' — a hard kill at the platform ceiling, an evicted background
--      task — would be locked out of new runs permanently. Putting the reap
--      inside the function means every legitimate start self-heals its own chat
--      before deciding.
--
-- WHY 330 SECONDS. It is a PLATFORM FACT, not a tuning knob, and it is the SAME
-- fact as RUN_WEDGE_CEILING_MS (330_000) in lib/chat/run-staleness.ts. The
-- agent route runs under Vercel Fluid Compute with maxDuration = 300 (and a
-- 240s self-budget inside that), so no LIVE run can ever be older than 300s;
-- 330s clears it with a 30s margin for the terminal write. The two layers —
-- the client-side guard release and this server-side reaper — MUST be changed
-- together, or one will consider a run live while the other reaps it.
--
-- WHY THE FUNCTION IS REPLACED RATHER THAN DROPPED AND RECREATED: CREATE OR
-- REPLACE preserves the existing grants. The definer posture and the empty
-- search_path are nevertheless RE-DECLARED below, because search_path is part
-- of the function definition and is silently LOST if omitted — which would turn
-- a SECURITY DEFINER function into a search-path injection surface. Every table
-- reference is therefore schema-qualified.
-- ============================================================================

create or replace function public.start_run(p_user_id uuid, p_chat_id uuid, p_model_id text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance int;
  v_run     uuid;
begin
  -- (1) Serialize concurrent starts for this user (unchanged from 0002). The
  --     lock closes the PARALLEL window; steps 2-3 close the SEQUENTIAL one.
  perform 1 from public.profiles where user_id = p_user_id for update;

  -- (2) REAP this chat's wedged runs before deciding anything. Scoped to
  --     p_chat_id deliberately: a global reap on every start would touch
  --     unrelated rows and widen the write for no benefit, and per-chat
  --     self-healing is sufficient because a locked-out chat heals on the
  --     user's next attempt in that chat.
  --
  --     A NULL started_at counts as stale, mirroring the fail-safe direction
  --     isRunWedged already takes on the client, so a malformed row cannot hold
  --     a chat hostage.
  --
  --     THIS REAP DELIBERATELY DOES NOT REFUND. It writes only status and
  --     ended_at. Refund eligibility is gated on runs.first_model_call_completed
  --     and lives in public.refund_run; duplicating that decision here would
  --     create a SECOND money path, exactly what PROJECT.md forbids. A wedged
  --     run that never billed keeps its credit unrefunded — accepted knowingly
  --     (threat T-03-18-06), and GW-01 makes that case loggable rather than
  --     silent.
  update public.runs
     set status = 'failed',
         ended_at = coalesce(ended_at, now())
   where chat_id = p_chat_id
     and status = 'running'
     and (started_at is null or started_at < now() - interval '330 seconds');

  -- (3) REFUSE if a live run remains. Placed AFTER the reap and BEFORE the
  --     balance read, so a chat with a genuinely live run is told the truth
  --     rather than being told it is out of credits.
  if exists (
    select 1 from public.runs
     where chat_id = p_chat_id and status = 'running'
  ) then
    raise exception 'run_in_flight' using errcode = 'P0002';
  end if;

  -- (4) Balance gate (unchanged from 0002). Balance = SUM(delta); there is
  --     deliberately no mutable balance column anywhere.
  select coalesce(sum(delta), 0) into v_balance
    from public.credits_ledger where user_id = p_user_id;
  if v_balance <= 0 then
    raise exception 'insufficient_credits' using errcode = 'P0001';
  end if;

  -- (5) Open the run. The nested block exists so the partial unique index can
  --     never surface a raw 23505 to the route: a lost race between step 3 and
  --     this insert is the SAME condition step 3 names, and must reach the
  --     client as the same refusal. The handler is scoped to THIS insert only —
  --     an outer-level handler would also catch a credits_ledger unique
  --     violation and mislabel it as an in-flight run (threat T-03-18-07).
  begin
    insert into public.runs (chat_id, user_id, model_id)
    values (p_chat_id, p_user_id, p_model_id)
    returning id into v_run;
  exception when unique_violation then
    raise exception 'run_in_flight' using errcode = 'P0002';
  end;

  -- (6) Debit. Still exactly one atomic Postgres call for the caller; no
  --     app-level check-then-insert is introduced anywhere.
  insert into public.credits_ledger (user_id, delta, reason, ref_id)
  values (p_user_id, -1, 'run_debit', v_run::text);

  return v_run;
end;
$$;

-- ============ one-time reap, then the fail-closed backstop =================
-- ORDER IS LOAD-BEARING. If two stale 'running' rows share a chat, index
-- creation fails and the migration is half-applied — and this project already
-- carries at least one wedged run from a UAT session. The one-time reap
-- therefore runs FIRST, using the same 330-second bound and the same
-- status/ended_at-only write as the in-function reap (threat T-03-18-05).
update public.runs
   set status = 'failed',
       ended_at = coalesce(ended_at, now())
 where status = 'running'
   and (started_at is null or started_at < now() - interval '330 seconds');

-- The invariant as a schema fact: at most one live run per chat, for every
-- caller, forever. `if not exists` keeps a re-applied migration idempotent.
create unique index if not exists runs_one_running_per_chat
  on public.runs (chat_id) where status = 'running';

-- ============ execute posture, re-stated =====================================
-- CREATE OR REPLACE preserved these, but they are re-stated so this migration
-- is self-documenting about who may spend a credit: only the trusted backend.
revoke all on function public.start_run(uuid, uuid, text) from public;
revoke all on function public.start_run(uuid, uuid, text) from authenticated;
grant execute on function public.start_run(uuid, uuid, text) to service_role;
