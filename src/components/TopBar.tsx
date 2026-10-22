import { Link } from "react-router-dom";
import { ChevronsRight, Menu as MenuIcon } from "lucide-react";
import { useUi } from "../store/ui";
import { IconButton } from "./Menu";
import { SyncStatus } from "./SyncStatus";

type Crumb = { id: string; icon: string | null; title: string };

export function TopBar({
  crumbs,
  right,
  hrefFor = (id) => `/p/${id}`,
}: {
  crumbs: Crumb[] | null;
  right?: React.ReactNode;
  /** Where a crumb leads; pages shared by invite live under /shared/. */
  hrefFor?: (id: string) => string;
}) {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggleCollapsed = useUi((s) => s.toggleCollapsed);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);

  // Long paths collapse their middle: first / … / parent / current
  const shown =
    crumbs && crumbs.length > 3 ? [crumbs[0], null, ...crumbs.slice(-2)] : (crumbs ?? []);

  return (
    <header className="safe-top shrink-0 bg-paper">
      <div className="flex h-11 items-center gap-1 px-2">
        <IconButton label="Open sidebar" onClick={() => setSidebarOpen(true)} className="md:hidden">
          <MenuIcon size={18} />
        </IconButton>
        {collapsed && (
          <IconButton label="Open sidebar" onClick={toggleCollapsed} className="max-md:hidden">
            <ChevronsRight size={17} />
          </IconButton>
        )}
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center text-[14px]">
          {shown.map((c, i) =>
            c === null ? (
              <span key="gap" className="flex items-center">
                <span className="px-1 text-faint">…</span>
                <span className="text-faint">/</span>
              </span>
            ) : (
              <span key={c.id} className={`flex min-w-0 items-center ${i === shown.length - 1 ? "" : "max-sm:hidden"}`}>
                <Link
                  to={hrefFor(c.id)}
                  className={`flex min-w-0 items-center gap-1.5 truncate rounded-md px-1.5 py-1 hover:bg-hover ${
                    i === shown.length - 1 ? "text-ink" : "text-muted"
                  }`}
                >
                  {c.icon && <span className="text-[14px] leading-none">{c.icon}</span>}
                  <span className="truncate max-w-[180px]">{c.title}</span>
                </Link>
                {i < shown.length - 1 && <span className="text-faint">/</span>}
              </span>
            ),
          )}
        </nav>
        <div className="md:hidden">
          <SyncStatus compact />
        </div>
        <div className="flex items-center gap-0.5">{right}</div>
      </div>
    </header>
  );
}
