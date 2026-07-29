-- ============================================================================
-- 0006_artifacts.sql — PDF report artifacts + private reports bucket (RSCH-03)
--
-- ADDITIVE ONLY: creates public.artifacts and the private 'reports' Storage
-- bucket. NEVER alters any 0001–0005 object, policy, column, or row.
--
-- artifacts is the SYSTEM OF RECORD for report artifacts (D-39): the download
-- route queries it (id + user_id ownership predicate) and mints a per-click
-- ~60s signed URL from storage_path. Status is terminal-guaranteed: every
-- deferred-render exit path writes 'succeeded' or 'degraded' (D-43/D-46).
--
-- WHY there is NO `alter publication supabase_realtime add table` line and NO
-- `replica identity full` here (deliberate — not an oversight of the 0003
-- lesson): the Realtime CARRIER for the artifact card is a role='tool' row in
-- public.messages, which is already published with replica identity full
-- (migrations 0002 + 0003) and already subscribed/replayed by ChatThread. The
-- pending→settled transition rides that existing messages UPDATE; publishing
-- artifacts as well would be a second subscription for the same event
-- (RESEARCH Pattern 5 / Anti-Patterns).
--
-- RLS from birth (D-05 convention): select-only for authenticated owners.
-- ALL writes (insert pending, settle terminal) are service-role only from the
-- agent route's waitUntil task — no insert/update policies exist on purpose.
-- ============================================================================

create table public.artifacts (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid references public.runs(id) on delete set null,
  chat_id      uuid not null references public.chats(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  title        text not null,
  storage_path text,
  status       text not null default 'pending'
               check (status in ('pending', 'succeeded', 'degraded')),
  created_at   timestamptz not null default now()
);

alter table public.artifacts enable row level security;

create policy "artifacts_select_own" on public.artifacts
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- Private reports bucket (D-39): PDFs live at {user_id}/{chat_id}/{artifact_id}.pdf.
-- public=false is the default but stated explicitly to document intent; reads
-- happen ONLY through per-click signed URLs minted behind the ownership check.
-- on conflict do nothing keeps a re-applied migration idempotent. Only the
-- (id, name, public) columns are used — size/mime caps are dashboard-side.
insert into storage.buckets (id, name, public)
values ('reports', 'reports', false)
on conflict (id) do nothing;
