import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { blocksToText, displayTitle } from "../../src/lib/text.js";
import type { Block } from "../../src/lib/types.js";
import { DAILY_PARENT_TITLE } from "./config.js";
import type { Store, TreePage } from "./store.js";

export type Context = { store: Store; origin: string };

/** Told to every agent when it connects. */
export const INSTRUCTIONS = `Margin is the user's notes app. Pages can sit inside other pages, and their content is Markdown here.
Find pages with search_pages, recent_pages or list_pages, then read one with read_page. Write with create_page, append_to_page, update_page or daily_note.
Refer to a page by its id or its Margin link. In content, link to another page by writing [[Page title]].
Changes appear in the user's Margin app right away and in the page's version history, marked with this app's name.
Only pages in the user's account are reachable. A device with "Sync all pages" off keeps its other pages to itself.`;

/** A problem to tell the agent about, in words it can act on. */
class ToolError extends Error {}

type Tree = Map<string, TreePage>;
// The Markdown converter brings in a whole editor and jsdom: load it when a tool first needs it,
// so connecting and listing tools stay quick on a cold start.
const md = () => import("./markdown.js");
const fromMarkdown: typeof import("./markdown.js").fromMarkdown = async (...a) => (await md()).fromMarkdown(...a);
const toMarkdown: typeof import("./markdown.js").toMarkdown = async (...a) => (await md()).toMarkdown(...a);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const MAX_MARKDOWN = 100_000;
const MAX_READ = 100_000;
const LIMITS = { write: { minute: 30, day: 500 }, read: { minute: 120, day: 3000 } };

const markdown = z.string().max(MAX_MARKDOWN, `Content can be up to ${MAX_MARKDOWN.toLocaleString("en")} characters.`);
const pageRef = z.string().trim().min(1).describe("The page's id, or its Margin link");
const emoji = z
  .string()
  .trim()
  .max(16)
  .refine((s) => s === "" || /\p{Extended_Pictographic}/u.test(s), "The icon must be an emoji.");

function trashed(tree: Tree, id: string) {
  let p = tree.get(id);
  for (let guard = 0; p && guard < 200; guard++) {
    if (p.is_archived) return true;
    p = p.parent_id ? tree.get(p.parent_id) : undefined;
  }
  return false;
}

function pathOf(tree: Tree, id: string) {
  const names: string[] = [];
  let p = tree.get(id);
  for (let guard = 0; p && guard < 200; guard++) {
    names.unshift(displayTitle(p.title));
    p = p.parent_id ? tree.get(p.parent_id) : undefined;
  }
  return names.join(" › ");
}

function childrenOf(tree: Tree, parent: string | null) {
  return [...tree.values()]
    .filter((p) => p.parent_id === parent && !trashed(tree, p.id))
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
}

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const name = (p: { title: string; icon: string | null }) => `${p.icon ? `${p.icon} ` : ""}${displayTitle(p.title)}`;

function line(tree: Tree, p: TreePage) {
  const where = p.parent_id && tree.has(p.parent_id) ? `in ${pathOf(tree, p.parent_id)}` : "top level";
  const inside = childrenOf(tree, p.id).length;
  return `${name(p)} (id: ${p.id}) · ${where} · edited ${when(p.updated_at)}${inside ? ` · ${inside} page${inside === 1 ? "" : "s"} inside` : ""}`;
}

function find(tree: Tree, ref: string): TreePage {
  const ids = ref.match(UUID);
  const page = ids ? tree.get(ids[ids.length - 1].toLowerCase()) : undefined;
  if (!page) {
    throw new ToolError(
      `No page of yours matches "${ref}". Use search_pages or list_pages to find its id. Pages other people shared with you aren't available to agents.`,
    );
  }
  if (trashed(tree, page.id)) throw new ToolError(`"${displayTitle(page.title)}" is in the trash. Restore it in Margin first.`);
  return page;
}

async function loadTree(store: Store): Promise<Tree> {
  return new Map((await store.tree()).map((p) => [p.id, p]));
}

async function guard(store: Store, write: boolean) {
  const q = await store.take(write);
  if (q.ok) return;
  const kind = write ? "write" : "read";
  if (q.limit === "minute") {
    throw new ToolError(
      `Margin allows agents ${LIMITS[kind].minute} ${write ? "changes" : "reads"} a minute, and that's used up. Try again in ${q.retry_after} seconds.`,
    );
  }
  throw new ToolError(
    `Margin allows agents ${LIMITS[kind].day} ${write ? "changes" : "reads"} a day, and today's are used up. They reset at midnight UTC, in about ${Math.max(1, Math.round(q.retry_after / 3600))} hours.`,
  );
}

async function ensureFree(store: Store, page: TreePage) {
  const who = await store.editingNow(page.id);
  if (who) throw new ToolError(`${who} is editing "${displayTitle(page.title)}" in Margin right now. Try again in a minute.`);
}

/** Drop empty paragraphs at the end, so appended content follows the last real line. */
function trimEnd(blocks: Block[]) {
  const out = [...blocks];
  while (out.length) {
    const last = out[out.length - 1];
    const empty = last.type === "paragraph" && (!Array.isArray(last.content) || last.content.length === 0) && !last.children?.length;
    if (!empty) break;
    out.pop();
  }
  return out;
}

const searchText = (blocks: Block[]) => blocksToText(blocks).slice(0, 20000);
const nextPosition = (tree: Tree, parent: string | null) =>
  Math.max(-1, ...[...tree.values()].filter((p) => p.parent_id === parent).map((p) => p.position)) + 1;

async function pageText(ctx: Context, tree: Tree, page: TreePage) {
  const full = await ctx.store.page(page.id);
  if (!full) throw new ToolError("That page isn't available anymore.");
  let md = await toMarkdown(full.content ?? [], tree, ctx.origin, (path) => ctx.store.fileLink(path));
  if (md.length > MAX_READ) {
    md = `${md.slice(0, MAX_READ)}\n\n[Cut off here: the page is longer than ${MAX_READ.toLocaleString("en")} characters. Don't send this copy back with update_page; use append_to_page instead.]`;
  }
  const inside = childrenOf(tree, page.id);
  return [
    `Title: ${displayTitle(page.title)}`,
    page.icon ? `Icon: ${page.icon}` : null,
    `Page id: ${page.id}`,
    `Link: ${ctx.origin}/p/${page.id}`,
    `Location: ${page.parent_id && tree.has(page.parent_id) ? pathOf(tree, page.id) : "top level"}`,
    `Last edited: ${when(full.updated_at)}`,
    inside.length ? `Pages inside:\n${inside.map((c) => `- ${name(c)} (id: ${c.id})`).join("\n")}` : null,
    "",
    "Content (Markdown):",
    "",
    md || "(empty)",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Run a tool: count it against the limits, and turn problems into a message for the agent. */
function run<A>(ctx: Context, write: boolean, fn: (args: A) => Promise<string>) {
  return async (args: A): Promise<Result> => {
    try {
      await guard(ctx.store, write);
      return { content: [{ type: "text", text: await fn(args) }] };
    } catch (e) {
      if (e instanceof ToolError) return { content: [{ type: "text", text: e.message }], isError: true };
      console.error("[mcp] tool failed:", e instanceof Error ? e.message : e);
      return { content: [{ type: "text", text: "Margin couldn't do that just now. Try again in a moment." }], isError: true };
    }
  };
}

export function registerTools(server: McpServer, ctx: Context) {
  const { store } = ctx;
  const read = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool(
    "search_pages",
    {
      title: "Search pages",
      description:
        "Search the user's Margin pages for words in the title or text. Returns the best matches (up to 25) with their ids, where each one is, and a snippet. Use read_page to get a page's full content.",
      inputSchema: {
        query: z.string().trim().min(1).max(200).describe("Words or a phrase to look for"),
        limit: z.number().int().min(1).max(25).optional().describe("How many results to return (10 if left out)"),
      },
      annotations: read,
    },
    run(ctx, false, async ({ query, limit }: { query: string; limit?: number }) => {
      const [hits, tree] = await Promise.all([store.search(query, limit ?? 10), loadTree(store)]);
      const found = hits.filter((h) => tree.has(h.id) && !trashed(tree, h.id));
      if (!found.length) return `No pages match "${query}".`;
      const rows = found.map((h, i) => {
        const snippet = (h.snippet ?? "").replace(/\s+/g, " ").trim();
        return `${i + 1}. ${line(tree, tree.get(h.id)!)}${snippet ? `\n   "${snippet}"` : ""}`;
      });
      return `${found.length} page${found.length === 1 ? "" : "s"} match "${query}":\n${rows.join("\n")}`;
    }),
  );

  server.registerTool(
    "recent_pages",
    {
      title: "Recent pages",
      description: "List the user's most recently edited pages, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe("How many pages (15 if left out)") },
      annotations: read,
    },
    run(ctx, false, async ({ limit }: { limit?: number }) => {
      const tree = await loadTree(store);
      const pages = [...tree.values()]
        .filter((p) => !trashed(tree, p.id))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, limit ?? 15);
      if (!pages.length) return "There are no pages yet.";
      return `Most recently edited:\n${pages.map((p, i) => `${i + 1}. ${line(tree, p)}`).join("\n")}`;
    }),
  );

  server.registerTool(
    "list_pages",
    {
      title: "List pages",
      description:
        "List the pages inside a page, in the order the user arranged them, or the top-level pages when no parent is given.",
      inputSchema: { parent: pageRef.optional().describe("The page whose pages to list: its id or Margin link. Top level if left out.") },
      annotations: read,
    },
    run(ctx, false, async ({ parent }: { parent?: string }) => {
      const tree = await loadTree(store);
      const top = parent ? find(tree, parent) : null;
      const pages = childrenOf(tree, top?.id ?? null);
      if (!pages.length) return top ? `There are no pages inside "${displayTitle(top.title)}".` : "There are no pages yet.";
      const head = top ? `Pages inside "${displayTitle(top.title)}":` : "Top-level pages:";
      return `${head}\n${pages.map((p, i) => `${i + 1}. ${line(tree, p)}`).join("\n")}`;
    }),
  );

  server.registerTool(
    "read_page",
    {
      title: "Read a page",
      description:
        "Read a page: its title, where it is, the pages inside it, and its content as Markdown. Links to other pages appear as links to them in Margin.",
      inputSchema: { page: pageRef },
      annotations: read,
    },
    run(ctx, false, async ({ page }: { page: string }) => {
      const tree = await loadTree(store);
      return pageText(ctx, tree, find(tree, page));
    }),
  );

  server.registerTool(
    "create_page",
    {
      title: "Create a page",
      description:
        "Create a page with a title and, optionally, Markdown content, at the top level or inside another page. Link to other pages with [[Page title]].",
      inputSchema: {
        title: z.string().trim().min(1).max(300).describe("The page's title"),
        content: markdown.optional().describe("The page's content, in Markdown"),
        parent: pageRef.optional().describe("The page to put it in: its id or Margin link. Top level if left out."),
        icon: emoji.optional().describe("An emoji to show next to the title, such as 📝"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    run(ctx, true, async ({ title, content, parent, icon }: { title: string; content?: string; parent?: string; icon?: string }) => {
      const tree = await loadTree(store);
      const into = parent ? find(tree, parent) : null;
      const blocks = content ? await fromMarkdown(content, tree, (id) => trashed(tree, id)) : [];
      const id = crypto.randomUUID();
      await store.insertPage({
        id,
        parent_id: into?.id ?? null,
        title,
        icon: icon || null,
        content: blocks,
        search_text: searchText(blocks),
        position: nextPosition(tree, into?.id ?? null),
      });
      await store.seal(id);
      return `Created "${title}"${into ? ` inside "${displayTitle(into.title)}"` : ""}.\nPage id: ${id}\nLink: ${ctx.origin}/p/${id}`;
    }),
  );

  server.registerTool(
    "append_to_page",
    {
      title: "Add to a page",
      description: "Add Markdown to the end of a page, keeping everything already on it.",
      inputSchema: { page: pageRef, content: markdown.min(1).describe("What to add, in Markdown") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    run(ctx, true, async ({ page, content }: { page: string; content: string }) => {
      const tree = await loadTree(store);
      const target = find(tree, page);
      await ensureFree(store, target);
      const full = await store.page(target.id);
      if (!full) throw new ToolError("That page isn't available anymore.");
      const blocks = [...trimEnd(full.content ?? []), ...(await fromMarkdown(content, tree, (id) => trashed(tree, id)))];
      await store.seal(target.id);
      await store.updatePage(target.id, { content: blocks, search_text: searchText(blocks) });
      await store.seal(target.id);
      return `Added to "${displayTitle(target.title)}".\nLink: ${ctx.origin}/p/${target.id}`;
    }),
  );

  server.registerTool(
    "update_page",
    {
      title: "Change a page",
      description:
        "Change a page's title, icon or content. New content replaces everything on the page, so read the page first and send it back complete with your changes. The page's version history keeps what was there before.",
      inputSchema: {
        page: pageRef,
        title: z.string().trim().min(1).max(300).optional().describe("A new title"),
        icon: emoji.optional().describe("A new emoji icon, or an empty string to remove it"),
        content: markdown.optional().describe("The page's whole new content, in Markdown"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    run(ctx, true, async ({ page, title, icon, content }: { page: string; title?: string; icon?: string; content?: string }) => {
      if (title === undefined && icon === undefined && content === undefined) {
        throw new ToolError("Nothing to change: give a new title, icon or content.");
      }
      const tree = await loadTree(store);
      const target = find(tree, page);
      await ensureFree(store, target);
      const patch: Parameters<Store["updatePage"]>[1] = {};
      if (title !== undefined) patch.title = title;
      if (icon !== undefined) patch.icon = icon || null;
      if (content !== undefined) {
        const blocks = await fromMarkdown(content, tree, (id) => trashed(tree, id));
        patch.content = blocks;
        patch.search_text = searchText(blocks);
      }
      await store.seal(target.id);
      await store.updatePage(target.id, patch);
      await store.seal(target.id);
      const changed = [title !== undefined && "title", icon !== undefined && "icon", content !== undefined && "content"].filter(Boolean);
      return `Updated the ${changed.join(" and ")} of "${title ?? displayTitle(target.title)}". The previous version is in its version history.\nLink: ${ctx.origin}/p/${target.id}`;
    }),
  );

  server.registerTool(
    "daily_note",
    {
      title: "Daily note",
      description: `Read the user's daily note for a day, or add Markdown to it. Daily notes are pages titled YYYY-MM-DD inside a "${DAILY_PARENT_TITLE}" page; adding to a day that has none creates it.`,
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
          .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), "That date doesn't exist.")
          .optional()
          .describe("The day in the user's own time zone, as YYYY-MM-DD. Today in UTC if left out."),
        append: markdown.min(1).optional().describe("Markdown to add to the end of that day's note"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    run(ctx, false, async ({ date, append }: { date?: string; append?: string }) => {
      const day = date ?? new Date().toISOString().slice(0, 10);
      const tree = await loadTree(store);
      const oldest = (a: TreePage, b: TreePage) => a.created_at.localeCompare(b.created_at);
      const findParent = () => childrenOf(tree, null).filter((p) => p.title.trim() === DAILY_PARENT_TITLE).sort(oldest)[0];
      const findDay = (parent: TreePage) => childrenOf(tree, parent.id).filter((p) => p.title.trim() === day).sort(oldest)[0];

      let parent = findParent();
      let note = parent ? findDay(parent) : undefined;
      if (!append) {
        if (!note) return `There's no daily note for ${day} yet. Add to it with daily_note's append to create it.`;
        return pageText(ctx, tree, note);
      }

      await guard(store, true);
      if (!parent) {
        const made = { id: crypto.randomUUID(), parent_id: null, title: DAILY_PARENT_TITLE, icon: "📅", position: nextPosition(tree, null) };
        const { updated_at } = await store.insertPage({ ...made, content: [], search_text: "" });
        parent = { ...made, is_archived: false, created_at: updated_at, updated_at };
        tree.set(parent.id, parent);
      }
      const blocks = await fromMarkdown(append, tree, (id) => trashed(tree, id));
      if (!note) {
        const id = crypto.randomUUID();
        await store.insertPage({ id, parent_id: parent.id, title: day, icon: null, content: blocks, search_text: searchText(blocks), position: nextPosition(tree, parent.id) });
        await store.seal(id);
        return `Started the daily note for ${day} with your text.\nPage id: ${id}\nLink: ${ctx.origin}/p/${id}`;
      }
      await ensureFree(store, note);
      const full = await store.page(note.id);
      const merged = [...trimEnd(full?.content ?? []), ...blocks];
      await store.seal(note.id);
      await store.updatePage(note.id, { content: merged, search_text: searchText(merged) });
      await store.seal(note.id);
      return `Added to the daily note for ${day}.\nPage id: ${note.id}\nLink: ${ctx.origin}/p/${note.id}`;
    }),
  );
}
