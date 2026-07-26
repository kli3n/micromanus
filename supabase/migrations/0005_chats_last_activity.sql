-- ============================================================================
-- 0005_chats_last_activity.sql — order chats by recent usage (bump-to-top)
--
-- ADDITIVE: adds chats.last_activity_at + a supporting index + an AFTER INSERT
-- trigger on messages (role='user') that touches it. Never alters a prior
-- 0001-0004 object, policy, or any money invariant.
--
-- WHY: the sidebar ordered chats by created_at (static). This denormalized
-- last_activity_at is bumped to now() whenever the user sends a message in a
-- chat (the "use/reuse" moment), so the sidebar (ordered by last_activity_at
-- desc) floats the most recently used chat to the top. Only user messages bump
-- (WHEN role='user'); assistant/tool status rows during the run do not re-bump.
-- ============================================================================

-- 1. Denormalized activity timestamp.
alter table public.chats
  add column if not exists last_activity_at timestamptz not null default now();

-- 2. Backfill existing chats from their latest message (fallback: created_at).
update public.chats c
  set last_activity_at = coalesce(
    (select max(m.created_at) from public.messages m where m.chat_id = c.id),
    c.created_at
  );

-- 3. Order index for the RLS-scoped sidebar query.
create index if not exists chats_user_activity_idx
  on public.chats (user_id, last_activity_at desc);

-- 4. Bump last_activity_at when the user sends a message. Only role='user'
--    inserts bump. SECURITY DEFINER + empty search_path per project convention;
--    the update hits 0 rows (no error) if the chat was concurrently deleted, so
--    it can never fail the message insert.
create or replace function public.touch_chat_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.chats set last_activity_at = now() where id = new.chat_id;
  return new;
end;
$$;

drop trigger if exists messages_touch_chat_activity on public.messages;
create trigger messages_touch_chat_activity
  after insert on public.messages
  for each row
  when (new.role = 'user')
  execute function public.touch_chat_activity();
