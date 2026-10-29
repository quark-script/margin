-- AI agents (MCP clients) that act for someone through Supabase Auth's OAuth server: limits on
-- how much they can do, search on the server, and versions marked with the agent that made them.
-- Agents use the person's own access token, so every table's row level security applies as is.

-- How much each person's agents did this minute and today (one row per person, reset in place).
create table if not exists notes.agent_usage (
  user_id uuid primary key references auth.users (id) on delete cascade,
  minute_start timestamptz not null default date_trunc('minute', now()),
  minute_reads integer not null default 0,
  minute_writes integer not null default 0,
  day_start date not null default (now() at time zone 'utc')::date,
  day_reads integer not null default 0,
  day_writes integer not null default 0
);
-- When each connected app last did something (Settings shows it).
create table if not exists notes.agent_clients (
  user_id uuid not null references auth.users (id) on delete cascade,
  client_id uuid not null,
  last_used_at timestamptz not null default now(),
  primary key (user_id, client_id)
);
-- Only the functions below read or write them.
alter table notes.agent_usage enable row level security;
alter table notes.agent_clients enable row level security;
revoke all on notes.agent_usage, notes.agent_clients from anon, authenticated;

-- The OAuth app a request comes from (the client_id claim of its token), if any.
create or replace function notes.request_client()
returns uuid language sql stable set search_path = '' as $$
  select case when (auth.jwt() ->> 'client_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (auth.jwt() ->> 'client_id')::uuid end;
$$;

-- One agent call, before it runs: ok while under the limits (then counted), else which limit
-- and how many seconds until it resets. Writes: 30 a minute, 500 a day. Reads: 120 a minute,
-- 3000 a day. Days are UTC.
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

-- Your pages matching the words (in any order) or containing the text, best first: a match in
-- the title counts most. Runs as you, so row level security limits it to your pages. Pages in
-- the trash are left out (the caller also drops pages inside one).
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

-- A version started by an agent carries the app's name, so history can say "via Claude".
alter table notes.page_versions add column if not exists edited_via text;

create or replace function notes.version_via()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.edited_via := (select c.client_name from auth.oauth_clients c where c.id = notes.request_client());
  return new;
end $$;

create or replace trigger page_versions_via
  before insert on notes.page_versions
  for each row execute function notes.version_via();

-- page_history with who made each version through which app (page_history stays for old copies
-- of the app).
create or replace function notes.page_history_v2(p_page_id uuid)
returns table (id bigint, title text, saved_at timestamptz, editor text, mine boolean, via text)
language sql stable security definer set search_path = '' as $$
  select v.id, v.title, v.saved_at, notes.user_name(v.edited_by), v.edited_by = auth.uid(), v.edited_via
  from notes.page_versions v
  where v.page_id = p_page_id and (notes.owns_page(p_page_id) or notes.member_can_edit(p_page_id))
  order by v.saved_at desc, v.id desc
  limit 300;
$$;

revoke execute on function notes.request_client(), notes.version_via() from public, anon, authenticated;
revoke execute on function notes.agent_take(boolean), notes.my_agent_activity(), notes.agent_search(text, integer),
  notes.page_history_v2(uuid) from public, anon;
grant execute on function notes.agent_take(boolean), notes.my_agent_activity(), notes.agent_search(text, integer),
  notes.page_history_v2(uuid) to authenticated;
