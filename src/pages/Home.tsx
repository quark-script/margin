import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FileText, Plus, Search } from "lucide-react";
import { isTrashed, useIsLocal, usePages } from "../store/pages";
import { useUi } from "../store/ui";
import { useAuth } from "../store/auth";
import { displayTitle, timeAgo } from "../lib/text";
import { TopBar } from "../components/TopBar";
import { modKey } from "../components/Sidebar";

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export function Home() {
  const pages = usePages((s) => s.pages);
  const loaded = usePages((s) => s.loaded);
  const setSwitcherOpen = useUi((s) => s.setSwitcherOpen);
  const navigate = useNavigate();
  // First name, from the name you set (or Google's).
  const name = useAuth((s) => {
    const m = s.session?.user.user_metadata as { full_name?: string; name?: string } | undefined;
    return (m?.full_name || m?.name || "").trim().split(/\s+/)[0] || undefined;
  });

  const recent = useMemo(
    () =>
      Object.values(pages)
        .filter((p) => !isTrashed(pages, p.id))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 12),
    [pages],
  );

  const newPage = () => navigate(`/p/${usePages.getState().createPage(null)}`);

  return (
    <div className="flex h-full flex-col">
      <TopBar crumbs={null} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-5 pb-24 pt-10 sm:px-14 sm:pt-16">
          <h1 className="page-title text-ink">
            {greeting()}
            {name ? `, ${name}` : ""}
          </h1>

          <div className="mt-6 flex flex-wrap gap-2">
            <button
              onClick={newPage}
              className="flex h-9 items-center gap-2 rounded-md bg-ink px-3 text-[14px] font-medium text-paper hover:opacity-90"
            >
              <Plus size={16} /> New page
            </button>
            <button
              onClick={() => setSwitcherOpen(true)}
              className="flex h-9 items-center gap-2 rounded-md px-3 text-[14px] text-muted ring-1 ring-line ring-inset hover:bg-hover hover:text-ink"
            >
              <Search size={15} /> Search
              <span className="text-[12px] text-faint [@media(pointer:coarse)]:hidden">{modKey} K</span>
            </button>
          </div>

          <SyncHint />

          <h2 className="mt-12 mb-2 text-[13px] font-medium text-muted">Recently edited</h2>
          {loaded && recent.length === 0 ? (
            <p className="text-[15px] text-muted">
              No pages yet. Start with a page for whatever is on your mind today.
            </p>
          ) : (
            <ul className="-mx-2">
              {recent.map((p) => (
                <li key={p.id}>
                  <Link to={`/p/${p.id}`} className="flex h-10 items-center gap-3 rounded-md px-2 hover:bg-hover">
                    <span className="flex w-5 justify-center text-[16px] leading-none">
                      {p.icon || <FileText size={17} className="text-faint" strokeWidth={1.75} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[15px]">{displayTitle(p.title)}</span>
                    <span className="shrink-0 text-[13px] text-faint">{timeAgo(p.updated_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

const HINT_KEY = "margin:sync-hint-dismissed";

/**
 * Signed in with "Sync all pages" off (the default on a new device): say why pages from other
 * devices aren't here, once.
 */
function SyncHint() {
  const local = useIsLocal();
  const syncOn = usePages((s) => s.syncOn);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) === "1";
    } catch {
      return false;
    }
  });
  if (local || syncOn || dismissed) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* shows again next time */
    }
  };
  return (
    <div className="mt-8 rounded-lg px-4 py-3 ring-1 ring-line ring-inset" role="note">
      <p className="text-[14px] text-ink">Your pages stay on this device</p>
      <p className="mt-0.5 text-[13px] text-muted">
        Only pages you share sync. To have all your pages on every device, sync them all.
      </p>
      <div className="mt-2.5 flex gap-2">
        <button
          onClick={() => usePages.getState().setSyncOn(true)}
          className="h-8 rounded-md bg-ink px-3 text-[13px] font-medium text-paper hover:opacity-90"
        >
          Sync all pages
        </button>
        <button onClick={dismiss} className="h-8 rounded-md px-3 text-[13px] text-muted hover:bg-hover hover:text-ink">
          Keep them here
        </button>
      </div>
    </div>
  );
}
