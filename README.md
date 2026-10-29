# Margin

A quiet notes app, private by default: your notes stay on your device and sync only if you want them to. Nested pages, linked notes, a block editor, search and sharing. Installable as a PWA.

Built with React, TypeScript, BlockNote and Supabase.

## Features

- Nested pages with favorites and trash
- Links between pages (`[[`) with backlinks; links follow renames
- Daily notes: one click opens today's page
- Share like a doc: invite people by email (with an invitation email) as Full access (edit, and share with others), Can edit or Can view, and/or open a page to anyone with the link, view or edit. One link per page; pages shared with you appear under "Shared with me". Everyone invited sees who has access; only the owner and people with full access see email addresses and change sharing
- One editor at a time on shared pages, with the editor's name shown to everyone else; editing always needs an account
- Version history for every page: see what changed in each version (highlighted), preview and restore. Saves that change nothing visible don't count
- Block editor with images, tables, code and to-dos. Images and PDFs up to 10 MB each, 100 MB per account; Settings shows what's used and deletes files no page uses
- Search across titles and content (`Ctrl/⌘ K`)
- Import Markdown (an Obsidian vault as a .zip, or .md files) and export everything as Markdown
- Copy a page as Markdown, or save it as a PDF
- Private by default. Without an account, nothing leaves the browser. Signed in, only pages you share sync until you turn on Sync all pages (per device, in Settings); then everything syncs and updates live across devices
- Works offline, including images, which go up when their page syncs
- Without an account, a strip at the top says pages are only on this device. Signing in from there backs them up: they go into the account and sync
- Light and dark themes, mobile layout
- Settings page: name, password, theme, import and export
- Sign in with email or Google; delete your account and all its data in Settings

## Development

```bash
npm install
npm run dev
```

Requires a Supabase project with `supabase/schema.sql` and `supabase/migrations/*.sql` applied, the `notes` schema exposed in the Data API, and the edge functions in `supabase/functions` deployed: `share-file` with JWT verification off, `send-invite` and `delete-account` with it on. Invitation emails need a `RESEND_API_KEY` edge function secret. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env`. Optional: `VITE_TURNSTILE_SITE_KEY` turns on a Cloudflare Turnstile check for sign-up, sign-in and password reset (enable CAPTCHA protection in Supabase Auth with the matching secret).

Auth email templates are in `supabase/templates`.

## Deployment

Any static host. `vercel.json` and `public/_redirects` handle client-side routing.

On Vercel, turn on Web Analytics in the project's Analytics tab, then redeploy. Page and share links reach it as `/p/[page]` and `/s/[link]`, without ids, tokens, query strings or fragments (`src/lib/analytics.ts`).

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
