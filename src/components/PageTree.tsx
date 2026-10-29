import { memo, useCallback, useRef, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import {
  ChevronRight,
  ClipboardCopy,
  Copy,
  CornerUpRight,
  FileDown,
  FileText,
  Globe,
  History,
  MoreHorizontal,
  Plus,
  Star,
  StarOff,
  Trash2,
  Users,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { childrenOf, useIsLocal, usePages } from "../store/pages";
import { useUi } from "../store/ui";
import { displayTitle } from "../lib/text";
import { useShares } from "../store/shares";
import { IconButton, MenuDivider, MenuItem, Popover } from "./Menu";

export function PageTree({ parentId, depth = 0 }: { parentId: string | null; depth?: number }) {
  const ids = usePages(useShallow((s) => childrenOf(s.pages, parentId).map((p) => p.id)));
  if (!ids.length && depth > 0) {
    return (
      <div className="py-1 text-[13px] text-faint" style={{ paddingLeft: 30 + depth * 14 }}>
        No pages inside
      </div>
    );
  }
  return (
    <>
      {ids.map((id) => (
        <TreeItem key={id} id={id} depth={depth} />
      ))}
    </>
  );
}

const TreeItem = memo(function TreeItem({ id, depth }: { id: string; depth: number }) {
  const page = usePages((s) => s.pages[id]);
  const open = useUi((s) => !!s.expanded[id]);
  const setExpanded = useUi((s) => s.setExpanded);
  const setOpen = (v: boolean) => setExpanded(id, v);
  const navigate = useNavigate();
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);
  const linkShared = useShares((s) => Boolean(s.shares[id]));
  const invited = useShares((s) => Boolean(s.members[id]?.length));

  if (!page) return null;

  const addChild = () => {
    const newId = usePages.getState().createPage(id);
    setOpen(true);
    setSidebarOpen(false);
    navigate(`/p/${newId}`);
  };

  return (
    <div>
      <div
        className="group relative flex h-[30px] items-center [@media(pointer:coarse)]:h-9 rounded-md pr-1 text-[14px] text-ink/80 hover:bg-hover has-[a[aria-current=page]]:bg-press has-[a[aria-current=page]]:font-medium has-[a[aria-current=page]]:text-ink"
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        <button
          aria-label={open ? "Collapse" : "Expand"}
          onClick={() => setOpen(!open)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint hover:bg-press hover:text-ink"
        >
          <ChevronRight size={14} className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
        </button>
        <NavLink
          to={`/p/${id}`}
          onClick={() => setSidebarOpen(false)}
          className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch pr-1 outline-offset-[-2px]"
        >
          <span className="flex w-5 shrink-0 justify-center text-[15px] leading-none">
            {page.icon || <FileText size={16} className="text-faint" strokeWidth={1.75} />}
          </span>
          <span className={`truncate ${page.title.trim() ? "" : "text-faint"}`}>{displayTitle(page.title)}</span>
          {(linkShared || invited) && (
            <span
              title={linkShared ? "Anyone with the link can open" : "Shared with people"}
              aria-label="Shared"
              className="shrink-0 text-faint"
            >
              {linkShared ? <Globe size={12} strokeWidth={2} /> : <Users size={12} strokeWidth={2} />}
            </span>
          )}
        </NavLink>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100">
          <PageMenu id={id} />
          <IconButton label="Add a page inside" onClick={addChild} className="h-6 w-6">
            <Plus size={15} />
          </IconButton>
        </div>
      </div>
      {open && <PageTree parentId={id} depth={depth + 1} />}
    </div>
  );
});

export function PageMenu({ id, align = "start" }: { id: string; align?: "start" | "end" }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const page = usePages((s) => s.pages[id]);
  const local = useIsLocal();
  const navigate = useNavigate();
  const { pageId } = useParams();
  const close = useCallback(() => setOpen(false), []);
  if (!page) return null;

  const act = (fn: () => void) => () => {
    close();
    fn();
  };

  const duplicate = () => {
    const s = usePages.getState();
    const newId = s.createPage(page.parent_id, {
      title: page.title ? `${page.title} (copy)` : "",
      icon: page.icon,
      content: page.content,
      search_text: page.search_text,
      position: page.position + 0.5,
    });
    navigate(`/p/${newId}`);
  };

  return (
    <>
      <IconButton label="More actions" buttonRef={btn} onClick={() => setOpen((v) => !v)} className="h-6 w-6">
        <MoreHorizontal size={15} />
      </IconButton>
      <Popover anchor={btn.current} open={open} onClose={close} align={align}>
        <MenuItem
          icon={page.is_favorite ? <StarOff size={15} /> : <Star size={15} />}
          onClick={act(() => usePages.getState().updatePage(id, { is_favorite: !page.is_favorite }))}
        >
          {page.is_favorite ? "Remove from favorites" : "Add to favorites"}
        </MenuItem>
        <MenuItem icon={<Copy size={15} />} onClick={act(duplicate)}>
          Duplicate
        </MenuItem>
        <MenuItem icon={<CornerUpRight size={15} />} onClick={act(() => useUi.getState().setMoveId(id))}>
          Move to
        </MenuItem>
        {!local && (
          <MenuItem icon={<History size={15} />} onClick={act(() => useUi.getState().setHistory({ pageId: id }))}>
            Version history
          </MenuItem>
        )}
        <MenuDivider />
        <MenuItem icon={<ClipboardCopy size={15} />} onClick={act(() => copyMarkdown(id))}>
          Copy as Markdown
        </MenuItem>
        <MenuItem icon={<FileDown size={15} />} onClick={act(() => savePdf(id))}>
          Export as PDF
        </MenuItem>
        <MenuDivider />
        <MenuItem
          danger
          icon={<Trash2 size={15} />}
          onClick={act(() => {
            usePages.getState().archivePage(id);
            if (pageId === id) navigate(page.parent_id ? `/p/${page.parent_id}` : "/");
          })}
        >
          Move to trash
        </MenuItem>
      </Popover>
    </>
  );
}

function copyMarkdown(id: string) {
  const { notify } = useUi.getState();
  const text = import("../lib/markdown").then((m) => m.pageMarkdown(id));
  // Safari only allows clipboard writes inside the click, so hand it a promise right away.
  const write =
    typeof ClipboardItem !== "undefined"
      ? navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })])
      : text.then((t) => navigator.clipboard.writeText(t));
  write
    .catch(() => text.then((t) => navigator.clipboard.writeText(t)))
    .then(
      () => notify("Copied as Markdown."),
      () => notify("Couldn't copy to the clipboard."),
    );
}

async function savePdf(id: string) {
  try {
    const { exportPdf } = await import("../lib/pdf");
    await exportPdf(id);
  } catch (err) {
    useUi.getState().notify(err instanceof Error ? err.message : String(err));
  }
}
