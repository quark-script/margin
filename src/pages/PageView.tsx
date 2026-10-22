import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FileText, Plus, RotateCcw, Smile, Star, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { BlockNoteEditor } from "@blocknote/core";
import { ancestorsOf, childrenOf, isTrashed, usePages } from "../store/pages";
import { useUi } from "../store/ui";
import { useTheme } from "../lib/theme";
import { displayTitle } from "../lib/text";
import { backlinksTo } from "../lib/links";
import { EmojiPicker, randomEmoji } from "../components/EmojiPicker";
import { IconButton, Popover } from "../components/Menu";
import { PageMenu } from "../components/PageTree";
import { TopBar } from "../components/TopBar";
import { EditorBoundary } from "../components/EditorBoundary";
import { ShareMenu } from "../components/ShareMenu";
import { editableByOthers, useShares } from "../store/shares";
import { memberRootFor, pageLockInfo } from "../lib/share";
import { useEditLock } from "../lib/useEditLock";

const Editor = lazy(() => import("../components/Editor").then((m) => ({ default: m.Editor })));

export function PageView() {
  const { pageId = "" } = useParams();
  const page = usePages((s) => s.pages[pageId]);
  const loaded = usePages((s) => s.loaded);
  const status = usePages((s) => s.status);
  const rev = usePages((s) => s.revs[pageId] ?? 0);
  const trashed = usePages((s) => isTrashed(s.pages, pageId));
  const ancestors = usePages(useShallow((s) => ancestorsOf(s.pages, pageId)));
  const isDark = useTheme((s) => s.isDark);
  const expandMany = useUi((s) => s.expandMany);
  const editorRef = useRef<BlockNoteEditor | null>(null);
  // Enter in the title before the lazy editor has loaded: focus the body once it's ready.
  const focusBodyWhenReady = useRef(false);

  const focusBody = (ed: BlockNoteEditor) => {
    const first = ed.document[0];
    if (first) ed.setTextCursorPosition(first, "start");
    ed.focus();
  };

  useEffect(() => {
    if (ancestors.length) expandMany(ancestors.map((a) => a.id));
  }, [ancestors, expandMany]);

  useEffect(() => {
    document.title = page ? `${page.icon ? page.icon + " " : ""}${displayTitle(page.title)}` : "Margin";
    if (page) {
      try {
        localStorage.setItem("lastPage", page.id);
      } catch {
        /* ignore */
      }
    }
  }, [page?.title, page?.icon, page?.id, page]);

  // Pages others can edit (a link or an invite) take turns: whoever is typing holds the page.
  const pages = usePages((s) => s.pages);
  const shares = useShares((s) => s.shares);
  const members = useShares((s) => s.members);
  const lockEnabled = editableByOthers(pages, shares, members, pageId) && !trashed;
  const [holder, setHolder] = useState<{ editor: string; name: string | null } | null>(null);
  useEffect(() => {
    setHolder(null);
    if (!lockEnabled) return;
    let alive = true;
    const poll = () => pageLockInfo(pageId).then((h) => alive && setHolder(h)).catch(() => {});
    void poll();
    const t = setInterval(poll, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pageId, lockEnabled]);
  const lock = useEditLock(pageId, null, lockEnabled, holder?.editor ?? null);

  // Not one of ours: maybe someone invited us to it (they sent the page's own link).
  const navigate = useNavigate();
  const [checkingInvite, setCheckingInvite] = useState(false);
  const missing = loaded && !page && status !== "syncing";
  useEffect(() => {
    if (!missing || !navigator.onLine) return;
    let alive = true;
    setCheckingInvite(true);
    memberRootFor(pageId)
      .then((root) => {
        if (alive && root) navigate(root === pageId ? `/shared/${root}` : `/shared/${root}/${pageId}`, { replace: true });
      })
      .catch(() => {})
      .finally(() => alive && setCheckingInvite(false));
    return () => {
      alive = false;
    };
  }, [missing, pageId, navigate]);

  const setContent = useCallback((blocks: Parameters<ReturnType<typeof usePages.getState>["setContent"]>[1]) => {
    lock.activity();
    usePages.getState().setContent(pageId, blocks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, lock.activity]);

  if (!loaded) return <PageSkeleton />;

  if (!page) {
    return (
      <div className="flex h-full flex-col">
        <TopBar crumbs={null} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          {status === "syncing" || checkingInvite ? (
            <p className="text-[15px] text-muted">Looking for this page…</p>
          ) : (
            <>
              <p className="text-[15px] text-ink">This page doesn't exist or was deleted.</p>
              <Link to="/" className="rounded-md px-3 py-1.5 text-[14px] text-accent hover:bg-hover">
                Go to home
              </Link>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar
        crumbs={[...ancestors, page].map((p) => ({ id: p.id, icon: p.icon, title: displayTitle(p.title) }))}
        right={
          <>
            {!trashed && <ShareMenu pageId={page.id} />}
            {!trashed && (
              <IconButton
                label={page.is_favorite ? "Remove from favorites" : "Add to favorites"}
                onClick={() => usePages.getState().updatePage(page.id, { is_favorite: !page.is_favorite })}
              >
                <Star
                  size={16}
                  className={page.is_favorite ? "fill-[#E6B422] text-[#E6B422]" : ""}
                  strokeWidth={1.75}
                />
              </IconButton>
            )}
            <PageMenu id={page.id} align="end" />
          </>
        }
      />

      {trashed && <TrashedBanner pageId={page.id} archivedSelf={page.is_archived} />}
      {lock.heldByOther && <EditingElsewhereBanner name={holder?.name ?? null} />}

      <div className="min-h-0 flex-1 overflow-y-auto" id="page-scroll">
        <article className="mx-auto w-full max-w-[760px] px-5 pb-[40vh] pt-10 sm:px-14 sm:pt-16">
          <PageHeader
            key={page.id}
            pageId={page.id}
            readOnly={trashed}
            onEnter={() => {
              if (editorRef.current) return focusBody(editorRef.current);
              focusBodyWhenReady.current = true;
              (document.activeElement as HTMLElement | null)?.blur();
            }}
          />
          <div className="mt-2 sm:-mx-[54px]">
            <EditorBoundary key={`${page.id}:${rev}`} fallbackText={page.search_text}>
            <Suspense fallback={<div className="h-7 sm:px-[54px]" />}>
            <Editor
              key={`${page.id}:${rev}`}
              pageId={page.id}
              rev={rev}
              initialContent={page.content}
              isDark={isDark}
              editable={!trashed && !lock.heldByOther}
              onChange={setContent}
              onFocusChange={(focused) => (focused ? void lock.acquire() : lock.blurred())}
              onReady={(ed) => {
                editorRef.current = ed;
                if (focusBodyWhenReady.current) {
                  focusBodyWhenReady.current = false;
                  focusBody(ed);
                }
              }}
            />
            </Suspense>
            </EditorBoundary>
          </div>
          {!trashed && <SubPages pageId={page.id} />}
          <Backlinks pageId={page.id} />
        </article>
      </div>
    </div>
  );
}

function PageHeader({ pageId, readOnly, onEnter }: { pageId: string; readOnly: boolean; onEnter: () => void }) {
  const page = usePages((s) => s.pages[pageId]);
  const updatePage = usePages((s) => s.updatePage);
  const ta = useRef<HTMLTextAreaElement>(null);
  const iconBtn = useRef<HTMLButtonElement>(null);
  const addIconBtn = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [value, setValue] = useState(page?.title ?? "");
  const closePicker = useCallback(() => setPickerOpen(false), []);

  // Pick up title changes from other devices while this field isn't focused.
  useEffect(() => {
    if (page && document.activeElement !== ta.current) setValue(page.title);
  }, [page?.title, page]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = el.scrollHeight + "px";
  }, [value]);

  // New, empty pages open with the cursor in the title.
  useEffect(() => {
    if (page && !page.title && !page.content.length && !readOnly) ta.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!page) return null;

  const pick = (e: string | null) => {
    updatePage(pageId, { icon: e });
    setPickerOpen(false);
  };

  return (
    <header className="group/header">
      {page.icon ? (
        <button
          ref={iconBtn}
          onClick={() => !readOnly && setPickerOpen(true)}
          className="-ml-1 mb-2 flex h-[72px] w-[72px] items-center justify-center rounded-lg text-[56px] leading-none hover:bg-hover"
          aria-label="Change icon"
        >
          {page.icon}
        </button>
      ) : (
        !readOnly && (
          <div className="mb-1 flex h-7 items-center opacity-0 transition-opacity group-hover/header:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100">
            <button
              ref={addIconBtn}
              onClick={() => updatePage(pageId, { icon: randomEmoji() })}
              onContextMenu={(e) => {
                e.preventDefault();
                setPickerOpen(true);
              }}
              className="-ml-1.5 flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[13px] text-muted hover:bg-hover"
            >
              <Smile size={15} /> Add icon
            </button>
          </div>
        )
      )}
      <Popover anchor={iconBtn.current ?? addIconBtn.current} open={pickerOpen} onClose={closePicker} width={316}>
        <EmojiPicker onPick={pick} onRemove={page.icon ? () => pick(null) : undefined} />
      </Popover>

      <textarea
        ref={ta}
        rows={1}
        value={value}
        readOnly={readOnly}
        placeholder="Untitled"
        aria-label="Page title"
        onChange={(e) => {
          const v = e.target.value.replace(/\n/g, " ");
          setValue(v);
          updatePage(pageId, { title: v });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || (e.key === "ArrowDown" && ta.current?.selectionStart === value.length)) {
            e.preventDefault();
            onEnter();
          }
        }}
        className="page-title block w-full resize-none overflow-hidden bg-transparent text-ink outline-none placeholder:text-faint/70"
      />
    </header>
  );
}

function SubPages({ pageId }: { pageId: string }) {
  const kids = usePages(useShallow((s) => childrenOf(s.pages, pageId)));
  const navigate = useNavigate();
  const expandMany = useUi((s) => s.expandMany);
  const add = () => {
    const id = usePages.getState().createPage(pageId);
    expandMany([pageId]);
    navigate(`/p/${id}`);
  };
  return (
    <section className="mt-10 border-t border-line pt-4">
      {kids.length > 0 && (
        <ul className="mb-1">
          {kids.map((k) => (
            <li key={k.id}>
              <Link
                to={`/p/${k.id}`}
                className="-mx-2 flex h-9 items-center gap-2 rounded-md px-2 text-[15px] hover:bg-hover"
              >
                <span className="flex w-5 justify-center text-[16px] leading-none">
                  {k.icon || <FileText size={17} className="text-faint" strokeWidth={1.75} />}
                </span>
                <span className="truncate underline decoration-line underline-offset-4">{displayTitle(k.title)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <button
        onClick={add}
        className="-mx-2 flex h-9 items-center gap-2 rounded-md px-2 text-[14px] text-muted hover:bg-hover hover:text-ink"
      >
        <Plus size={16} /> Add a page inside
      </button>
    </section>
  );
}

function Backlinks({ pageId }: { pageId: string }) {
  const links = usePages(useShallow((s) => backlinksTo(s.pages, pageId).filter((p) => !isTrashed(s.pages, p.id))));
  if (!links.length) return null;
  return (
    <section className="mt-8">
      <h2 className="mb-1 text-[13px] font-medium text-muted">Linked from</h2>
      <ul>
        {links.map((p) => (
          <li key={p.id}>
            <Link to={`/p/${p.id}`} className="-mx-2 flex h-9 items-center gap-2 rounded-md px-2 text-[15px] hover:bg-hover">
              <span className="flex w-5 justify-center text-[16px] leading-none">
                {p.icon || <FileText size={17} className="text-faint" strokeWidth={1.75} />}
              </span>
              <span className="truncate">{displayTitle(p.title)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EditingElsewhereBanner({ name }: { name: string | null }) {
  return (
    <div className="border-b border-line px-4 py-2 text-center text-[14px] text-muted">
      {name ?? "Someone"} is editing this page. It updates live; you can edit when they stop.
    </div>
  );
}

function TrashedBanner({ pageId, archivedSelf }: { pageId: string; archivedSelf: boolean }) {
  const navigate = useNavigate();
  const { restorePage, deleteForever } = usePages.getState();
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 bg-danger px-4 py-2 text-[14px] text-white">
      <span>{archivedSelf ? "This page is in trash." : "A page above this one is in trash."}</span>
      {archivedSelf && (
        <span className="flex gap-2">
          <button
            onClick={() => restorePage(pageId)}
            className="flex items-center gap-1.5 rounded-md border border-white/50 px-2 py-0.5 hover:bg-white/15"
          >
            <RotateCcw size={13} /> Restore page
          </button>
          <button
            onClick={() => {
              deleteForever(pageId);
              navigate("/");
            }}
            className="flex items-center gap-1.5 rounded-md border border-white/50 px-2 py-0.5 hover:bg-white/15"
          >
            <Trash2 size={13} /> Delete forever
          </button>
        </span>
      )}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[760px] px-5 pt-24 sm:px-14">
      <div className="h-9 w-2/3 animate-pulse rounded-md bg-hover" />
      <div className="mt-6 space-y-3">
        <div className="h-4 w-full animate-pulse rounded bg-hover" />
        <div className="h-4 w-5/6 animate-pulse rounded bg-hover" />
        <div className="h-4 w-4/6 animate-pulse rounded bg-hover" />
      </div>
    </div>
  );
}
