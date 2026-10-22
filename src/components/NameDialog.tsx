import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "../store/auth";

/** Set the name people you share pages with see (and invitation emails use). */
export function NameDialog({ onClose }: { onClose: () => void }) {
  const current = useAuth((s) => (s.session?.user.user_metadata?.full_name as string | undefined) ?? "");
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!navigator.onLine) return setError("You're offline. Try again when you're back online.");
    setBusy(true);
    setError(null);
    // An empty name falls back to the start of your email address.
    const { error } = await supabase.auth.updateUser({ data: { full_name: name.trim().slice(0, 60) } });
    setBusy(false);
    if (error) setError("Couldn't save your name. Try again.");
    else onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Your name"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 px-4 pt-[18vh] dark:bg-black/50"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form onSubmit={save} className="w-full max-w-[360px] rounded-xl bg-pop p-4 shadow-pop">
        <h2 className="text-[16px] font-semibold text-ink">Your name</h2>
        <p className="mt-1 text-[13px] text-muted">Shown to people you share pages with.</p>
        <input
          autoFocus
          type="text"
          autoComplete="name"
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Your name"
          placeholder="Your name"
          className="mt-3 h-10 w-full rounded-md bg-transparent px-3 text-[15px] text-ink outline-none ring-1 ring-line ring-inset placeholder:text-faint focus:ring-2 focus:ring-accent"
        />
        {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 rounded-md px-3 text-[14px] text-ink hover:bg-hover">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || name.trim() === current.trim()}
            className="h-9 rounded-md bg-ink px-3.5 text-[14px] font-medium text-paper hover:opacity-90 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
