import { create } from "zustand";
import { get as idbGet, set as idbSet, delMany, keys as idbKeys } from "idb-keyval";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { PAGE_COLUMNS, type Block, type Page } from "../lib/types";
import { blocksToText } from "../lib/text";
import { deleteLocalFilesExcept, LOCAL_ID, LOCAL_PREFIX, localFile, rememberUpload } from "../lib/local";
import { STORAGE_LIMIT_BYTES, storageUsed, uploadToStorage } from "../lib/media";
import { invitesCovering, shareCovering, useShares } from "./shares";
import { useUi } from "./ui";

/**
 * Offline-first page store.
 *
 * - Every change lands in memory + IndexedDB immediately, so the UI never waits on the network.
 * - Changed page ids go into `dirty`; a debounced flush upserts them to Supabase.
 * - Remote changes (pull on start/focus + realtime) are applied only to pages with no pending
 *   local edits, so you never lose what you just typed. Last write wins per page.
 * - With "Sync all pages" off, only pages shared with others go up and come down; the rest stay
 *   dirty on this device until it's turned on. A page that isn't on the server yet goes up too
 *   when a shared page is put inside it (the server needs it), without being shared.
 */

/** "local": no account, pages stay on this device. "paused": signed in, "Sync all pages" off. */
export type SyncStatus = "idle" | "syncing" | "offline" | "error" | "local" | "paused";

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
  /**
   * "Sync all pages" on this device. Off: only pages shared with others sync (so they always see
   * the latest); everything else stays on this device until it's turned on.
   */
  syncOn: boolean;

  init: (userId: string) => Promise<void>;
  setSyncOn: (on: boolean) => void;
  /** After signing in from Margin without an account: move this device's pages into the account. */
  adoptLocal: (uid: string) => Promise<{ pages: number }>;
  /** Put these pages on the server now, whatever "Sync all pages" says (to share one). */
  uploadNow: (ids: string[]) => Promise<boolean>;
  reset: () => Promise<void>;
  sync: () => Promise<void>;

  createPage: (parentId: string | null, patch?: Partial<Page>) => string;
  updatePage: (id: string, patch: Partial<Page>) => void;
  setContent: (id: string, content: Block[]) => void;
  /** Put back an earlier version: replaces title, icon and content and reloads the open editor. */
  restoreVersion: (id: string, v: Pick<Page, "title" | "icon" | "content">) => void;
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

// "Sync all pages", per account on this device.
const syncKey = (uid: string) => `margin:sync:${uid}`;
function syncPreference(uid: string, hadCopy: boolean) {
  try {
    const saved = localStorage.getItem(syncKey(uid));
    if (saved === "all" || saved === "shared") return saved === "all";
    // First run of this version: a device that already holds this account's pages keeps syncing
    // everything (unless it was switched off before); a new device starts private.
    const on = localStorage.getItem(`margin:sync-off:${uid}`) === "1" ? false : hadCopy;
    localStorage.setItem(syncKey(uid), on ? "all" : "shared");
    localStorage.removeItem(`margin:sync-off:${uid}`);
    return on;
  } catch {
    return hadCopy;
  }
}

/** Can someone else open this page: a link, or an invite, on it or a page above it. */
export function sharedWithOthers(pages: Record<string, Page>, id: string) {
  const { shares, members } = useShares.getState();
  return Boolean(shareCovering(pages, shares, id) || invitesCovering(pages, members, id));
}

// Pages to upload once whatever "Sync all pages" says (see uploadNow).
const forced = new Set<string>();

/** Addresses of the images kept on this device that these blocks show. */
function deviceImages(blocks: Block[], out = new Set<string>()) {
  for (const b of blocks) {
    const url = b.props?.url;
    if (typeof url === "string" && url.startsWith(LOCAL_PREFIX)) out.add(url);
    if (b.children) deviceImages(b.children, out);
  }
  return out;
}

let toldImagesStayed = false;

/** Images kept on this device go up when their page syncs; the server copy points at the upload. */
async function withUploadedImages(blocks: Block[], uid: string): Promise<Block[]> {
  const urls = deviceImages(blocks);
  if (!urls.size) return blocks;
  const uploaded = new Map<string, string>();
  for (const url of urls) {
    const file = await localFile(url);
    if (!file) continue;
    if (file.remote) {
      uploaded.set(url, file.remote);
      continue;
    }
    try {
      const remote = await uploadToStorage(uid, file.blob, file.name);
      await rememberUpload(url, remote);
      uploaded.set(url, remote);
    } catch (e) {
      // No answer, or a server hiccup: this sync fails and it's tried again. Refused (storage full,
      // a type the storage doesn't take): the image stays on this device, shown only here, so the
      // page itself still syncs. It's tried again the next time the page changes.
      const status = (e as { status?: number }).status;
      if (status === undefined || status >= 500 || status === 408 || status === 429) throw e;
      if (!toldImagesStayed) {
        toldImagesStayed = true;
        const full = await storageUsed().then((used) => used >= STORAGE_LIMIT_BYTES, () => false);
        useUi
          .getState()
          .notify(
            full
              ? "Your storage is full (100 MB), so some images show only on this device. Settings > Storage can free up space."
              : "Some images couldn't upload, so they show only on this device.",
          );
      }
    }
  }
  const rewrite = (bs: Block[]): Block[] =>
    bs.map((b) => {
      const url = b.props?.url;
      const to = typeof url === "string" ? uploaded.get(url) : undefined;
      return { ...b, ...(to ? { props: { ...b.props, url: to } } : {}), ...(b.children ? { children: rewrite(b.children) } : {}) };
    });
  return rewrite(blocks);
}

// Local edit counter per page: a flush only clears `dirty` if nothing changed while it was in flight.
const versions = new Map<string, number>();
const bumpVersion = (id: string) => versions.set(id, (versions.get(id) ?? 0) + 1);

let channel: RealtimeChannel | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let syncing: Promise<void> | null = null;
let syncAgain = false;
// A full pull was asked for (start, "Sync all pages" turned on) and hasn't run yet.
let fullDue = false;
let cleanupListeners: (() => void) | null = null;
// getSession() and onAuthStateChange(INITIAL_SESSION) both call init() on startup; share one run.
let initRun: { userId: string; promise: Promise<void> } | null = null;

const nowIso = () => new Date().toISOString();

export const usePages = create<State>((set, get) => {
  const writeLocal = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    const { userId, pages, dirty, deletions } = get();
    if (!userId) return;
    const k = keys(userId);
    void idbSet(k.pages, pages);
    void idbSet(k.dirty, dirty);
    void idbSet(k.deletions, deletions);
  };

  const persist = () => {
    if (!get().userId) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(writeLocal, 250);
  };

  const scheduleFlush = (ms = 900) => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void get().sync();
    }, ms);
  };

  // With "Sync all pages" off, sharing a page makes it sync: send its waiting edits right away,
  // so whoever opens it sees them.
  useShares.subscribe((now, before) => {
    const changed = now.shares !== before.shares || now.members !== before.members;
    if (changed && !get().syncOn && Object.keys(get().dirty).length) scheduleFlush(300);
  });

  const markDirty = (ids: string[]) => {
    if (get().userId === LOCAL_ID) return; // nothing to send without an account
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

  // A page from the server that someone else can open (it may not be on this device yet).
  const sharedRow = (row: Page) => {
    const { shares, members } = useShares.getState();
    return Boolean(shares[row.id] || members[row.id]?.length || (row.parent_id && sharedWithOthers(get().pages, row.parent_id)));
  };

  // Off: only pages others can open come in. A parent can arrive after its children, so go round
  // until nothing more applies.
  const applyRows = (rows: Page[]) => {
    if (get().syncOn) return rows.forEach(applyRemote);
    let rest = rows;
    for (let more = true; more && rest.length; ) {
      more = false;
      const next: Page[] = [];
      for (const row of rest) {
        if (sharedRow(row)) {
          applyRemote(row);
          more = true;
        } else next.push(row);
      }
      rest = next;
    }
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
      applyRows(rows);
      for (const r of rows) if (!newest || r.updated_at > newest) newest = r.updated_at;
      if (rows.length < pageSize) break;
    }

    if (full) {
      // Detect pages deleted on another device. Keyset-paged: the API caps a response at 1000 rows,
      // and a truncated list would make every page past the cap look deleted.
      const remoteIds = new Set<string>();
      for (let after: string | null = null; ; ) {
        let q = supabase.from("pages").select("id").order("id").limit(pageSize);
        if (after) q = q.gt("id", after);
        const { data, error } = await q;
        if (error) throw error;
        const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
        ids.forEach((id) => remoteIds.add(id));
        if (ids.length < pageSize) break;
        after = ids[ids.length - 1];
      }
      const { pages, dirty } = get();
      const gone = Object.keys(pages).filter(
        (id) => !remoteIds.has(id) && !dirty[id] && (get().syncOn || sharedWithOthers(pages, id)),
      );
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
    const existing = Object.keys(dirty).filter((id) => pages[id]);
    // Drop dirty markers for pages that no longer exist locally.
    if (existing.length !== Object.keys(dirty).length) {
      const d: Record<string, true> = {};
      existing.forEach((id) => (d[id] = true));
      set({ dirty: d });
    }
    // With "Sync all pages" off, the rest wait here.
    const ids = existing.filter((id) => get().syncOn || forced.has(id) || sharedWithOthers(pages, id));
    if (!ids.length) return;
    const pushing = new Set(ids);

    // Parents must exist on the server before their children (RLS + FK),
    // so upload in levels: pages whose parent isn't also pending go first.
    const level = new Map<string, number>();
    const levelOf = (id: string, seen = new Set<string>()): number => {
      if (level.has(id)) return level.get(id)!;
      const parent = pages[id]?.parent_id;
      let l = 0;
      if (parent && pushing.has(parent) && !seen.has(parent)) {
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
      const rows = await Promise.all(
        batchIds.map(async (id) => {
          const p = get().pages[id];
          return {
            id: p.id,
            owner_id: p.owner_id,
            parent_id: p.parent_id,
            title: p.title,
            icon: p.icon,
            content: await withUploadedImages(p.content ?? [], p.owner_id),
            search_text: p.search_text,
            position: p.position,
            is_favorite: p.is_favorite,
            is_archived: p.is_archived,
            created_at: p.created_at,
          };
        }),
      );

      const upsert = (r: typeof rows) =>
        supabase.from("pages").upsert(r, { onConflict: "id" }).select("id,updated_at,archived_at");
      let { data, error } = await upsert(rows);

      // Parent was deleted elsewhere (FK) or isn't ours (RLS). One bad row fails the whole batch,
      // so retry row by row and re-home only the rows that fail at the root; they go up next sync.
      // With "Sync all pages" off, the parent may just not be on the server yet: it goes up first.
      const orphanError = (e: { code?: string } | null) => e?.code === "23503" || e?.code === "42501";
      let orphaned = false;
      if (orphanError(error)) {
        data = [];
        error = null;
        for (const row of rows) {
          const res = await upsert([row]);
          const p = get().pages[row.id];
          if (orphanError(res.error) && p?.parent_id) {
            if (!get().syncOn && get().pages[p.parent_id] && get().dirty[p.parent_id]) forced.add(p.parent_id);
            else set({ pages: { ...get().pages, [row.id]: { ...p, parent_id: null } } });
            orphaned = true;
          } else if (res.error) {
            error = res.error;
            break;
          } else {
            data.push(...(res.data ?? []));
          }
        }
      }
      if (error) throw error;
      if (orphaned) syncAgain = true;

      const nextPages = { ...get().pages };
      const nextDirty = { ...get().dirty };
      for (const r of (data ?? []) as Pick<Page, "id" | "updated_at" | "archived_at">[]) {
        if (!nextPages[r.id]) continue;
        if ((versions.get(r.id) ?? 0) === snapshotVersions.get(r.id)) {
          delete nextDirty[r.id];
          forced.delete(r.id);
          nextPages[r.id] = { ...nextPages[r.id], updated_at: r.updated_at, archived_at: r.archived_at };
        }
      }
      set({ pages: nextPages, dirty: nextDirty });
      // Children of a re-homed page would fail the same way; let the next sync take them.
      if (orphaned) return;
    }
  };

  const subscribe = (userId: string) => {
    channel?.unsubscribe();
    const table = { schema: "notes", table: "pages" } as const;
    const ownRows = { ...table, filter: `owner_id=eq.${userId}` };
    const onUpsert = ({ new: row }: { new: object }) => {
      if (!get().syncOn && !sharedRow(row as Page)) return;
      applyRemote(row as Page);
      persist();
    };
    channel = supabase
      .channel(`pages:${userId}`)
      .on("postgres_changes", { ...ownRows, event: "INSERT" }, onUpsert)
      .on("postgres_changes", { ...ownRows, event: "UPDATE" }, onUpsert)
      // Realtime can't filter DELETE events, and with RLS `old` carries only the id.
      // Ids we don't have locally are ignored.
      .on("postgres_changes", { ...table, event: "DELETE" }, ({ old }) => {
        const id = (old as { id?: string }).id;
        if (id && !get().dirty[id] && get().pages[id] && (get().syncOn || sharedWithOthers(get().pages, id))) {
          removeLocal([id, ...descendantsOf(get().pages, id)]);
          persist();
        }
      })
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
    syncOn: true,

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
      forced.clear();
      fullDue = false;
      set({ userId: null, loaded: false, pages: {}, dirty: {}, deletions: {}, revs: {}, status: "idle" });
    },

    sync: () => doSync(false),

    setSyncOn(on) {
      const uid = get().userId;
      if (!uid || uid === LOCAL_ID) return;
      try {
        localStorage.setItem(syncKey(uid), on ? "all" : "shared");
      } catch {
        /* storage blocked: the choice lasts until the app closes */
      }
      set({ syncOn: on });
      // On: everything goes up and everything comes down. Off: shared pages carry on syncing.
      if (on) void doSync(true);
      else if (get().status === "idle") set({ status: "paused" });
    },

    async adoptLocal(uid) {
      const k = keys(LOCAL_ID);
      const local = Object.values((await idbGet<Record<string, Page>>(k.pages)) ?? {});
      if (get().userId !== uid) return { pages: 0 };
      // After the account's own pages at the top level, in their own order. They sync like any
      // other page; their images go up when they do.
      const top = Math.max(-1, ...Object.values(get().pages).filter((p) => !p.parent_id).map((p) => p.position)) + 1;
      const adopted: Record<string, Page> = {};
      for (const p of local) adopted[p.id] = { ...p, owner_id: uid, position: p.parent_id ? p.position : top + p.position };
      if (local.length) {
        set({ pages: { ...get().pages, ...adopted } });
        markDirty(Object.keys(adopted));
        persist();
        scheduleFlush(0);
      }
      await delMany([k.pages, k.dirty, k.deletions, k.lastSync]);
      return { pages: local.length };
    },

    async uploadNow(ids) {
      ids.forEach((id) => forced.add(id));
      markDirty(ids);
      persist();
      const end = Date.now() + 20_000;
      while (ids.some((id) => get().dirty[id]) && Date.now() < end) {
        await doSync(false);
        if (ids.some((id) => get().dirty[id])) await new Promise((r) => setTimeout(r, 300));
      }
      return !ids.some((id) => get().dirty[id]);
    },

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

    restoreVersion(id, v) {
      const p = get().pages[id];
      if (!p) return;
      const content = v.content ?? [];
      set({
        pages: {
          ...get().pages,
          [id]: { ...p, title: v.title, icon: v.icon, content, search_text: blocksToText(content), updated_at: nowIso() },
        },
        revs: { ...get().revs, [id]: (get().revs[id] ?? 0) + 1 },
      });
      markDirty([id]);
      persist();
      scheduleFlush(0);
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
      if (get().userId !== LOCAL_ID) set({ deletions: { ...get().deletions, [id]: true } });
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
      // Moved out of a shared page with "Sync all pages" off: the server must hear it, or it stays
      // shared there.
      if (!get().syncOn && sharedWithOthers(pages, id)) forced.add(id);
      get().updatePage(id, { parent_id: newParentId, position });
    },
  };

  async function initFor(userId: string): Promise<void> {
    if (persistTimer) writeLocal(); // the last edits of whoever was here before
    cleanupListeners?.();
    void channel?.unsubscribe();
    channel = null;
    const k = keys(userId);
    const [pages, dirty, deletions] = await Promise.all([
      idbGet<Record<string, Page>>(k.pages),
      idbGet<Record<string, true>>(k.dirty),
      idbGet<Record<string, true>>(k.deletions),
    ]);
    const local = userId === LOCAL_ID;
    const syncOn = !local && syncPreference(userId, pages !== undefined);
    set({
      userId,
      loaded: true,
      pages: pages ?? {},
      dirty: dirty ?? {},
      deletions: deletions ?? {},
      syncOn,
      status: local ? "local" : !navigator.onLine ? "offline" : syncOn ? "idle" : "paused",
    });

    if (!local) subscribe(userId);

    const onOnline = () => void get().sync();
    const onOffline = () => get().status !== "local" && set({ status: "offline" });
    // Mobile browsers may kill a hidden page without further events, so don't sit on
    // debounced writes once we're hidden.
    const onVisible = () => {
      if (document.visibilityState === "visible") return void get().sync();
      if (persistTimer) writeLocal();
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
        void get().sync();
      }
    };
    const onPageHide = () => persistTimer && writeLocal();
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", onPageHide);
    const interval = setInterval(() => {
      if (Object.keys(get().dirty).length || Object.keys(get().deletions).length) void get().sync();
    }, 30_000);
    cleanupListeners = () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", onPageHide);
      clearInterval(interval);
    };

    // First sync of a session does a full pull so deletions from other devices show up.
    await doSync(true);
  }

  async function doSync(full: boolean): Promise<void> {
    if (full) fullDue = true;
    const uid = get().userId;
    if (!uid) return;
    if (uid === LOCAL_ID) return void set({ status: "local" });
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
      const wantFull = fullDue;
      fullDue = false;
      try {
        // What counts as shared decides what syncs while "Sync all pages" is off.
        if (!get().syncOn) {
          await useShares.getState().ensureLoaded();
          if (!useShares.getState().loaded) throw new Error("Couldn't check which pages are shared");
        }
        await pushDeletions();
        await pushDirty();
        await pull(uid, wantFull);
        set({ status: get().syncOn ? "idle" : "paused", lastError: null });
      } catch (e) {
        if (wantFull) fullDue = true;
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

/** Margin without an account: no sharing, version history or sync. */
export const useIsLocal = () => usePages((s) => s.userId === LOCAL_ID);

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

/** Images that pages here show from this device only: their page hasn't synced, or they couldn't upload. */
export async function imagesOnlyHere() {
  const urls = new Set<string>();
  Object.values(usePages.getState().pages).forEach((p) => deviceImages(p.content ?? [], urls));
  let n = 0;
  for (const url of urls) {
    const file = await localFile(url);
    if (file && !file.remote) n++;
  }
  return n;
}

/**
 * After signing out, deleting the account, or deleting Margin's pages without an account: remove
 * the images kept on this device that no page left here shows (a copy kept for unsynced edits
 * keeps its images).
 */
export async function pruneDeviceImages() {
  const inUse = new Set<string>();
  Object.values(usePages.getState().pages).forEach((p) => deviceImages(p.content ?? [], inUse));
  for (const key of await idbKeys()) {
    if (!/^notes:[^:]+:pages$/.test(String(key))) continue;
    const pages = await idbGet<Record<string, Page>>(String(key));
    Object.values(pages ?? {}).forEach((p) => deviceImages(p.content ?? [], inUse));
  }
  await deleteLocalFilesExcept(inUse);
}

/**
 * Signed out without asking (account deleted on another device, password changed), or starting
 * signed out: remove this device's copies of accounts that aren't signed in. A copy holding edits
 * that never reached the server stays, so they're saved when that account signs in again.
 */
export async function dropSignedOutCopies() {
  const s = usePages.getState();
  if (s.userId && s.userId !== LOCAL_ID && !hasPending()) await s.reset();
  const keep = usePages.getState().userId;
  for (const key of await idbKeys()) {
    const uid = /^notes:([^:]+):pages$/.exec(String(key))?.[1];
    // Pages kept without an account belong to no account: they stay.
    if (!uid || uid === keep || uid === LOCAL_ID) continue;
    const k = keys(uid);
    const [dirty, deletions] = await Promise.all([
      idbGet<Record<string, true>>(k.dirty),
      idbGet<Record<string, true>>(k.deletions),
    ]);
    if (Object.keys(dirty ?? {}).length || Object.keys(deletions ?? {}).length) continue;
    await delMany([k.pages, k.dirty, k.deletions, k.lastSync]);
  }
}
