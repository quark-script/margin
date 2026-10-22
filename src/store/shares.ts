import { create } from "zustand";
import { supabase } from "../lib/supabase";
import { fetchSharedWithMe, leaveShared, sendInviteEmail, type IncomingShare, type InviteEmail } from "../lib/share";
import type { Page } from "../lib/types";

export type Share = { page_id: string; token: string; can_edit: boolean };
/** Someone the owner invited to a page by email. */
export type Member = { page_id: string; email: string; can_edit: boolean };

type State = {
  shares: Record<string, Share>;
  /** The owner's invites, by page. */
  members: Record<string, Member[]>;
  /** Pages other people invited this user to. */
  incoming: IncomingShare[];
  load: () => Promise<void>;
  loadIncoming: () => Promise<void>;
  enable: (pageId: string) => Promise<Share>;
  setCanEdit: (pageId: string, canEdit: boolean) => Promise<void>;
  disable: (pageId: string) => Promise<void>;
  /** Adds the person and emails them; resolves with whether the email went out. */
  invite: (pageId: string, email: string, canEdit: boolean) => Promise<InviteEmail>;
  resendInvite: (pageId: string, email: string) => Promise<InviteEmail>;
  setMemberCanEdit: (pageId: string, email: string, canEdit: boolean) => Promise<void>;
  removeMember: (pageId: string, email: string) => Promise<void>;
  leave: (rootId: string) => Promise<void>;
  reset: () => void;
};

const byPage = (rows: Member[]) => {
  const out: Record<string, Member[]> = {};
  for (const m of rows) (out[m.page_id] ??= []).push(m);
  return out;
};

/** The owner's share links and invites, and pages shared with this user. Needs the network. */
export const useShares = create<State>((set, get) => ({
  shares: {},
  members: {},
  incoming: [],

  async load() {
    const [links, invites] = await Promise.all([
      supabase.from("shares").select("page_id,token,can_edit"),
      supabase.from("page_members").select("page_id,email,can_edit").order("created_at"),
    ]);
    if (!links.error) set({ shares: Object.fromEntries((links.data as Share[]).map((s) => [s.page_id, s])) });
    if (!invites.error) set({ members: byPage(invites.data as Member[]) });
    await get().loadIncoming();
  },

  async loadIncoming() {
    try {
      set({ incoming: await fetchSharedWithMe() });
    } catch {
      /* offline: keep what we have */
    }
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

  async invite(pageId, email, canEdit) {
    const row = { page_id: pageId, email: email.trim().toLowerCase(), can_edit: canEdit };
    const { error } = await supabase.from("page_members").insert(row);
    if (error) throw error;
    const members = get().members;
    set({ members: { ...members, [pageId]: [...(members[pageId] ?? []), row] } });
    return sendInviteEmail(pageId, row.email);
  },

  resendInvite: (pageId, email) => sendInviteEmail(pageId, email),

  async setMemberCanEdit(pageId, email, canEdit) {
    const { error } = await supabase.from("page_members").update({ can_edit: canEdit }).eq("page_id", pageId).eq("email", email);
    if (error) throw error;
    const members = get().members;
    set({ members: { ...members, [pageId]: (members[pageId] ?? []).map((m) => (m.email === email ? { ...m, can_edit: canEdit } : m)) } });
  },

  async removeMember(pageId, email) {
    const { error } = await supabase.from("page_members").delete().eq("page_id", pageId).eq("email", email);
    if (error) throw error;
    const members = get().members;
    set({ members: { ...members, [pageId]: (members[pageId] ?? []).filter((m) => m.email !== email) } });
  },

  async leave(rootId) {
    await leaveShared(rootId);
    set({ incoming: get().incoming.filter((s) => s.page_id !== rootId) });
  },

  reset: () => set({ shares: {}, members: {}, incoming: [] }),
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

/** The nearest page at or above `id` that people were invited to. */
export function invitesCovering(pages: Record<string, Page>, members: Record<string, Member[]>, id: string) {
  let cur: Page | undefined = pages[id];
  for (let guard = 0; cur && guard < 100; guard++) {
    if (members[cur.id]?.length) return { members: members[cur.id], via: cur };
    cur = cur.parent_id ? pages[cur.parent_id] : undefined;
  }
  return null;
}

/** Can anyone besides the owner edit this page (a link or an invite with edit access)? */
export function editableByOthers(
  pages: Record<string, Page>,
  shares: Record<string, Share>,
  members: Record<string, Member[]>,
  id: string,
) {
  let cur: Page | undefined = pages[id];
  for (let guard = 0; cur && guard < 100; guard++) {
    if (shares[cur.id]?.can_edit || members[cur.id]?.some((m) => m.can_edit)) return true;
    cur = cur.parent_id ? pages[cur.parent_id] : undefined;
  }
  return false;
}
