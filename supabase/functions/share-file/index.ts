// Serves images on pages shared with "Anyone with the link". Storage is private, so after
// checking that the page may show this file, redirect to a short-lived signed URL. Called from
// <img> tags, which can't send an auth header, hence verify_jwt = false and the check here.
// `page` is the shared page; `token` is for links from before pages had one link.
import { createClient } from "jsr:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  db: { schema: "notes" },
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const page = url.searchParams.get("page") ?? "";
  const token = url.searchParams.get("token") ?? "";
  const path = url.searchParams.get("path") ?? "";
  if ((!page && !token) || !path || path.includes("..")) return new Response("Bad request", { status: 400 });

  const { data: allowed, error } = page
    ? await admin.rpc("share_has_file_page", { p_page_id: page, p_path: path })
    : await admin.rpc("share_has_file", { p_token: token, p_path: path });
  if (error || !allowed) return new Response("Not found", { status: 404 });

  const signed = await admin.storage.from("notes-media").createSignedUrl(path, 60 * 60);
  if (signed.error || !signed.data) return new Response("Not found", { status: 404 });

  return new Response(null, {
    status: 302,
    headers: {
      Location: signed.data.signedUrl,
      "Cache-Control": "private, max-age=3000",
      "Access-Control-Allow-Origin": "*",
    },
  });
});
