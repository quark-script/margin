-- Editing through a share link needs an account, so every edit has a name. Anyone with the
-- link can still read; only lock_page and shared_save (the write path) change.

alter table notes.page_locks add column if not exists user_id uuid references auth.users(id) on delete cascade;

create or replace function notes.lock_page(p_page_id uuid, p_editor text, p_token text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_holder text;
begin
  if auth.uid() is null then raise exception 'sign in to edit' using errcode = '42501'; end if;
  if length(coalesce(p_editor, '')) < 16 then raise exception 'invalid editor id'; end if;
  if p_token is null then
    if not notes.owns_page(p_page_id) then raise exception 'not allowed' using errcode = '42501'; end if;
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

create or replace function notes.shared_save(p_token text, p_page_id uuid, p_editor text, p_content jsonb, p_search_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_updated timestamptz;
begin
  if auth.uid() is null then raise exception 'sign in to edit' using errcode = '42501'; end if;
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

-- Viewers see who is editing: the part of the editor's email before the @.
create or replace function notes.shared_state(p_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when count(p.id) = 0 then null else jsonb_build_object(
    'can_edit', bool_or(t.can_edit),
    'pages', jsonb_agg(jsonb_build_object('id', p.id, 'updated_at', p.updated_at)),
    'locks', coalesce((
      select jsonb_agg(jsonb_build_object('page_id', l.page_id, 'editor', l.editor, 'name', split_part(u.email, '@', 1)))
      from notes.page_locks l left join auth.users u on u.id = l.user_id
      where l.expires_at > now() and l.page_id in (select x.id from notes.share_pages(p_token) x)
    ), '[]'::jsonb))
  end
  from notes.share_pages(p_token) t join notes.pages p on p.id = t.id;
$$;

revoke execute on function notes.lock_page(uuid, text, text), notes.shared_save(text, uuid, text, jsonb, text) from anon;
