-- Who is on a shared page right now, who opened it before (its owner sees that), and how many
-- times its link was opened. Only pages shared by invite take part: the owner and the people
-- invited check in while the page is open. Visitors through "Anyone with the link" are only
-- counted, never identified. "Show when I view shared pages" off (Settings) keeps you out of it.

create table if not exists notes.page_views (
  page_id uuid not null references notes.pages (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Checked in within the last few seconds: on the page now.
  here_until timestamptz not null default now(),
  -- Visits: a gap of 30 minutes starts a new one.
  visits integer not null default 1,
  primary key (page_id, user_id)
);
-- Only the functions below read or write it.
alter table notes.page_views enable row level security;
revoke all on notes.page_views from anon, authenticated;

alter table notes.shares
  add column if not exists views integer not null default 0,
  add column if not exists last_viewed_at timestamptz;

-- The "Show when I view shared pages" setting, kept in the user's metadata.
create or replace function notes.hides_views(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((u.raw_user_meta_data ->> 'hide_views')::boolean, false) from auth.users u where u.id = p_user;
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

-- Check in on a page you have open (p_here false: you're leaving it) and see who else is here.
-- Its owner also sees who opened it before, when, and how often; everyone else sees only who is
-- here now. Email addresses as in the Share panel: the owner sees everyone's, people invited see
-- the owner's. Null for visitors through the link and anyone who can't open the page.
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

-- Someone opened a page through "Anyone with the link" (once per visit; the app decides when):
-- count it on that link. Nobody is identified, and the owner and people invited aren't counted.
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

revoke execute on function notes.hides_views(uuid), notes.invited_or_owner(uuid, uuid) from public, anon, authenticated;
revoke execute on function notes.page_presence(uuid, boolean), notes.record_link_view(uuid), notes.forget_my_views()
from public, anon;
grant execute on function notes.page_presence(uuid, boolean), notes.forget_my_views() to authenticated;
grant execute on function notes.record_link_view(uuid) to anon, authenticated;
