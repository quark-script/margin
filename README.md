# Notes

A clean, minimal, Notion-style notes app for personal use. React + Supabase, installable as a PWA on phone and desktop, works offline.

## One-time Supabase setup (required — the app won't load pages without step 1)

The database lives in your **upkeep** project, in its own `notes` schema (table, security rules and image storage are already created).

1. **Expose the schema to the API.** Dashboard → upkeep → Project Settings → Data API → *Exposed schemas* → add `notes` → Save.
2. **Auth URLs.** Authentication → URL Configuration → add your deployed URL (and `http://localhost:5173`) to *Redirect URLs*. If upkeep doesn't use email confirmation links, you can instead turn off *Confirm email* under Authentication → Providers → Email.
3. **After you create your account, turn off new sign-ups** (Authentication → Providers → Email → *Allow new users to sign up*). Row Level Security already stops other users from reading your notes, but there's no reason to let strangers create accounts. Check first that upkeep doesn't rely on public sign-ups.

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
```

`.env` already holds the project URL and the publishable key (safe to ship; data is protected by RLS).

## Deploy (free)

- **Vercel:** import the repo, framework "Vite", no settings needed (`vercel.json` handles routing).
- **Netlify:** build `npm run build`, publish `dist` (`public/_redirects` handles routing).

Then open the URL on your phone → browser menu → **Install app / Add to Home screen**.

## Keyboard shortcuts

| | |
|---|---|
| `Ctrl/⌘ K` | Search pages and contents |
| `Ctrl/⌘ \` | Toggle sidebar |
| `Alt N` | New page |
| `/` in editor | Insert a block (heading, to-do, image, table, code…) |
| `Enter` in title | Jump into the page body |

## How sync works

- Every edit is saved to the device first (IndexedDB), then pushed to Supabase after ~1 second.
- Offline edits queue up and sync when you're back online; the sidebar footer shows the state.
- Other devices update live (Supabase Realtime) and on app focus.
- Conflicts: last write wins per page. If you edit the same page on two devices while both are offline, the later sync wins.

## Project layout

```
src/
  store/pages.ts      offline-first store + sync engine (the important file)
  store/auth.ts       session handling
  components/         sidebar, page tree, editor, search, trash, menus
  pages/              Home, PageView, Login
supabase/schema.sql   the database schema that was applied
```
