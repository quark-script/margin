# Margin

A minimal, offline-first notes app. Nested pages, a block editor, search, and sync across devices. Installable as a PWA.

Built with React, TypeScript, BlockNote and Supabase.

## Features

- Nested pages with favorites and trash
- Block editor with images, tables, code and to-dos
- Search across titles and content (`Ctrl/⌘ K`)
- Works offline; syncs and updates live across devices
- Light and dark themes, mobile layout

## Development

```bash
npm install
npm run dev
```

Requires a Supabase project with `supabase/schema.sql` applied and the `notes` schema exposed in the Data API. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env`.

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
