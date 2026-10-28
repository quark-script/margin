// Emails an invitation after someone invites a person to a page. The app creates the invite
// (the owner directly, people with full access through notes.share_invite); this checks the
// caller may share the page and the invite exists, then sends it through Resend. Needs the
// RESEND_API_KEY secret; without it nothing is sent and the app says to send the link instead.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://margin.dhanpulse.in";
const FROM = Deno.env.get("INVITE_FROM") ?? "Margin <margin@dhanpulse.in>";
const DAILY_LIMIT = 50; // per person inviting, against using this to send spam
const RESEND_GAP_MS = 10 * 60_000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let input: { page_id?: unknown; email?: unknown };
  try {
    input = await req.json();
  } catch {
    return json({ error: "bad request" }, 400);
  }
  const pageId = String(input.page_id ?? "");
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!pageId || !email) return json({ error: "bad request" }, 400);

  const url = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
    db: { schema: "notes" },
    auth: { persistSession: false },
  });
  // There's no stored session in a function, so the caller's token is passed explicitly.
  const { data: auth } = await asUser.auth.getUser(authHeader.replace(/^Bearer\s+/i, ""));
  const user = auth.user;
  if (!user?.email) return json({ error: "unauthorized" }, 401);

  // The owner, or someone with full access. Asked as the caller, so it's their access that counts.
  const { data: mayShare } = await asUser.rpc("can_manage_sharing", { p_page_id: pageId });
  if (mayShare !== true) return json({ error: "not found" }, 404);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    db: { schema: "notes" },
    auth: { persistSession: false },
  });
  const { data: invite } = await admin.from("page_members").select("can_edit,can_share").eq("page_id", pageId).eq("email", email).maybeSingle();
  const { data: page } = await admin.from("pages").select("title,icon").eq("id", pageId).maybeSingle();
  if (!invite || !page) return json({ error: "not found" }, 404);

  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return json({ sent: false, reason: "not_configured" });

  const since = (ms: number) => new Date(Date.now() - ms).toISOString();
  const { count: today } = await admin
    .from("invite_emails").select("id", { count: "exact", head: true })
    .eq("owner_id", user.id).gte("sent_at", since(86_400_000));
  if ((today ?? 0) >= DAILY_LIMIT) return json({ sent: false, reason: "limit" });
  const { count: recent } = await admin
    .from("invite_emails").select("id", { count: "exact", head: true })
    .eq("page_id", pageId).eq("email", email).gte("sent_at", since(RESEND_GAP_MS));
  if ((recent ?? 0) > 0) return json({ sent: false, reason: "recent" });

  // No account yet: the button leads to sign-up with the address filled in, then to the page.
  const { data: hasAccount } = await admin.rpc("email_has_account", { p_email: email });
  const pagePath = `/p/${pageId}`;
  const link = hasAccount
    ? `${SITE_URL}${pagePath}`
    : `${SITE_URL}/signup?email=${encodeURIComponent(email)}&next=${encodeURIComponent(pagePath)}`;

  const inviter = (user.user_metadata?.full_name as string | undefined)?.trim() || user.email.split("@")[0];
  const title = page.title?.trim() || "Untitled";
  const verb = invite.can_share ? "edit and share" : invite.can_edit ? "edit" : "view";
  const access = invite.can_share ? "Full access" : invite.can_edit ? "Can edit" : "Can view";
  const subject = `${inviter} shared “${title}” with you`;
  const button = hasAccount ? "Open page" : "Create account to open";
  const note = hasAccount
    ? `${inviter} (${user.email}) invited you to ${verb} this page on Margin.`
    : `${inviter} (${user.email}) invited you to ${verb} this page on Margin. Create a free account with ${email} to open it.`;

  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:0;background:#FBFBFA;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBFBFA;"><tr><td align="center" style="padding:48px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1E1F22;">
<tr><td style="padding-bottom:32px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="width:36px;height:36px;background:#1E1F22;border-radius:8px;text-align:center;vertical-align:middle;color:#FBFBFA;font-size:18px;font-weight:700;line-height:36px;">M</td>
<td style="padding-left:10px;font-size:16px;font-weight:600;color:#1E1F22;">Margin</td>
</tr></table></td></tr>
<tr><td style="font-size:24px;line-height:1.3;font-weight:700;letter-spacing:-0.01em;padding-bottom:20px;">${esc(inviter)} shared a page with you</td></tr>
<tr><td style="padding-bottom:24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #EBEBE8;border-radius:10px;background:#FFFFFF;"><tr>
<td style="padding:14px 16px;font-size:16px;font-weight:600;color:#1E1F22;">${page.icon ? esc(page.icon) + "&nbsp;&nbsp;" : ""}${esc(title)}<div style="padding-top:2px;font-size:13px;font-weight:400;color:#73767D;">${access}</div></td>
</tr></table></td></tr>
<tr><td style="padding-bottom:28px;"><a href="${esc(link)}" style="display:inline-block;background:#1E1F22;color:#FBFBFA;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:8px;">${button}</a></td></tr>
<tr><td style="font-size:14px;line-height:1.6;color:#45474D;padding-bottom:20px;">${esc(note)}</td></tr>
<tr><td style="font-size:13px;line-height:1.6;color:#73767D;padding-bottom:32px;">If you weren't expecting this, you can ignore this email.</td></tr>
<tr><td style="border-top:1px solid #EBEBE8;padding-top:16px;font-size:12px;color:#A3A6AC;">Margin · notes that work offline and sync everywhere</td></tr>
</table></td></tr></table>
</body></html>`;
  const text = `${inviter} shared “${title}” with you on Margin (${access.toLowerCase()}).\n\n${button}: ${link}\n\n${note}\n\nIf you weren't expecting this, you can ignore this email.`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [email], reply_to: user.email, subject, html, text }),
  });
  if (!res.ok) {
    console.error("resend failed", res.status, await res.text());
    return json({ sent: false, reason: "send_failed" });
  }
  await admin.from("invite_emails").insert({ owner_id: user.id, page_id: pageId, email });
  return json({ sent: true });
});
