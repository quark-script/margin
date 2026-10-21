import { create } from "zustand";
import { get as idbGet, set as idbSet, delMany } from "idb-keyval";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { PAGE_COLUMNS, type Block, type Page } from "../lib/types";
import { blocksToText } from "../lib/text";

/**
 * Offline-first page store.
 *
 * - Every change lands in memory + IndexedDB immediately, so the UI never waits on the network.
 * - Changed page ids go into `dirty`; a debounced flush upserts them to Supabase.
 * - Remote changes (pull on start/focus + realtime) are applied only to pages with no pending
 *   local edits, so you never lose what you just typed. Last write wins per page.
 */

export type SyncStatus = "idle" | "syncing" | "offline" | "error";

type State = {
  userId: string | null;
  loaded: boolean;
  pages: Record<string, Page>;
  dirty: Record<string, true>;
  deletions: Record<string, true>;
  /** Bumped when a page's content changes from another device, so the open editor reloads. */
  revs: Record<string, number>;
  status: SyncStatus;
  lastError: string | null;

  init: (userId: string) => Promise<void>;
  reset: () => Promise<void>;
  sync: () => Promise<void>;

  createPage: (parentId: string | null, patch?: Partial<Page>) => string;
  updatePage: (id: string, patch: Partial<Page>) => void;
  setContent: (id: string, content: Block[]) => void;
  archivePage: (id: string) => void;
  restorePage: (id: string) => void;
  deleteForever: (id: string) => void;
  emptyTrash: () => void;
  movePage: (id: string, newParentId: string | null) => void;
};

const keys = (uid: string) => ({
  pages: `notes:${uid}:pages`,
  dirty: `notes:${uid}:dirty`,
  deletions: `notes:${uid}:deletions`,
  lastSync: `notes:${uid}:lastSync`,
});

// Local edit counter per page: a flush only clears `dirty` if nothing changed while it was in flight.
const versions = new Map<string, number>();
const bumpVersion = (id: string) => versions.set(id, (versions.get(id) ?? 0) + 1);

let channel: RealtimeChannel | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let syncing: Promise<void> | null = null;
let syncAgain = false;
let cleanupListeners: (() => void) | null = null;
// getSession() and onAuthStateChange(INITIAL_SESSION) both call init() on startup; share one run.
let initRun: { userId: string; promise: Promise<void> } | null = null;

const nowIso = () => new Date().toISOString();

export const usePages = create<State>((set, get) => {
  const persist = () => {
    const { userId, pages, dirty, deletions } = get();
    if (!userId) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const k = keys(userId);
      void idbSet(k.pages, pages);
      void idbSet(k.dirty, dirty);
      void idbSet(k.deletions, deletions);
    }, 250);
  };

  const scheduleFlush = (ms = 900) => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => void get().sync(), ms);
  };

  const markDirty = (ids: string[]) => {
    const dirty = { ...get().dirty };
    ids.forEach((id) => {
      dirty[id] = true;
      bumpVersion(id);
    });
    set({ dirty });
  };

  const descendantsOf = (pages: Record<string, Page>, id: string): string[] => {
    const out: string[] = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const p of Object.values(pages)) {
        if (p.parent_id === cur) {
          out.push(p.id);
          stack.push(p.id);
        }
      }
    }
    return out;
  };

  const applyRemote = (row: Page) => {
    const { pages, dirty, deletions, revs } = get();
    if (dirty[row.id] || deletions[row.id]) return;
    const local = pages[row.id];
    if (local && local.updated_at >= row.updated_at) return;
    const contentChanged = !local || JSON.stringify(local.content) !== JSON.stringify(row.content);
    set({
      pages: { ...pages, [row.id]: row },
      revs: contentChanged ? { ...revs, [row.id]: (revs[row.id] ?? 0) + 1 } : revs,
    });
  };

  const removeLocal = (ids: string[]) => {
    const pages = { ...get().pages };
    const dirty = { ...get().dirty };
    ids.forEach((id) => {
      delete pages[id];
      delete dirty[id];
    });
    set({ pages, dirty });
  };

  const pull = async (userId: string, full: boolean) => {
    const k = keys(userId);
    const lastSync = full ? null : ((await idbGet<string>(k.lastSync)) ?? null);
    let newest = lastSync;
    const pageSize = 500;
    for (let from = 0; ; from += pageSize) {
      let q = supabase.from("pages").select(PAGE_COLUMNS).order("updated_at", { ascending: true });
      if (lastSync) {
        // small overlap guards against clock skew between server writes
        q = q.gt("updated_at", new Date(new Date(lastSync).getTime() - 10_000).toISOString());
      }
      const { data, error } = await q.range(from, from + pageSize - 1);
      if (error) throw error;
      const rows = (data ?? []) as Page[];
      rows.forEach(applyRemote);
      for (const r of rows) if (!newest || r.updated_at > newest) newest = r.updated_at;
      if (rows.length < pageSize) break;
    }

    if (full) {
      // Detect pages deleted on another device.
      const { data, error } = await supabase.from("pages").select("id");
      if (error) throw error;
      const remoteIds = new Set((data ?? []).map((r: { id: string }) => r.id));
      const { pages, dirty } = get();
      const gone = Object.keys(pages).filter((id) => !remoteIds.has(id) && !dirty[id]);
      if (gone.length) removeLocal(gone);
    }
    if (newest) await idbSet(k.lastSync, newest);
  };

  const pushDeletions = async () => {
    const ids = Object.keys(get().deletions);
    if (!ids.length) return;
    const { error } = await supabase.from("pages").delete().in("id", ids);
    if (error) throw error;
    const deletions = { ...get().deletions };
    ids.forEach((id) => delete deletions[id]);
    set({ deletions });
  };

  const pushDirty = async () => {
    const { pages, dirty } = get();
    const ids = Object.keys(dirty).filter((id) => pages[id]);
    // Drop dirty markers for pages that no longer exist locally.
    if (ids.length !== Object.keys(dirty).length) {
      const d: Record<string, true> = {};
      ids.forEach((id) => (d[id] = true));
      set({ dirty: d });
    }
    if (!ids.length) return;

    // Parents must exist on the server before their children (RLS + FK),
    // so upload in levels: pages whose parent isn't also pending go first.
    const level = new Map<string, number>();
    const levelOf = (id: string, seen = new Set<string>()): number => {
      if (level.has(id)) return level.get(id)!;
      const parent = pages[id]?.parent_id;
      let l = 0;
      if (parent && dirty[parent] && !seen.has(parent)) {
        seen.add(id);
        l = levelOf(parent, seen) + 1;
      }
      level.set(id, l);
      return l;
    };
    ids.forEach((id) => levelOf(id));
    const maxLevel = Math.max(...level.values());

    for (let l = 0; l <= maxLevel; l++) {
      const batchIds = ids.filter((id) => level.get(id) === l);
      if (!batchIds.length) continue;
      const snapshotVersions = new Map(batchIds.map((id) => [id, versions.get(id) ?? 0]));
      const rows = batchIds.map((id) => {
        const p = get().pages[id];
        return {
          id: p.id,
          owner_id: p.owner_id,
          parent_id: p.parent_id,
          title: p.title,
          icon: p.icon,
          content: p.content,
          search_text: p.search_text,
          position: p.position,
          is_favorite: p.is_favorite,
          is_archived: p.is_archived,
          created_at: p.created_at,
        };
      });

      const { data, error } = await supabase
        .from("pages")
        .upsert(rows, { onConflict: "id" })
        .select("id,updated_at,archived_at");

      if (error) {
        // Parent was deleted elsewhere (FK) or isn't ours (RLS): re-home the page at the root.
        if (error.code === "23503" || error.code === "42501") {
          const fixed = { ...get().pages };
          batchIds.forEach((id) => {
            if (fixed[id]?.parent_id) fixed[id] = { ...fixed[id], parent_id: null };
          });
          set({ pages: fixed });
        }
        throw error;
      }

      const nextPages = { ...get().pages };
      const nextDirty = { ...get().dirty };
      for (const r of (data ?? []) as Pick<Page, "id" | "updated_at" | "archived_at">[]) {
        if (!nextPages[r.id]) continue;
        if ((versions.get(r.id) ?? 0) === snapshotVersions.get(r.id)) {
          delete nextDirty[r.id];
          nextPages[r.id] = { ...nextPages[r.id], updated_at: r.updated_at, archived_at: r.archived_at };
        }
      }
      set({ pages: nextPages, dirty: nextDirty });
    }
  };

  const subscribe = (userId: string) => {
    channel?.unsubscribe();
    channel = supabase
      .channel(`pages:${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "notes", table: "pages", filter: `owner_id=eq.${userId}` },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const id = (payload.old as { id?: string }).id;
            if (id && !get().dirty[id] && get().pages[id]) {
              removeLocal([id, ...descendantsOf(get().pages, id)]);
              persist();
            }
          } else {
            applyRemote(payload.new as Page);
            persist();
          }
        },
      )
      .subscribe();
  };

  return {
    userId: null,
    loaded: false,
    pages: {},
    dirty: {},
    deletions: {},
    revs: {},
    status: "idle",
    lastError: null,

    init(userId) {
      if (get().userId === userId && get().loaded) return Promise.resolve();
      if (initRun?.userId === userId) return initRun.promise;
      const promise = initFor(userId).finally(() => {
        if (initRun?.promise === promise) initRun = null;
      });
      initRun = { userId, promise };
      return promise;
    },

    async reset() {
      const uid = get().userId;
      initRun = null;
      cleanupListeners?.();
      cleanupListeners = null;
      await channel?.unsubscribe();
      channel = null;
      if (flushTimer) clearTimeout(flushTimer);
      if (persistTimer) clearTimeout(persistTimer);
      if (uid) {
        const k = keys(uid);
        await delMany([k.pages, k.dirty, k.deletions, k.lastSync]);
      }
      versions.clear();
      set({ userId: null, loaded: false, pages: {}, dirty: {}, deletions: {}, revs: {}, status: "idle" });
    },

    sync: () => doSync(false),

    createPage(parentId, patch = {}) {
      const { pages, userId } = get();
      if (!userId) throw new Error("Not signed in");
      const siblings = Object.values(pages).filter((p) => p.parent_id === parentId);
      const position = siblings.length ? Math.max(...siblings.map((p) => p.position)) + 1 : 0;
      const now = nowIso();
      const page: Page = {
        id: crypto.randomUUID(),
        owner_id: userId,
        parent_id: parentId,
        title: "",
        icon: null,
        content: [],
        search_text: "",
        position,
        is_favorite: false,
        is_archived: false,
        archived_at: null,
        created_at: now,
        updated_at: now,
        ...patch,
      };
      set({ pages: { ...pages, [page.id]: page } });
      markDirty([page.id]);
      persist();
      scheduleFlush(300);
      return page.id;
    },

    updatePage(id, patch) {
      const p = get().pages[id];
      if (!p) return;
      set({ pages: { ...get().pages, [id]: { ...p, ...patch, updated_at: nowIso() } } });
      markDirty([id]);
      persist();
      scheduleFlush();
    },

    setContent(id, content) {
      const p = get().pages[id];
      if (!p) return;
      set({
        pages: {
          ...get().pages,
          [id]: { ...p, content, search_text: blocksToText(content), updated_at: nowIso() },
        },
      });
      markDirty([id]);
      persist();
      scheduleFlush();
    },

    archivePage(id) {
      get().updatePage(id, { is_archived: true, is_favorite: false, archived_at: nowIso() });
    },

    restorePage(id) {
      const { pages } = get();
      const p = pages[id];
      if (!p) return;
      // If the old parent is gone or still in trash, restore to the top level.
      const parent = p.parent_id ? pages[p.parent_id] : null;
      const parentOk = parent && !isTrashed(pages, parent.id);
      get().updatePage(id, { is_archived: false, archived_at: null, parent_id: parentOk ? p.parent_id : null });
    },

    deleteForever(id) {
      const { pages } = get();
      const ids = [id, ...descendantsOf(pages, id)];
      removeLocal(ids);
      // The server cascades to children; we only need to delete the root.
      set({ deletions: { ...get().deletions, [id]: true } });
      persist();
      scheduleFlush(200);
    },

    emptyTrash() {
      const { pages } = get();
      Object.values(pages)
        .filter((p) => p.is_archived)
        .forEach((p) => get().pages[p.id] && get().deleteForever(p.id));
    },

    movePage(id, newParentId) {
      const { pages } = get();
      if (newParentId === id) return;
      if (newParentId && descendantsOf(pages, id).includes(newParentId)) return; // no cycles
      const siblings = Object.values(pages).filter((p) => p.parent_id === newParentId && p.id !== id);
      const position = siblings.length ? Math.max(...siblings.map((p) => p.position)) + 1 : 0;
      get().updatePage(id, { parent_id: newParentId, position });
    },
  };

  async function initFor(userId: string): Promise<void> {
    cleanupListeners?.();
    const k = keys(userId);
    const [pages, dirty, deletions] = await Promise.all([
      idbGet<Record<string, Page>>(k.pages),
      idbGet<Record<string, true>>(k.dirty),
      idbGet<Record<string, true>>(k.deletions),
    ]);
    set({
      userId,
      loaded: true,
      pages: pages ?? {},
      dirty: dirty ?? {},
      deletions: deletions ?? {},
      status: navigator.onLine ? "idle" : "offline",
    });

    subscribe(userId);

    const onOnline = () => void get().sync();
    const onOffline = () => set({ status: "offline" });
    const onVisible = () => document.visibilityState === "visible" && void get().sync();
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    const interval = setInterval(() => {
      if (Object.keys(get().dirty).length || Object.keys(get().deletions).length) void get().sync();
    }, 30_000);
    cleanupListeners = () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(interval);
    };

    // First sync of a session does a full pull so deletions from other devices show up.
    await doSync(true);
  }

  async function doSync(full: boolean): Promise<void> {
    const uid = get().userId;
    if (!uid) return;
    if (!navigator.onLine) {
      set({ status: "offline" });
      return;
    }
    if (syncing) {
      syncAgain = true;
      return syncing;
    }
    set({ status: "syncing" });
    syncing = (async () => {
      try {
        await pushDeletions();
        await pushDirty();
        await pull(uid, full);
        set({ status: "idle", lastError: null });
      } catch (e) {
        const msg = e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e);
        console.error("[sync]", e);
        set({ status: navigator.onLine ? "error" : "offline", lastError: msg });
      } finally {
        persist();
        syncing = null;
        if (syncAgain) {
          syncAgain = false;
          scheduleFlush(500);
        }
      }
    })();
    return syncing;
  }
});

/** A page is in the trash if it or any ancestor is archived. */
export function isTrashed(pages: Record<string, Page>, id: string): boolean {
  let cur: Page | undefined = pages[id];
  let guard = 0;
  while (cur && guard++ < 100) {
    if (cur.is_archived) return true;
    cur = cur.parent_id ? pages[cur.parent_id] : undefined;
  }
  return false;
}

export function childrenOf(pages: Record<string, Page>, parentId: string | null) {
  return Object.values(pages)
    .filter((p) => p.parent_id === parentId && !p.is_archived)
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
}

export function ancestorsOf(pages: Record<string, Page>, id: string): Page[] {
  const out: Page[] = [];
  let cur = pages[id]?.parent_id ? pages[pages[id].parent_id!] : undefined;
  let guard = 0;
  while (cur && guard++ < 100) {
    out.unshift(cur);
    cur = cur.parent_id ? pages[cur.parent_id] : undefined;
  }
  return out;
}

export function hasPending() {
  const s = usePages.getState();
  return Object.keys(s.dirty).length > 0 || Object.keys(s.deletions).length > 0;
}
