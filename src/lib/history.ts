import { supabase } from "./supabase";
import type { Block } from "./types";
import { usePages } from "../store/pages";

export type VersionRow = { id: number; title: string; saved_at: string; editor: string | null; mine: boolean };
export type Version = { title: string; icon: string | null; content: Block[] };

/** A page's versions, newest first (owner only). */
export async function fetchHistory(pageId: string): Promise<VersionRow[]> {
  const { data, error } = await supabase.rpc("page_history", { p_page_id: pageId });
  if (error) throw error;
  return (data ?? []) as VersionRow[];
}

export async function fetchVersion(id: number): Promise<Version> {
  const { data, error } = await supabase.from("page_versions").select("title,icon,content").eq("id", id).single();
  if (error) throw error;
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
