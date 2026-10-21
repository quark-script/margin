import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileText, RotateCcw, Trash2, X } from "lucide-react";
import { usePages } from "../store/pages";
import { useUi } from "../store/ui";
import { displayTitle, timeAgo } from "../lib/text";
import { IconButton } from "./Menu";

export function TrashPanel() {
  const open = useUi((s) => s.trashOpen);
  const setOpen = useUi((s) => s.setTrashOpen);
  const pages = usePages((s) => s.pages);
  const { restorePage, deleteForever, emptyTrash } = usePages.getState();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  useEffect(() => {
    if (!open) {
      setQ("");
      setConfirmEmpty(false);
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  const items = useMemo(
    () =>
      Object.values(pages)
        .filter((p) => p.is_archived)
        .filter((p) => !q.trim() || displayTitle(p.title).toLowerCase().includes(q.trim().toLowerCase()))
        .sort((a, b) => (b.archived_at ?? b.updated_at).localeCompare(a.archived_at ?? a.updated_at)),
    [pages, q],
  );

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Trash"
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/25 px-3 pt-[12vh] dark:bg-black/50"
      onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <div className="flex max-h-[70vh] w-full max-w-[520px] flex-col overflow-hidden rounded-xl bg-pop shadow-pop">
        <div className="flex items-center gap-2 border-b border-line px-4">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search trash"
            className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
          />
          <IconButton label="Close" onClick={() => setOpen(false)}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {items.length === 0 && (
            <p className="px-3 py-8 text-center text-[14px] text-muted">
              {q.trim() ? "Nothing in trash matches that." : "Trash is empty. Pages you remove land here first."}
            </p>
          )}
          {items.map((p) => (
            <div key={p.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-hover">
              <button
                onClick={() => {
                  setOpen(false);
                  navigate(`/p/${p.id}`);
                }}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <span className="flex w-5 shrink-0 justify-center text-[15px]">
                  {p.icon || <FileText size={16} className="text-faint" strokeWidth={1.75} />}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[14px]">{displayTitle(p.title)}</span>
                  <span className="block text-[12px] text-muted">Removed {timeAgo(p.archived_at ?? p.updated_at)}</span>
                </span>
              </button>
              <IconButton label="Restore" onClick={() => restorePage(p.id)}>
                <RotateCcw size={15} />
              </IconButton>
              <IconButton label="Delete forever" onClick={() => deleteForever(p.id)} className="hover:text-danger">
                <Trash2 size={15} />
              </IconButton>
            </div>
          ))}
        </div>
        {items.length > 0 && !q.trim() && (
          <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[13px]">
            <span className="text-muted">Deleting forever also removes pages inside.</span>
            {confirmEmpty ? (
              <span className="flex items-center gap-2">
                <button onClick={() => setConfirmEmpty(false)} className="rounded-md px-2 py-1 text-muted hover:bg-hover">
                  Cancel
                </button>
                <button
                  onClick={() => {
                    emptyTrash();
                    setConfirmEmpty(false);
                  }}
                  className="rounded-md bg-danger px-2.5 py-1 font-medium text-white"
                >
                  Delete {items.length} forever
                </button>
              </span>
            ) : (
              <button onClick={() => setConfirmEmpty(true)} className="rounded-md px-2 py-1 text-danger hover:bg-hover">
                Empty trash
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
