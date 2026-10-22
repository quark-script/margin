-- Invite people to a page by email. Once signed in with that email they find it under "Shared
-- with me" and can view or edit it, sub-pages included. Like share links, everything goes
-- through the security definer functions below; notes.pages RLS stays owner-only, so the
-- owner's sync is untouched.

create table notes.page_members (
  page_id uuid not null references notes.pages(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  email text not null check (email = lower(email) and email like '_%@_%'),
  can_edit boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (page_id, email)
);
create index page_members_email on notes.page_members (email);
alter table notes.page_members enable row level security;
create policy "members_owner" on notes.page_members for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and notes.owns_page(page_id));
grant select, insert, update, delete on notes.page_members to authenticated;
grant all on notes.page_members to service_role;

create or replace function notes.my_email()
returns text language sql stable security definer set search_path = '' as $$
  select lower(u.email) from auth.users u where u.id = auth.uid();
$$;

-- A page and its sub-pages outside the trash; empty when it, or a page above it, is in trash.
create or replace function notes.page_subtree(p_root uuid)
returns setof uuid language sql stable security definer set search_path = '' as $$
  with recursive up as (
    select p.id, p.parent_id, p.is_archived from notes.pages p where p.id = p_root
    union
    select p.id, p.parent_id, p.is_archived from notes.pages p join up on p.id = up.parent_id
  ), tree as (
    select p.id from notes.pages p
    where p.id = p_root and not exists (select 1 from up where up.is_archived)
    union
    select c.id from notes.pages c join tree on c.parent_id = tree.id where not c.is_archived
  )
  select tree.id from tree;
$$;

-- The caller's invite covering a page (its own, or one on a page above it); edit access wins.
create or replace function notes.member_access(p_page_id uuid)
returns table (root_id uuid, can_edit boolean)
language sql stable security definer set search_path = '' as $$
  select m.page_id, m.can_edit from notes.page_members m
  where m.email = notes.my_email() and p_page_id in (select notes.page_subtree(m.page_id))
  order by m.can_edit desc, m.created_at
  limit 1;
$$;

create or replace function notes.member_can_edit(p_page_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select a.can_edit from notes.member_access(p_page_id) a), false);
$$;

-- For "Shared with me": invited pages that are still reachable.
create or replace function notes.shared_with_me()
returns table (page_id uuid, title text, icon text, owner_name text, can_edit boolean)
language sql stable security definer set search_path = '' as $$
  select m.page_id, p.title, p.icon, split_part(u.email, '@', 1), m.can_edit
  from notes.page_members m
  join notes.pages p on p.id = m.page_id
  left join auth.users u on u.id = m.owner_id
  where m.email = notes.my_email() and exists (select 1 from notes.page_subtree(m.page_id))
  order by m.created_at desc;
$$;

-- The invited page and its sub-pages, same shape as shared_pages. Null without access.
create or replace function notes.member_pages(p_root uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'can_edit', m.can_edit,
    'root_id', m.page_id,
    'pages', (
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'parent_id', p.parent_id, 'title', p.title, 'icon', p.icon, 'content', p.content,
        'position', p.position, 'created_at', p.created_at, 'updated_at', p.updated_at))
      from notes.page_subtree(m.page_id) as t(id) join notes.pages p on p.id = t.id))
  from notes.page_members m
  where m.page_id = p_root and m.email = notes.my_email()
    and exists (select 1 from notes.page_subtree(m.page_id));
$$;

-- Cheap poll, same shape as shared_state.
create or replace function notes.member_state(p_root uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'can_edit', m.can_edit,
    'pages', (
      select jsonb_agg(jsonb_build_object('id', p.id, 'updated_at', p.updated_at))
      from notes.page_subtree(m.page_id) as t(id) join notes.pages p on p.id = t.id),
    'locks', coalesce((
      select jsonb_agg(jsonb_build_object('page_id', l.page_id, 'editor', l.editor, 'name', split_part(u.email, '@', 1)))
      from notes.page_locks l left join auth.users u on u.id = l.user_id
      where l.expires_at > now() and l.page_id in (select notes.page_subtree(m.page_id))
    ), '[]'::jsonb))
  from notes.page_members m
  where m.page_id = p_root and m.email = notes.my_email()
    and exists (select 1 from notes.page_subtree(m.page_id));
$$;

-- Saves from an invited editor. Requires edit access and holding the page's lock.
create or replace function notes.member_save(p_page_id uuid, p_editor text, p_content jsonb, p_search_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_updated timestamptz;
begin
  if not notes.member_can_edit(p_page_id) then raise exception 'not allowed' using errcode = '42501'; end if;
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

create or replace function notes.leave_shared(p_root uuid)
returns void language sql security definer set search_path = '' as $$
  delete from notes.page_members where page_id = p_root and email = notes.my_email();
$$;

-- Someone opened /p/<id> of a page that isn't theirs: the invited page it belongs to, if any.
create or replace function notes.member_root_for(p_page_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select a.root_id from notes.member_access(p_page_id) a;
$$;

-- Owners lock without a token; that now includes invited editors.
create or replace function notes.lock_page(p_page_id uuid, p_editor text, p_token text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_holder text;
begin
  if auth.uid() is null then raise exception 'sign in to edit' using errcode = '42501'; end if;
  if length(coalesce(p_editor, '')) < 16 then raise exception 'invalid editor id'; end if;
  if p_token is null then
    if not (notes.owns_page(p_page_id) or notes.member_can_edit(p_page_id)) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
  elsif not exists (select 1 from notes.share_pages(p_token) t where t.id = p_page_id and t.can_edit) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into notes.page_locks as l (page_id, editor, user_id, expires_at)
  values (p_page_id, p_editor, auth.uid(), now() + interval '30 seconds')
  on conflict (page_id) do update
    set editor = excluded.editor, user_id = excluded.user_id, expires_at = excluded.expires_at
    where l.editor = excluded.editor or l.expires_at < now()
  returning l.editor into v_holder;
  return jsonb_build_object('ok', v_holder is not null);
end $$;

-- For the owner's app: who is editing this page right now (editor id and name).
create or replace function notes.page_lock_info(p_page_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('editor', l.editor, 'name', split_part(u.email, '@', 1))
  from notes.page_locks l left join auth.users u on u.id = l.user_id
  where l.page_id = p_page_id and l.expires_at > now() and notes.owns_page(p_page_id);
$$;

-- Version history for invited editors too.
create or replace function notes.page_history(p_page_id uuid)
returns table (id bigint, title text, saved_at timestamptz, editor text, mine boolean)
language sql stable security definer set search_path = '' as $$
  select v.id, v.title, v.saved_at, split_part(u.email, '@', 1), v.edited_by = auth.uid()
  from notes.page_versions v left join auth.users u on u.id = v.edited_by
  where v.page_id = p_page_id and (notes.owns_page(p_page_id) or notes.member_can_edit(p_page_id))
  order by v.saved_at desc, v.id desc
  limit 300;
$$;

create or replace function notes.page_version(p_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('title', v.title, 'icon', v.icon, 'content', v.content)
  from notes.page_versions v
  where v.id = p_id and (notes.owns_page(v.page_id) or notes.member_can_edit(v.page_id));
$$;

-- An invited editor restores a version (owners restore through their own sync). Needs the lock.
create or replace function notes.member_restore(p_id bigint, p_editor text, p_search_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_page uuid; v_title text; v_icon text; v_content jsonb; v_updated timestamptz;
begin
  select page_id, title, icon, content into v_page, v_title, v_icon, v_content
  from notes.page_versions where id = p_id;
  if v_page is null or not notes.member_can_edit(v_page) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from notes.page_locks l where l.page_id = v_page and l.editor = p_editor and l.expires_at > now()) then
    return jsonb_build_object('ok', false, 'reason', 'lock');
  end if;
  update notes.page_versions set sealed = true where page_id = v_page and not sealed;
  update notes.pages
    set title = v_title, icon = v_icon, content = v_content, search_text = left(coalesce(p_search_text, ''), 20000)
    where id = v_page returning updated_at into v_updated;
  return jsonb_build_object('ok', true, 'updated_at', v_updated);
end $$;

-- Invitees see the owner's images that appear in pages shared with them.
create or replace function notes.member_can_read_file(p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from notes.page_members m
    cross join lateral notes.page_subtree(m.page_id) as t(id)
    join notes.pages p on p.id = t.id
    where m.email = notes.my_email()
      and p_path like m.owner_id::text || '/%'
      and position(('notes-media:' || p_path) in p.content::text) > 0
  );
$$;
create policy "notes_media_select_member" on storage.objects for select to authenticated
  using (bucket_id = 'notes-media' and notes.member_can_read_file(name));

revoke execute on function
  notes.my_email(), notes.page_subtree(uuid), notes.member_access(uuid), notes.member_can_edit(uuid),
  notes.shared_with_me(), notes.member_pages(uuid), notes.member_state(uuid),
  notes.member_save(uuid, text, jsonb, text), notes.leave_shared(uuid), notes.member_root_for(uuid),
  notes.page_lock_info(uuid), notes.page_version(bigint), notes.member_restore(bigint, text, text),
  notes.member_can_read_file(text)
from public, anon;
grant execute on function
  notes.shared_with_me(), notes.member_pages(uuid), notes.member_state(uuid),
  notes.member_save(uuid, text, jsonb, text), notes.leave_shared(uuid), notes.member_root_for(uuid),
  notes.page_lock_info(uuid), notes.page_version(bigint), notes.member_restore(bigint, text, text),
  notes.member_can_read_file(text)
to authenticated;
