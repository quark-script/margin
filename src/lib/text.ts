import type { Block } from "./types";

/** Flatten BlockNote JSON into plain text for search. */
export function blocksToText(blocks: Block[] | undefined): string {
  if (!blocks) return "";
  const out: string[] = [];
  const walkInline = (c: unknown): void => {
    if (!c) return;
    if (typeof c === "string") {
      out.push(c);
      return;
    }
    if (Array.isArray(c)) {
      c.forEach(walkInline);
      return;
    }
    if (typeof c === "object") {
      const o = c as Record<string, unknown>;
      if (typeof o.text === "string") out.push(o.text);
      if (o.content) walkInline(o.content);
      // tables: { type: "tableContent", rows: [{ cells: [...] }] }
      if (Array.isArray(o.rows)) o.rows.forEach((r) => walkInline((r as { cells?: unknown }).cells));
    }
  };
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      walkInline(b.content);
      out.push("\n");
      if (b.children?.length) walk(b.children);
    }
  };
  walk(blocks);
  return out.join("").replace(/\n{2,}/g, "\n").trim().slice(0, 20000);
}

export function displayTitle(title: string | undefined | null) {
  return title?.trim() || "Untitled";
}

export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
