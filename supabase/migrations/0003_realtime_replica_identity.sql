-- ============================================================================
-- 0003_realtime_replica_identity.sql — make reopened-tab Realtime settle (CHAT-08)
--
-- ADDITIVE ONLY: sets REPLICA IDENTITY FULL on the two tables published to
-- supabase_realtime in 0002. NEVER alters any 0001/0002 object, policy, column,
-- or row — REPLICA IDENTITY is table metadata only, and FULL is idempotent.
--
-- WHY: 0002 added public.messages + public.runs to the supabase_realtime
-- publication (its "Pitfall 8" fix) so a reopened tab can resume a live run via
-- postgres_changes. But those tables kept the DEFAULT replica identity. With RLS
-- enabled (`(select auth.uid()) = user_id` on both), Supabase Realtime cannot
-- authorize UPDATE (and DELETE) change events without the full row available in
-- the WAL — the default replica identity carries only the primary key, so the
-- RLS check on the changed row cannot confirm the subscriber owns it and the
-- event is dropped. Net effect (Phase-2 UAT Test 8): a tab reopened mid-run never
-- receives the incremental assistant-content UPDATEs (loop.ts db.updateMessageContent
-- flushes) or the tool running→done UPDATEs, so it stays frozen until a manual
-- refresh re-runs the server query. INSERTs are unaffected (the new row is present
-- for the RLS check), which is why the initiating tab (SSE, not Realtime) never hit
-- this. REPLICA IDENTITY FULL puts the full row in the WAL for UPDATE/DELETE, so
-- Realtime can authorize and deliver those events to the owning subscriber.
--
-- COST: slightly larger WAL entries for UPDATE/DELETE on these two low-volume
-- tables. Negligible here; standard Supabase guidance for RLS + Realtime UPDATE.
-- ============================================================================

alter table public.messages replica identity full;
alter table public.runs     replica identity full;
