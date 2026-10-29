import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronDown, Globe, Link2, Lock } from "lucide-react";
import { ancestorsOf, usePages } from "../store/pages";
import { roleOf, shareCovering, useShares, type Member, type Role, type Share } from "../store/shares";
import { useAuth } from "../store/auth";
import { useUi } from "../store/ui";
import {
  fetchPageSharing,
  pageUrl,
  sendInviteEmail,
  shareInvite,
  shareRemove,
  shareSetLink,
  shareSetRole,
  type InviteEmail,
  type PageSharing,
} from "../lib/share";
import { displayTitle, timeAgo } from "../lib/text";
import { supabase } from "../lib/supabase";
import { MenuDivider, MenuItem, Popover } from "./Menu";

const NO_MEMBERS: Member[] = [];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type LinkMode = "off" | "view" | "edit";

// Visits through the link are counted without knowing who made them.
const linkVisits = (s: Share) =>
  s.views && s.last_viewed_at
    ? `Link opened ${s.views} time${s.views === 1 ? "" : "s"}, most recently ${timeAgo(s.last_viewed_at)}`
    : "Link not opened yet";

const ROLES: Record<Role, { title: string; detail: string }> = {
  full: { title: "Full access", detail: "Edit, and share with others" },
  edit: { title: "Can edit", detail: "Edit text, one person at a time" },
  view: { title: "Can view", detail: "Read only" },
};

/** The Share button. The owner manages sharing from their own data; people invited ask the server. */
export function ShareMenu({ pageId, invited }: { pageId: string; invited?: boolean }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (open && !invited) void useShares.getState().load();
  }, [open, invited]);

  return (
    <>
      <button ref={btn} onClick={() => setOpen((v) => !v)} className="h-8 rounded-md px-2.5 text-[14px] text-ink hover:bg-hover">
        Share
      </button>
      <Popover anchor={btn.current} open={open} onClose={close} align="end" width={400}>
        {invited ? <InvitedPanel pageId={pageId} /> : <SyncedFirst pageId={pageId} />}
      </Popover>
    </>
  );
}

/**
 * With "Sync all pages" off, a page may exist only on this device. Sharing needs it on the
 * server, and the pages it's inside too (without sharing them), so that comes first.
 */
function SyncedFirst({ pageId }: { pageId: string }) {
  const syncOn = usePages((s) => s.syncOn);
  const pages = usePages((s) => s.pages);
  const [missing, setMissing] = useState<string[] | null>(syncOn ? [] : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (syncOn) return setMissing([]);
    const chain = [...ancestorsOf(usePages.getState().pages, pageId).map((p) => p.id), pageId];
    let alive = true;
    void supabase
      .from("pages")
      .select("id")
      .in("id", chain)
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) return setError(navigator.onLine ? "Couldn't check this page. Try again." : "Sharing needs a connection.");
        const there = new Set((data ?? []).map((r) => (r as { id: string }).id));
        setMissing(chain.filter((id) => !there.has(id)));
      });
    return () => {
      alive = false;
    };
  }, [pageId, syncOn]);

  if (missing?.length === 0) return <OwnerPanel pageId={pageId} />;
  if (!missing) return <p className="p-4 text-[13px] text-muted">{error ?? "Loading…"}</p>;

  const above = missing.filter((id) => id !== pageId).map((id) => displayTitle(pages[id]?.title));
  const syncIt = async () => {
    setBusy(true);
    setError(null);
    const ok = await usePages.getState().uploadNow(missing);
    setBusy(false);
    if (ok) setMissing([]);
    else setError(navigator.onLine ? "Couldn't sync it. Try again." : "Sharing needs a connection.");
  };
  return (
    <div className="p-4 text-[14px]">
      <p className="text-ink">This page is only on this device.</p>
      <p className="mt-1 text-[13px] text-muted">
        To share it, it has to sync to your account
        {above.length
          ? `, and so ${above.length === 1 ? "does the page" : "do the pages"} it's inside (${above.join(", ")}), without being shared`
          : ""}
        . Shared pages keep syncing so people always see your latest changes.
      </p>
      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
      <button
        onClick={() => void syncIt()}
        disabled={busy}
        className="mt-3 h-9 rounded-md bg-ink px-3.5 text-[14px] font-medium text-paper hover:opacity-90 disabled:opacity-40"
      >
        {busy ? "Syncing…" : "Sync and share"}
      </button>
    </div>
  );
}

/** What the owner sees: who has access, general access, one link. */
function OwnerPanel({ pageId }: { pageId: string }) {
  const pages = usePages((s) => s.pages);
  const shares = useShares((s) => s.shares);
  const allMembers = useShares((s) => s.members);
  const direct = useShares((s) => s.members[pageId]) ?? NO_MEMBERS;
  const myEmail = useAuth((s) => s.session?.user.email?.toLowerCase() ?? "");
  const myName = useAuth((s) => {
    const m = s.session?.user.user_metadata as { full_name?: string; name?: string } | undefined;
    return m?.full_name?.trim() || m?.name?.trim() || "";
  });

  // People invited to a page above this one can open it too.
  const directEmails = new Set(direct.map((m) => m.email));
  const inherited = ancestorsOf(pages, pageId)
    .reverse()
    .flatMap((a) => (allMembers[a.id] ?? []).map((m) => ({ ...m, via: a })))
    .filter((m, i, all) => !directEmails.has(m.email) && all.findIndex((x) => x.email === m.email) === i);

  const parentId = pages[pageId]?.parent_id ?? null;
  const linkAbove = !shares[pageId] && parentId ? shareCovering(pages, shares, parentId) : null;
  const share = shares[pageId];

  const setLink = async (mode: LinkMode) => {
    const st = useShares.getState();
    if (mode === "off") return st.disable(pageId);
    if (!st.shares[pageId]) await st.enable(pageId);
    if (Boolean(useShares.getState().shares[pageId]?.can_edit) !== (mode === "edit")) await st.setCanEdit(pageId, mode === "edit");
  };

  return (
    <Panel pageId={pageId}>
      <InviteForm
        taken={(email) => email === myEmail || directEmails.has(email)}
        onInvite={(email, role) => useShares.getState().invite(pageId, email, role)}
      />

      <ul aria-label="People with access" className="mt-3">
        <Person
          initial={(myName || myEmail)[0]}
          name={myName ? `${myName} (you)` : "You"}
          detail={myEmail}
          owner
          right={<RoleLabel text="Owner" />}
        />
        {direct.map((m) => (
          <Person key={m.email} initial={m.email[0]} name={m.email} right={<OwnerMemberRole pageId={pageId} member={m} />} />
        ))}
        {inherited.map((m) => (
          <Person
            key={m.email}
            initial={m.email[0]}
            name={m.email}
            detail={<Via id={m.via.id} title={m.via.title} />}
            right={<RoleLabel text={ROLES[roleOf(m)].title} />}
          />
        ))}
      </ul>

      <p className="mt-4 mb-1 text-[12px] font-medium text-muted">General access</p>
      {linkAbove ? (
        <LinkAbove canEdit={linkAbove.share.can_edit} via={linkAbove.via} />
      ) : (
        <GeneralAccess value={share ? { can_edit: share.can_edit } : null} onSet={setLink} />
      )}
      {share && !linkAbove && <p className="pl-11 text-[12px] text-muted">{linkVisits(share)}</p>}
    </Panel>
  );
}

/**
 * What people invited see. With full access, the same controls as the owner; otherwise who has
 * access (other people by name only) and how the page is shared, without changing anything.
 */
function InvitedPanel({ pageId }: { pageId: string }) {
  const [data, setData] = useState<PageSharing | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const notify = useUi.getState().notify;

  const reload = useCallback(async () => {
    try {
      setData(await fetchPageSharing(pageId));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [pageId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  if (data === undefined || data === null) {
    const text = data === null ? "You don't have access to this page's sharing." : failed ? "Couldn't load who has access. Check your connection." : "Loading…";
    return <p className="p-4 text-[13px] text-muted">{text}</p>;
  }

  const manage = data.can_manage;
  const fail = () => notify("Couldn't update access. Check your connection.");
  const change = (task: () => Promise<unknown>) => task().then(reload, fail);
  const linkAbove = data.link?.via ?? null;

  return (
    <Panel pageId={pageId} note={manage ? null : "Only the owner and people with full access can change sharing."}>
      {manage && (
        <InviteForm
          taken={(email) => email === data.owner.email?.toLowerCase() || data.people.some((p) => p.email === email && !p.via)}
          onInvite={async (email, role) => {
            await shareInvite(pageId, email, role);
            void reload();
            return sendInviteEmail(pageId, email);
          }}
        />
      )}

      <ul aria-label="People with access" className={manage ? "mt-3" : ""}>
        <Person
          initial={(data.owner.name || data.owner.email || "?")[0]}
          name={data.owner.name ?? "Owner"}
          detail={data.owner.email}
          owner
          right={<RoleLabel text="Owner" />}
        />
        {data.people.map((p, i) => {
          const name = p.you ? `${p.name || p.email} (you)` : p.name || (manage && p.email) || "Invited, hasn't joined yet";
          const email = p.email && (p.you || (manage && p.name)) ? p.email : null;
          const detail =
            email || p.via ? (
              <>
                {email}
                {email && p.via && " · "}
                {p.via && <Via id={p.via.id} title={p.via.title} />}
              </>
            ) : undefined;
          const editable = manage && !p.you && !p.via && p.email;
          return (
            <Person
              key={p.email ?? `${p.name}-${i}`}
              initial={(p.name || p.email || "?")[0]}
              name={name}
              detail={detail}
              right={
                editable ? (
                  <RoleMenu
                    label={`Access for ${p.email}`}
                    role={p.role}
                    onChange={(role) => void change(() => shareSetRole(pageId, p.email!, role))}
                    more={(close) => (
                      <MemberActions
                        email={p.email!}
                        close={close}
                        onResend={() => sendInviteEmail(pageId, p.email!)}
                        onRemove={() => void change(() => shareRemove(pageId, p.email!))}
                      />
                    )}
                  />
                ) : (
                  <RoleLabel text={ROLES[p.role].title} />
                )
              }
            />
          );
        })}
      </ul>

      <p className="mt-4 mb-1 text-[12px] font-medium text-muted">General access</p>
      {linkAbove ? (
        <LinkAbove canEdit={Boolean(data.link?.can_edit)} via={linkAbove} />
      ) : manage ? (
        <GeneralAccess
          value={data.link ? { can_edit: data.link.can_edit } : null}
          onSet={async (mode) => {
            await shareSetLink(pageId, mode);
            await reload();
          }}
        />
      ) : (
        <AccessRow
          isPublic={Boolean(data.link)}
          title={<span className="text-ink">{data.link ? "Anyone with the link" : "Only people invited"}</span>}
          detail={data.link ? "Anyone on the internet with the link" : "Only people with access can open"}
          right={data.link ? <RoleLabel text={data.link.can_edit ? "Can edit" : "Can view"} /> : null}
        />
      )}
    </Panel>
  );
}

/** The panel's frame: its content, then the link to copy, and an optional note. */
function Panel({ pageId, note, children }: { pageId: string; note?: string | null; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
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
      <div className="p-3">{children}</div>
      <div className="flex items-center gap-2 border-t border-line px-1.5 py-1.5">
        <button
          onClick={() => void copy()}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-ink hover:bg-hover"
        >
          {copied ? <Check size={15} className="text-accent" /> : <Link2 size={15} className="text-muted" />}
          {copied ? "Link copied" : "Copy link"}
        </button>
        {note && <p className="min-w-0 flex-1 px-1 text-right text-[12px] text-muted">{note}</p>}
      </div>
    </div>
  );
}

function InviteForm({
  taken,
  onInvite,
}: {
  taken: (email: string) => boolean;
  onInvite: (email: string, role: Role) => Promise<InviteEmail>;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("edit");
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
      const mail = await onInvite(addr, role);
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
          <RoleMenu label="Access for new person" role={role} onChange={setRole} />
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

function OwnerMemberRole({ pageId, member }: { pageId: string; member: Member }) {
  const { setMemberRole, removeMember, resendInvite } = useShares.getState();
  const fail = () => useUi.getState().notify("Couldn't update access. Check your connection.");
  return (
    <RoleMenu
      label={`Access for ${member.email}`}
      role={roleOf(member)}
      onChange={(role) => void setMemberRole(pageId, member.email, role).catch(fail)}
      more={(close) => (
        <MemberActions
          email={member.email}
          close={close}
          onResend={() => resendInvite(pageId, member.email)}
          onRemove={() => void removeMember(pageId, member.email).catch(fail)}
        />
      )}
    />
  );
}

function MemberActions({
  email,
  close,
  onResend,
  onRemove,
}: {
  email: string;
  close: () => void;
  onResend: () => Promise<InviteEmail>;
  onRemove: () => void;
}) {
  const notify = useUi.getState().notify;
  return (
    <>
      <MenuDivider />
      <MenuItem
        onClick={() => {
          close();
          void onResend().then((mail) =>
            notify(mail.sent || mail.reason === "recent" ? `Invitation sent to ${email}.` : inviteNotice(email, mail)),
          );
        }}
      >
        Resend invitation
      </MenuItem>
      <MenuItem
        danger
        onClick={() => {
          close();
          onRemove();
        }}
      >
        Remove
      </MenuItem>
    </>
  );
}

/** "Only people invited" or "Anyone with the link" (view or edit). */
function GeneralAccess({ value, onSet }: { value: { can_edit: boolean } | null; onSet: (mode: LinkMode) => Promise<void> }) {
  const [pending, setPending] = useState<boolean | null>(null); // optimistic while the server catches up
  const isPublic = pending ?? Boolean(value);
  const notify = useUi.getState().notify;

  const set = async (mode: LinkMode) => {
    if (!navigator.onLine) return notify("You're offline. Sharing needs a connection.");
    setPending(mode !== "off");
    try {
      await onSet(mode);
    } catch {
      notify("Couldn't change access. Try again.");
    } finally {
      setPending(null);
    }
  };

  const canEdit = Boolean(value?.can_edit);
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
                onClick={() => (close(), !isPublic || void set("off"))}
              />
              <Option
                selected={isPublic}
                title="Anyone with the link"
                detail="Anyone on the internet with the link"
                onClick={() => (close(), isPublic || void set("view"))}
              />
            </>
          )}
        </Dropdown>
      }
      detail={!isPublic ? "Only people with access can open" : canEdit ? "Editing needs a Margin account" : "Anyone on the internet with the link"}
      right={
        isPublic && value ? (
          <RoleMenu
            label="Link access"
            role={canEdit ? "edit" : "view"}
            roles={["edit", "view"]}
            onChange={(role) => void set(role === "edit" ? "edit" : "view")}
          />
        ) : null
      }
    />
  );
}

function LinkAbove({ canEdit, via }: { canEdit: boolean; via: { id: string; title: string } }) {
  return (
    <AccessRow
      isPublic
      title={<span className="text-ink">Anyone with the link</span>}
      detail={<Via id={via.id} title={via.title} />}
      right={<RoleLabel text={canEdit ? "Can edit" : "Can view"} />}
    />
  );
}

function Via({ id, title }: { id: string; title: string }) {
  return (
    <>
      Via{" "}
      <Link to={`/p/${id}`} className="hover:text-ink hover:underline">
        {displayTitle(title)}
      </Link>
    </>
  );
}

const RoleLabel = ({ text }: { text: string }) => <span className="shrink-0 px-2 text-[13px] text-faint">{text}</span>;

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

/** Full access, Can edit or Can view (links: edit or view), plus optional extra actions. */
function RoleMenu({
  label,
  role,
  roles = ["full", "edit", "view"],
  onChange,
  more,
}: {
  label: string;
  role: Role;
  roles?: Role[];
  onChange: (role: Role) => void;
  more?: (close: () => void) => ReactNode;
}) {
  return (
    <Dropdown
      label={label}
      width={230}
      trigger={
        <span className="inline-flex items-center gap-1 text-[13px] text-muted">
          {ROLES[role].title}
          <ChevronDown size={14} />
        </span>
      }
    >
      {(close) => (
        <>
          {roles.map((r) => (
            <Option key={r} selected={role === r} title={ROLES[r].title} detail={ROLES[r].detail} onClick={() => (close(), onChange(r))} />
          ))}
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
