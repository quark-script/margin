# Self-hosting

Margin needs a [Supabase](https://supabase.com) project (database, sign-in, file storage and
three edge functions) and a host for the app. The MCP server for AI apps runs as Vercel functions;
everything else is a static site.

## 1. Supabase project

1. Create a project.
2. In the SQL editor, paste [`supabase/schema.sql`](../supabase/schema.sql) and run it. It creates
   the `notes` schema, the private `notes-media` storage bucket and all access rules.
3. **Project Settings > Data API**: add `notes` to the exposed schemas.
4. **Authentication > URL Configuration**: set the Site URL to your app's address, and add
   `https://your-address/**` to the redirect URLs.
5. **Authentication > Emails**: optionally use the templates in
   [`supabase/templates`](../supabase/templates), which also has a script that uploads them.
6. **Authentication > Sign In / Providers**: email works as is. For Google sign-in, add a Google
   OAuth client. For a CAPTCHA on sign-up and sign-in, turn on CAPTCHA protection with
   Cloudflare Turnstile and set `VITE_TURNSTILE_SITE_KEY` in the app.

## 2. Edge functions

Deploy the functions in [`supabase/functions`](../supabase/functions) with the
[Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
supabase functions deploy share-file --no-verify-jwt --project-ref your-project-ref
supabase functions deploy send-invite --project-ref your-project-ref
supabase functions deploy delete-account --project-ref your-project-ref
```

- `share-file` serves images on pages opened through "Anyone with the link". It checks access
  itself, so it runs without JWT verification.
- `send-invite` emails invitations through [Resend](https://resend.com). It needs the secrets
  `RESEND_API_KEY`, `SITE_URL` (your app's address) and `INVITE_FROM` (such as
  `Margin <margin@example.com>`, on a domain verified in Resend). Without them, sharing still
  works and the app tells people to send the link themselves.
- `delete-account` deletes an account with all its pages, files and history.

## 3. The app

```bash
cp .env.example .env
```

Fill in `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (from **Project Settings > API
Keys**) and `VITE_SITE_URL`. Then `npm run build` makes a static site in `dist/`.

On Vercel: import the repository (Vite is detected), add the same variables under
**Settings > Environment Variables**, and deploy. [`vercel.json`](../vercel.json) sends every
page to the app and routes the MCP server.

Edit [`src/pages/Privacy.tsx`](../src/pages/Privacy.tsx) to describe your instance and give your
own contact address.

## 4. AI agents (optional)

The MCP server ([`api/mcp.ts`](../api/mcp.ts)) answers at `/mcp`. AI apps sign people in through
Supabase Auth's OAuth 2.1 server, and Margin shows the consent screen at `/oauth/consent`.

1. **Authentication > OAuth Server**: turn it on, set the authorization path to
   `/oauth/consent` and allow dynamic client registration.
2. Prefer asymmetric JWT signing keys (**Project Settings > JWT Keys**), which Supabase recommends
   for OAuth.
3. The functions read `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, falling back to the `VITE_`
   variables.

Then follow the guide at `/agents` on your site to connect an app. The server runs a Markdown
converter that needs jsdom; `package.json` pins jsdom to a version whose dependencies Vercel's
Node runtime can load.

## 5. Keeping a free project awake

Free Supabase projects pause after a week without activity.
[`.github/workflows/keep-supabase-awake.yml`](../.github/workflows/keep-supabase-awake.yml) calls
`/api/health` every three days; set the `SITE_URL` repository variable to your address.

## Updating

`supabase/schema.sql` sets up a new project. Changes to an existing database come as migrations
in `supabase/migrations`, to run in order in the SQL editor.
