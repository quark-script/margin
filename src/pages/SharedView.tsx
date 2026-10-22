import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { FileText } from "lucide-react";
import { useAuth } from "../store/auth";
import { useTheme } from "../lib/theme";
import { blocksToText, displayTitle } from "../lib/text";
import { MEDIA_PREFIX } from "../lib/supabase";
import type { Block } from "../lib/types";
import {
  fetchShared,
  fetchSharedState,
  saveShared,
  saveSharedOnExit,
  sharedFileUrl,
  type SharedPage,
  type SharedTree,
} from "../lib/share";
import { useEditLock } from "../lib/useEditLock";
import { PageLinkContext } from "../lib/pageLinkContext";
import { EditorBoundary } from "../components/EditorBoundary";

const Editor = lazy(() => import("../components/Editor").then((m) => ({ default: m.Editor })));

const POLL_MS = 5000;
const SAVE_DEBOUNCE_MS = 800;

/** A page shared to the web: readable by anyone with the link, editable if the owner allows. */
export function SharedView() {
  const { token = "", pageId } = useParams();
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
        const t = await fetchShared(token);
        setTree(t);
        setFailed(false);
        known.current = Object.fromEntries((t?.pages ?? []).map((p) => [p.id, p.updated_at]));
        if (bump?.length) setRevs((r) => ({ ...r, ...Object.fromEntries(bump.map((id) => [id, (r[id] ?? 0) + 1])) }));
      } catch {
        setFailed(true);
      }
    },
    [token],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const pages = useMemo(() => Object.fromEntries((tree?.pages ?? []).map((p) => [p.id, p])), [tree]);
  const current: SharedPage | undefined = tree ? pages[pageId ?? tree.root_id] : undefined;
  const linkCanEdit = Boolean(tree?.can_edit);
  // Editing through a link needs an account; without one the page is read-only with a sign-in prompt.
  const canEdit = linkCanEdit && Boolean(session);
  const holder = holders[current?.id ?? ""] ?? null;
  const lock = useEditLock(current?.id ?? "", token, canEdit && Boolean(current), holder?.editor ?? null);
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
        const s = await fetchSharedState(token);
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
  }, [tree, token, load, current]);

  // Debounced saves while holding the lock.
  const pending = useRef<{ id: string; blocks: Block[] } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    try {
      const r = await saveShared(token, p.id, p.blocks, blocksToText(p.blocks));
      if (!r.ok) setSaveError("Someone else started editing, so your last change wasn't saved.");
      else {
        setSaveError(null);
        if (r.updated_at) known.current[p.id] = r.updated_at;
      }
    } catch {
      pending.current = pending.current ?? p; // keep it for the next attempt
      setSaveError("Couldn't save. Check your connection.");
    }
  }, [token]);

  useEffect(() => {
    const onHide = () => {
      if (timer.current) clearTimeout(timer.current);
      const p = pending.current;
      pending.current = null;
      if (p && accessToken.current) saveSharedOnExit(token, p.id, p.blocks, blocksToText(p.blocks), accessToken.current);
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      void flush();
    };
  }, [flush, token, current?.id]);

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
    (id: string) => (pages[id] ? { title: displayTitle(pages[id].title), icon: pages[id].icon, href: `/s/${token}/${id}` } : null),
    [pages, token],
  );
  const files = useMemo(
    () => ({
      resolve: async (url: string) => (url.startsWith(MEDIA_PREFIX) ? sharedFileUrl(token, url.slice(MEDIA_PREFIX.length)) : url),
    }),
    [token],
  );
  const linkCandidates = useCallback(
    () => Object.values(pages).map((p) => ({ id: p.id, title: p.title, icon: p.icon, updated_at: p.updated_at })),
    [pages],
  );

  useEffect(() => {
    document.title = current ? `${current.icon ? current.icon + " " : ""}${displayTitle(current.title)}` : "Margin";
  }, [current]);

  if (tree === undefined) return failed ? <Message text="Can't reach the server. Check your connection." /> : null;
  if (tree === null) return <Message text="This link doesn't work anymore. The owner may have stopped sharing it." />;
  if (!current) return <Message text="This page isn't part of the shared link." home={`/s/${token}`} />;

  const trail: SharedPage[] = [];
  for (let p: SharedPage | undefined = current; p; p = p.parent_id ? pages[p.parent_id] : undefined) {
    trail.unshift(p);
    if (p.id === tree.root_id) break;
  }
  const children = Object.values(pages)
    .filter((p) => p.parent_id === current.id)
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));

  const editingName = holder?.name ? `${holder.name} is editing` : "Someone else is editing";
  const status = !linkCanEdit ? "View only" : lock.heldByOther ? editingName : lock.holding ? "Editing" : "Can edit";
  const signInHref = `/login?next=${encodeURIComponent(`/s/${token}${pageId ? `/${pageId}` : ""}`)}`;

  return (
    <PageLinkContext.Provider value={resolveLink}>
      <div className="flex min-h-full flex-col bg-paper">
        <header className="safe-top sticky top-0 z-10 bg-paper">
          <div className="flex h-11 items-center gap-2 px-3">
            <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center text-[14px]">
              {trail.map((p, i) => (
                <span key={p.id} className={`flex min-w-0 items-center ${i === trail.length - 1 ? "" : "max-sm:hidden"}`}>
                  <Link
                    to={`/s/${token}/${p.id}`}
                    className={`flex min-w-0 items-center gap-1.5 truncate rounded-md px-1.5 py-1 hover:bg-hover ${i === trail.length - 1 ? "text-ink" : "text-muted"}`}
                  >
                    {p.icon && <span className="leading-none">{p.icon}</span>}
                    <span className="max-w-[180px] truncate">{displayTitle(p.title)}</span>
                  </Link>
                  {i < trail.length - 1 && <span className="text-faint">/</span>}
                </span>
              ))}
            </nav>
            {linkCanEdit && !session ? (
              // A full page load: the sign-in screen lives outside this shared-page router.
              <a
                href={signInHref}
                className="shrink-0 rounded-md bg-ink px-2.5 py-1 text-[13px] font-medium text-paper hover:opacity-90"
              >
                Sign in to edit
              </a>
            ) : (
              <span className={`shrink-0 rounded-md px-2 py-0.5 text-[12px] ${lock.heldByOther ? "text-muted" : "text-faint"}`}>
                {status}
              </span>
            )}
          </div>
        </header>

        <main className="flex-1">
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
                      <Link to={`/s/${token}/${k.id}`} className="-mx-2 flex h-9 items-center gap-2 rounded-md px-2 text-[15px] hover:bg-hover">
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
        </main>
        <footer className="px-5 pb-6 text-center text-[12px] text-faint">Shared with Margin</footer>
      </div>
    </PageLinkContext.Provider>
  );
}

function Message({ text, home }: { text: string; home?: string }) {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-3 bg-paper px-6 text-center">
      <p className="text-[15px] text-ink">{text}</p>
      {home && (
        <Link to={home} className="rounded-md px-3 py-1.5 text-[14px] text-accent hover:bg-hover">
          Go to the shared page
        </Link>
      )}
    </main>
  );
}
