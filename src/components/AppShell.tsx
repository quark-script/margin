import { useEffect } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { usePages } from "../store/pages";
import { useUi } from "../store/ui";
import { Sidebar } from "./Sidebar";
import { MovePicker, QuickSwitcher } from "./QuickSwitcher";
import { TrashPanel } from "./TrashPanel";

export function AppShell() {
  const { sidebarOpen, sidebarCollapsed, setSidebarOpen, toggleCollapsed, setSwitcherOpen } = useUi();
  const navigate = useNavigate();

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
    <div className="flex h-full">
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

      <main className="min-w-0 flex-1">
        <Outlet />
      </main>

      <QuickSwitcher />
      <MovePicker />
      <TrashPanel />
    </div>
  );
}
