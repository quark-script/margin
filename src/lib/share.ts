import { supabase } from "./supabase";
import type { Block } from "./types";

/** One id per browser tab, so two tabs of the same person also take turns editing. */
export const editorId = (() => {
  try {
    const k = "margin:editor";
    const existing = sessionStorage.getItem(k);
    if (existing) return existing;
    const id = `ed-${crypto.randomUUID()}`;
    sessionStorage.setItem(k, id);
    return id;
  } catch {
    return `ed-${crypto.randomUUID()}`;
  }
})();

export const shareUrl = (token: string) => `${location.origin}/s/${token}`;

export const sharedFileUrl = (token: string, path: string) =>
  `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/share-file?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`;

export type SharedPage = {
  id: string;
  parent_id: string | null;
  title: string;
  icon: string | null;
  content: Block[];
  position: number;
  created_at: string;
  updated_at: string;
};
export type SharedTree = { can_edit: boolean; root_id: string; pages: SharedPage[] };
export type SharedState = {
  can_edit: boolean;
  pages: { id: string; updated_at: string }[];
  locks: { page_id: string; editor: string; name?: string | null }[];
};

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export const fetchShared = (token: string) => rpc<SharedTree | null>("shared_pages", { p_token: token });
export const fetchSharedState = (token: string) => rpc<SharedState | null>("shared_state", { p_token: token });

/** Take or renew the edit lock. `token` is null for the owner. */
export const lockPage = (pageId: string, token: string | null) =>
  rpc<{ ok: boolean }>("lock_page", { p_page_id: pageId, p_editor: editorId, p_token: token });

export const unlockPage = (pageId: string) =>
  rpc<null>("unlock_page", { p_page_id: pageId, p_editor: editorId }).catch(() => null);

/** For pagehide: a normal request is cancelled with the page; keepalive lets it finish. */
export function unlockPageOnExit(pageId: string) {
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
  void fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/rpc/unlock_page`, {
    method: "POST",
    keepalive: true,
    headers: { apikey: key, "Content-Type": "application/json", "Content-Profile": "notes" },
    body: JSON.stringify({ p_page_id: pageId, p_editor: editorId }),
  }).catch(() => {});
}

/** Owner only: id of whoever holds the page's lock right now, if anyone. */
export const pageLockHolder = (pageId: string) => rpc<string | null>("page_lock_state", { p_page_id: pageId });

export const saveShared = (token: string, pageId: string, content: Block[], searchText: string) =>
  rpc<{ ok: boolean; reason?: string; updated_at?: string }>("shared_save", {
    p_token: token,
    p_page_id: pageId,
    p_editor: editorId,
    p_content: content,
    p_search_text: searchText,
  });

/**
 * pagehide variant of saveShared (see unlockPageOnExit). Saving needs the editor's sign-in, so
 * the access token goes along. Browsers cap keepalive bodies at 64 KB.
 */
export function saveSharedOnExit(token: string, pageId: string, content: Block[], searchText: string, accessToken: string) {
  const body = JSON.stringify({ p_token: token, p_page_id: pageId, p_editor: editorId, p_content: content, p_search_text: searchText });
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
  void fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/rpc/shared_save`, {
    method: "POST",
    keepalive: body.length < 60_000,
    headers: {
      apikey: key,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Content-Profile": "notes",
    },
    body,
  }).catch(() => {});
}
