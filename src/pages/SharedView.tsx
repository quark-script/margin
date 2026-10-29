import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FileText, History, LogOut, MoreHorizontal } from "lucide-react";
import { useAuth } from "../store/auth";
import { useShares } from "../store/shares";
import { useUi } from "../store/ui";
import { useTheme } from "../lib/theme";
import { blocksToText, displayTitle } from "../lib/text";
import { MEDIA_PREFIX } from "../lib/supabase";
import { resolveFileUrl } from "../lib/media";
import type { Block } from "../lib/types";
import {
  fetchTree,
  fetchTreeState,
  recordLinkView,
  saveSharedPage,
  saveSharedPageOnExit,
  sharedFileUrl,
  shareRoot,
  type SharedPage as Page,
  type SharedTree,
} from "../lib/share";
import { useEditLock } from "../lib/useEditLock";
import { usePresence } from "../lib/usePresence";
import { PageLinkContext } from "../lib/pageLinkContext";
import { EditorBoundary } from "../components/EditorBoundary";
import { IconButton, MenuItem, Popover } from "../components/Menu";
import { TopBar } from "../components/TopBar";
import { ShareMenu } from "../components/ShareMenu";
import { Facepile } from "../components/Facepile";
import { Login } from "./Login";

const Editor = lazy(() => import("../components/Editor").then((m) => ({ default: m.Editor })));

const POLL_MS = 5000;
const SAVE_DEBOUNCE_MS = 800;
const href = (id: string) => `/p/${id}`;

/** /p/:pageId for a signed-in person who isn't the owner: shown inside their app. */
export function SharedPage({ pageId }: { pageId: string }) {
  return <SharedView pageId={pageId} layout="app" />;
}

/** /p/:pageId when signed out: the page if it's open to anyone with the link, else sign-in. */
export function PublicPage() {
  const { pageId = "" } = useParams();
  return <SharedView pageId={pageId} layout="public" />;
}

/** /s/:token from before every page had one link: on to the page it points at. */
export function TokenRedirect() {
  const { token = "", pageId } = useParams();
  const [gone, setGone] = useState(false);
  useEffect(() => {
    shareRoot(token)
      .then((root) => (root ? location.replace(href(pageId ?? root)) : setGone(true)))
      .catch(() => setGone(true));
  }, [token, pageId]);
  return gone ? <Message text="This link doesn't work anymore. The owner may have stopped sharing it." /> : null;
}

function SharedView({ pageId, layout }: { pageId: string; layout: "app" | "public" }) {
  const isDark = useTheme((s) => s.isDark);
  const session = useAuth((s) => s.session);
  const [tree, setTree] = useState<SharedTree | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [revs, setRevs] = useState<Record<string, number>>({});
  const [holders, setHolders] = useState<Record<string, { editor: string; name?: string | null }>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const known = useRef<Record<string, string>>({}); // page id -> updated_at we last loaded

  const load = useCallback(async (id: string, bump?: string[]) => {
    try {
      const t = await fetchTree(id);
      setTree(t);
      setFailed(false);
      known.current = Object.fromEntries((t?.pages ?? []).map((p) => [p.id, p.updated_at]));
      if (bump?.length) setRevs((r) => ({ ...r, ...Object.fromEntries(bump.map((x) => [x, (r[x] ?? 0) + 1])) }));
    } catch {
      setFailed(true);
    }
  }, []);

  const pages = useMemo(() => Object.fromEntries((tree?.pages ?? []).map((p) => [p.id, p])), [tree]);
  // Moving between pages of what was shared needs no reload; another page does.
  useEffect(() => {
    if (tree === undefined || (tree && !pages[pageId])) void load(pageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  const current: Page | undefined = pages[pageId];
  const allowsEdit = Boolean(tree?.can_edit);
  const canEdit = allowsEdit && Boolean(session); // editing always needs an account
  const holder = holders[current?.id ?? ""] ?? null;
  const lock = useEditLock(current?.id ?? "", null, canEdit && Boolean(current), holder?.editor ?? null);
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
        const s = await fetchTreeState(tree.root_id);
        if (!alive) return;
        if (!s) return setTree(null);
        setHolders(Object.fromEntries(s.locks.map((l) => [l.page_id, { editor: l.editor, name: l.name }])));
        const changed = s.pages.filter((p) => known.current[p.id] !== p.updated_at).map((p) => p.id);
        const membership = s.pages.length !== Object.keys(known.current).length;
        const skip = holdingRef.current && current ? current.id : null;
        const reload = changed.filter((id) => id !== skip);
        if (reload.length || membership || s.can_edit !== tree.can_edit || s.root_id !== tree.root_id) {
          await load(current?.id ?? tree.root_id, reload);
        }
      } catch {
        /* offline: try again next tick */
      }
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [tree, load, current]);

  // Debounced saves while holding the lock.
  const pending = useRef<{ id: string; blocks: Block[] } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    try {
      const r = await saveSharedPage(p.id, p.blocks, blocksToText(p.blocks));
      if (!r.ok) setSaveError("Someone else started editing, so your last change wasn't saved.");
      else {
        setSaveError(null);
        if (r.updated_at) known.current[p.id] = r.updated_at;
      }
    } catch {
      pending.current = pending.current ?? p; // keep it for the next attempt
      setSaveError("Couldn't save. Check your connection.");
    }
  }, []);

  useEffect(() => {
    const onHide = () => {
      if (timer.current) clearTimeout(timer.current);
      const p = pending.current;
      pending.current = null;
      if (p && accessToken.current) saveSharedPageOnExit(p.id, p.blocks, blocksToText(p.blocks), accessToken.current);
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      void flush();
    };
  }, [flush, current?.id]);

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
    (id: string) => (pages[id] ? { title: displayTitle(pages[id].title), icon: pages[id].icon, href: href(id) } : null),
    [pages],
  );
  // Invitees may read the owner's images directly; link visitors go through the share-file function.
  const files = useMemo(
    () => ({
      resolve: async (url: string) =>
        tree?.via === "invite" || !url.startsWith(MEDIA_PREFIX) ? resolveFileUrl(url) : sharedFileUrl(tree?.root_id ?? "", url.slice(MEDIA_PREFIX.length)),
    }),
    [tree?.via, tree?.root_id],
  );
  const linkCandidates = useCallback(
    () => Object.values(pages).map((p) => ({ id: p.id, title: p.title, icon: p.icon, updated_at: p.updated_at })),
    [pages],
  );

  useEffect(() => {
    if (current) document.title = `${current.icon ? current.icon + " " : ""}${displayTitle(current.title)}`;
  }, [current]);

  // Invited: who else is here. Through the link: one visit counted, nobody identified.
  const presence = usePresence(current?.id ?? "", layout === "app" && tree?.via === "invite" && Boolean(session));
  useEffect(() => {
    if (tree?.via !== "link") return;
    const key = `margin:link-visit:${tree.root_id}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      /* storage blocked: count it anyway */
    }
    void recordLinkView(tree.root_id);
  }, [tree?.via, tree?.root_id]);

  const app = layout === "app";
  if (tree === undefined || (tree && !current && !failed)) {
    return failed ? <Message app={app} text="Can't reach the server. Check your connection." /> : null;
  }
  if (!tree || !current) {
    return app ? (
      // Also what you see for one of your own pages after deleting it for good.
      <Message
        app
        text="This page doesn't exist, or you don't have access to it."
        detail={`If someone shared it with you, ask them to invite ${session?.user.email ?? "you"}.`}
        home="/"
        homeLabel="Go to your pages"
      />
    ) : (
      <Login />
    );
  }

  const trail: Page[] = [];
  for (let p: Page | undefined = current; p; p = p.parent_id ? pages[p.parent_id] : undefined) {
    trail.unshift(p);
    if (p.id === tree.root_id) break;
  }
  const children = Object.values(pages)
    .filter((p) => p.parent_id === current.id)
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));

  // Only say something when it matters: read-only, or someone else has the page.
  const status = lock.heldByOther ? `${holder?.name ?? "Someone"} is editing` : !allowsEdit ? "View only" : null;
  const statusEl = status && <span className="shrink-0 px-2 text-[13px] text-muted">{status}</span>;

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
                <Link to={href(k.id)} className="-mx-2 flex h-9 items-center gap-2 rounded-md px-2 text-[15px] hover:bg-hover">
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
      {app ? (
        <div className="flex h-full flex-col">
          <TopBar
            crumbs={trail.map((p) => ({ id: p.id, icon: p.icon, title: displayTitle(p.title) }))}
            right={
              <>
                {statusEl}
                <Facepile people={presence.people} ownerView={presence.ownerView} />
                {tree.via === "invite" && <ShareMenu pageId={current.id} invited />}
                {tree.via === "invite" && (
                  <InvitedActions
                    rootId={tree.root_id}
                    canEdit={canEdit}
                    onHistory={() =>
                      useUi.getState().setHistory({
                        pageId: current.id,
                        title: current.title,
                        invited: { onRestored: () => void load(current.id, [current.id]) },
                      })
                    }
                  />
                )}
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
                      to={href(p.id)}
                      className={`flex min-w-0 items-center gap-1.5 truncate rounded-md px-1.5 py-1 hover:bg-hover ${i === trail.length - 1 ? "text-ink" : "text-muted"}`}
                    >
                      {p.icon && <span className="leading-none">{p.icon}</span>}
                      <span className="max-w-[180px] truncate">{displayTitle(p.title)}</span>
                    </Link>
                    {i < trail.length - 1 && <span className="text-faint">/</span>}
                  </span>
                ))}
              </nav>
              {allowsEdit ? (
                // A full page load: the sign-in screen lives outside this page's router.
                <a
                  href={`/login?next=${encodeURIComponent(href(pageId))}&intent=edit`}
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
          <footer className="px-5 pb-6 text-center text-[12px] text-faint">
            <a href="/" className="hover:text-muted">
              Shared with Margin
            </a>
          </footer>
        </div>
      )}
    </PageLinkContext.Provider>
  );
}

/** For pages you were invited to: version history (editors) and leaving the page. */
function InvitedActions({ rootId, canEdit, onHistory }: { rootId: string; canEdit: boolean; onHistory: () => void }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const navigate = useNavigate();

  const leave = async () => {
    close();
    if (!window.confirm("Leave this page? You'll need a new invitation to open it again.")) return;
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

function Message({
  text,
  detail,
  home,
  homeLabel,
  app,
}: {
  text: string;
  detail?: string;
  home?: string;
  homeLabel?: string;
  app?: boolean;
}) {
  const body = (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center gap-2 bg-paper px-6 text-center">
      <p className="max-w-[420px] text-[15px] text-ink">{text}</p>
      {detail && <p className="max-w-[420px] text-[14px] text-muted">{detail}</p>}
      {home && (
        <Link to={home} className="mt-1 rounded-md px-3 py-1.5 text-[14px] text-accent hover:bg-hover">
          {homeLabel ?? "Go home"}
        </Link>
      )}
    </main>
  );
  // Inside the app the top bar keeps the sidebar reachable on phones.
  return app ? (
    <div className="flex h-full flex-col">
      <TopBar crumbs={null} />
      {body}
    </div>
  ) : (
    body
  );
}
