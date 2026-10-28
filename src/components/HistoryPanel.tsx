import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, X } from "lucide-react";
import { usePages } from "../store/pages";
import { useUi } from "../store/ui";
import { useTheme } from "../lib/theme";
import { displayTitle } from "../lib/text";
import { fetchHistory, fetchVersion, restoreInvitedVersion, restoreVersion, type Version, type VersionRow } from "../lib/history";
import { compareVersions, type Comparison } from "../lib/versionDiff";
import { EditorBoundary } from "./EditorBoundary";
import { IconButton } from "./Menu";
import { VersionDiff } from "./VersionDiff";

const Editor = lazy(() => import("./Editor").then((m) => ({ default: m.Editor })));

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: days > 300 ? "numeric" : undefined });
};
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const sinceLabel = (iso: string) => {
  const day = dayLabel(iso);
  return `${day === "Today" ? "" : `${day === "Yesterday" ? "yesterday" : day}, `}${timeLabel(iso)}`;
};

const HIGHLIGHT_KEY = "margin:history-highlight";
const savedHighlight = () => {
  try {
    return localStorage.getItem(HIGHLIGHT_KEY) !== "off";
  } catch {
    return true;
  }
};

function summary(c: Comparison) {
  if (!c.lines) return "too many changes to highlight";
  const parts = [
    c.added && `${c.added} added`,
    c.removed && `${c.removed} removed`,
    c.changed && `${c.changed} edited`,
    c.title && "title changed",
    c.icon && "icon changed",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "no visible changes";
}

const pageTitle = (id: string) => {
  const page = usePages.getState().pages[id];
  return page ? displayTitle(page.title) : "Page";
};

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
  // The version before the selected one, to show what changed. null for the oldest.
  const [before, setBefore] = useState<Version | null>(null);
  const [highlight, setHighlight] = useState(savedHighlight);
  const versions = useRef(new Map<number, Promise<Version>>());
  const [busy, setBusy] = useState(false);
  const [showList, setShowList] = useState(true); // phones show the list or the preview

  useEffect(() => {
    if (!pageId) return;
    setRows(null);
    setError(null);
    versions.current = new Map(); // the newest version changes while its session lasts
    fetchHistory(pageId).then(
      (r) => {
        setRows(r);
        setSelected(r[0]?.id ?? null);
      },
      () => setError(navigator.onLine ? "Couldn't load the history." : "Version history needs a connection."),
    );
  }, [pageId]);

  useEffect(() => {
    if (selected == null || !rows) return;
    setPreview(null);
    setBefore(null);
    const load = (id: number) => {
      let v = versions.current.get(id);
      if (!v) {
        v = fetchVersion(id);
        versions.current.set(id, v);
        v.catch(() => versions.current.delete(id));
      }
      return v;
    };
    const prevId = rows[rows.findIndex((r) => r.id === selected) + 1]?.id;
    let alive = true;
    Promise.all([load(selected), prevId == null ? null : load(prevId).catch(() => null)]).then(
      ([v, b]) => {
        if (!alive) return;
        setPreview(v);
        setBefore(b);
      },
      () => alive && setError("Couldn't load this version."),
    );
    return () => {
      alive = false;
    };
  }, [selected, rows]);

  const comparison = useMemo(() => (preview && before ? compareVersions(before, preview, pageTitle) : null), [preview, before]);
  const toggleHighlight = () => {
    setHighlight(!highlight);
    try {
      localStorage.setItem(HIGHLIGHT_KEY, highlight ? "off" : "on");
    } catch {
      // Private windows can refuse storage; the choice then lasts until the panel closes.
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!pageId || (!ownPage && !target?.invited)) return null;

  const isLatest = rows?.[0]?.id === selected;
  const selectedIndex = rows?.findIndex((r) => r.id === selected) ?? -1;
  const previousRow = rows?.[selectedIndex + 1];
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
              <>
                <div className="sticky top-0 z-10 flex min-h-10 items-center gap-3 border-b border-line bg-pop px-4 py-1.5 text-[13px] text-muted sm:px-6">
                  <p className="min-w-0 flex-1" aria-live="polite">
                    {previousRow
                      ? comparison
                        ? `Since ${sinceLabel(previousRow.saved_at)}: ${summary(comparison)}`
                        : `Couldn't load the version before this one.`
                      : "The oldest version in the history."}
                  </p>
                  {comparison?.lines && (
                    <button
                      role="switch"
                      aria-checked={highlight}
                      onClick={toggleHighlight}
                      className="flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 text-ink hover:bg-hover"
                    >
                      <span className={`switch ${highlight ? "on" : ""}`} aria-hidden="true" />
                      Highlight changes
                    </button>
                  )}
                </div>
                <article className="mx-auto w-full max-w-[720px] px-5 pt-8 pb-16 sm:px-12">
                  {highlight && comparison?.lines ? (
                    <VersionDiff version={preview} comparison={comparison} lines={comparison.lines} />
                  ) : (
                    <>
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
                    </>
                  )}
                </article>
              </>
            ) : (
              selected != null && !error && <p className="px-6 py-6 text-[13px] text-muted">Loading…</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
