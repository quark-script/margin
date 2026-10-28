-- Sharing roles: Full access (edit, and share with others), Can edit, Can view. People with
-- full access manage sharing like the owner: invite people, change their access, remove them,
-- and set general access, for the page they were invited to and the pages inside it. Everyone
-- invited sees who has access; only the owner and people with full access see the email
-- addresses of others.

alter table notes.page_members add column if not exists can_share boolean not null default false;
do $$ begin
  alter table notes.page_members add constraint page_members_share_edits check (not can_share or can_edit);
exception when duplicate_object then null;
end $$;

create or replace function notes.member_role(p_can_edit boolean, p_can_share boolean)
returns text language sql immutable set search_path = '' as $$
  select case when p_can_share then 'full' when p_can_edit then 'edit' else 'view' end;
$$;

-- The owner, or someone invited with full access to the page or a page above it.
create or replace function notes.can_manage_sharing(p_page_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select notes.owns_page(p_page_id) or exists (
    select 1 from notes.page_members m
    where m.email = notes.my_email() and m.can_share
      and p_page_id in (select notes.page_subtree(m.page_id))
  );
$$;

-- The Share panel for people invited to a page (the owner's comes from their own tables):
-- the owner, everyone invited to the page or a page above it, and general access. Null for
-- anyone who can't open the page through an invite.
create or replace function notes.page_sharing(p_page_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  with recursive up as (
    select p.id, p.parent_id, p.title, 0 as depth from notes.pages p where p.id = p_page_id
    union all
    select p.id, p.parent_id, p.title, up.depth + 1
    from notes.pages p join up on p.id = up.parent_id
    where up.depth < 200
  ), people as (
    -- One row per person: their strongest access, from the nearest page that gives it.
    select distinct on (m.email) m.email, notes.member_role(m.can_edit, m.can_share) as role,
      up.id as via_id, up.title as via_title, up.depth, m.created_at
    from up join notes.page_members m on m.page_id = up.id
    order by m.email, m.can_share desc, m.can_edit desc, up.depth
  ), ctx as (
    select pg.owner_id, notes.my_email() as me, notes.can_manage_sharing(p_page_id) as manage
    from notes.pages pg where pg.id = p_page_id
  )
  select jsonb_build_object(
    'can_manage', ctx.manage,
    'role', case when ctx.owner_id = auth.uid() then 'owner' else (select pp.role from people pp where pp.email = ctx.me) end,
    'owner', jsonb_build_object(
      'name', notes.user_name(ctx.owner_id),
      'email', (select u.email from auth.users u where u.id = ctx.owner_id)),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'email', case when ctx.manage or pp.email = ctx.me then pp.email end,
        -- Without an account there's no name yet; only those who manage sharing see the address.
        'name', (select notes.user_name(u.id) from auth.users u where lower(u.email) = pp.email limit 1),
        'role', pp.role,
        'you', pp.email = ctx.me,
        'via', case when pp.depth > 0 then jsonb_build_object('id', pp.via_id, 'title', pp.via_title) end
      ) order by pp.depth, pp.created_at)
      from people pp), '[]'::jsonb),
    'link', (
      select jsonb_build_object(
        'can_edit', s.can_edit,
        'via', case when up.depth > 0 then jsonb_build_object('id', up.id, 'title', up.title) end)
      from up join notes.shares s on s.page_id = up.id
      order by up.depth limit 1))
  from ctx
  where ctx.owner_id = auth.uid()
     or exists (select 1 from notes.page_grant(p_page_id) g where g.via = 'invite');
$$;

-- For people with full access (the owner writes notes.page_members directly).
create or replace function notes.share_invite(p_page_id uuid, p_email text, p_role text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(p_email));
  v_owner uuid;
begin
  if not notes.can_manage_sharing(p_page_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_role not in ('view', 'edit', 'full') then raise exception 'invalid role'; end if;
  select p.owner_id into v_owner from notes.pages p where p.id = p_page_id;
  if v_email = (select lower(u.email) from auth.users u where u.id = v_owner) then
    raise exception 'already has access' using errcode = '23505';
  end if;
  insert into notes.page_members (page_id, owner_id, email, can_edit, can_share)
  values (p_page_id, v_owner, v_email, p_role <> 'view', p_role = 'full');
end $$;

-- Change someone's access. Not your own: leave the page instead.
create or replace function notes.share_set_role(p_page_id uuid, p_email text, p_role text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not notes.can_manage_sharing(p_page_id) or lower(p_email) = notes.my_email() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_role not in ('view', 'edit', 'full') then raise exception 'invalid role'; end if;
  update notes.page_members set can_edit = p_role <> 'view', can_share = p_role = 'full'
  where page_id = p_page_id and email = lower(p_email);
end $$;

create or replace function notes.share_remove(p_page_id uuid, p_email text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not notes.can_manage_sharing(p_page_id) or lower(p_email) = notes.my_email() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from notes.page_members where page_id = p_page_id and email = lower(p_email);
end $$;

-- General access: 'off', or anyone with the link can 'view' or 'edit'.
create or replace function notes.share_set_link(p_page_id uuid, p_mode text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not notes.can_manage_sharing(p_page_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_mode = 'off' then
    delete from notes.shares where page_id = p_page_id;
  elsif p_mode in ('view', 'edit') then
    insert into notes.shares (page_id, owner_id, can_edit)
    select p.id, p.owner_id, p_mode = 'edit' from notes.pages p where p.id = p_page_id
    on conflict (page_id) do update set can_edit = excluded.can_edit;
  else
    raise exception 'invalid mode';
  end if;
end $$;

revoke execute on function
  notes.member_role(boolean, boolean), notes.can_manage_sharing(uuid), notes.page_sharing(uuid),
  notes.share_invite(uuid, text, text), notes.share_set_role(uuid, text, text),
  notes.share_remove(uuid, text), notes.share_set_link(uuid, text)
from public, anon;
grant execute on function
  notes.can_manage_sharing(uuid), notes.page_sharing(uuid), notes.share_invite(uuid, text, text),
  notes.share_set_role(uuid, text, text), notes.share_remove(uuid, text), notes.share_set_link(uuid, text)
to authenticated;
