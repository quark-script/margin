import { create } from "zustand";
import { supabase } from "../lib/supabase";
import type { Page } from "../lib/types";

export type Share = { page_id: string; token: string; can_edit: boolean };

type State = {
  shares: Record<string, Share>;
  load: () => Promise<void>;
  enable: (pageId: string) => Promise<Share>;
  setCanEdit: (pageId: string, canEdit: boolean) => Promise<void>;
  disable: (pageId: string) => Promise<void>;
  reset: () => void;
};

/** The owner's share links. Needs the network: shares are created on the server. */
export const useShares = create<State>((set, get) => ({
  shares: {},

  async load() {
    const { data, error } = await supabase.from("shares").select("page_id,token,can_edit");
    if (error) return;
    set({ shares: Object.fromEntries((data as Share[]).map((s) => [s.page_id, s])) });
  },

  async enable(pageId) {
    const { data, error } = await supabase
      .from("shares")
      .upsert({ page_id: pageId }, { onConflict: "page_id", ignoreDuplicates: false })
      .select("page_id,token,can_edit")
      .single();
    if (error) throw error;
    const share = data as Share;
    set({ shares: { ...get().shares, [pageId]: share } });
    return share;
  },

  async setCanEdit(pageId, canEdit) {
    const { error } = await supabase.from("shares").update({ can_edit: canEdit }).eq("page_id", pageId);
    if (error) throw error;
    set({ shares: { ...get().shares, [pageId]: { ...get().shares[pageId], can_edit: canEdit } } });
  },

  async disable(pageId) {
    const { error } = await supabase.from("shares").delete().eq("page_id", pageId);
    if (error) throw error;
    const shares = { ...get().shares };
    delete shares[pageId];
    set({ shares });
  },

  reset: () => set({ shares: {} }),
}));

/** The nearest share covering a page: its own, or one on an ancestor (sub-pages are included). */
export function shareCovering(pages: Record<string, Page>, shares: Record<string, Share>, id: string) {
  let cur: Page | undefined = pages[id];
  for (let guard = 0; cur && guard < 100; guard++) {
    if (shares[cur.id]) return { share: shares[cur.id], via: cur };
    cur = cur.parent_id ? pages[cur.parent_id] : undefined;
  }
  return null;
}
