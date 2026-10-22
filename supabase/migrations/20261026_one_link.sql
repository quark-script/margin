-- One link per page. /p/<id> works for everyone; what a visitor can do depends on their access:
-- the owner, people invited to the page (or a page above it), or anyone, when the page (or a
-- page above it) has general access "Anyone with the link" (a row in notes.shares). Share
-- tokens are no longer handed out; share_root() keeps old /s/<token> links working.
--
-- The token-based functions from earlier migrations stay for app versions still cached on
-- devices; the app now uses the functions below.

-- The best access the caller has to a page: usable edit access first, invites before the
-- link, and the highest shared page (the most context). Nothing if the page or a page above
-- it is in trash.
create or replace function notes.page_grant(p_page_id uuid)
returns table (root_id uuid, can_edit boolean, via text)
language sql stable security definer set search_path = '' as $$
  with recursive up as (
    select p.id, p.parent_id, p.is_archived, 0 as depth from notes.pages p where p.id = p_page_id
    union all
    select p.id, p.parent_id, p.is_archived, up.depth + 1
    from notes.pages p join up on p.id = up.parent_id
    where up.depth < 200
  ), grants as (
    select m.page_id as root_id, m.can_edit, 'invite'::text as via, up.depth
    from up join notes.page_members m on m.page_id = up.id
    where m.email = notes.my_email()
    union all
    select s.page_id, s.can_edit, 'link', up.depth
    from up join notes.shares s on s.page_id = up.id
  )
  select g.root_id, g.can_edit, g.via from grants g
  where not exists (select 1 from up where up.is_archived)
  order by
    (g.can_edit and (g.via = 'invite' or auth.uid() is not null)) desc,
    (g.via = 'invite') desc,
    g.depth desc
  limit 1;
$$;

-- What a non-owner sees: the shared page they reached and its sub-pages.
create or replace function notes.shared_tree(p_page_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'root_id', g.root_id,
    'can_edit', g.can_edit,
    'via', g.via,
    'pages', (
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'parent_id', p.parent_id, 'title', p.title, 'icon', p.icon, 'content', p.content,
        'position', p.position, 'created_at', p.created_at, 'updated_at', p.updated_at))
      from notes.page_subtree(g.root_id) as t(id) join notes.pages p on p.id = t.id))
  from notes.page_grant(p_page_id) g;
$$;

-- Cheap poll: what changed, who is editing.
create or replace function notes.shared_tree_state(p_page_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'root_id', g.root_id,
    'can_edit', g.can_edit,
    'via', g.via,
    'pages', (
      select jsonb_agg(jsonb_build_object('id', p.id, 'updated_at', p.updated_at))
      from notes.page_subtree(g.root_id) as t(id) join notes.pages p on p.id = t.id),
    'locks', coalesce((
      select jsonb_agg(jsonb_build_object('page_id', l.page_id, 'editor', l.editor, 'name', split_part(u.email, '@', 1)))
      from notes.page_locks l left join auth.users u on u.id = l.user_id
      where l.expires_at > now() and l.page_id in (select notes.page_subtree(g.root_id))
    ), '[]'::jsonb))
  from notes.page_grant(p_page_id) g;
$$;

-- Saves from anyone with edit access who isn't the owner. Needs an account and the lock.
create or replace function notes.shared_page_save(p_page_id uuid, p_editor text, p_content jsonb, p_search_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_updated timestamptz;
begin
  if auth.uid() is null then raise exception 'sign in to edit' using errcode = '42501'; end if;
  if not coalesce((select g.can_edit from notes.page_grant(p_page_id) g), false) then
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

-- Locks without a token: the owner, or anyone signed in with edit access.
create or replace function notes.lock_page(p_page_id uuid, p_editor text, p_token text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_holder text;
begin
  if auth.uid() is null then raise exception 'sign in to edit' using errcode = '42501'; end if;
  if length(coalesce(p_editor, '')) < 16 then raise exception 'invalid editor id'; end if;
  if p_token is null then
    if not (notes.owns_page(p_page_id) or coalesce((select g.can_edit from notes.page_grant(p_page_id) g), false)) then
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

-- Old /s/<token> links: the page they point at.
create or replace function notes.share_root(p_token text)
returns uuid language sql stable security definer set search_path = '' as $$
  select s.page_id from notes.shares s where s.token = p_token;
$$;

-- For the share-file edge function: may a link visitor see this image on this page?
create or replace function notes.share_has_file_page(p_page_id uuid, p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from notes.page_grant(p_page_id) g
    cross join lateral notes.page_subtree(g.root_id) as t(id)
    join notes.pages p on p.id = t.id
    where g.via = 'link'
      and p_path like p.owner_id::text || '/%'
      and position(('notes-media:' || p_path) in p.content::text) > 0
  );
$$;

-- Invitation emails sent, for the daily cap. Written by the send-invite edge function only.
create table notes.invite_emails (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  page_id uuid not null references notes.pages(id) on delete cascade,
  email text not null,
  sent_at timestamptz not null default now()
);
create index invite_emails_owner_sent on notes.invite_emails (owner_id, sent_at desc);
alter table notes.invite_emails enable row level security; -- no policies: service role only
grant all on notes.invite_emails to service_role;

-- For the invitation email: link to sign-up instead when the address has no account yet.
create or replace function notes.email_has_account(p_email text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.users u where lower(u.email) = lower(p_email));
$$;

revoke execute on function
  notes.page_grant(uuid), notes.shared_tree(uuid), notes.shared_tree_state(uuid),
  notes.shared_page_save(uuid, text, jsonb, text), notes.share_root(text),
  notes.share_has_file_page(uuid, text), notes.email_has_account(text)
from public, anon, authenticated;
grant execute on function notes.shared_tree(uuid), notes.shared_tree_state(uuid), notes.share_root(text) to anon, authenticated;
grant execute on function notes.shared_page_save(uuid, text, jsonb, text) to authenticated;
grant execute on function notes.share_has_file_page(uuid, text), notes.email_has_account(text) to service_role;
