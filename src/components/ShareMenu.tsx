import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, Globe } from "lucide-react";
import { usePages } from "../store/pages";
import { shareCovering, useShares } from "../store/shares";
import { shareUrl } from "../lib/share";
import { displayTitle } from "../lib/text";
import { Popover } from "./Menu";

export function ShareMenu({ pageId }: { pageId: string }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const pages = usePages((s) => s.pages);
  const shares = useShares((s) => s.shares);
  const covering = shareCovering(pages, shares, pageId);
  const own = shares[pageId];
  const inherited = !own && covering ? covering : null;
  const live = Boolean(own || inherited);

  useEffect(() => {
    if (open) void useShares.getState().load();
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-[14px] hover:bg-hover ${live ? "text-accent" : "text-ink"}`}
      >
        {live && <Globe size={14} />}
        Share
      </button>
      <Popover anchor={btn.current} open={open} onClose={close} align="end" width={320}>
        {inherited ? <Inherited pageId={inherited.via.id} title={displayTitle(inherited.via.title)} /> : <Own pageId={pageId} />}
      </Popover>
    </>
  );
}

function Inherited({ pageId, title }: { pageId: string; title: string }) {
  return (
    <div className="p-2.5 text-[13px]">
      <p className="text-ink">This page is shared as part of</p>
      <Link to={`/p/${pageId}`} className="mt-1 inline-block font-medium text-accent hover:underline">
        {title}
      </Link>
      <p className="mt-2 text-muted">Change sharing there. Anyone with that link can see this page too.</p>
    </div>
  );
}

function Own({ pageId }: { pageId: string }) {
  const share = useShares((s) => s.shares[pageId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Flip the switch immediately; the server catches up (or we flip back on error).
  const [wantOn, setWantOn] = useState<boolean | null>(null);
  const on = wantOn ?? Boolean(share);

  const run = async (fn: () => Promise<unknown>) => {
    if (!navigator.onLine) {
      setWantOn(null);
      return setError("You're offline. Sharing needs a connection.");
    }
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch {
      setError("Couldn't update sharing. Try again.");
    } finally {
      setBusy(false);
      setWantOn(null);
    }
  };

  const copy = async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(shareUrl(share.token));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the link is still selectable below */
    }
  };

  const { enable, disable, setCanEdit } = useShares.getState();

  return (
    <div className="p-2.5 text-[13px]">
      <label className="flex items-center justify-between gap-3">
        <span>
          <span className="block text-[14px] font-medium text-ink">Share to web</span>
          <span className="block text-muted">Anyone with the link, including pages inside</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-label="Share to web"
          checked={on}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.checked;
            setWantOn(next);
            void run(() => (next ? enable(pageId) : disable(pageId)));
          }}
          className="toggle"
        />
      </label>

      {share && (
        <>
          <div className="mt-3 flex items-center gap-1.5">
            <input
              readOnly
              value={shareUrl(share.token)}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Share link"
              className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-2 text-[13px] text-muted outline-none ring-1 ring-line ring-inset focus:ring-accent"
            />
            <button
              onClick={() => void copy()}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-ink px-2.5 text-[13px] font-medium text-paper hover:opacity-90"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-1 rounded-md bg-hover p-0.5" role="radiogroup" aria-label="Permission">
            {[
              { v: false, label: "Can view" },
              { v: true, label: "Can edit" },
            ].map((o) => (
              <button
                key={o.label}
                role="radio"
                aria-checked={share.can_edit === o.v}
                disabled={busy}
                onClick={() => share.can_edit !== o.v && void run(() => setCanEdit(pageId, o.v))}
                className={`h-7 rounded text-[13px] ${share.can_edit === o.v ? "bg-paper font-medium text-ink ring-1 ring-line" : "text-muted hover:text-ink"}`}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-muted">
            {share.can_edit
              ? "They can edit text. One person edits a page at a time; others see it live."
              : "They can read, not change anything."}
          </p>
        </>
      )}

      {error && <p className="mt-2 text-danger">{error}</p>}
    </div>
  );
}
