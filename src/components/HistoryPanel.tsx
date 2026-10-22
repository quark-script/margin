import { lazy, Suspense, useEffect, useState } from "react";
import { ArrowLeft, X } from "lucide-react";
import { usePages } from "../store/pages";
import { useUi } from "../store/ui";
import { useTheme } from "../lib/theme";
import { displayTitle } from "../lib/text";
import { fetchHistory, fetchVersion, restoreInvitedVersion, restoreVersion, type Version, type VersionRow } from "../lib/history";
import { EditorBoundary } from "./EditorBoundary";
import { IconButton } from "./Menu";

const Editor = lazy(() => import("./Editor").then((m) => ({ default: m.Editor })));

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: days > 300 ? "numeric" : undefined });
};
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** Versions of a page: pick one to preview, restore it. The newest is the page as it is now. */
export function HistoryPanel() {
  const target = useUi((s) => s.history);
  const pageId = target?.pageId ?? null;
  const close = () => useUi.getState().setHistory(null);
  const ownPage = usePages((s) => (pageId ? s.pages[pageId] : undefined));
  const title = ownPage ? ownPage.title : (target?.title ?? "");
  const isDark = useTheme((s) => s.isDark);
  const [rows, setRows] = useState<VersionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [preview, setPreview] = useState<Version | null>(null);
  const [busy, setBusy] = useState(false);
  const [showList, setShowList] = useState(true); // phones show the list or the preview

  useEffect(() => {
    if (!pageId) return;
    setRows(null);
    setError(null);
    fetchHistory(pageId).then(
      (r) => {
        setRows(r);
        setSelected(r[0]?.id ?? null);
      },
      () => setError(navigator.onLine ? "Couldn't load the history." : "Version history needs a connection."),
    );
  }, [pageId]);

  useEffect(() => {
    if (selected == null) return;
    setPreview(null);
    let alive = true;
    fetchVersion(selected).then(
      (v) => alive && setPreview(v),
      () => alive && setError("Couldn't load this version."),
    );
    return () => {
      alive = false;
    };
  }, [selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!pageId || (!ownPage && !target?.invited)) return null;

  const isLatest = rows?.[0]?.id === selected;
  const restore = async () => {
    if (selected == null) return;
    setBusy(true);
    try {
      if (target?.invited) {
        await restoreInvitedVersion(pageId, selected);
        target.invited.onRestored();
      } else {
        await restoreVersion(pageId, selected);
      }
      useUi.getState().notify("Version restored. The previous state is kept in the history.");
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  let lastDay = "";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Version history"
      className="fixed inset-0 z-40 flex items-stretch justify-center bg-black/25 sm:items-center sm:p-6 dark:bg-black/50"
      onPointerDown={(e) => e.target === e.currentTarget && close()}
    >
      <div className="safe-top flex h-full w-full max-w-[1040px] flex-col overflow-hidden bg-pop shadow-pop sm:h-[82vh] sm:rounded-xl">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
          {!showList && (
            <IconButton label="Back to versions" onClick={() => setShowList(true)} className="sm:hidden">
              <ArrowLeft size={16} />
            </IconButton>
          )}
          <h2 className="min-w-0 flex-1 truncate px-1 text-[15px] font-medium text-ink">
            Version history <span className="text-muted">· {displayTitle(title)}</span>
          </h2>
          {preview && !isLatest && (
            <button
              onClick={() => void restore()}
              disabled={busy}
              className="h-8 shrink-0 rounded-md bg-ink px-3 text-[13px] font-medium text-paper hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Restoring…" : "Restore this version"}
            </button>
          )}
          <IconButton label="Close" onClick={close}>
            <X size={16} />
          </IconButton>
        </header>

        {error && <p className="border-b border-line px-4 py-2 text-[13px] text-danger">{error}</p>}

        <div className="flex min-h-0 flex-1">
          <aside
            className={`min-h-0 w-full shrink-0 overflow-y-auto border-line p-1.5 sm:block sm:w-[260px] sm:border-r ${showList ? "" : "max-sm:hidden"}`}
            aria-label="Versions"
          >
            {rows === null && !error && <p className="px-3 py-2 text-[13px] text-muted">Loading…</p>}
            {rows?.length === 0 && <p className="px-3 py-2 text-[13px] text-muted">No earlier versions yet.</p>}
            {rows?.map((r, i) => {
              const day = dayLabel(r.saved_at);
              const header = day !== lastDay ? ((lastDay = day), day) : null;
              return (
                <div key={r.id}>
                  {header && <div className="px-2.5 pt-3 pb-1 text-[12px] font-medium text-muted">{header}</div>}
                  <button
                    onClick={() => {
                      setSelected(r.id);
                      setShowList(false);
                    }}
                    aria-current={r.id === selected}
                    className={`flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left hover:bg-hover ${r.id === selected ? "bg-press" : ""}`}
                  >
                    <span className="text-[14px] text-ink">
                      {timeLabel(r.saved_at)}
                      {i === 0 && <span className="ml-1.5 text-[12px] text-muted">Current</span>}
                    </span>
                    <span className="text-[12px] text-muted">{r.mine ? "You" : (r.editor ?? "Someone")}</span>
                  </button>
                </div>
              );
            })}
          </aside>

          <section className={`min-h-0 min-w-0 flex-1 overflow-y-auto ${showList ? "max-sm:hidden" : ""}`} aria-label="Preview">
            {preview ? (
              <article className="mx-auto w-full max-w-[720px] px-5 pt-8 pb-16 sm:px-12">
                {preview.icon && <div className="mb-2 text-[44px] leading-none">{preview.icon}</div>}
                <h1 className="page-title text-ink">{displayTitle(preview.title)}</h1>
                <div className="mt-2 sm:-mx-[54px]">
                  <EditorBoundary key={selected ?? 0} fallbackText="">
                    <Suspense fallback={null}>
                      <Editor
                        key={selected ?? 0}
                        pageId={`version-${selected}`}
                        rev={0}
                        initialContent={preview.content ?? []}
                        isDark={isDark}
                        editable={false}
                        onChange={() => {}}
                      />
                    </Suspense>
                  </EditorBoundary>
                </div>
              </article>
            ) : (
              selected != null && !error && <p className="px-6 py-6 text-[13px] text-muted">Loading…</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
