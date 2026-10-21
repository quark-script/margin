import type { Block, Page } from "./types";

// Content arrays are replaced (never mutated) on edit, so caching by array identity is safe
// and keeps backlink lookups from rescanning every page on every keystroke.
const cache = new WeakMap<Block[], Set<string>>();

/** Ids of the pages a page's content links to. */
export function linkedPageIds(content: Block[]): Set<string> {
  let ids = cache.get(content);
  if (ids) return ids;
  ids = new Set();
  const walkInline = (c: unknown) => {
    if (Array.isArray(c)) return c.forEach(walkInline);
    if (!c || typeof c !== "object") return;
    const o = c as { type?: string; props?: { pageId?: string }; content?: unknown; rows?: { cells?: unknown }[] };
    if (o.type === "pageLink" && o.props?.pageId) ids!.add(o.props.pageId);
    if (o.content) walkInline(o.content);
    if (Array.isArray(o.rows)) o.rows.forEach((r) => walkInline(r.cells));
  };
  const walk = (bs: Block[]) =>
    bs.forEach((b) => {
      walkInline(b.content);
      if (b.children?.length) walk(b.children);
    });
  walk(content);
  cache.set(content, ids);
  return ids;
}

/** Pages whose content links to `id`, most recently edited first. */
export function backlinksTo(pages: Record<string, Page>, id: string): Page[] {
  return Object.values(pages)
    .filter((p) => p.id !== id && linkedPageIds(p.content).has(id))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
