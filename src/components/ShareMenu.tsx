import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, Globe, Users, X } from "lucide-react";
import { usePages } from "../store/pages";
import { invitesCovering, shareCovering, useShares, type Member } from "../store/shares";
import { useAuth } from "../store/auth";
import { shareUrl } from "../lib/share";
import { SITE_URL } from "../lib/supabase";
import { displayTitle } from "../lib/text";
import { IconButton, Popover } from "./Menu";

const NO_MEMBERS: Member[] = [];

export function ShareMenu({ pageId }: { pageId: string }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const pages = usePages((s) => s.pages);
  const shares = useShares((s) => s.shares);
  const members = useShares((s) => s.members);
  const covering = shareCovering(pages, shares, pageId);
  const own = shares[pageId];
  const inherited = !own && covering ? covering : null;
  const linkLive = Boolean(own || inherited);
  const invited = Boolean(invitesCovering(pages, members, pageId));

  useEffect(() => {
    if (open) void useShares.getState().load();
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-[14px] hover:bg-hover ${linkLive || invited ? "text-accent" : "text-ink"}`}
      >
        {linkLive ? <Globe size={14} /> : invited ? <Users size={14} /> : null}
        Share
      </button>
      <Popover anchor={btn.current} open={open} onClose={close} align="end" width={360}>
        <Invites pageId={pageId} />
        <div className="mx-2.5 h-px bg-line" />
        {inherited ? <Inherited pageId={inherited.via.id} title={displayTitle(inherited.via.title)} /> : <Own pageId={pageId} />}
      </Popover>
    </>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Invite people by email: they find the page under "Shared with me" once signed in. */
function Invites({ pageId }: { pageId: string }) {
  const members = useShares((s) => s.members[pageId]) ?? NO_MEMBERS;
  const parentId = usePages((s) => s.pages[pageId]?.parent_id ?? null);
  const pages = usePages((s) => s.pages);
  const allMembers = useShares((s) => s.members);
  const above = parentId ? invitesCovering(pages, allMembers, parentId) : null;
  const myEmail = useAuth((s) => s.session?.user.email?.toLowerCase() ?? "");
  const [email, setEmail] = useState("");
  const [canEdit, setCanEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { invite, setMemberCanEdit, removeMember } = useShares.getState();

  const run = async (fn: () => Promise<unknown>) => {
    if (!navigator.onLine) return setError("You're offline. Sharing needs a connection.");
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      setError(code === "23505" ? "Already invited." : "Couldn't update sharing. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const addr = email.trim().toLowerCase();
    if (!EMAIL_RE.test(addr)) return setError("Enter an email address.");
    if (addr === myEmail) return setError("That's you. You already have access.");
    if (members.some((m) => m.email === addr)) return setError("Already invited.");
    if (await run(() => invite(pageId, addr, canEdit))) setEmail("");
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${SITE_URL}/p/${pageId}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const select =
    "h-8 shrink-0 rounded-md bg-transparent px-1.5 text-[13px] text-ink outline-none ring-1 ring-line ring-inset focus:ring-accent";

  return (
    <div className="p-2.5 text-[13px]">
      <span className="block text-[14px] font-medium text-ink">Invite people</span>
      <form onSubmit={submit} noValidate className="mt-2 flex items-center gap-1.5">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email address"
          aria-label="Email to invite"
          className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-2 text-[13px] text-ink outline-none ring-1 ring-line ring-inset placeholder:text-faint focus:ring-accent"
        />
        <select
          aria-label="Access for the new person"
          value={canEdit ? "edit" : "view"}
          onChange={(e) => setCanEdit(e.target.value === "edit")}
          className={select}
        >
          <option value="view">Can view</option>
          <option value="edit">Can edit</option>
        </select>
        <button
          type="submit"
          disabled={busy || !email.trim()}
          className="h-8 shrink-0 rounded-md bg-ink px-2.5 text-[13px] font-medium text-paper hover:opacity-90 disabled:opacity-40"
        >
          Invite
        </button>
      </form>

      {members.length > 0 && (
        <ul className="mt-2" aria-label="People with access">
          {members.map((m) => (
            <li key={m.email} className="flex items-center gap-2 py-1">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-hover text-[11px] font-semibold text-muted">
                {m.email[0]?.toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate text-ink">{m.email}</span>
              <select
                aria-label={`Access for ${m.email}`}
                value={m.can_edit ? "edit" : "view"}
                disabled={busy}
                onChange={(e) => void run(() => setMemberCanEdit(pageId, m.email, e.target.value === "edit"))}
                className={select}
              >
                <option value="view">Can view</option>
                <option value="edit">Can edit</option>
              </select>
              <IconButton label={`Remove ${m.email}`} onClick={() => void run(() => removeMember(pageId, m.email))}>
                <X size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      {above && (
        <p className="mt-2 text-muted">
          People invited to{" "}
          <Link to={`/p/${above.via.id}`} className="text-accent hover:underline">
            {displayTitle(above.via.title)}
          </Link>{" "}
          can see this page too.
        </p>
      )}

      {members.length > 0 && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-muted">They'll find it under "Shared with me". No email is sent, so send them the link.</p>
          <button
            onClick={() => void copyLink()}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-ink ring-1 ring-line ring-inset hover:bg-hover"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}

      {error && <p className="mt-2 text-danger">{error}</p>}
    </div>
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
