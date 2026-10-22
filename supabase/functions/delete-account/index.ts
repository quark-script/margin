// Deletes the caller's account (account menu > Delete account): their images, the invitations
// other people sent them, then the sign-in, which takes their pages, history and sharing with it
// and ends their sessions on every device. Every step can run again, so a failed attempt is
// finished by retrying.
import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "notes-media";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const fail = (step: string, error: unknown) => {
  console.error("delete-account:", step, error);
  return json({ error: "failed" }, 500);
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let input: { confirm?: unknown };
  try {
    input = await req.json();
  } catch {
    return json({ error: "bad request" }, 400);
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  // There's no stored session in a function, so the caller's token is passed explicitly.
  const { data: auth } = await asUser.auth.getUser(authHeader.replace(/^Bearer\s+/i, ""));
  const user = auth.user;
  if (!user?.email) return json({ error: "unauthorized" }, 401);
  // The app has people type their email address to confirm; checked here as well.
  if (String(input.confirm ?? "").trim().toLowerCase() !== user.email.toLowerCase()) {
    return json({ error: "confirm" }, 400);
  }

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    db: { schema: "notes" },
    auth: { persistSession: false },
  });

  // Deleting the sign-in would also delete another app's rows for this person (their foreign
  // keys cascade), so stop before touching anything while one still has them.
  const { data: inUse, error: checkError } = await admin.rpc("has_other_app_data", { p_user: user.id });
  if (checkError) return fail("check other apps", checkError);
  if (inUse) return json({ error: "in_use" }, 409);

  // 1. Images. The list comes back up to 1000 at a time, so repeat until it's empty.
  for (let round = 0; round < 100; round++) {
    const { data: files, error } = await admin.rpc("account_files", { p_user: user.id });
    if (error) return fail("list files", error);
    if (!files?.length) break;
    const { data: removed, error: removeError } = await admin.storage.from(BUCKET).remove(files as string[]);
    if (removeError || !removed?.length) return fail("remove files", removeError);
  }

  // 2. Invitations other people sent to their address: not tied to the sign-in, so not deleted with it.
  for (const table of ["page_members", "invite_emails"]) {
    const { error } = await admin.from(table).delete().eq("email", user.email.toLowerCase());
    if (error) return fail(`delete ${table}`, error);
  }

  // 3. The sign-in, and with it everything else.
  const { error: userError } = await admin.auth.admin.deleteUser(user.id);
  if (userError) return fail("delete user", userError);

  return json({ deleted: true });
});
