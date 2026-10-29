import { SUPABASE_KEY, SUPABASE_URL } from "./_lib/config.js";

// /api/health: is Margin up, and can it reach its database? The keep-awake workflow calls it, so
// the Supabase project sees activity and isn't paused for being idle.
export async function GET(): Promise<Response> {
  const ok = await fetch(`${SUPABASE_URL}/rest/v1/rpc/shared_tree`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json", "Content-Profile": "notes" },
    // A page that can't exist: the answer is null, but the database was asked.
    body: JSON.stringify({ p_page_id: "00000000-0000-0000-0000-000000000000" }),
  }).then((res) => res.ok, () => false);
  return Response.json({ ok }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
