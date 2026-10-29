import type { SupabaseClient } from "@supabase/supabase-js";
import type { Block } from "../../src/lib/types.js";
import { MEDIA_BUCKET } from "./config.js";

export type TreePage = {
  id: string;
  parent_id: string | null;
  title: string;
  icon: string | null;
  position: number;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
};
export type FullPage = TreePage & { content: Block[] | null };
export type Hit = { id: string; title: string; icon: string | null; parent_id: string | null; updated_at: string; snippet: string | null };
export type Quota = { ok: true } | { ok: false; limit: "minute" | "day"; retry_after: number };
export type NewPage = {
  id: string;
  parent_id: string | null;
  title: string;
  icon: string | null;
  content: Block[];
  search_text: string;
  position: number;
};
export type PagePatch = Partial<Pick<NewPage, "title" | "icon" | "content" | "search_text">>;

/** What the tools need from the database: Supabase as the caller in production, memory in tests. */
export interface Store {
  /** Count one call against the agent limits (notes.agent_take). */
  take(write: boolean): Promise<Quota>;
  /** Every page of the caller's, without content. */
  tree(): Promise<TreePage[]>;
  page(id: string): Promise<FullPage | null>;
  search(query: string, limit: number): Promise<Hit[]>;
  insertPage(page: NewPage): Promise<{ updated_at: string }>;
  updatePage(id: string, patch: PagePatch): Promise<{ updated_at: string }>;
  /** Close the page's open version, so the next change starts its own. */
  seal(id: string): Promise<void>;
  /** Who is editing the page in Margin right now (shared pages take turns), if anyone. */
  editingNow(id: string): Promise<string | null>;
  /** A link to a stored file that works for a week. */
  fileLink(path: string): Promise<string | null>;
}

const TREE_COLUMNS = "id,parent_id,title,icon,position,is_archived,created_at,updated_at";

/** The Store over Supabase, as the caller: `db` sends their access token, so RLS applies. */
export function supabaseStore(db: SupabaseClient<any, "public", "notes">, userId: string): Store {
  const check = (what: string, error: { message?: string } | null) => {
    if (error) throw new Error(`${what}: ${error.message ?? "failed"}`);
  };
  return {
    async take(write) {
      const { data, error } = await db.rpc("agent_take", { p_write: write });
      check("limits", error);
      return data as Quota;
    },
    async tree() {
      const out: TreePage[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await db.from("pages").select(TREE_COLUMNS).order("id").range(from, from + 999);
        check("pages", error);
        out.push(...((data ?? []) as TreePage[]));
        if (!data || data.length < 1000) return out;
      }
    },
    async page(id) {
      const { data, error } = await db.from("pages").select(`${TREE_COLUMNS},content`).eq("id", id).maybeSingle();
      check("page", error);
      return (data as FullPage | null) ?? null;
    },
    async search(query, limit) {
      const { data, error } = await db.rpc("agent_search", { p_query: query, p_limit: limit });
      check("search", error);
      return (data ?? []) as Hit[];
    },
    async insertPage(page) {
      const { data, error } = await db
        .from("pages")
        .insert({ ...page, owner_id: userId, is_favorite: false, is_archived: false, created_at: new Date().toISOString() })
        .select("updated_at")
        .single();
      check("create", error);
      return data as { updated_at: string };
    },
    async updatePage(id, patch) {
      const { data, error } = await db.from("pages").update(patch).eq("id", id).select("updated_at").single();
      check("save", error);
      return data as { updated_at: string };
    },
    async seal(id) {
      const { error } = await db.rpc("seal_page_versions", { p_page_id: id });
      check("history", error);
    },
    async editingNow(id) {
      const { data, error } = await db.rpc("page_lock_info", { p_page_id: id });
      if (error || !data) return null;
      return (data as { name?: string | null }).name || "Someone";
    },
    async fileLink(path) {
      const { data } = await db.storage.from(MEDIA_BUCKET).createSignedUrl(path, 60 * 60 * 24 * 7);
      return data?.signedUrl ?? null;
    },
  };
}
