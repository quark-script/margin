import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import {
  CalendarDays,
  ChevronsLeft,
  Download,
  FileText,
  KeyRound,
  UserRound,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Search,
  SquarePen,
  Sun,
  Trash2,
  Upload,
  UserRoundX,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { usePages } from "../store/pages";
import { useUi } from "../store/ui";
import { useAuth } from "../store/auth";
import { useShares } from "../store/shares";
import { useTheme, type ThemePref } from "../lib/theme";
import { displayTitle } from "../lib/text";
import { PageTree } from "./PageTree";
import { IconButton, MenuDivider, MenuItem, Popover } from "./Menu";
import { SyncStatus } from "./SyncStatus";
import { openToday } from "../lib/daily";
import { download } from "../lib/download";
import { NameDialog } from "./NameDialog";
import { DeleteAccountDialog } from "./DeleteAccountDialog";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? "⌘" : "Ctrl";

export function Sidebar({ onCollapse }: { onCollapse?: () => void }) {
  const navigate = useNavigate();
  const { setSwitcherOpen, setTrashOpen, setSidebarOpen } = useUi();
  const favorites = usePages(
    useShallow((s) =>
      Object.values(s.pages)
        .filter((p) => p.is_favorite && !p.is_archived)
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((p) => p.id),
    ),
  );
  const hasPages = usePages((s) => Object.values(s.pages).some((p) => !p.is_archived && !p.parent_id));
  const loaded = usePages((s) => s.loaded);

  const newPage = () => {
    const id = usePages.getState().createPage(null);
    setSidebarOpen(false);
    navigate(`/p/${id}`);
  };

  return (
    <nav className="flex h-full flex-col bg-side text-ink" aria-label="Pages">
      <div className="flex items-center gap-1 px-2 pt-2 pb-1">
        <AccountMenu />
        {onCollapse && (
          <IconButton label="Close sidebar" onClick={onCollapse}>
            <ChevronsLeft size={17} />
          </IconButton>
        )}
        <IconButton label="New page" onClick={newPage}>
          <SquarePen size={16} />
        </IconButton>
      </div>

      <div className="px-2 pb-2">
        <SideRow icon={<Search size={16} />} onClick={() => setSwitcherOpen(true)} hint={`${modKey} K`}>
          Search
        </SideRow>
        <SideRow
          icon={<CalendarDays size={16} />}
          onClick={() => {
            setSidebarOpen(false);
            navigate(`/p/${openToday()}`);
          }}
        >
          Today
        </SideRow>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {favorites.length > 0 && (
          <section className="mb-4">
            <SectionLabel>Favorites</SectionLabel>
            {favorites.map((id) => (
              <FavoriteRow key={id} id={id} />
            ))}
          </section>
        )}

        <SharedWithMe />

        <section>
          <div className="group flex items-center justify-between pr-1">
            <SectionLabel>Pages</SectionLabel>
            <IconButton
              label="New page"
              onClick={newPage}
              className="h-6 w-6 opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(pointer:coarse)]:opacity-100"
            >
              <Plus size={15} />
            </IconButton>
          </div>
          <PageTree parentId={null} />
          {loaded && !hasPages && (
            <button
              onClick={newPage}
              className="mt-1 flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-[14px] text-muted hover:bg-hover"
            >
              <Plus size={15} /> Add your first page
            </button>
          )}
        </section>
      </div>

      <div className="safe-bottom border-t border-line px-2 py-2">
        <div className="flex items-center justify-between">
          <SideRow icon={<Trash2 size={16} />} onClick={() => setTrashOpen(true)}>
            Trash
          </SideRow>
          <SyncStatus />
        </div>
      </div>
    </nav>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pb-1 pt-1 text-[12px] font-medium text-muted">{children}</div>;
}

function SideRow({
  icon,
  children,
  onClick,
  hint,
  className = "w-full",
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  hint?: string;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex h-[30px] items-center gap-2 rounded-md px-2 text-[14px] text-ink/75 [@media(pointer:coarse)]:h-9 hover:bg-hover hover:text-ink ${className}`}
    >
      <span className="text-muted">{icon}</span>
      <span className="flex-1 text-left">{children}</span>
      {hint && <span className="text-[12px] text-faint [@media(pointer:coarse)]:hidden">{hint}</span>}
    </button>
  );
}

/** Pages other people invited you to. Refreshed whenever the app comes back to the foreground. */
function SharedWithMe() {
  const incoming = useShares((s) => s.incoming);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  useEffect(() => {
    const refresh = () => document.visibilityState === "visible" && void useShares.getState().loadIncoming();
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);
  if (!incoming.length) return null;
  return (
    <section className="mb-4">
      <SectionLabel>Shared with me</SectionLabel>
      {incoming.map((p) => (
        <NavLink
          key={p.page_id}
          to={`/p/${p.page_id}`}
          onClick={() => setSidebarOpen(false)}
          title={p.owner_name ? `Shared by ${p.owner_name}` : undefined}
          className={({ isActive }) =>
            `flex h-[30px] items-center gap-2 rounded-md px-2 text-[14px] [@media(pointer:coarse)]:h-9 hover:bg-hover ${
              isActive ? "bg-press font-medium text-ink" : "text-ink/80"
            }`
          }
        >
          <span className="flex w-5 justify-center text-[15px] leading-none">
            {p.icon || <FileText size={16} className="text-faint" strokeWidth={1.75} />}
          </span>
          <span className="min-w-0 flex-1 truncate">{displayTitle(p.title)}</span>
        </NavLink>
      ))}
    </section>
  );
}

function FavoriteRow({ id }: { id: string }) {
  const page = usePages((s) => s.pages[id]);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  if (!page) return null;
  return (
    <NavLink
      to={`/p/${id}`}
      onClick={() => setSidebarOpen(false)}
      className={({ isActive }) =>
        `flex h-[30px] items-center gap-2 rounded-md px-2 text-[14px] hover:bg-hover ${
          isActive ? "bg-press font-medium text-ink" : "text-ink/80"
        }`
      }
    >
      <span className="flex w-5 justify-center text-[15px] leading-none">
        {page.icon || <FileText size={16} className="text-faint" strokeWidth={1.75} />}
      </span>
      <span className="truncate">{displayTitle(page.title)}</span>
    </NavLink>
  );
}

function AccountMenu() {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const email = useAuth((s) => s.session?.user.email ?? "");
  const signOut = useAuth((s) => s.signOut);
  const changePassword = useAuth((s) => s.changePassword);
  const { pref, setPref } = useTheme();
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const notify = useUi((s) => s.notify);

  const run = async (label: string, task: () => Promise<string>) => {
    close();
    setBusy(true);
    notify(label);
    try {
      notify(await task());
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const exportEverything = async () => {
    const { exportPages } = await import("../lib/markdown");
    const res = await exportPages(null);
    download(res.blob, res.filename);
    const missing = res.missingImages ? ` ${res.missingImages} image(s) couldn't be downloaded.` : "";
    return `Exported ${res.pages} page${res.pages === 1 ? "" : "s"}.${missing}`;
  };
  const exportAll = () => run("Preparing your export…", exportEverything);

  const importPicked = (files: File[]) =>
    run("Importing…", async () => {
      const { importFiles } = await import("../lib/markdown");
      const res = await importFiles(files);
      if (res.rootId) {
        useUi.getState().setSidebarOpen(false);
        navigate(`/p/${res.rootId}`);
      }
      const missing = res.missingImages.length ? ` Missing images: ${res.missingImages.slice(0, 3).join(", ")}${res.missingImages.length > 3 ? "…" : ""}.` : "";
      return `Imported ${res.pages} page${res.pages === 1 ? "" : "s"}.${missing}`;
    });
  const initial = (email[0] ?? "N").toUpperCase();
  // Google accounts come with a name and photo.
  const meta = useAuth((s) => s.session?.user.user_metadata) as { full_name?: string; name?: string; avatar_url?: string } | undefined;
  const name = meta?.full_name?.trim() || meta?.name?.trim() || "";
  const [photoFailed, setPhotoFailed] = useState(false);
  const photo = !photoFailed ? meta?.avatar_url : undefined;
  // Signed up with Google only: there's no password yet, so offer to set one.
  const hasPassword = useAuth((s) => s.session?.user.identities?.some((i) => i.provider === "email") ?? true);
  const [naming, setNaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const themeItem = (value: ThemePref, label: string, icon: React.ReactNode) => (
    <MenuItem icon={icon} onClick={() => setPref(value)} hint={pref === value ? "✓" : undefined}>
      {label}
    </MenuItem>
  );

  return (
    <>
      <button
        ref={btn}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left hover:bg-hover"
      >
        {photo ? (
          <img
            src={photo}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setPhotoFailed(true)}
            className="h-[22px] w-[22px] shrink-0 rounded-[5px] object-cover"
          />
        ) : (
          <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] bg-ink text-[12px] font-semibold text-paper">
            {initial}
          </span>
        )}
        <span className="truncate text-[14px] font-medium">Margin</span>
      </button>
      <Popover anchor={btn.current} open={open} onClose={close} width={240}>
        <div className="px-2 py-1.5">
          {name && <div className="truncate text-[13px] font-medium text-ink">{name}</div>}
          <div className="truncate text-[12px] text-muted">{email}</div>
        </div>
        <MenuDivider />
        {themeItem("system", "System theme", <Monitor size={15} />)}
        {themeItem("light", "Light", <Sun size={15} />)}
        {themeItem("dark", "Dark", <Moon size={15} />)}
        <MenuDivider />
        <MenuItem icon={<Upload size={15} />} onClick={() => !busy && fileInput.current?.click()}>
          Import Markdown
        </MenuItem>
        <MenuItem icon={<Download size={15} />} onClick={() => !busy && void exportAll()}>
          Export all pages
        </MenuItem>
        <MenuDivider />
        <MenuItem
          icon={<UserRound size={15} />}
          onClick={() => {
            close();
            setNaming(true);
          }}
        >
          {name ? "Change your name" : "Add your name"}
        </MenuItem>
        <MenuItem
          icon={<KeyRound size={15} />}
          onClick={() => {
            close();
            changePassword();
          }}
        >
          {hasPassword ? "Change password" : "Set a password"}
        </MenuItem>
        <MenuItem
          icon={<LogOut size={15} />}
          onClick={() => {
            close();
            void signOut();
          }}
        >
          Sign out
        </MenuItem>
        <MenuDivider />
        <MenuItem
          danger
          icon={<UserRoundX size={15} />}
          onClick={() => {
            close();
            setDeleting(true);
          }}
        >
          Delete account
        </MenuItem>
      </Popover>
      {naming && <NameDialog onClose={() => setNaming(false)} />}
      {deleting && <DeleteAccountDialog onClose={() => setDeleting(false)} onExport={exportEverything} />}
      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".md,.markdown,.txt,.zip,image/*"
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) void importPicked(files);
        }}
      />
    </>
  );
}

