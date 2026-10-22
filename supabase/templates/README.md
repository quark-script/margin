# Auth email templates

Margin-branded emails for Supabase Auth. Upload them, with the Site URL and
redirect URLs, in one step:

```bash
SUPABASE_ACCESS_TOKEN=sbp_... node supabase/apply-auth-config.mjs
```

Or paste each file into Supabase → Authentication → Emails → Templates, with
these subjects:

| Template | File | Subject |
| --- | --- | --- |
| Confirm signup | `confirm-signup.html` | Confirm your Margin account |
| Reset password | `reset-password.html` | Reset your Margin password |
| Magic link | `magic-link.html` | Your Margin sign-in link |
| Change email address | `change-email.html` | Confirm your new email for Margin |
| Invite user | `invite.html` | You're invited to Margin |

The project is shared with upkeep, so these templates apply to its emails too. Links
go straight to Margin's `/auth/confirm` only when the request came from Margin
(its redirect equals the Site URL); anything else gets Supabase's standard link.
