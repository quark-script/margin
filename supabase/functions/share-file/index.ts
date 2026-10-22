// Serves images on shared pages. Storage is private, so after checking that the link may
// show this file, redirect to a short-lived signed URL. Called from <img> tags, which can't
// send an auth header, hence verify_jwt = false and the token check here.
import { createClient } from "jsr:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  db: { schema: "notes" },
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const path = url.searchParams.get("path") ?? "";
  if (!token || !path || path.includes("..")) return new Response("Bad request", { status: 400 });

  const { data: allowed, error } = await admin.rpc("share_has_file", { p_token: token, p_path: path });
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
