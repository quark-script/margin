# Margin

A minimal, offline-first notes app. Nested pages, linked notes, a block editor, search, and sync across devices. Installable as a PWA.

Built with React, TypeScript, BlockNote and Supabase.

## Features

- Nested pages with favorites and trash
- Links between pages (`[[`) with backlinks; links follow renames
- Daily notes: one click opens today's page
- Share any page (and the pages inside it) with a link, view-only or editable; one editor at a time
- Block editor with images, tables, code and to-dos
- Search across titles and content (`Ctrl/⌘ K`)
- Works offline; syncs and updates live across devices
- Light and dark themes, mobile layout

## Development

```bash
npm install
npm run dev
```

Requires a Supabase project with `supabase/schema.sql` and `supabase/migrations/*.sql` applied, the `notes` schema exposed in the Data API, and the `share-file` edge function (`supabase/functions/share-file`) deployed with JWT verification off. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env`. Optional: `VITE_TURNSTILE_SITE_KEY` turns on a Cloudflare Turnstile check for sign-up, sign-in and password reset (enable CAPTCHA protection in Supabase Auth with the matching secret).

Auth email templates are in `supabase/templates`.

## Deployment

Any static host. `vercel.json` and `public/_redirects` handle client-side routing.

## Sync

Edits are saved locally first (IndexedDB) and pushed to Supabase in the background. Changes from other devices arrive through Realtime. Conflicts resolve last-write-wins per page.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/⌘ K` | Search |
| `Ctrl/⌘ \` | Toggle sidebar |
| `Alt N` | New page |
| `/` | Insert a block |
| `[[` | Link to a page |
