-- Show people by name where there is one (Google accounts come with it), else by the part of
-- their email before the @, as before.

create or replace function notes.user_name(p_user_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    nullif(trim(u.raw_user_meta_data->>'full_name'), ''),
    nullif(trim(u.raw_user_meta_data->>'name'), ''),
    split_part(u.email, '@', 1))
  from auth.users u where u.id = p_user_id;
$$;
revoke execute on function notes.user_name(uuid) from public, anon, authenticated;

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
      select jsonb_agg(jsonb_build_object('page_id', l.page_id, 'editor', l.editor, 'name', notes.user_name(l.user_id)))
      from notes.page_locks l
      where l.expires_at > now() and l.page_id in (select notes.page_subtree(g.root_id))
    ), '[]'::jsonb))
  from notes.page_grant(p_page_id) g;
$$;

create or replace function notes.page_lock_info(p_page_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('editor', l.editor, 'name', notes.user_name(l.user_id))
  from notes.page_locks l
  where l.page_id = p_page_id and l.expires_at > now() and notes.owns_page(p_page_id);
$$;

create or replace function notes.page_history(p_page_id uuid)
returns table (id bigint, title text, saved_at timestamptz, editor text, mine boolean)
language sql stable security definer set search_path = '' as $$
  select v.id, v.title, v.saved_at, notes.user_name(v.edited_by), v.edited_by = auth.uid()
  from notes.page_versions v
  where v.page_id = p_page_id and (notes.owns_page(p_page_id) or notes.member_can_edit(p_page_id))
  order by v.saved_at desc, v.id desc
  limit 300;
$$;

create or replace function notes.shared_with_me()
returns table (page_id uuid, title text, icon text, owner_name text, can_edit boolean)
language sql stable security definer set search_path = '' as $$
  select m.page_id, p.title, p.icon, notes.user_name(m.owner_id), m.can_edit
  from notes.page_members m
  join notes.pages p on p.id = m.page_id
  where m.email = notes.my_email() and exists (select 1 from notes.page_subtree(m.page_id))
  order by m.created_at desc;
$$;
