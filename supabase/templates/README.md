# Auth email templates

Margin-branded emails for Supabase Auth. Upload them, with the Site URL and
redirect URLs, in one step:

```bash
SUPABASE_ACCESS_TOKEN=sbp_... PROJECT_REF=your-project-ref SITE_URL=https://notes.example.com \
  node supabase/apply-auth-config.mjs
```

Add `EXTRA_URLS` (comma separated) for any other address Margin answers on.

Or paste each file into Supabase > Authentication > Emails > Templates, with
these subjects:

| Template | File | Subject |
| --- | --- | --- |
| Confirm signup | `confirm-signup.html` | Confirm your Margin account |
| Reset password | `reset-password.html` | Reset your Margin password |
| Magic link | `magic-link.html` | Your Margin sign-in link |
| Change email address | `change-email.html` | Confirm your new email for Margin |
| Invite user | `invite.html` | You're invited to Margin |

Links go straight to Margin's `/auth/confirm` when the request's redirect is the
Site URL, which is how the app sends them; anything else gets Supabase's standard
link.
