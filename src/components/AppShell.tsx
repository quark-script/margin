import { lazy, Suspense, useEffect } from "react";
import { Link, Outlet, useNavigate } from "react-router-dom";
import { usePages } from "../store/pages";
import { useUi } from "../store/ui";
import { useAuth } from "../store/auth";
import { Sidebar } from "./Sidebar";
import { MovePicker, QuickSwitcher } from "./QuickSwitcher";
import { TrashPanel } from "./TrashPanel";

const HistoryPanel = lazy(() => import("./HistoryPanel").then((m) => ({ default: m.HistoryPanel })));

export function AppShell() {
  const { sidebarOpen, sidebarCollapsed, setSidebarOpen, toggleCollapsed, setSwitcherOpen } = useUi();
  const navigate = useNavigate();
  const historyOpen = useUi((s) => s.history !== null);
  const local = useAuth((s) => s.local && !s.session);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSwitcherOpen(!useUi.getState().switcherOpen);
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        if (window.matchMedia("(min-width: 768px)").matches) toggleCollapsed();
        else setSidebarOpen(!useUi.getState().sidebarOpen);
      } else if (e.altKey && e.code === "KeyN") {
        e.preventDefault();
        navigate(`/p/${usePages.getState().createPage(null)}`);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navigate, setSidebarOpen, setSwitcherOpen, toggleCollapsed]);

  // Lock background scroll while the mobile drawer is open.
  useEffect(() => {
    document.body.style.overflow = sidebarOpen ? "hidden" : "";
  }, [sidebarOpen]);

  return (
    <div className="flex h-full flex-col">
      {local && <DeviceOnlyStrip />}
      <div className={`flex min-h-0 flex-1 ${local ? "under-strip" : ""}`}>
        {/* Desktop sidebar */}
        <aside
          className={`hidden shrink-0 border-r border-line transition-[width] duration-200 md:block ${
            sidebarCollapsed ? "w-0 overflow-hidden border-r-0" : "w-[248px]"
          }`}
        >
          <div className="h-full w-[248px]">
            <Sidebar onCollapse={toggleCollapsed} />
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>

      {/* Mobile drawer */}
      <div
        className={`fixed inset-0 z-30 md:hidden ${sidebarOpen ? "" : "pointer-events-none"}`}
        aria-hidden={!sidebarOpen}
      >
        <div
          onClick={() => setSidebarOpen(false)}
          className={`absolute inset-0 bg-black/30 transition-opacity duration-200 ${
            sidebarOpen ? "opacity-100" : "opacity-0"
          }`}
        />
        <div
          className={`safe-top absolute inset-y-0 left-0 w-[84vw] max-w-[320px] bg-side transition-[transform,visibility] duration-200 ease-out ${
            sidebarOpen ? "translate-x-0 shadow-pop" : "invisible -translate-x-full"
          }`}
        >
          <Sidebar />
        </div>
      </div>

      <QuickSwitcher />
      <MovePicker />
      <TrashPanel />
      {historyOpen && (
        <Suspense fallback={null}>
          <HistoryPanel />
        </Suspense>
      )}
      <Notice />
    </div>
  );
}

/** Without an account: where the pages are, and how to keep them. Always shown. */
function DeviceOnlyStrip() {
  const link = "font-medium text-ink underline decoration-faint underline-offset-2 hover:decoration-ink";
  return (
    <div role="note" className="safe-top shrink-0 border-b border-line bg-side">
      <p className="px-4 py-2 text-center text-[13px] leading-snug text-muted">
        <span className="sm:hidden">
          Saved on this device only.{" "}
          <Link to="/signup" className={link}>
            Back up and sync
          </Link>
        </span>
        <span className="max-sm:hidden">
          Your pages are saved on this device only. To sync across devices and keep a backup,{" "}
          <Link to="/signup" className={link}>
            create an account
          </Link>{" "}
          or{" "}
          <Link to="/login" className={link}>
            sign in
          </Link>
          .
        </span>
      </p>
    </div>
  );
}

/** One-line status message at the bottom of the screen, e.g. after an import. */
function Notice() {
  const notice = useUi((s) => s.notice);
  const notify = useUi((s) => s.notify);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => notify(null), 6000);
    return () => clearTimeout(t);
  }, [notice, notify]);
  if (!notice) return null;
  return (
    <div className="safe-bottom pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto flex max-w-[420px] items-start gap-3 rounded-lg bg-ink px-3.5 py-2.5 text-[14px] text-paper shadow-pop"
      >
        <span className="flex-1">{notice}</span>
        <button onClick={() => notify(null)} className="text-paper/70 hover:text-paper" aria-label="Dismiss">
          ✕
        </button>
      </div>
    </div>
  );
}
