import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { FileText, History, LogOut, MoreHorizontal } from "lucide-react";
import { useAuth } from "../store/auth";
import { usePages } from "../store/pages";
import { useShares } from "../store/shares";
import { useUi } from "../store/ui";
import { useTheme } from "../lib/theme";
import { blocksToText, displayTitle } from "../lib/text";
import { MEDIA_PREFIX } from "../lib/supabase";
import { resolveFileUrl } from "../lib/media";
import type { Block } from "../lib/types";
import {
  fetchMember,
  fetchMemberState,
  fetchShared,
  fetchSharedState,
  saveMember,
  saveMemberOnExit,
  saveShared,
  saveSharedOnExit,
  sharedFileUrl,
  type SharedPage,
  type SharedTree,
} from "../lib/share";
import { useEditLock } from "../lib/useEditLock";
import { PageLinkContext } from "../lib/pageLinkContext";
import { EditorBoundary } from "../components/EditorBoundary";
import { IconButton, MenuItem, Popover } from "../components/Menu";
import { TopBar } from "../components/TopBar";

const Editor = lazy(() => import("../components/Editor").then((m) => ({ default: m.Editor })));

const POLL_MS = 5000;
const SAVE_DEBOUNCE_MS = 800;

/** How the visitor reached the page: a public link, or an invite to their account. */
type Access = { kind: "link"; token: string } | { kind: "invite"; root: string };

/** The same operations for both kinds of access. */
function accessApi(access: Access) {
  if (access.kind === "link") {
    const t = access.token;
    return {
      lockToken: t as string | null,
      fetch: () => fetchShared(t),
      state: () => fetchSharedState(t),
      save: (id: string, blocks: Block[]) => saveShared(t, id, blocks, blocksToText(blocks)),
      saveOnExit: (id: string, blocks: Block[], jwt: string) => saveSharedOnExit(t, id, blocks, blocksToText(blocks), jwt),
      href: (id?: string) => `/s/${t}${id ? `/${id}` : ""}`,
      resolveFile: async (url: string) => (url.startsWith(MEDIA_PREFIX) ? sharedFileUrl(t, url.slice(MEDIA_PREFIX.length)) : url),
    };
  }
  const r = access.root;
  return {
    lockToken: null,
    fetch: () => fetchMember(r),
    state: () => fetchMemberState(r),
    save: (id: string, blocks: Block[]) => saveMember(id, blocks, blocksToText(blocks)),
    saveOnExit: (id: string, blocks: Block[], jwt: string) => saveMemberOnExit(id, blocks, blocksToText(blocks), jwt),
    href: (id?: string) => (id && id !== r ? `/shared/${r}/${id}` : `/shared/${r}`),
    resolveFile: resolveFileUrl,
  };
}

/** /s/:token/:pageId? : a page shared to the web, readable by anyone with the link. */
export function LinkSharedPage() {
  const { token = "", pageId } = useParams();
  const access = useMemo<Access>(() => ({ kind: "link", token }), [token]);
  return <SharedView key={token} access={access} pageId={pageId} />;
}

/** /shared/:rootId/:pageId? : a page someone invited this user to, inside the app. */
export function InvitedPage() {
  const { rootId = "", pageId } = useParams();
  const own = usePages((s) => Boolean(s.pages[pageId ?? rootId]));
  const access = useMemo<Access>(() => ({ kind: "invite", root: rootId }), [rootId]);
  if (own) return <Navigate to={`/p/${pageId ?? rootId}`} replace />; // the owner opened an invite link
  return <SharedView key={rootId} access={access} pageId={pageId} />;
}

function SharedView({ access, pageId }: { access: Access; pageId?: string }) {
  const api = useMemo(() => accessApi(access), [access]);
  const invited = access.kind === "invite";
  const isDark = useTheme((s) => s.isDark);
  const [tree, setTree] = useState<SharedTree | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [revs, setRevs] = useState<Record<string, number>>({});
  const [holders, setHolders] = useState<Record<string, { editor: string; name?: string | null }>>({});
  const session = useAuth((s) => s.session);
  const [saveError, setSaveError] = useState<string | null>(null);
  const known = useRef<Record<string, string>>({}); // page id -> updated_at we last loaded

  const load = useCallback(
    async (bump?: string[]) => {
      try {
        const t = await api.fetch();
        setTree(t);
        setFailed(false);
        known.current = Object.fromEntries((t?.pages ?? []).map((p) => [p.id, p.updated_at]));
        if (bump?.length) setRevs((r) => ({ ...r, ...Object.fromEntries(bump.map((id) => [id, (r[id] ?? 0) + 1])) }));
      } catch {
        setFailed(true);
      }
    },
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const pages = useMemo(() => Object.fromEntries((tree?.pages ?? []).map((p) => [p.id, p])), [tree]);
  const current: SharedPage | undefined = tree ? pages[pageId ?? tree.root_id] : undefined;
  const allowsEdit = Boolean(tree?.can_edit);
  // Editing needs an account; a signed-out link visitor reads, with a sign-in prompt.
  const canEdit = allowsEdit && Boolean(session);
  const holder = holders[current?.id ?? ""] ?? null;
  const lock = useEditLock(current?.id ?? "", api.lockToken, canEdit && Boolean(current), holder?.editor ?? null);
  const accessToken = useRef<string | null>(null);
  accessToken.current = session?.access_token ?? null;
  const holdingRef = useRef(false);
  holdingRef.current = lock.holding;

  // Poll for changes and edit locks. Reload pages someone else changed; never the one being typed in.
  useEffect(() => {
    if (!tree) return;
    let alive = true;
    const t = setInterval(async () => {
      try {
        const s = await api.state();
        if (!alive) return;
        if (!s) return setTree(null);
        setHolders(Object.fromEntries(s.locks.map((l) => [l.page_id, { editor: l.editor, name: l.name }])));
        const changed = s.pages.filter((p) => known.current[p.id] !== p.updated_at).map((p) => p.id);
        const membership = s.pages.length !== Object.keys(known.current).length;
        const skip = holdingRef.current && current ? current.id : null;
        const reload = changed.filter((id) => id !== skip);
        if (reload.length || membership || s.can_edit !== tree.can_edit) await load(reload);
      } catch {
        /* offline: try again next tick */
      }
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tree, api, load, current]);

  // Debounced saves while holding the lock.
  const pending = useRef<{ id: string; blocks: Block[] } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    try {
      const r = await api.save(p.id, p.blocks);
      if (!r.ok) setSaveError("Someone else started editing, so your last change wasn't saved.");
      else {
        setSaveError(null);
        if (r.updated_at) known.current[p.id] = r.updated_at;
      }
    } catch {
      pending.current = pending.current ?? p; // keep it for the next attempt
      setSaveError("Couldn't save. Check your connection.");
    }
  }, [api]);

  useEffect(() => {
    const onHide = () => {
      if (timer.current) clearTimeout(timer.current);
      const p = pending.current;
      pending.current = null;
      if (p && accessToken.current) api.saveOnExit(p.id, p.blocks, accessToken.current);
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      void flush();
    };
  }, [flush, api, current?.id]);

  const onChange = useCallback(
    (blocks: Block[]) => {
      if (!current || !lock.holding) return;
      lock.activity();
      pending.current = { id: current.id, blocks };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    },
    [current, lock, flush],
  );

  const resolveLink = useCallback(
    (id: string) => (pages[id] ? { title: displayTitle(pages[id].title), icon: pages[id].icon, href: api.href(id) } : null),
    [pages, api],
  );
  const files = useMemo(() => ({ resolve: api.resolveFile }), [api]);
  const linkCandidates = useCallback(
    () => Object.values(pages).map((p) => ({ id: p.id, title: p.title, icon: p.icon, updated_at: p.updated_at })),
    [pages],
  );

  useEffect(() => {
    document.title = current ? `${current.icon ? current.icon + " " : ""}${displayTitle(current.title)}` : "Margin";
  }, [current]);

  if (tree === undefined) {
    return failed ? <Message invited={invited} text="Can't reach the server. Check your connection." /> : null;
  }
  if (tree === null) {
    return invited ? (
      <Message invited text="You don't have access to this page anymore. The owner may have removed you or moved it to trash." home="/" homeLabel="Go to your pages" />
    ) : (
      <Message text="This link doesn't work anymore. The owner may have stopped sharing it." />
    );
  }
  if (!current) return <Message invited={invited} text="This page isn't part of what was shared." home={api.href()} />;

  const trail: SharedPage[] = [];
  for (let p: SharedPage | undefined = current; p; p = p.parent_id ? pages[p.parent_id] : undefined) {
    trail.unshift(p);
    if (p.id === tree.root_id) break;
  }
  const children = Object.values(pages)
    .filter((p) => p.parent_id === current.id)
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));

  const editingName = holder?.name ? `${holder.name} is editing` : "Someone else is editing";
  const status = !allowsEdit ? "View only" : lock.heldByOther ? editingName : lock.holding ? "Editing" : "Can edit";
  const statusEl = (
    <span className={`shrink-0 rounded-md px-2 py-0.5 text-[12px] ${lock.heldByOther ? "text-muted" : "text-faint"}`}>{status}</span>
  );

  const article = (
    <article className="mx-auto w-full max-w-[760px] px-5 pb-[30vh] pt-10 sm:px-14 sm:pt-16">
      {current.icon && <div className="mb-2 text-[56px] leading-none">{current.icon}</div>}
      <h1 className="page-title text-ink">{displayTitle(current.title)}</h1>
      {saveError && <p className="mt-3 text-[13px] text-danger">{saveError}</p>}
      <div className="mt-2 sm:-mx-[54px]">
        <EditorBoundary key={`${current.id}:${revs[current.id] ?? 0}`} fallbackText={blocksToText(current.content)}>
          <Suspense fallback={<div className="h-7 sm:px-[54px]" />}>
            <Editor
              key={`${current.id}:${revs[current.id] ?? 0}`}
              pageId={current.id}
              rev={revs[current.id] ?? 0}
              initialContent={current.content}
              isDark={isDark}
              editable={canEdit && !lock.heldByOther}
              onChange={onChange}
              files={files}
              linkCandidates={linkCandidates}
              onFocusChange={(focused) => (focused ? void lock.acquire() : (void flush(), lock.blurred()))}
            />
          </Suspense>
        </EditorBoundary>
      </div>
      {children.length > 0 && (
        <section className="mt-10 border-t border-line pt-4">
          <ul>
            {children.map((k) => (
              <li key={k.id}>
                <Link to={api.href(k.id)} className="-mx-2 flex h-9 items-center gap-2 rounded-md px-2 text-[15px] hover:bg-hover">
                  <span className="flex w-5 justify-center text-[16px] leading-none">
                    {k.icon || <FileText size={17} className="text-faint" strokeWidth={1.75} />}
                  </span>
                  <span className="truncate underline decoration-line underline-offset-4">{displayTitle(k.title)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );

  return (
    <PageLinkContext.Provider value={resolveLink}>
      {invited ? (
        <div className="flex h-full flex-col">
          <TopBar
            crumbs={trail.map((p) => ({ id: p.id, icon: p.icon, title: displayTitle(p.title) }))}
            hrefFor={api.href}
            right={
              <>
                {statusEl}
                <InvitedMenu
                  rootId={tree.root_id}
                  canEdit={canEdit}
                  onHistory={() =>
                    useUi.getState().setHistory({
                      pageId: current.id,
                      title: current.title,
                      invited: { onRestored: () => void load([current.id]) },
                    })
                  }
                />
              </>
            }
          />
          <div className="min-h-0 flex-1 overflow-y-auto">{article}</div>
        </div>
      ) : (
        <div className="flex min-h-full flex-col bg-paper">
          <header className="safe-top sticky top-0 z-10 bg-paper">
            <div className="flex h-11 items-center gap-2 px-3">
              <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center text-[14px]">
                {trail.map((p, i) => (
                  <span key={p.id} className={`flex min-w-0 items-center ${i === trail.length - 1 ? "" : "max-sm:hidden"}`}>
                    <Link
                      to={api.href(p.id)}
                      className={`flex min-w-0 items-center gap-1.5 truncate rounded-md px-1.5 py-1 hover:bg-hover ${i === trail.length - 1 ? "text-ink" : "text-muted"}`}
                    >
                      {p.icon && <span className="leading-none">{p.icon}</span>}
                      <span className="max-w-[180px] truncate">{displayTitle(p.title)}</span>
                    </Link>
                    {i < trail.length - 1 && <span className="text-faint">/</span>}
                  </span>
                ))}
              </nav>
              {allowsEdit && !session ? (
                // A full page load: the sign-in screen lives outside this shared-page router.
                <a
                  href={`/login?next=${encodeURIComponent(api.href(pageId))}`}
                  className="shrink-0 rounded-md bg-ink px-2.5 py-1 text-[13px] font-medium text-paper hover:opacity-90"
                >
                  Sign in to edit
                </a>
              ) : (
                statusEl
              )}
            </div>
          </header>
          <main className="flex-1">{article}</main>
          <footer className="px-5 pb-6 text-center text-[12px] text-faint">Shared with Margin</footer>
        </div>
      )}
    </PageLinkContext.Provider>
  );
}

/** Version history (for editors) and leaving the shared page. */
function InvitedMenu({ rootId, canEdit, onHistory }: { rootId: string; canEdit: boolean; onHistory: () => void }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const navigate = useNavigate();

  const leave = async () => {
    close();
    if (!window.confirm("Remove this page from Shared with me? You'll need a new invite to see it again.")) return;
    try {
      await useShares.getState().leave(rootId);
      navigate("/", { replace: true });
    } catch {
      useUi.getState().notify("Couldn't leave the page. Check your connection.");
    }
  };

  return (
    <>
      <IconButton label="More actions" buttonRef={btn} onClick={() => setOpen((v) => !v)}>
        <MoreHorizontal size={16} />
      </IconButton>
      <Popover anchor={btn.current} open={open} onClose={close} align="end">
        {canEdit && (
          <MenuItem
            icon={<History size={15} />}
            onClick={() => {
              close();
              onHistory();
            }}
          >
            Version history
          </MenuItem>
        )}
        <MenuItem danger icon={<LogOut size={15} />} onClick={() => void leave()}>
          Leave page
        </MenuItem>
      </Popover>
    </>
  );
}

function Message({ text, home, homeLabel, invited }: { text: string; home?: string; homeLabel?: string; invited?: boolean }) {
  const body = (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center gap-3 bg-paper px-6 text-center">
      <p className="max-w-[420px] text-[15px] text-ink">{text}</p>
      {home && (
        <Link to={home} className="rounded-md px-3 py-1.5 text-[14px] text-accent hover:bg-hover">
          {homeLabel ?? "Go to the shared page"}
        </Link>
      )}
    </main>
  );
  // Inside the app the top bar keeps the sidebar reachable on phones.
  return invited ? (
    <div className="flex h-full flex-col">
      <TopBar crumbs={null} />
      {body}
    </div>
  ) : (
    body
  );
}
