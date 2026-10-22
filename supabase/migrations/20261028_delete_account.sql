-- Delete your account (account menu > Delete account). The delete-account edge function, with
-- the service role:
--   1. has_other_app_data: refuses while another app sharing this project still has rows for
--      the person, since deleting the sign-in would delete those too;
--   2. account_files: removes the person's images through the Storage API (deleting the rows in
--      SQL would leave the files behind);
--   3. deletes the invitations other people sent to their email address (page_members and the
--      invite_emails log), which aren't tied to the sign-in;
--   4. deletes the sign-in. Their pages, history, links, invitations and locks go with it (on
--      delete cascade); edits they made on other people's pages stay there without their name
--      (on delete set null).

-- Rows outside Margin's schema that point at this sign-in, through any foreign key to auth.users.
create or replace function notes.has_other_app_data(p_user uuid)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  r record;
  found_row boolean;
begin
  for r in
    select n.nspname as sch, c.relname as tbl, a.attname as col
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
    where con.contype = 'f' and con.confrelid = 'auth.users'::regclass
      and cardinality(con.conkey) = 1 and n.nspname not in ('auth', 'notes')
  loop
    execute format('select exists (select 1 from %I.%I where %I = $1)', r.sch, r.tbl, r.col)
      into found_row using p_user;
    if found_row then
      return true;
    end if;
  end loop;
  return false;
end $$;

create or replace function notes.account_files(p_user uuid)
returns setof text
language sql stable security definer set search_path = ''
as $$
  select o.name from storage.objects o
  where o.bucket_id = 'notes-media' and (storage.foldername(o.name))[1] = p_user::text
$$;

revoke all on function notes.has_other_app_data(uuid) from public, anon, authenticated;
revoke all on function notes.account_files(uuid) from public, anon, authenticated;
grant execute on function notes.has_other_app_data(uuid) to service_role;
grant execute on function notes.account_files(uuid) to service_role;
