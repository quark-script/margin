import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import { FileText, Plus, CornerUpRight, Home } from "lucide-react";
import { ancestorsOf, isTrashed, usePages } from "../store/pages";
import { useUi } from "../store/ui";
import { displayTitle, timeAgo } from "../lib/text";
import type { Page } from "../lib/types";

function Overlay({ onClose, children, label }: { onClose: () => void; children: React.ReactNode; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-label={label}
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/25 px-3 pt-[12vh] dark:bg-black/50"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-[560px] overflow-hidden rounded-xl bg-pop shadow-pop">{children}</div>
    </div>
  );
}

function snippet(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - 30);
  return (start > 0 ? "…" : "") + text.slice(start, i + q.length + 60).replace(/\s*\n\s*/g, " · ").replace(/\s+/g, " ");
}

function pathLabel(pages: Record<string, Page>, id: string) {
  const a = ancestorsOf(pages, id);
  return a.length ? a.map((p) => displayTitle(p.title)).join(" / ") : "";
}

const itemCls =
  "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[14px] text-ink data-[selected=true]:bg-hover";

export function QuickSwitcher() {
  const open = useUi((s) => s.switcherOpen);
  const setOpen = useUi((s) => s.setSwitcherOpen);
  const pages = usePages((s) => s.pages);
  const navigate = useNavigate();
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const results = useMemo(() => {
    const live = Object.values(pages).filter((p) => !isTrashed(pages, p.id));
    const query = q.trim().toLowerCase();
    if (!query) {
      return live
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 8)
        .map((p) => ({ p, snip: null as string | null }));
    }
    const scored: { p: Page; score: number; snip: string | null }[] = [];
    for (const p of live) {
      const t = displayTitle(p.title).toLowerCase();
      let score = 0;
      if (t === query) score = 100;
      else if (t.startsWith(query)) score = 80;
      else if (t.includes(query)) score = 60;
      let snip: string | null = null;
      if (!score && p.search_text.toLowerCase().includes(query)) {
        score = 30;
        snip = snippet(p.search_text, q.trim());
      }
      if (score) scored.push({ p, score, snip });
    }
    return scored
      .sort((a, b) => b.score - a.score || b.p.updated_at.localeCompare(a.p.updated_at))
      .slice(0, 30);
  }, [pages, q]);

  if (!open) return null;
  const close = () => setOpen(false);
  const go = (id: string) => {
    close();
    navigate(`/p/${id}`);
  };

  return (
    <Overlay onClose={close} label="Search pages">
      <Command shouldFilter={false} loop>
        <Command.Input
          autoFocus
          value={q}
          onValueChange={setQ}
          placeholder="Search pages and their contents"
          className="h-12 w-full border-b border-line bg-transparent px-4 text-[15px] text-ink outline-none placeholder:text-faint"
        />
        <Command.List className="max-h-[min(420px,60vh)] overflow-y-auto p-1.5">
          {!q.trim() && results.length > 0 && (
            <div className="px-3 pb-1 pt-2 text-[12px] font-medium text-muted">Recent</div>
          )}
          {results.map(({ p, snip }) => (
            <Command.Item key={p.id} value={p.id} onSelect={() => go(p.id)} className={itemCls}>
              <span className="flex w-5 shrink-0 justify-center text-[16px] leading-none">
                {p.icon || <FileText size={16} className="text-faint" strokeWidth={1.75} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{displayTitle(p.title)}</span>
                {(snip || pathLabel(pages, p.id)) && (
                  <span className="block truncate text-[12px] text-muted">{snip ?? pathLabel(pages, p.id)}</span>
                )}
              </span>
              <span className="shrink-0 text-[12px] text-faint">{timeAgo(p.updated_at)}</span>
            </Command.Item>
          ))}
          {q.trim() && results.length === 0 && (
            <div className="px-3 py-6 text-center text-[14px] text-muted">No pages match “{q.trim()}”</div>
          )}
          {q.trim() && (
            <Command.Item
              value="__create"
              onSelect={() => go(usePages.getState().createPage(null, { title: q.trim() }))}
              className={itemCls}
            >
              <Plus size={16} className="w-5 text-muted" />
              <span className="truncate">
                Create page <span className="font-medium">“{q.trim()}”</span>
              </span>
            </Command.Item>
          )}
        </Command.List>
      </Command>
    </Overlay>
  );
}

export function MovePicker() {
  const moveId = useUi((s) => s.moveId);
  const setMoveId = useUi((s) => s.setMoveId);
  const expandMany = useUi((s) => s.expandMany);
  const pages = usePages((s) => s.pages);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!moveId) setQ("");
  }, [moveId]);

  const targets = useMemo(() => {
    if (!moveId) return [];
    // A page can't move into itself or anything nested inside it.
    const blocked = new Set<string>([moveId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of Object.values(pages)) {
        if (p.parent_id && blocked.has(p.parent_id) && !blocked.has(p.id)) {
          blocked.add(p.id);
          grew = true;
        }
      }
    }
    const query = q.trim().toLowerCase();
    return Object.values(pages)
      .filter((p) => !blocked.has(p.id) && !isTrashed(pages, p.id))
      .filter((p) => !query || displayTitle(p.title).toLowerCase().includes(query))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 40);
  }, [moveId, pages, q]);

  if (!moveId) return null;
  const page = pages[moveId];
  const close = () => setMoveId(null);
  const move = (parent: string | null) => {
    usePages.getState().movePage(moveId, parent);
    if (parent) expandMany([...ancestorsOf(pages, parent).map((a) => a.id), parent]);
    close();
  };

  return (
    <Overlay onClose={close} label="Move page">
      <Command shouldFilter={false} loop>
        <div className="flex items-center gap-2 border-b border-line px-4">
          <CornerUpRight size={16} className="shrink-0 text-muted" />
          <Command.Input
            autoFocus
            value={q}
            onValueChange={setQ}
            placeholder={`Move “${displayTitle(page?.title)}” to…`}
            className="h-12 w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-faint"
          />
        </div>
        <Command.List className="max-h-[min(420px,60vh)] overflow-y-auto p-1.5">
          {!q.trim() && page?.parent_id && (
            <Command.Item value="__root" onSelect={() => move(null)} className={itemCls}>
              <Home size={16} className="w-5 text-muted" />
              <span>Top level</span>
            </Command.Item>
          )}
          {targets.map((p) => (
            <Command.Item key={p.id} value={p.id} onSelect={() => move(p.id)} className={itemCls}>
              <span className="flex w-5 shrink-0 justify-center text-[16px] leading-none">
                {p.icon || <FileText size={16} className="text-faint" strokeWidth={1.75} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{displayTitle(p.title)}</span>
                {pathLabel(pages, p.id) && (
                  <span className="block truncate text-[12px] text-muted">{pathLabel(pages, p.id)}</span>
                )}
              </span>
            </Command.Item>
          ))}
          {targets.length === 0 && (
            <div className="px-3 py-6 text-center text-[14px] text-muted">No other pages to move into</div>
          )}
        </Command.List>
      </Command>
    </Overlay>
  );
}
