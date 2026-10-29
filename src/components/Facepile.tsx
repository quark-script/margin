import { useRef, useState } from "react";
import type { Viewer } from "../lib/share";
import { timeAgo } from "../lib/text";
import { Popover } from "./Menu";

const SHOWN = 3;

const nameOf = (p: Viewer) => p.name ?? p.email ?? "Someone";
function status(p: Viewer) {
  if (p.editing) return "Editing now";
  if (p.here) return "Here now";
  if (!p.last_seen_at) return "";
  return `Viewed ${timeAgo(p.last_seen_at)}${p.visits && p.visits > 1 ? `, ${p.visits} visits` : ""}`;
}

function Avatar({ person }: { person: Viewer }) {
  const [failed, setFailed] = useState(false);
  return person.avatar && !failed ? (
    <img
      src={person.avatar}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="h-full w-full rounded-full object-cover"
    />
  ) : (
    <span className="flex h-full w-full items-center justify-center rounded-full bg-press text-[11px] font-semibold text-ink">
      {nameOf(person).trim().charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * Who is on a page shared by invite: people here now in full, and for its owner, who opened it
 * before, faded. Hover a face for who it is; click for the list.
 */
export function Facepile({ people, ownerView }: { people: Viewer[]; ownerView: boolean }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!people.length) return null;

  const here = people.filter((p) => p.here);
  const before = people.filter((p) => !p.here);
  const shown = people.slice(0, SHOWN);
  const more = people.length - shown.length;
  const label = here.length
    ? `${here.length === 1 ? nameOf(here[0]) : `${here.length} people`} on this page now`
    : "People who viewed this page";

  const list = (title: string, group: Viewer[]) => (
    <section className="py-1">
      <h3 className="px-3 pb-1 pt-1.5 text-[12px] font-medium text-muted">{title}</h3>
      <ul>
        {group.map((p) => (
          <li key={p.id} className="flex items-center gap-2.5 px-3 py-1.5">
            <span className={`h-7 w-7 shrink-0 ${p.here ? "" : "opacity-60"}`}>
              <Avatar person={p} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] text-ink">
                {nameOf(p)}
                {p.owner && <span className="text-muted"> (owner)</span>}
              </span>
              <span className="block truncate text-[12px] text-muted">
                {[p.email, status(p)].filter(Boolean).join(" · ")}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <>
      <button
        ref={btn}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 shrink-0 items-center gap-1 rounded-md px-1 hover:bg-hover"
      >
        <span className="flex -space-x-1.5">
          {shown.map((p) => (
            <span key={p.id} className="group relative h-6 w-6 rounded-full bg-paper ring-2 ring-paper">
              <span className={`block h-full w-full ${p.here ? "" : "opacity-40 grayscale"}`}>
                <Avatar person={p} />
              </span>
              <span
                role="presentation"
                className="pointer-events-none absolute right-0 top-full z-50 mt-2 hidden w-max max-w-[240px] rounded-lg bg-pop px-3 py-2 text-left shadow-pop group-hover:block"
              >
                <span className="block truncate text-[13px] font-medium text-ink">{nameOf(p)}</span>
                {p.email && <span className="block truncate text-[12px] text-muted">{p.email}</span>}
                <span className="block text-[12px] text-muted">{status(p)}</span>
              </span>
            </span>
          ))}
        </span>
        {more > 0 && <span className="pr-0.5 text-[12px] text-muted">+{more}</span>}
      </button>
      <Popover anchor={btn.current} open={open} onClose={() => setOpen(false)} align="end" width={280}>
        <div className="py-1">
          {here.length > 0 && list("Here now", here)}
          {before.length > 0 && list("Viewed this page", before)}
          {ownerView && before.length > 0 && (
            <p className="px-3 pb-2 pt-1 text-[12px] text-faint">Only you see who viewed this page.</p>
          )}
        </div>
      </Popover>
    </>
  );
}
