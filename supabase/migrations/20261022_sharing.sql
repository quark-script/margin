-- Share a page (and its sub-pages) with anyone who has the link; optionally let them edit.
-- Anonymous visitors never touch the tables: everything goes through the security definer
-- functions below, which check the link token first.

create table notes.shares (
  page_id uuid primary key references notes.pages(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  token text not null unique
    default replace(replace(rtrim(encode(extensions.gen_random_bytes(18), 'base64'), '='), '+', '-'), '/', '_'),
  can_edit boolean not null default false,
  created_at timestamptz not null default now()
);
alter table notes.shares enable row level security;
create policy "shares_own" on notes.shares for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and notes.owns_page(page_id));
grant select, insert, update, delete on notes.shares to authenticated;
grant all on notes.shares to service_role;

-- One editor per page at a time. Locks expire 30s after the last renewal.
create table notes.page_locks (
  page_id uuid primary key references notes.pages(id) on delete cascade,
  editor text not null,
  expires_at timestamptz not null
);
alter table notes.page_locks enable row level security; -- no policies: functions only
grant all on notes.page_locks to service_role;

-- Pages reachable through a link: the shared page plus its sub-pages that aren't in trash.
-- Empty when the token is unknown or the shared page (or an ancestor) is in trash.
create or replace function notes.share_pages(p_token text)
returns table (id uuid, can_edit boolean, owner_id uuid)
language sql stable security definer set search_path = '' as $$
  with recursive s as (
    select sh.page_id, sh.can_edit, sh.owner_id from notes.shares sh where sh.token = p_token
  ), up as (
    select p.id, p.parent_id, p.is_archived from notes.pages p join s on p.id = s.page_id
    union
    select p.id, p.parent_id, p.is_archived from notes.pages p join up on p.id = up.parent_id
  ), tree as (
    select p.id from notes.pages p join s on p.id = s.page_id
    where not exists (select 1 from up where up.is_archived)
    union
    select c.id from notes.pages c join tree on c.parent_id = tree.id where not c.is_archived
  )
  select tree.id, s.can_edit, s.owner_id from tree cross join s;
$$;

create or replace function notes.shared_pages(p_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when count(p.id) = 0 then null else jsonb_build_object(
    'can_edit', bool_or(t.can_edit),
    'root_id', (select sh.page_id from notes.shares sh where sh.token = p_token),
    'pages', jsonb_agg(jsonb_build_object(
      'id', p.id, 'parent_id', p.parent_id, 'title', p.title, 'icon', p.icon, 'content', p.content,
      'position', p.position, 'created_at', p.created_at, 'updated_at', p.updated_at)))
  end
  from notes.share_pages(p_token) t join notes.pages p on p.id = t.id;
$$;

-- Cheap poll for viewers: what changed, who is editing.
create or replace function notes.shared_state(p_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when count(p.id) = 0 then null else jsonb_build_object(
    'can_edit', bool_or(t.can_edit),
    'pages', jsonb_agg(jsonb_build_object('id', p.id, 'updated_at', p.updated_at)),
    'locks', coalesce((
      select jsonb_agg(jsonb_build_object('page_id', l.page_id, 'editor', l.editor))
      from notes.page_locks l
      where l.expires_at > now() and l.page_id in (select x.id from notes.share_pages(p_token) x)
    ), '[]'::jsonb))
  end
  from notes.share_pages(p_token) t join notes.pages p on p.id = t.id;
$$;

-- Take or renew the lock. Owners lock without a token; link editors pass theirs.
create or replace function notes.lock_page(p_page_id uuid, p_editor text, p_token text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_holder text;
begin
  if length(coalesce(p_editor, '')) < 16 then raise exception 'invalid editor id'; end if;
  if p_token is null then
    if not notes.owns_page(p_page_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  elsif not exists (select 1 from notes.share_pages(p_token) t where t.id = p_page_id and t.can_edit) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into notes.page_locks as l (page_id, editor, expires_at)
  values (p_page_id, p_editor, now() + interval '30 seconds')
  on conflict (page_id) do update set editor = excluded.editor, expires_at = excluded.expires_at
    where l.editor = excluded.editor or l.expires_at < now()
  returning l.editor into v_holder;
  return jsonb_build_object('ok', v_holder is not null);
end $$;

create or replace function notes.unlock_page(p_page_id uuid, p_editor text)
returns void language sql security definer set search_path = '' as $$
  delete from notes.page_locks where page_id = p_page_id and editor = p_editor;
$$;

-- For the owner's app: is someone else editing this page right now?
create or replace function notes.page_lock_state(p_page_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  if not notes.owns_page(p_page_id) then return null; end if;
  return (select l.editor from notes.page_locks l where l.page_id = p_page_id and l.expires_at > now());
end $$;

-- Saves from a link editor. Requires edit access and holding the page's lock.
create or replace function notes.shared_save(p_token text, p_page_id uuid, p_editor text, p_content jsonb, p_search_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_updated timestamptz;
begin
  if not exists (select 1 from notes.share_pages(p_token) t where t.id = p_page_id and t.can_edit) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from notes.page_locks l where l.page_id = p_page_id and l.editor = p_editor and l.expires_at > now()) then
    return jsonb_build_object('ok', false, 'reason', 'lock');
  end if;
  if jsonb_typeof(p_content) <> 'array' or octet_length(p_content::text) > 2000000 then
    raise exception 'invalid content';
  end if;
  update notes.pages set content = p_content, search_text = left(coalesce(p_search_text, ''), 20000)
  where id = p_page_id returning updated_at into v_updated;
  update notes.page_locks set expires_at = now() + interval '30 seconds' where page_id = p_page_id;
  return jsonb_build_object('ok', true, 'updated_at', v_updated);
end $$;

-- Used by the share-file edge function: may this link show this image?
create or replace function notes.share_has_file(p_token text, p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from notes.share_pages(p_token) t join notes.pages p on p.id = t.id
    where p_path like t.owner_id::text || '/%'
      and position(('notes-media:' || p_path) in p.content::text) > 0
  );
$$;

grant usage on schema notes to anon;
revoke execute on all functions in schema notes from public, anon;
alter default privileges in schema notes revoke execute on functions from public;
grant execute on function notes.owns_page(uuid) to authenticated;
grant execute on function notes.shared_pages(text), notes.shared_state(text),
  notes.shared_save(text, uuid, text, jsonb, text), notes.lock_page(uuid, text, text),
  notes.unlock_page(uuid, text) to anon, authenticated;
grant execute on function notes.page_lock_state(uuid) to authenticated;
grant execute on function notes.share_has_file(text, text) to service_role;
