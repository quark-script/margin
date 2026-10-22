import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronDown, Globe, Link2, Lock } from "lucide-react";
import { ancestorsOf, usePages } from "../store/pages";
import { shareCovering, useShares, type Member } from "../store/shares";
import { useAuth } from "../store/auth";
import { useUi } from "../store/ui";
import { pageUrl, type InviteEmail } from "../lib/share";
import { displayTitle } from "../lib/text";
import { MenuDivider, MenuItem, Popover } from "./Menu";

const NO_MEMBERS: Member[] = [];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ShareMenu({ pageId }: { pageId: string }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (open) void useShares.getState().load();
  }, [open]);

  return (
    <>
      <button ref={btn} onClick={() => setOpen((v) => !v)} className="h-8 rounded-md px-2.5 text-[14px] text-ink hover:bg-hover">
        Share
      </button>
      <Popover anchor={btn.current} open={open} onClose={close} align="end" width={400}>
        <SharePanel pageId={pageId} />
      </Popover>
    </>
  );
}

/** What the owner sees: who has access, general access, one link. */
function SharePanel({ pageId }: { pageId: string }) {
  const pages = usePages((s) => s.pages);
  const shares = useShares((s) => s.shares);
  const allMembers = useShares((s) => s.members);
  const direct = useShares((s) => s.members[pageId]) ?? NO_MEMBERS;
  const myEmail = useAuth((s) => s.session?.user.email?.toLowerCase() ?? "");
  const [copied, setCopied] = useState(false);

  // People invited to a page above this one can open it too.
  const directEmails = new Set(direct.map((m) => m.email));
  const inherited = ancestorsOf(pages, pageId)
    .reverse()
    .flatMap((a) => (allMembers[a.id] ?? []).map((m) => ({ ...m, via: a })))
    .filter((m, i, all) => !directEmails.has(m.email) && all.findIndex((x) => x.email === m.email) === i);

  const parentId = pages[pageId]?.parent_id ?? null;
  const linkAbove = !shares[pageId] && parentId ? shareCovering(pages, shares, parentId) : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pageUrl(pageId));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <div className="text-[14px]">
      <div className="p-3">
        <InviteForm pageId={pageId} taken={(email) => email === myEmail || directEmails.has(email)} />

        <ul aria-label="People with access" className="mt-3">
          <Person initial={myEmail[0]} name="You" detail={myEmail} owner right={<span className="px-2 text-[13px] text-faint">Owner</span>} />
          {direct.map((m) => (
            <Person key={m.email} initial={m.email[0]} name={m.email} right={<MemberRole pageId={pageId} member={m} />} />
          ))}
          {inherited.map((m) => (
            <Person
              key={m.email}
              initial={m.email[0]}
              name={m.email}
              detail={
                <>
                  Via{" "}
                  <Link to={`/p/${m.via.id}`} className="hover:text-ink hover:underline">
                    {displayTitle(m.via.title)}
                  </Link>
                </>
              }
              right={<span className="px-2 text-[13px] text-faint">{m.can_edit ? "Can edit" : "Can view"}</span>}
            />
          ))}
        </ul>

        <p className="mt-4 mb-1 text-[12px] font-medium text-muted">General access</p>
        {linkAbove ? (
          <AccessRow
            isPublic
            title={<span className="text-ink">Anyone with the link</span>}
            detail={
              <>
                Via{" "}
                <Link to={`/p/${linkAbove.via.id}`} className="hover:text-ink hover:underline">
                  {displayTitle(linkAbove.via.title)}
                </Link>
              </>
            }
            right={<span className="px-2 text-[13px] text-faint">{linkAbove.share.can_edit ? "Can edit" : "Can view"}</span>}
          />
        ) : (
          <GeneralAccess pageId={pageId} />
        )}
      </div>

      <div className="flex items-center border-t border-line px-1.5 py-1.5">
        <button
          onClick={() => void copy()}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-ink hover:bg-hover"
        >
          {copied ? <Check size={15} className="text-accent" /> : <Link2 size={15} className="text-muted" />}
          {copied ? "Link copied" : "Copy link"}
        </button>
      </div>
    </div>
  );
}

function InviteForm({ pageId, taken }: { pageId: string; taken: (email: string) => boolean }) {
  const [email, setEmail] = useState("");
  const [canEdit, setCanEdit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const addr = email.trim().toLowerCase();
    if (!EMAIL_RE.test(addr)) return setError("Enter a valid email address.");
    if (taken(addr)) return setError("They already have access.");
    if (!navigator.onLine) return setError("You're offline. Inviting needs a connection.");
    setBusy(true);
    setError(null);
    try {
      const mail = await useShares.getState().invite(pageId, addr, canEdit);
      setEmail("");
      useUi.getState().notify(inviteNotice(addr, mail));
    } catch (err) {
      setError((err as { code?: string }).code === "23505" ? "They already have access." : "Couldn't invite them. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form onSubmit={submit} noValidate className="flex items-center gap-2">
        <div className="flex h-9 min-w-0 flex-1 items-center rounded-md ring-1 ring-line ring-inset focus-within:ring-2 focus-within:ring-accent">
          <input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
            placeholder="Add people by email"
            aria-label="Email to invite"
            className="h-full min-w-0 flex-1 bg-transparent pl-2.5 text-[14px] text-ink outline-none placeholder:text-faint"
          />
          <RoleMenu label="Access for new person" canEdit={canEdit} onChange={setCanEdit} />
        </div>
        <button
          type="submit"
          disabled={busy || !email.trim()}
          className="h-9 shrink-0 rounded-md bg-ink px-3.5 text-[14px] font-medium text-paper hover:opacity-90 disabled:opacity-40"
        >
          Invite
        </button>
      </form>
      {error && <p className="mt-1.5 text-[12px] text-danger">{error}</p>}
    </>
  );
}

function inviteNotice(email: string, mail: InviteEmail) {
  if (mail.sent) return `Invitation sent to ${email}.`;
  if (mail.reason === "recent") return `An invitation was just sent to ${email}.`;
  const why = mail.reason === "limit" ? "You've reached today's email limit" : "The invitation email couldn't be sent";
  return `${email} can open the page now. ${why}, so send them the link.`;
}

function MemberRole({ pageId, member }: { pageId: string; member: Member }) {
  const { setMemberCanEdit, removeMember, resendInvite } = useShares.getState();
  const notify = useUi.getState().notify;
  const fail = () => notify("Couldn't update access. Check your connection.");
  return (
    <RoleMenu
      label={`Access for ${member.email}`}
      canEdit={member.can_edit}
      onChange={(v) => void setMemberCanEdit(pageId, member.email, v).catch(fail)}
      more={(close) => (
        <>
          <MenuDivider />
          <MenuItem
            onClick={() => {
              close();
              void resendInvite(pageId, member.email).then((mail) =>
                notify(mail.sent || mail.reason === "recent" ? `Invitation sent to ${member.email}.` : inviteNotice(member.email, mail)),
              );
            }}
          >
            Resend invitation
          </MenuItem>
          <MenuItem
            danger
            onClick={() => {
              close();
              void removeMember(pageId, member.email).catch(fail);
            }}
          >
            Remove
          </MenuItem>
        </>
      )}
    />
  );
}

/** "Only people invited" or "Anyone with the link" (view or edit) for this page. */
function GeneralAccess({ pageId }: { pageId: string }) {
  const share = useShares((s) => s.shares[pageId]);
  const [pending, setPending] = useState<boolean | null>(null); // optimistic while the server catches up
  const isPublic = pending ?? Boolean(share);
  const { enable, disable, setCanEdit } = useShares.getState();
  const notify = useUi.getState().notify;

  const setPublic = async (next: boolean) => {
    if (next === isPublic) return;
    if (!navigator.onLine) return notify("You're offline. Sharing needs a connection.");
    setPending(next);
    try {
      await (next ? enable(pageId) : disable(pageId));
    } catch {
      notify("Couldn't change access. Try again.");
    } finally {
      setPending(null);
    }
  };

  const canEdit = Boolean(share?.can_edit);
  return (
    <AccessRow
      isPublic={isPublic}
      title={
        <Dropdown
          label="General access"
          width={280}
          trigger={
            <span className="inline-flex items-center gap-1 font-medium text-ink">
              {isPublic ? "Anyone with the link" : "Only people invited"}
              <ChevronDown size={14} className="text-muted" />
            </span>
          }
        >
          {(close) => (
            <>
              <Option
                selected={!isPublic}
                title="Only people invited"
                detail="Only people with access can open"
                onClick={() => (close(), void setPublic(false))}
              />
              <Option
                selected={isPublic}
                title="Anyone with the link"
                detail="Anyone on the internet with the link"
                onClick={() => (close(), void setPublic(true))}
              />
            </>
          )}
        </Dropdown>
      }
      detail={!isPublic ? "Only people with access can open" : canEdit ? "Editing needs a Margin account" : "Anyone on the internet with the link"}
      right={
        isPublic && share ? (
          <RoleMenu
            label="Link access"
            canEdit={canEdit}
            onChange={(v) => void setCanEdit(pageId, v).catch(() => notify("Couldn't change access. Try again."))}
          />
        ) : null
      }
    />
  );
}

function AccessRow({ isPublic, title, detail, right }: { isPublic: boolean; title: ReactNode; detail: ReactNode; right: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-hover text-muted">
        {isPublic ? <Globe size={16} /> : <Lock size={15} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate">{title}</div>
        <div className="truncate text-[12px] text-muted">{detail}</div>
      </div>
      {right}
    </div>
  );
}

function Person({
  initial,
  name,
  detail,
  right,
  owner,
}: {
  initial?: string;
  name: string;
  detail?: ReactNode;
  right: ReactNode;
  owner?: boolean;
}) {
  return (
    <li className="flex items-center gap-3 py-1">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ${owner ? "bg-ink text-paper" : "bg-hover text-ink/70"}`}
      >
        {(initial ?? "?").toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-ink">{name}</div>
        {detail && <div className="truncate text-[12px] text-muted">{detail}</div>}
      </div>
      {right}
    </li>
  );
}

/** "Can edit" / "Can view", plus optional extra actions. */
function RoleMenu({
  label,
  canEdit,
  onChange,
  more,
}: {
  label: string;
  canEdit: boolean;
  onChange: (canEdit: boolean) => void;
  more?: (close: () => void) => ReactNode;
}) {
  return (
    <Dropdown
      label={label}
      width={220}
      trigger={
        <span className="inline-flex items-center gap-1 text-[13px] text-muted">
          {canEdit ? "Can edit" : "Can view"}
          <ChevronDown size={14} />
        </span>
      }
    >
      {(close) => (
        <>
          <Option selected={canEdit} title="Can edit" detail="Edit text, one person at a time" onClick={() => (close(), onChange(true))} />
          <Option selected={!canEdit} title="Can view" detail="Read only" onClick={() => (close(), onChange(false))} />
          {more?.(close)}
        </>
      )}
    </Dropdown>
  );
}

function Dropdown({
  label,
  trigger,
  width,
  children,
}: {
  label: string;
  trigger: ReactNode;
  width: number;
  children: (close: () => void) => ReactNode;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="-mx-1 shrink-0 rounded-md px-1.5 py-1 hover:bg-hover"
      >
        {trigger}
      </button>
      <Popover anchor={btn.current} open={open} onClose={close} align="end" width={width}>
        {children(close)}
      </Popover>
    </>
  );
}

function Option({ selected, title, detail, onClick }: { selected: boolean; title: string; detail: string; onClick: () => void }) {
  return (
    <button
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] text-ink">{title}</span>
        <span className="block text-[12px] text-muted">{detail}</span>
      </span>
      <Check size={15} className={`mt-0.5 shrink-0 text-ink ${selected ? "" : "invisible"}`} />
    </button>
  );
}
