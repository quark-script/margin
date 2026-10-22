-- Current schema of the "notes" app in the "upkeep" Supabase project. Applied as migration
-- "notes_init" (2026-10-21), with the parent-ownership policies fixed afterwards (see
-- migrations/20261021_fix_policy_recursion.sql). Sharing (shares, page_locks and the share
-- functions) is in migrations/20261022_sharing.sql.
create schema if not exists notes;

create table notes.pages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  parent_id uuid references notes.pages(id) on delete cascade,
  title text not null default '',
  icon text,
  content jsonb not null default '[]'::jsonb,
  search_text text not null default '',
  position double precision not null default 0,
  is_favorite boolean not null default false,
  is_archived boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  fts tsvector generated always as (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(search_text,''))) stored,
  constraint pages_not_own_parent check (parent_id is null or parent_id <> id)
);

create index pages_owner_parent_idx on notes.pages (owner_id, parent_id, position);
create index pages_parent_idx on notes.pages (parent_id);
create index pages_owner_updated_idx on notes.pages (owner_id, updated_at desc);
create index pages_fts_idx on notes.pages using gin (fts);

create or replace function notes.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if new.is_archived and not old.is_archived then new.archived_at := now();
  elsif not new.is_archived then new.archived_at := null;
  end if;
  return new;
end; $$;
create trigger pages_touch_updated_at before update on notes.pages for each row execute function notes.touch_updated_at();

alter table notes.pages enable row level security;
create policy "pages_select_own" on notes.pages for select to authenticated using (owner_id = (select auth.uid()));
-- Parent ownership goes through a security definer function: a policy on notes.pages that
-- queries notes.pages itself fails with 42P17 (infinite recursion).
create or replace function notes.owns_page(page_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from notes.pages where id = page_id and owner_id = (select auth.uid()));
$$;
revoke all on function notes.owns_page(uuid) from public, anon;
grant execute on function notes.owns_page(uuid) to authenticated;
create policy "pages_insert_own" on notes.pages for insert to authenticated with check (
  owner_id = (select auth.uid()) and (parent_id is null or notes.owns_page(parent_id)));
create policy "pages_update_own" on notes.pages for update to authenticated using (owner_id = (select auth.uid())) with check (
  owner_id = (select auth.uid()) and (parent_id is null or notes.owns_page(parent_id)));
create policy "pages_delete_own" on notes.pages for delete to authenticated using (owner_id = (select auth.uid()));

revoke all on schema notes from anon, public;
grant usage on schema notes to authenticated, service_role;
revoke all on notes.pages from anon, public;
grant select, insert, update, delete on notes.pages to authenticated;
grant all on notes.pages to service_role;
alter publication supabase_realtime add table notes.pages;

-- Private image bucket; each user can only touch files under their own user-id folder.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('notes-media', 'notes-media', false, 10485760, array['image/png','image/jpeg','image/webp','image/gif','image/svg+xml','application/pdf'])
on conflict (id) do nothing;
create policy "notes_media_select_own" on storage.objects for select to authenticated using (bucket_id = 'notes-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "notes_media_insert_own" on storage.objects for insert to authenticated with check (bucket_id = 'notes-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "notes_media_delete_own" on storage.objects for delete to authenticated using (bucket_id = 'notes-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
