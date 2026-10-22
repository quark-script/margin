// Uploads the auth email templates and sets the Site URL and redirect URLs.
//
//   SUPABASE_ACCESS_TOKEN=sbp_... node supabase/apply-auth-config.mjs
//
// Create a token at https://supabase.com/dashboard/account/tokens. Optional:
// PROJECT_REF and SITE_URL. The redirect URLs become Margin's addresses only.

import { readFile } from "node:fs/promises";

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.PROJECT_REF || "ykowlfymtwzirnzwiiov";
const site = (process.env.SITE_URL || "https://margin.dhanpulse.in").replace(/\/$/, "");
if (!token) {
  console.error("Set SUPABASE_ACCESS_TOKEN first.");
  process.exit(1);
}

const api = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const templates = [
  ["confirmation", "confirm-signup.html", "Confirm your Margin account"],
  ["recovery", "reset-password.html", "Reset your Margin password"],
  ["magic_link", "magic-link.html", "Your Margin sign-in link"],
  ["email_change", "change-email.html", "Confirm your new email for Margin"],
  ["invite", "invite.html", "You're invited to Margin"],
];

const res = await fetch(api, { headers });
if (!res.ok) {
  console.error(`Reading auth config failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const current = await res.json();

// Auth emails and Google sign-in may only send people back to Margin: its domain, and the
// Vercel address it also answers on.
const allow = [site, "https://margin-murex-seven.vercel.app"].map((u) => `${u}/**`);

const body = { site_url: site, uri_allow_list: allow.join(",") };
for (const [key, file, subject] of templates) {
  body[`mailer_subjects_${key}`] = subject;
  body[`mailer_templates_${key}_content`] = await readFile(new URL(`./templates/${file}`, import.meta.url), "utf8");
}

const put = await fetch(api, { method: "PATCH", headers, body: JSON.stringify(body) });
if (!put.ok) {
  console.error(`Updating auth config failed: ${put.status} ${await put.text()}`);
  process.exit(1);
}

console.log(`Site URL: ${current.site_url || "(none)"} -> ${site}`);
console.log(`Redirect URLs: ${current.uri_allow_list || "(none)"} -> ${allow.join(", ")}`);
console.log(`Templates: ${templates.length} uploaded`);
console.log(`Sign-ups are ${current.disable_signup ? "still closed" : "open"}.`);
