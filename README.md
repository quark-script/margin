# Margin

A minimal, offline-first notes app. Nested pages, linked notes, a block editor, search, and sync across devices. Installable as a PWA.

Built with React, TypeScript, BlockNote and Supabase.

## Features

- Nested pages with favorites and trash
- Links between pages (`[[`) with backlinks; links follow renames
- Daily notes: one click opens today's page
- Share like a doc: invite people by email (with an invitation email) and/or open a page to anyone with the link, view or edit. One link per page; pages shared with you appear under "Shared with me"
- One editor at a time on shared pages, with the editor's name shown to everyone else; editing always needs an account
- Version history for every page: preview and restore earlier versions
- Block editor with images, tables, code and to-dos
- Search across titles and content (`Ctrl/⌘ K`)
- Import Markdown (an Obsidian vault as a .zip, or .md files) and export everything as Markdown
- Works offline; syncs and updates live across devices
- Light and dark themes, mobile layout

## Development

```bash
npm install
npm run dev
```

Requires a Supabase project with `supabase/schema.sql` and `supabase/migrations/*.sql` applied, the `notes` schema exposed in the Data API, and the edge functions in `supabase/functions` deployed: `share-file` with JWT verification off, `send-invite` with it on. Invitation emails need a `RESEND_API_KEY` edge function secret. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env`. Optional: `VITE_TURNSTILE_SITE_KEY` turns on a Cloudflare Turnstile check for sign-up, sign-in and password reset (enable CAPTCHA protection in Supabase Auth with the matching secret).

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
