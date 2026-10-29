import type { Block } from "./types";

// Walking BlockNote content. Shared by the app and the MCP server (api/), so keep it free of
// browser and Node APIs.

/** Map every inline node (text, links, page links), table cells included. */
export function mapInline(c: unknown, fn: (node: Record<string, unknown>) => unknown): unknown {
  if (!Array.isArray(c)) {
    // tables: { type: "tableContent", rows: [{ cells: [...] }] }
    const t = c as { rows?: { cells?: unknown[] }[] } | undefined;
    if (t && Array.isArray(t.rows)) {
      return {
        ...t,
        rows: t.rows.map((r) => ({
          ...r,
          cells: r.cells?.map((cell) => {
            const o = cell as { content?: unknown };
            return Array.isArray(cell) ? mapInline(cell, fn) : o && typeof o === "object" ? { ...o, content: mapInline(o.content, fn) } : cell;
          }),
        })),
      };
    }
    return c;
  }
  // fn may return a node, an array of nodes (unwrapping a link), or the node unchanged.
  return c.flatMap((n) => {
    const node = n as Record<string, unknown>;
    const inner = node?.type === "link" ? { ...node, content: mapInline(node.content, fn) } : node;
    return [fn(inner)].flat();
  });
}

/** Map every block, children first. */
export function mapBlocks(blocks: Block[], fn: (b: Block) => Block): Block[] {
  return blocks.map((b) => fn({ ...b, children: b.children ? mapBlocks(b.children, fn) : b.children }));
}
