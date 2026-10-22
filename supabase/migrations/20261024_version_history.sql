-- Version history. Every save to a page updates its latest version; a new version starts after
-- 10 minutes without edits, after 30 minutes of editing, or when someone else edits. So a
-- version is one editing session, with who and when. Recorded by a trigger, so it covers the
-- app, share-link editors and every device alike.

create table notes.page_versions (
  id bigint generated always as identity primary key,
  page_id uuid not null references notes.pages(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '',
  icon text,
  content jsonb not null,
  edited_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  saved_at timestamptz not null default now(),
  -- A sealed version is never updated again; restoring seals the current state first.
  sealed boolean not null default false
);
create index page_versions_page_saved on notes.page_versions (page_id, saved_at desc);
alter table notes.page_versions enable row level security;
create policy "versions_own_read" on notes.page_versions for select to authenticated
  using (owner_id = (select auth.uid()));
grant select on notes.page_versions to authenticated;
grant all on notes.page_versions to service_role;

create or replace function notes.record_version()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v notes.page_versions%rowtype;
  v_editor uuid := coalesce(auth.uid(), new.owner_id);
begin
  if tg_op = 'UPDATE' and new.content is not distinct from old.content and new.title is not distinct from old.title then
    return null;
  end if;
  if tg_op = 'INSERT' and new.content = '[]'::jsonb and new.title = '' then
    return null; -- a blank new page; its first edit starts the history
  end if;

  select * into v from notes.page_versions where page_id = new.id order by saved_at desc, id desc limit 1;
  if found and not v.sealed and v.edited_by is not distinct from v_editor
     and v.saved_at > now() - interval '10 minutes' and v.started_at > now() - interval '30 minutes' then
    update notes.page_versions
      set title = new.title, icon = new.icon, content = new.content, saved_at = now()
      where id = v.id;
  else
    insert into notes.page_versions (page_id, owner_id, title, icon, content, edited_by)
    values (new.id, new.owner_id, new.title, new.icon, new.content, v_editor);
    -- Past 30 days, keep only the last version of each day.
    delete from notes.page_versions pv
    where pv.page_id = new.id and pv.saved_at < now() - interval '30 days'
      and pv.id not in (
        select distinct on (date_trunc('day', x.saved_at)) x.id from notes.page_versions x
        where x.page_id = new.id and x.saved_at < now() - interval '30 days'
        order by date_trunc('day', x.saved_at), x.saved_at desc, x.id desc
      );
  end if;
  return null;
end $$;

create trigger pages_record_version after insert or update of content, title on notes.pages
  for each row execute function notes.record_version();

-- The list for the history panel: newest first, without content. Owner only.
create or replace function notes.page_history(p_page_id uuid)
returns table (id bigint, title text, saved_at timestamptz, editor text, mine boolean)
language sql stable security definer set search_path = '' as $$
  select v.id, v.title, v.saved_at, split_part(u.email, '@', 1), v.edited_by = auth.uid()
  from notes.page_versions v left join auth.users u on u.id = v.edited_by
  where v.page_id = p_page_id and notes.owns_page(p_page_id)
  order by v.saved_at desc, v.id desc
  limit 300;
$$;

-- Before a restore: keep the current state as its own version.
create or replace function notes.seal_page_versions(p_page_id uuid)
returns void language sql security definer set search_path = '' as $$
  update notes.page_versions set sealed = true
  where page_id = p_page_id and not sealed and notes.owns_page(p_page_id);
$$;

revoke execute on function notes.record_version(), notes.page_history(uuid), notes.seal_page_versions(uuid) from public, anon;
grant execute on function notes.page_history(uuid), notes.seal_page_versions(uuid) to authenticated;

-- Baseline: every existing page starts with its current state as the first version.
insert into notes.page_versions (page_id, owner_id, title, icon, content, edited_by, started_at, saved_at, sealed)
select p.id, p.owner_id, p.title, p.icon, p.content, p.owner_id, p.updated_at, p.updated_at, true
from notes.pages p
where not (p.content = '[]'::jsonb and p.title = '');
