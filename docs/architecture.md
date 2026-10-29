# Architecture

Margin is a single-page app (React and Vite) that keeps its data in the browser and syncs it with
Supabase. A few Vercel functions add the MCP server for AI apps.

## Offline first

- Pages live in IndexedDB ([`src/store/pages.ts`](../src/store/pages.ts)). Every edit lands there
  first and marks the page as pending; a debounced sync pushes pending pages to `notes.pages`.
- Changes from other devices come in on start, when the app is shown again, when it's back
  online, and live through Supabase Realtime. They're applied only to pages without pending
  edits, so what you just typed is never overwritten. Otherwise the last write wins, per page.
- Images stay on the device until their page syncs, then go to the private `notes-media` bucket,
  referenced in the page as `notes-media:<path>`.
- Without an account, nothing leaves the browser. Signing in moves those pages into the account.
- **Sync all pages** (Settings, per device, on by default): turned off, only pages shared with
  others sync, plus the pages they sit inside; everything else stays on the device.

## Data and access

The whole database is in [`supabase/schema.sql`](../supabase/schema.sql).

- Row level security keeps each person's pages to themselves. Everything shared goes through
  security definer functions that check the caller's access first, run with an empty
  `search_path`, and can be called only by the roles that need them.
- The browser holds only the publishable key. The service role is used only inside edge functions.

## Sharing

- Invites (`notes.page_members`) are by email and cover the page and every page inside it.
  Roles: Full access (edit, and manage sharing), Can edit, Can view.
- "Anyone with the link" (`notes.shares`) opens a page and the pages inside it to everyone with
  its address, to view or to edit. Editing always needs an account.
- People take turns on pages others can edit: whoever is typing holds a 30-second lock
  (`lock_page`) that only they can renew or release, and everyone else sees their name.
- Invitees see images through storage policies; link visitors through the `share-file` edge
  function.

## Version history

A trigger on `notes.pages` (`record_version`) writes every change into the page's open version,
one per editing session. Sessions that end up looking like the version before are dropped, and
past 30 days only the last version of each day is kept. The app shows what changed between
versions ([`src/lib/versionDiff.ts`](../src/lib/versionDiff.ts)).

## MCP server

[`api/mcp.ts`](../api/mcp.ts) is a stateless MCP server (Streamable HTTP). AI apps sign in with
OAuth through Supabase Auth's OAuth 2.1 server, and Margin shows the consent screen
([`src/pages/OAuthConsent.tsx`](../src/pages/OAuthConsent.tsx)). The access token is an ordinary
Supabase user token, so each request runs as that person, under row level security.

- Tools ([`api/_lib/tools.ts`](../api/_lib/tools.ts)): search, recent pages, list pages, read,
  create, append, update and the daily note. Content goes both ways as Markdown, converted with
  BlockNote's server utilities ([`api/_lib/markdown.ts`](../api/_lib/markdown.ts)).
- Limits per account (`agent_take`): 30 changes a minute and 500 a day, 120 reads a minute and
  3,000 a day.
- Changes show in version history, marked with the app's name. Agents can't delete pages or
  change sharing.
