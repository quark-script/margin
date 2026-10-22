import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../store/auth";
import { usePages } from "../store/pages";

/** Account menu > Delete account. Typing your email address confirms it. */
export function DeleteAccountDialog({ onClose, onExport }: { onClose: () => void; onExport: () => Promise<string> }) {
  const email = useAuth((s) => s.session?.user.email ?? "");
  const finishDeletion = useAuth((s) => s.finishDeletion);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const confirmed = email !== "" && typed.trim().toLowerCase() === email.toLowerCase();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const exportFirst = async () => {
    setExporting(true);
    setExportNote("Preparing your export…");
    try {
      setExportNote(await onExport());
    } catch (err) {
      setExportNote(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmed || busy) return;
    if (!navigator.onLine) return setError("You're offline. Try again when you're back online.");
    setBusy(true);
    setError(null);
    // Send edits still on their way first, so none can land after the deletion.
    await usePages.getState().sync();
    const { error } = await supabase.functions.invoke("delete-account", { body: { confirm: typed.trim() } });
    if (error) {
      setBusy(false);
      const inUse = (error as { context?: Response }).context?.status === 409;
      return setError(
        inUse
          ? "This sign-in is also used by another app, so it can't be deleted here."
          : "Couldn't finish deleting your account. Try again.",
      );
    }
    await finishDeletion();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Delete account"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 px-4 pt-[18vh] dark:bg-black/50"
      onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <form onSubmit={submit} noValidate className="w-full max-w-[400px] rounded-xl bg-pop p-4 shadow-pop">
        <h2 className="text-[16px] font-semibold text-ink">Delete your account?</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
          All your pages, images and version history are deleted for good. Pages you've shared stop working for
          everyone, and you lose access to pages others shared with you.
        </p>
        <p className="mt-2 text-[13px] text-muted">
          Want a copy first?{" "}
          <button
            type="button"
            onClick={() => void exportFirst()}
            disabled={exporting || busy}
            className="font-medium text-accent hover:underline disabled:opacity-50"
          >
            Export all pages
          </button>
        </p>
        {exportNote && (
          <p role="status" className="mt-1 text-[13px] text-ink">
            {exportNote}
          </p>
        )}
        <label className="mt-4 block">
          <span className="mb-1.5 block text-[13px] text-ink">
            To confirm, type <span className="font-medium">{email}</span>
          </span>
          <input
            autoFocus
            type="text"
            inputMode="email"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={email}
            className="h-10 w-full rounded-md bg-transparent px-3 text-[15px] text-ink outline-none ring-1 ring-line ring-inset placeholder:text-faint focus:ring-2 focus:ring-danger"
          />
        </label>
        {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-9 rounded-md px-3 text-[14px] text-ink hover:bg-hover disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!confirmed || busy}
            className="h-9 rounded-md bg-danger px-3.5 text-[14px] font-medium text-paper hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Deleting…" : "Delete account"}
          </button>
        </div>
      </form>
    </div>
  );
}
