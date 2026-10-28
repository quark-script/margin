-- Storage limits: each file up to 10 MB (the notes-media bucket's own file size limit) and
-- 100 MB per account. Uploads are refused once an account has stored 100 MB, so the last file
-- can take it up to 110 MB at most.

-- What the signed-in account has stored, in bytes.
create or replace function notes.my_media_bytes()
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint
  from storage.objects o
  where o.bucket_id = 'notes-media' and (storage.foldername(o.name))[1] = (select auth.uid())::text;
$$;

revoke execute on function notes.my_media_bytes() from public, anon;
grant execute on function notes.my_media_bytes() to authenticated;

-- Restrictive: on top of notes_media_insert_own, never instead of it.
create policy notes_media_quota on storage.objects as restrictive for insert to authenticated
  with check (bucket_id <> 'notes-media' or notes.my_media_bytes() < 100 * 1024 * 1024);

-- Your files that no page uses any more, for Settings > Storage to delete. Pages in the Trash
-- count as using theirs, and so do other people's pages (an image copied into a page you
-- shared). Files from the last day are left alone: the page that uses a new image may not have
-- synced yet. Version history doesn't count, so an older version can lose an image this way.
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

revoke execute on function notes.unused_files() from public, anon;
grant execute on function notes.unused_files() to authenticated;
