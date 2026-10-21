-- Applied 2026-10-21. The original insert/update policies were broken twice over:
-- 1. They queried notes.pages from a policy on notes.pages -> 42P17 infinite recursion,
--    so every insert/upsert failed.
-- 2. Inside the subquery `parent_id` bound to the subquery's own alias (p.id = p.parent_id),
--    so a page with a parent could never pass even without the recursion.
create or replace function notes.owns_page(page_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from notes.pages where id = page_id and owner_id = (select auth.uid()));
$$;
revoke all on function notes.owns_page(uuid) from public, anon;
grant execute on function notes.owns_page(uuid) to authenticated;

alter policy "pages_insert_own" on notes.pages with check (
  owner_id = (select auth.uid()) and (parent_id is null or notes.owns_page(parent_id)));
alter policy "pages_update_own" on notes.pages with check (
  owner_id = (select auth.uid()) and (parent_id is null or notes.owns_page(parent_id)));
