-- Delete your account (account menu > Delete account). The delete-account edge function, with
-- the service role:
--   1. account_files: removes the person's images through the Storage API (deleting the rows in
--      SQL would leave the files behind);
--   2. deletes the invitations other people sent to their email address (page_members and the
--      invite_emails log), which aren't tied to the sign-in;
--   3. deletes the sign-in. Their pages, history, links, invitations and locks go with it (on
--      delete cascade); edits they made on other people's pages stay there without their name
--      (on delete set null).

create or replace function notes.account_files(p_user uuid)
returns setof text
language sql stable security definer set search_path = ''
as $$
  select o.name from storage.objects o
  where o.bucket_id = 'notes-media' and (storage.foldername(o.name))[1] = p_user::text
$$;

revoke all on function notes.account_files(uuid) from public, anon, authenticated;
grant execute on function notes.account_files(uuid) to service_role;
