import { supabase } from "./supabase";
import type { Block } from "./types";
import { blocksToText } from "./text";
import { editorId, lockPage, unlockPage } from "./share";
import { usePages } from "../store/pages";

export type VersionRow = { id: number; title: string; saved_at: string; editor: string | null; mine: boolean };
export type Version = { title: string; icon: string | null; content: Block[] };

/** A page's versions, newest first (the owner, and people invited with edit access). */
export async function fetchHistory(pageId: string): Promise<VersionRow[]> {
  const { data, error } = await supabase.rpc("page_history", { p_page_id: pageId });
  if (error) throw error;
  return (data ?? []) as VersionRow[];
}

export async function fetchVersion(id: number): Promise<Version> {
  const { data, error } = await supabase.rpc("page_version", { p_id: id });
  if (error) throw error;
  if (!data) throw new Error("This version isn't available.");
  return data as Version;
}

/**
 * Restore a version. The current state is saved first and sealed as its own version, so the
 * restore is undoable: it shows up as a new version on top.
 */
export async function restoreVersion(pageId: string, versionId: number) {
  const pages = usePages.getState();
  await pages.sync();
  if (usePages.getState().dirty[pageId]) throw new Error("Your latest changes are still saving. Try again in a moment.");
  const v = await fetchVersion(versionId);
  const { error } = await supabase.rpc("seal_page_versions", { p_page_id: pageId });
  if (error) throw error;
  usePages.getState().restoreVersion(pageId, v);
  await usePages.getState().sync();
}

/**
 * Restore on a page you were invited to edit: the server does it (sealing the current state
 * first, as above) while this tab briefly holds the page's edit lock.
 */
export async function restoreInvitedVersion(pageId: string, versionId: number) {
  const v = await fetchVersion(versionId);
  const { ok } = await lockPage(pageId, null);
  if (!ok) throw new Error("Someone else is editing this page. Try again when they're done.");
  try {
    const { data, error } = await supabase.rpc("member_restore", {
      p_id: versionId,
      p_editor: editorId,
      p_search_text: blocksToText(v.content),
    });
    if (error) throw error;
    if (!(data as { ok: boolean }).ok) throw new Error("Someone else started editing. Try again.");
  } finally {
    await unlockPage(pageId);
  }
}
