-- Version history counts only changes you can see. A save that changes nothing visible (new
-- block ids, empty lines, default styling) no longer starts a version, and an editing session
-- that ends up looking like the version before it is dropped. Icon changes now count.

alter table notes.page_versions add column if not exists signature text;

-- What a version looks like, as a hash: its title, icon and content without block ids,
-- default styling or empty lines. Versions with the same signature look the same.
-- It reads jsonb's text form, where keys come in a fixed order and quotes inside text are
-- escaped, so nothing typed into a page can pass for structure.
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

revoke execute on function notes.content_signature(text, text, jsonb) from public, anon, authenticated;

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

create or replace trigger pages_record_version after insert or update of content, title, icon on notes.pages
  for each row execute function notes.record_version();

-- Versions recorded so far: sign them, then drop the ones that look exactly like the version
-- before them.
update notes.page_versions set signature = notes.content_signature(title, icon, content);

delete from notes.page_versions v
using (
  select id, signature = lag(signature) over (partition by page_id order by saved_at, id) as unchanged
  from notes.page_versions
) d
where d.id = v.id and d.unchanged;
