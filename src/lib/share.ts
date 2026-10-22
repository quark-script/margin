import { SITE_URL, supabase } from "./supabase";
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

/** Every page has one link. What it opens depends on who follows it. */
export const pageUrl = (pageId: string) => `${SITE_URL}/p/${pageId}`;

/** Images on a page shared with "Anyone with the link", for visitors without access to storage. */
export const sharedFileUrl = (rootId: string, path: string) =>
  `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/share-file?page=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}`;

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
/** How someone who isn't the owner reached a page: invited, or anyone with the link. */
export type Via = "invite" | "link";
export type SharedTree = { root_id: string; can_edit: boolean; via: Via; pages: SharedPage[] };
export type SharedState = {
  root_id: string;
  can_edit: boolean;
  via: Via;
  pages: { id: string; updated_at: string }[];
  locks: { page_id: string; editor: string; name?: string | null }[];
};

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

/**
 * For pagehide: a normal request is cancelled with the page; keepalive lets it finish (browsers
 * cap keepalive bodies at 64 KB). Writes need the editor's sign-in, so the access token goes along.
 */
function rpcOnExit(fn: string, args: Record<string, unknown>, accessToken?: string) {
  const body = JSON.stringify(args);
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
  void fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    keepalive: body.length < 60_000,
    headers: {
      apikey: key,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      "Content-Type": "application/json",
      "Content-Profile": "notes",
    },
    body,
  }).catch(() => {});
}

/** A page someone shared, and the pages inside it. Null without access. */
export const fetchTree = (pageId: string) => rpc<SharedTree | null>("shared_tree", { p_page_id: pageId });
/** Cheap poll for an open shared page: what changed, who is editing. */
export const fetchTreeState = (pageId: string) => rpc<SharedState | null>("shared_tree_state", { p_page_id: pageId });

export const saveSharedPage = (pageId: string, content: Block[], searchText: string) =>
  rpc<{ ok: boolean; reason?: string; updated_at?: string }>("shared_page_save", {
    p_page_id: pageId,
    p_editor: editorId,
    p_content: content,
    p_search_text: searchText,
  });

export const saveSharedPageOnExit = (pageId: string, content: Block[], searchText: string, accessToken: string) =>
  rpcOnExit("shared_page_save", { p_page_id: pageId, p_editor: editorId, p_content: content, p_search_text: searchText }, accessToken);

/** Links from before every page had one link (/s/<token>): the page they point at. */
export const shareRoot = (token: string) => rpc<string | null>("share_root", { p_token: token });

/** Take or renew the edit lock. Always without a token now; the server checks access. */
export const lockPage = (pageId: string, token: string | null = null) =>
  rpc<{ ok: boolean }>("lock_page", { p_page_id: pageId, p_editor: editorId, p_token: token });

export const unlockPage = (pageId: string) =>
  rpc<null>("unlock_page", { p_page_id: pageId, p_editor: editorId }).catch(() => null);

export const unlockPageOnExit = (pageId: string) => rpcOnExit("unlock_page", { p_page_id: pageId, p_editor: editorId });

/** Owner only: who holds the page's lock right now (their editor id and name), if anyone. */
export const pageLockInfo = (pageId: string) =>
  rpc<{ editor: string; name: string | null } | null>("page_lock_info", { p_page_id: pageId });

export type IncomingShare = { page_id: string; title: string; icon: string | null; owner_name: string | null; can_edit: boolean };

/** Pages other people invited this user to. */
export const fetchSharedWithMe = () => rpc<IncomingShare[]>("shared_with_me", {});
export const leaveShared = (root: string) => rpc<null>("leave_shared", { p_root: root });

export type InviteEmail = { sent: boolean; reason?: "not_configured" | "limit" | "recent" | "send_failed" | "error" };

/** Email the invitation. The invite itself already exists; this only sends the message. */
export async function sendInviteEmail(pageId: string, email: string): Promise<InviteEmail> {
  try {
    const { data, error } = await supabase.functions.invoke("send-invite", { body: { page_id: pageId, email } });
    if (error) return { sent: false, reason: "error" };
    return data as InviteEmail;
  } catch {
    return { sent: false, reason: "error" };
  }
}
