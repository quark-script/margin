-- Margin's database. Run this once, in the SQL editor of a new Supabase project.
--
-- Everything lives in the "notes" schema, plus the private "notes-media" storage bucket. Then add
-- "notes" to the exposed schemas (Project Settings > Data API). The rest of the setup is in
-- docs/self-hosting.md.
--
-- Row level security keeps each person's pages to themselves. Anything shared goes through the
-- security definer functions below, and each checks the caller's access first.

set check_function_bodies = off;

create extension if not exists pgcrypto with schema extensions;

create schema notes;
grant usage on schema notes to anon, authenticated, service_role;

-- Tables ------------------------------------------------------------------------------------------

-- Pages nest through parent_id. content is the editor's JSON; search_text is its plain text.
create table notes.pages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  parent_id uuid references notes.pages (id) on delete cascade,
  title text not null default '',
  icon text,
  content jsonb not null default '[]',
  search_text text not null default '',
  position double precision not null default 0,
  is_favorite boolean not null default false,
  is_archived boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  fts tsvector generated always as (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(search_text, ''))) stored,
  constraint pages_not_own_parent check (parent_id is null or parent_id <> id)
);
create index pages_owner_parent_idx on notes.pages (owner_id, parent_id, position);
create index pages_parent_idx on notes.pages (parent_id);
create index pages_owner_updated_idx on notes.pages (owner_id, updated_at desc);
create index pages_fts_idx on notes.pages using gin (fts);

-- "Anyone with the link": one row per page that has it on. The token serves old /s/<token> links.
create table notes.shares (
  page_id uuid primary key references notes.pages (id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  token text not null unique default replace(replace(rtrim(encode(extensions.gen_random_bytes(18), 'base64'), '='), '+', '-'), '/', '_'),
  can_edit boolean not null default false,
  created_at timestamptz not null default now(),
  views integer not null default 0,
  last_viewed_at timestamptz
);

-- People invited to a page, by email. Access covers the pages inside it too.
create table notes.page_members (
  page_id uuid not null references notes.pages (id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  email text not null check (email = lower(email) and email like '_%@_%'),
  can_edit boolean not null default false,
  created_at timestamptz not null default now(),
  can_share boolean not null default false,
  primary key (page_id, email),
  constraint page_members_share_edits check (not can_share or can_edit)
);
create index page_members_email on notes.page_members (email);

-- Who is editing a page that others can edit too (see lock_page).
create table notes.page_locks (
  page_id uuid primary key references notes.pages (id) on delete cascade,
  editor text not null,
  expires_at timestamptz not null,
  user_id uuid references auth.users (id) on delete cascade
);

-- Version history, written by the record_version trigger.
create table notes.page_versions (
  id bigint generated always as identity primary key,
  page_id uuid not null references notes.pages (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  title text not null default '',
  icon text,
  content jsonb not null,
  edited_by uuid references auth.users (id) on delete set null,
  started_at timestamptz not null default now(),
  saved_at timestamptz not null default now(),
  sealed boolean not null default false,
  signature text,
  edited_via text
);
create index page_versions_page_saved on notes.page_versions (page_id, saved_at desc);

-- Invitation emails sent, for the daily limit in the send-invite edge function.
create table notes.invite_emails (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  page_id uuid not null references notes.pages (id) on delete cascade,
  email text not null,
  sent_at timestamptz not null default now()
);
create index invite_emails_owner_sent on notes.invite_emails (owner_id, sent_at desc);

-- Who has a page shared by invite open (here_until), and who opened it before.
create table notes.page_views (
  page_id uuid not null references notes.pages (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  here_until timestamptz not null default now(),
  visits integer not null default 1,
  primary key (page_id, user_id)
);

-- AI agent calls this minute and today, per account (see agent_take).
create table notes.agent_usage (
  user_id uuid primary key references auth.users (id) on delete cascade,
  minute_start timestamptz not null default date_trunc('minute', now()),
  minute_reads integer not null default 0,
  minute_writes integer not null default 0,
  day_start date not null default (now() at time zone 'utc')::date,
  day_reads integer not null default 0,
  day_writes integer not null default 0
);

-- When each connected AI app was last used, per account.
create table notes.agent_clients (
  user_id uuid not null references auth.users (id) on delete cascade,
  client_id uuid not null,
  last_used_at timestamptz not null default now(),
  primary key (user_id, client_id)
);

alter table notes.pages enable row level security;
alter table notes.shares enable row level security;
alter table notes.page_members enable row level security;
alter table notes.page_locks enable row level security;
alter table notes.page_versions enable row level security;
alter table notes.invite_emails enable row level security;
alter table notes.page_views enable row level security;
alter table notes.agent_usage enable row level security;
alter table notes.agent_clients enable row level security;

-- Functions ---------------------------------------------------------------------------------------

-- Pages and version history

-- Keeps updated_at and archived_at current.
create or replace function notes.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if new.is_archived and not old.is_archived then
    new.archived_at := now();
  elsif not new.is_archived then
    new.archived_at := null;
  end if;
  return new;
end;
$$;

-- Does the caller own this page? A function, so policies on notes.pages can ask it without
-- recursing into themselves.
create or replace function notes.owns_page(page_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from notes.pages where id = page_id and owner_id = (select auth.uid()));
$$;

-- What a version looks like, as a hash of its title, icon and content without block ids,
-- default styling or empty lines. Versions with the same signature look the same. It reads
-- jsonb's text form, where keys come in a fixed order and quotes inside text are escaped, so
-- nothing typed into a page can pass for structure.
create or replace function notes.content_signature(p_title text, p_icon text, p_content jsonb)
returns text language plpgsql immutable set search_path = '' as $$
declare
  s text := coalesce(p_content, '[]'::jsonb)::text;
  before text;
  -- Styling that is the default anyway.
  d constant text := '(?:"(?:textColor|backgroundColor)": "default"|"textAlignment": "left"|"(?:isToggleable|checked)": false)';
  -- A block or a piece of text with nothing in it. Table cells stay: they hold the table's shape.
  e constant text := '(?:\{"type": "(?!tableCell")[^"]*"(?:, "props": \{[^{}]*\})?, "content": \[\]\}|\{"text": "", "type": "text"\})';
begin
  s := regexp_replace(s, '"id": "[^"]*", ', '', 'g');
  s := regexp_replace(s, ', ' || d, '', 'g');
  s := regexp_replace(s, d || ', ', '', 'g');
  s := regexp_replace(s, '\{' || d || '\}', '{}', 'g');
  loop -- removing an empty block can leave its parent empty
    before := s;
    s := regexp_replace(s, ', "(?:props|styles)": \{\}|, "children": \[\]', '', 'g');
    s := regexp_replace(s, ', ' || e, '', 'g');
    s := regexp_replace(s, e || ', ', '', 'g');
    s := regexp_replace(s, e, '', 'g');
    exit when s = before;
  end loop;
  return md5(btrim(coalesce(p_title, '')) || chr(1) || coalesce(p_icon, '') || chr(1) || s);
end $$;

-- Every change to a page lands in its open version, one per editing session (the same person,
-- within 10 minutes of the last save and 30 of the start). A session that ends up looking like
-- the version before it is dropped, and changes nobody can see aren't recorded. Past 30 days,
-- only the last version of each day is kept.
create or replace function notes.record_version()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v notes.page_versions%rowtype;
  v_editor uuid := coalesce(auth.uid(), new.owner_id);
  v_sig text;
begin
  if tg_op = 'UPDATE' and new.content is not distinct from old.content and new.title is not distinct from old.title
     and new.icon is not distinct from old.icon then
    return null;
  end if;
  if tg_op = 'INSERT' and new.content = '[]'::jsonb and new.title = '' then
    return null; -- a blank new page; its first edit starts the history
  end if;
  v_sig := notes.content_signature(new.title, new.icon, new.content);

  select * into v from notes.page_versions where page_id = new.id order by saved_at desc, id desc limit 1;
  if found and not v.sealed and v.edited_by is not distinct from v_editor
     and v.saved_at > now() - interval '10 minutes' and v.started_at > now() - interval '30 minutes' then
    if v_sig = (select x.signature from notes.page_versions x where x.page_id = new.id and x.id <> v.id
                order by x.saved_at desc, x.id desc limit 1) then
      -- This session is back to how the version before it looked, so it changed nothing.
      delete from notes.page_versions where id = v.id;
    else
      update notes.page_versions
        set title = new.title, icon = new.icon, content = new.content, signature = v_sig, saved_at = now()
        where id = v.id;
    end if;
  elsif found and v.signature = v_sig then
    null; -- nothing you can see changed since the last version
  else
    insert into notes.page_versions (page_id, owner_id, title, icon, content, edited_by, signature)
    values (new.id, new.owner_id, new.title, new.icon, new.content, v_editor, v_sig);
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

-- The OAuth app a request comes from (the client_id claim of its token), if any.
create or replace function notes.request_client()
returns uuid language sql stable set search_path = '' as $$
  select case when (auth.jwt() ->> 'client_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (auth.jwt() ->> 'client_id')::uuid end;
$$;

-- Versions made through an AI app are marked with the app's name.
create or replace function notes.version_via()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.edited_via := (select c.client_name from auth.oauth_clients c where c.id = notes.request_client());
  return new;
end $$;

-- Close the page's open version, so the next change starts its own.
create or replace function notes.seal_page_versions(p_page_id uuid)
returns void language sql security definer set search_path = '' as $$
  update notes.page_versions set sealed = true
  where page_id = p_page_id and not sealed and notes.owns_page(p_page_id);
$$;

-- A page's versions, newest first, for its owner and people who can edit it.
create or replace function notes.page_history(p_page_id uuid)
returns table (id bigint, title text, saved_at timestamptz, editor text, mine boolean)
language sql stable security definer set search_path = '' as $$
  select v.id, v.title, v.saved_at, notes.user_name(v.edited_by), v.edited_by = auth.uid()
  from notes.page_versions v
  where v.page_id = p_page_id and (notes.owns_page(p_page_id) or notes.member_can_edit(p_page_id))
  order by v.saved_at desc, v.id desc
  limit 300;
$$;

-- page_history, plus the AI app each version was made through.
create or replace function notes.page_history_v2(p_page_id uuid)
returns table (id bigint, title text, saved_at timestamptz, editor text, mine boolean, via text)
language sql stable security definer set search_path = '' as $$
  select v.id, v.title, v.saved_at, notes.user_name(v.edited_by), v.edited_by = auth.uid(), v.edited_via
  from notes.page_versions v
  where v.page_id = p_page_id and (notes.owns_page(p_page_id) or notes.member_can_edit(p_page_id))
  order by v.saved_at desc, v.id desc
  limit 300;
$$;

-- One version's content.
create or replace function notes.page_version(p_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('title', v.title, 'icon', v.icon, 'content', v.content)
  from notes.page_versions v
  where v.id = p_id and (notes.owns_page(v.page_id) or notes.member_can_edit(v.page_id));
$$;

-- People

-- The caller's email, lowercased: invitations are by email.
create or replace function notes.my_email()
returns text language sql stable security definer set search_path = '' as $$
  select lower(u.email) from auth.users u where u.id = auth.uid();
$$;

-- A person's name where there is one, else the part of their email before the @.
create or replace function notes.user_name(p_user_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    nullif(trim(u.raw_user_meta_data->>'full_name'), ''),
    nullif(trim(u.raw_user_meta_data->>'name'), ''),
    split_part(u.email, '@', 1))
  from auth.users u where u.id = p_user_id;
$$;

-- Access

-- A page and its sub-pages outside the trash; empty when it, or a page above it, is in the trash.
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

-- The best access the caller has to a page through an invite or a link: usable edit access
-- first, invites before the link, then the highest shared page. Nothing for pages in the trash.
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

-- Can this user open the page as its owner, or through an invite to it or a page above it?
create or replace function notes.invited_or_owner(p_page_id uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from notes.pages p where p.id = p_page_id and p.owner_id = p_user)
    or exists (
      select 1 from notes.page_members m join auth.users u on lower(u.email) = m.email
      where u.id = p_user and p_page_id in (select notes.page_subtree(m.page_id))
    );
$$;

-- Sharing

-- The Share panel for people invited to a page: the owner, everyone invited to it or a page
-- above it, and the link setting. Email addresses only for those who manage sharing.
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

create or replace function notes.leave_shared(p_root uuid)
returns void language sql security definer set search_path = '' as $$
  delete from notes.page_members where page_id = p_root and email = notes.my_email();
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

-- For the invitation email: a sign-up link when the address has no account yet.
create or replace function notes.email_has_account(p_email text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.users u where lower(u.email) = lower(p_email));
$$;

-- Opening and saving shared pages

-- What someone who isn't the owner sees: the shared page they reached and its sub-pages.
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

-- What changed, and who is editing, without the content.
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

-- The invited page and its sub-pages. Null without access.
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

create or replace function notes.member_state(p_root uuid)
returns jsonb language sql stable security definer set search_path to '' as $function$
  select jsonb_build_object(
    'can_edit', m.can_edit,
    'pages', (
      select jsonb_agg(jsonb_build_object('id', p.id, 'updated_at', p.updated_at))
      from notes.page_subtree(m.page_id) as t(id) join notes.pages p on p.id = t.id),
    'locks', coalesce((
      select jsonb_agg(jsonb_build_object('page_id', l.page_id, 'editor', l.editor, 'name', notes.user_name(l.user_id)))
      from notes.page_locks l
      where l.expires_at > now() and l.page_id in (select notes.page_subtree(m.page_id))
    ), '[]'::jsonb))
  from notes.page_members m
  where m.page_id = p_root and m.email = notes.my_email()
    and exists (select 1 from notes.page_subtree(m.page_id));
$function$;

-- Someone opened /p/<id> of a page that isn't theirs: the invited page it belongs to, if any.
create or replace function notes.member_root_for(p_page_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select a.root_id from notes.member_access(p_page_id) a;
$$;

-- Saves need a sign-in, edit access and the page's editing lock.
create or replace function notes.shared_page_save(p_page_id uuid, p_editor text, p_content jsonb, p_search_text text)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_updated timestamptz;
begin
  if auth.uid() is null then raise exception 'sign in to edit' using errcode = '42501'; end if;
  if not coalesce((select g.can_edit from notes.page_grant(p_page_id) g), false) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from notes.page_locks l where l.page_id = p_page_id and l.editor = p_editor and l.user_id = auth.uid() and l.expires_at > now()) then
    return jsonb_build_object('ok', false, 'reason', 'lock');
  end if;
  if jsonb_typeof(p_content) <> 'array' or octet_length(p_content::text) > 2000000 then
    raise exception 'invalid content';
  end if;
  update notes.pages set content = p_content, search_text = left(coalesce(p_search_text, ''), 20000)
  where id = p_page_id returning updated_at into v_updated;
  update notes.page_locks set expires_at = now() + interval '30 seconds' where page_id = p_page_id;
  return jsonb_build_object('ok', true, 'updated_at', v_updated);
end $function$;

create or replace function notes.member_save(p_page_id uuid, p_editor text, p_content jsonb, p_search_text text)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_updated timestamptz;
begin
  if not notes.member_can_edit(p_page_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from notes.page_locks l where l.page_id = p_page_id and l.editor = p_editor and l.user_id = auth.uid() and l.expires_at > now()) then
    return jsonb_build_object('ok', false, 'reason', 'lock');
  end if;
  if jsonb_typeof(p_content) <> 'array' or octet_length(p_content::text) > 2000000 then
    raise exception 'invalid content';
  end if;
  update notes.pages set content = p_content, search_text = left(coalesce(p_search_text, ''), 20000)
  where id = p_page_id returning updated_at into v_updated;
  update notes.page_locks set expires_at = now() + interval '30 seconds' where page_id = p_page_id;
  return jsonb_build_object('ok', true, 'updated_at', v_updated);
end $function$;

-- Restore a version of a shared page.
create or replace function notes.member_restore(p_id bigint, p_editor text, p_search_text text)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  v_page uuid; v_title text; v_icon text; v_content jsonb; v_updated timestamptz;
begin
  select page_id, title, icon, content into v_page, v_title, v_icon, v_content
  from notes.page_versions where id = p_id;
  if v_page is null or not notes.member_can_edit(v_page) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from notes.page_locks l where l.page_id = v_page and l.editor = p_editor and l.user_id = auth.uid() and l.expires_at > now()) then
    return jsonb_build_object('ok', false, 'reason', 'lock');
  end if;
  update notes.page_versions set sealed = true where page_id = v_page and not sealed;
  update notes.pages
    set title = v_title, icon = v_icon, content = v_content, search_text = left(coalesce(p_search_text, ''), 20000)
    where id = v_page returning updated_at into v_updated;
  return jsonb_build_object('ok', true, 'updated_at', v_updated);
end $function$;

-- Links from before every page had one link (/s/<token>)

-- Pages reachable through a token: the shared page and its sub-pages outside the trash.
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

create or replace function notes.share_root(p_token text)
returns uuid language sql stable security definer set search_path = '' as $$
  select s.page_id from notes.shares s where s.token = p_token;
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

create or replace function notes.shared_state(p_token text)
returns jsonb language sql stable security definer set search_path to '' as $function$
  select case when count(p.id) = 0 then null else jsonb_build_object(
    'can_edit', bool_or(t.can_edit),
    'pages', jsonb_agg(jsonb_build_object('id', p.id, 'updated_at', p.updated_at)),
    'locks', coalesce((
      select jsonb_agg(jsonb_build_object('page_id', l.page_id, 'editor', l.editor, 'name', notes.user_name(l.user_id)))
      from notes.page_locks l
      where l.expires_at > now() and l.page_id in (select x.id from notes.share_pages(p_token) x)
    ), '[]'::jsonb))
  end
  from notes.share_pages(p_token) t join notes.pages p on p.id = t.id;
$function$;

create or replace function notes.shared_save(p_token text, p_page_id uuid, p_editor text, p_content jsonb, p_search_text text)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_updated timestamptz;
begin
  if auth.uid() is null then raise exception 'sign in to edit' using errcode = '42501'; end if;
  if not exists (select 1 from notes.share_pages(p_token) t where t.id = p_page_id and t.can_edit) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from notes.page_locks l where l.page_id = p_page_id and l.editor = p_editor and l.user_id = auth.uid() and l.expires_at > now()) then
    return jsonb_build_object('ok', false, 'reason', 'lock');
  end if;
  if jsonb_typeof(p_content) <> 'array' or octet_length(p_content::text) > 2000000 then
    raise exception 'invalid content';
  end if;
  update notes.pages set content = p_content, search_text = left(coalesce(p_search_text, ''), 20000)
  where id = p_page_id returning updated_at into v_updated;
  update notes.page_locks set expires_at = now() + interval '30 seconds' where page_id = p_page_id;
  return jsonb_build_object('ok', true, 'updated_at', v_updated);
end $function$;

-- Editing locks: people take turns on pages others can edit

-- Take the page, or keep holding it. A lock lasts 30 seconds unless renewed, and belongs to the
-- signed-in person who took it.
create or replace function notes.lock_page(p_page_id uuid, p_editor text, p_token text default null::text)
returns jsonb language plpgsql security definer set search_path to '' as $function$
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
    where (l.editor = excluded.editor and l.user_id = excluded.user_id) or l.expires_at < now()
  returning l.editor into v_holder;
  return jsonb_build_object('ok', v_holder is not null);
end $function$;

-- Releasing a lock ends it now; only its holder can.
create or replace function notes.unlock_page(p_page_id uuid, p_editor text)
returns void language sql security definer set search_path to '' as $function$
  update notes.page_locks set expires_at = now()
  where page_id = p_page_id and editor = p_editor and user_id = auth.uid() and expires_at > now();
$function$;

-- For the owner's app: is someone else editing this page right now?
create or replace function notes.page_lock_state(p_page_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  if not notes.owns_page(p_page_id) then return null; end if;
  return (select l.editor from notes.page_locks l where l.page_id = p_page_id and l.expires_at > now());
end $$;

create or replace function notes.page_lock_info(p_page_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('editor', l.editor, 'name', notes.user_name(l.user_id))
  from notes.page_locks l
  where l.page_id = p_page_id and l.expires_at > now() and notes.owns_page(p_page_id);
$$;

-- Presence and views

-- The "Show when I view shared pages" setting, kept in the user's metadata.
create or replace function notes.hides_views(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((u.raw_user_meta_data ->> 'hide_views')::boolean, false) from auth.users u where u.id = p_user;
$$;

-- Check in on a page you have open (p_here false: you're leaving it) and see who else is here.
-- The owner also sees who opened it before, when, and how many times.
create or replace function notes.page_presence(p_page_id uuid, p_here boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
begin
  if v_uid is null then return null; end if;
  select p.owner_id into v_owner from notes.pages p where p.id = p_page_id;
  if v_owner is null or not notes.invited_or_owner(p_page_id, v_uid) then return null; end if;
  if not notes.hides_views(v_uid) then
    insert into notes.page_views as v (page_id, user_id, here_until)
    values (p_page_id, v_uid, case when p_here then now() + interval '25 seconds' else now() end)
    on conflict (page_id, user_id) do update set
      visits = v.visits + case when v.last_seen_at < now() - interval '30 minutes' then 1 else 0 end,
      last_seen_at = now(),
      here_until = excluded.here_until;
  end if;
  return jsonb_build_object(
    'owner_view', v_uid = v_owner,
    'people', coalesce((
      select jsonb_agg(x.person order by x.here desc, x.last_seen_at desc)
      from (
        select v.here_until > now() as here, v.last_seen_at, jsonb_build_object(
          'id', v.user_id,
          'name', notes.user_name(v.user_id),
          'avatar', nullif(u.raw_user_meta_data ->> 'avatar_url', ''),
          'email', case when v_uid = v_owner or v.user_id = v_owner then u.email end,
          'owner', v.user_id = v_owner,
          'here', v.here_until > now(),
          'editing', exists (
            select 1 from notes.page_locks l
            where l.page_id = p_page_id and l.user_id = v.user_id and l.expires_at > now()),
          'last_seen_at', case when v_uid = v_owner then v.last_seen_at end,
          'visits', case when v_uid = v_owner then v.visits end
        ) as person
        from notes.page_views v join auth.users u on u.id = v.user_id
        where v.page_id = p_page_id and v.user_id <> v_uid
          and (v.here_until > now() or (v_uid = v_owner and v.user_id <> v_owner))
          and not notes.hides_views(v.user_id)
          and notes.invited_or_owner(p_page_id, v.user_id)
        order by v.here_until > now() desc, v.last_seen_at desc
        limit 50
      ) x
    ), '[]'::jsonb)
  );
end $$;

-- Someone opened a page through "Anyone with the link": count it on that link. Nobody is
-- identified, and people with their own access aren't counted.
create or replace function notes.record_link_view(p_page_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_root uuid;
begin
  if auth.uid() is not null and notes.invited_or_owner(p_page_id, auth.uid()) then return; end if;
  select g.root_id into v_root from notes.page_grant(p_page_id) g where g.via = 'link';
  if v_root is null then return; end if;
  update notes.shares set views = views + 1, last_viewed_at = now() where page_id = v_root;
end $$;

-- "Show when I view shared pages" turned off: forget which pages you opened.
create or replace function notes.forget_my_views()
returns void language sql security definer set search_path = '' as $$
  delete from notes.page_views where user_id = auth.uid();
$$;

-- Files

-- What the signed-in account has stored, in bytes.
create or replace function notes.my_media_bytes()
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint
  from storage.objects o
  where o.bucket_id = 'notes-media' and (storage.foldername(o.name))[1] = (select auth.uid())::text;
$$;

-- Your files that no page uses any more, for Settings > Storage to delete.
create or replace function notes.unused_files()
returns table (name text, size bigint) language sql stable security definer set search_path = '' as $$
  with mine as (
    select o.name, coalesce((o.metadata->>'size')::bigint, 0) as size
    from storage.objects o
    where o.bucket_id = 'notes-media' and (storage.foldername(o.name))[1] = (select auth.uid())::text
      and o.created_at < now() - interval '1 day'
  ), used as (
    select distinct m[1] as name
    from notes.pages p, regexp_matches(p.content::text, 'notes-media:([^"\\]+)', 'g') m
    where strpos(p.content::text, 'notes-media:' || (select auth.uid())::text || '/') > 0
  )
  select mine.name, mine.size from mine where mine.name not in (select used.name from used);
$$;

-- Invitees see the owner's images in pages shared with them.
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

-- For the share-file edge function: may this old link show this file?
create or replace function notes.share_has_file(p_token text, p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from notes.share_pages(p_token) t join notes.pages p on p.id = t.id
    where p_path like t.owner_id::text || '/%'
      and position(('notes-media:' || p_path) in p.content::text) > 0
  );
$$;

-- For the share-file edge function: may a link visitor see this file on this page?
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

-- For the delete-account edge function: every file an account stored.
create or replace function notes.account_files(p_user uuid)
returns setof text
language sql stable security definer set search_path = ''
as $$
  select o.name from storage.objects o
  where o.bucket_id = 'notes-media' and (storage.foldername(o.name))[1] = p_user::text
$$;

-- AI agents (the MCP server)

-- One agent call, before it runs: ok while under the limits (then counted), else which limit
-- and how many seconds until it resets. Writes: 30 a minute, 500 a day. Reads: 120 a minute,
-- 3,000 a day. Days are UTC.
create or replace function notes.agent_take(p_write boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_client uuid := notes.request_client();
  v_minute timestamptz := date_trunc('minute', now());
  v_day date := (now() at time zone 'utc')::date;
  u notes.agent_usage%rowtype;
  v_to_minute integer := ceil(extract(epoch from (v_minute + interval '1 minute' - now())));
  v_to_day integer := ceil(extract(epoch from (((v_day + 1)::timestamp at time zone 'utc') - now())));
begin
  if v_uid is null then raise exception 'sign in' using errcode = '42501'; end if;
  insert into notes.agent_usage (user_id) values (v_uid) on conflict (user_id) do nothing;
  select * into u from notes.agent_usage where user_id = v_uid for update;
  if u.minute_start < v_minute then
    u.minute_start := v_minute; u.minute_reads := 0; u.minute_writes := 0;
  end if;
  if u.day_start < v_day then
    u.day_start := v_day; u.day_reads := 0; u.day_writes := 0;
  end if;
  if p_write and u.minute_writes >= 30 then return jsonb_build_object('ok', false, 'limit', 'minute', 'retry_after', v_to_minute); end if;
  if p_write and u.day_writes >= 500 then return jsonb_build_object('ok', false, 'limit', 'day', 'retry_after', v_to_day); end if;
  if not p_write and u.minute_reads >= 120 then return jsonb_build_object('ok', false, 'limit', 'minute', 'retry_after', v_to_minute); end if;
  if not p_write and u.day_reads >= 3000 then return jsonb_build_object('ok', false, 'limit', 'day', 'retry_after', v_to_day); end if;
  if p_write then
    u.minute_writes := u.minute_writes + 1; u.day_writes := u.day_writes + 1;
  else
    u.minute_reads := u.minute_reads + 1; u.day_reads := u.day_reads + 1;
  end if;
  update notes.agent_usage set
    minute_start = u.minute_start, minute_reads = u.minute_reads, minute_writes = u.minute_writes,
    day_start = u.day_start, day_reads = u.day_reads, day_writes = u.day_writes
  where user_id = v_uid;
  if v_client is not null then
    insert into notes.agent_clients (user_id, client_id) values (v_uid, v_client)
    on conflict (user_id, client_id) do update set last_used_at = now();
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Settings: when each of your connected apps last did something.
create or replace function notes.my_agent_activity()
returns table (client_id uuid, last_used_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select a.client_id, a.last_used_at from notes.agent_clients a where a.user_id = auth.uid();
$$;

-- Your pages matching the words or containing the text, best first. Runs as you, so row level
-- security applies.
create or replace function notes.agent_search(p_query text, p_limit integer default 10)
returns table (id uuid, title text, icon text, parent_id uuid, updated_at timestamptz, snippet text)
language sql stable security invoker set search_path = '' as $$
  with q as (
    select websearch_to_tsquery('simple', p_query) as tsq,
           lower(trim(p_query)) as needle,
           '%' || replace(replace(replace(lower(trim(p_query)), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
  ), hits as (
    select p.id, p.title, p.icon, p.parent_id, p.updated_at, p.search_text, q.tsq, q.needle,
      (case when lower(p.title) like q.pat then 2 else 0 end)
      + (case when p.fts @@ q.tsq then 1 + ts_rank(p.fts, q.tsq) else 0 end)
      + (case when lower(p.search_text) like q.pat then 0.5 else 0 end) as score
    from notes.pages p, q
    where not p.is_archived and length(q.needle) > 0
      and (p.fts @@ q.tsq or lower(p.title) like q.pat or lower(p.search_text) like q.pat)
    order by score desc, p.updated_at desc
    limit least(greatest(coalesce(p_limit, 10), 1), 25)
  )
  select h.id, h.title, h.icon, h.parent_id, h.updated_at,
    case
      when strpos(lower(h.search_text), h.needle) > 0
        then substr(h.search_text, greatest(strpos(lower(h.search_text), h.needle) - 80, 1), 240)
      else ts_headline('simple', left(h.search_text, 20000), h.tsq,
                       'MaxWords=30, MinWords=10, ShortWord=2, MaxFragments=1, StartSel="", StopSel=""')
    end
  from hits h
  order by h.score desc, h.updated_at desc;
$$;

-- Triggers ----------------------------------------------------------------------------------------

create trigger pages_touch_updated_at before update on notes.pages
  for each row execute function notes.touch_updated_at();
create trigger pages_record_version after insert or update of content, title, icon on notes.pages
  for each row execute function notes.record_version();
create trigger page_versions_via before insert on notes.page_versions
  for each row execute function notes.version_via();

-- Row level security ------------------------------------------------------------------------------
-- Owners only. Tables without policies are reached through the functions above.

create policy pages_select_own on notes.pages for select to authenticated
  using (owner_id = (select auth.uid()));
create policy pages_insert_own on notes.pages for insert to authenticated
  with check (owner_id = (select auth.uid()) and (parent_id is null or notes.owns_page(parent_id)));
create policy pages_update_own on notes.pages for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and (parent_id is null or notes.owns_page(parent_id)));
create policy pages_delete_own on notes.pages for delete to authenticated
  using (owner_id = (select auth.uid()));
create policy shares_own on notes.shares for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and notes.owns_page(page_id));
create policy members_owner on notes.page_members for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and notes.owns_page(page_id));
create policy versions_own_read on notes.page_versions for select to authenticated
  using (owner_id = (select auth.uid()));

-- Grants ------------------------------------------------------------------------------------------

revoke all on all tables in schema notes from anon, authenticated, service_role;
grant select, insert, update, delete on notes.pages, notes.shares, notes.page_members to authenticated;
grant select on notes.page_versions to authenticated;
grant select, insert, update, delete, truncate, references, trigger
  on notes.pages, notes.shares, notes.page_members, notes.page_locks, notes.page_versions, notes.invite_emails
  to service_role;

revoke all on all functions in schema notes from public, anon, authenticated, service_role;
-- Page links and "Anyone with the link" work without an account.
grant execute on function notes.record_link_view(p_page_id uuid) to anon, authenticated;
grant execute on function notes.share_root(p_token text) to anon, authenticated;
grant execute on function notes.shared_pages(p_token text) to anon, authenticated;
grant execute on function notes.shared_state(p_token text) to anon, authenticated;
grant execute on function notes.shared_tree(p_page_id uuid) to anon, authenticated;
grant execute on function notes.shared_tree_state(p_page_id uuid) to anon, authenticated;
grant execute on function notes.agent_search(p_query text, p_limit integer) to authenticated;
grant execute on function notes.agent_take(p_write boolean) to authenticated;
grant execute on function notes.can_manage_sharing(p_page_id uuid) to authenticated;
grant execute on function notes.forget_my_views() to authenticated;
grant execute on function notes.leave_shared(p_root uuid) to authenticated;
grant execute on function notes.lock_page(p_page_id uuid, p_editor text, p_token text) to authenticated;
grant execute on function notes.member_can_read_file(p_path text) to authenticated;
grant execute on function notes.member_pages(p_root uuid) to authenticated;
grant execute on function notes.member_restore(p_id bigint, p_editor text, p_search_text text) to authenticated;
grant execute on function notes.member_root_for(p_page_id uuid) to authenticated;
grant execute on function notes.member_save(p_page_id uuid, p_editor text, p_content jsonb, p_search_text text) to authenticated;
grant execute on function notes.member_state(p_root uuid) to authenticated;
grant execute on function notes.my_agent_activity() to authenticated;
grant execute on function notes.my_media_bytes() to authenticated;
grant execute on function notes.owns_page(page_id uuid) to authenticated;
grant execute on function notes.page_history(p_page_id uuid) to authenticated;
grant execute on function notes.page_history_v2(p_page_id uuid) to authenticated;
grant execute on function notes.page_lock_info(p_page_id uuid) to authenticated;
grant execute on function notes.page_lock_state(p_page_id uuid) to authenticated;
grant execute on function notes.page_presence(p_page_id uuid, p_here boolean) to authenticated;
grant execute on function notes.page_sharing(p_page_id uuid) to authenticated;
grant execute on function notes.page_version(p_id bigint) to authenticated;
grant execute on function notes.seal_page_versions(p_page_id uuid) to authenticated;
grant execute on function notes.share_invite(p_page_id uuid, p_email text, p_role text) to authenticated;
grant execute on function notes.share_remove(p_page_id uuid, p_email text) to authenticated;
grant execute on function notes.share_set_link(p_page_id uuid, p_mode text) to authenticated;
grant execute on function notes.share_set_role(p_page_id uuid, p_email text, p_role text) to authenticated;
grant execute on function notes.shared_page_save(p_page_id uuid, p_editor text, p_content jsonb, p_search_text text) to authenticated;
grant execute on function notes.shared_save(p_token text, p_page_id uuid, p_editor text, p_content jsonb, p_search_text text) to authenticated;
grant execute on function notes.shared_with_me() to authenticated;
grant execute on function notes.unlock_page(p_page_id uuid, p_editor text) to authenticated;
grant execute on function notes.unused_files() to authenticated;
-- For the edge functions, which use the service role.
grant execute on function notes.account_files(p_user uuid) to service_role;
grant execute on function notes.email_has_account(p_email text) to service_role;
grant execute on function notes.share_has_file(p_token text, p_path text) to service_role;
grant execute on function notes.share_has_file_page(p_page_id uuid, p_path text) to service_role;

-- Storage: images and files, 10 MB each and 100 MB per account, in a folder per account ---------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('notes-media', 'notes-media', false, 10485760,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'application/pdf'])
on conflict (id) do nothing;

create policy notes_media_select_own on storage.objects for select to authenticated
  using (bucket_id = 'notes-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy notes_media_select_member on storage.objects for select to authenticated
  using (bucket_id = 'notes-media' and notes.member_can_read_file(name));
create policy notes_media_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'notes-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy notes_media_quota on storage.objects as restrictive for insert to authenticated
  with check (bucket_id <> 'notes-media' or notes.my_media_bytes() < 100 * 1024 * 1024);
create policy notes_media_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'notes-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- Realtime: other devices hear about page changes as they happen --------------------------------

alter publication supabase_realtime add table notes.pages;
