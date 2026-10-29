import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { mapBlocks, mapInline } from "../../src/lib/blockTree.js";
import { displayTitle } from "../../src/lib/text.js";
import type { Block } from "../../src/lib/types.js";
import { MEDIA_BUCKET, MEDIA_PREFIX, SUPABASE_URL } from "./config.js";
import type { TreePage } from "./store.js";

// Pages are BlockNote blocks; agents read and write Markdown. The same converter as the app's
// "Copy as Markdown" and Markdown import, with page links and stored files mapped around it.

let converter: ServerBlockNoteEditor | null = null;
const editor = () => (converter ??= ServerBlockNoteEditor.create());

// [[Title]] becomes a link to this placeholder before parsing, then a page link.
const PAGE_REF = "https://page.margin.invalid/";
const PAGE_URL = /\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;
const signedPrefix = () => `${SUPABASE_URL}/storage/v1/object/sign/${MEDIA_BUCKET}/`;

const text = (t: string) => ({ type: "text", text: t, styles: {} });

/**
 * A page's content as Markdown for an agent: page links become links to the page in Margin
 * (`origin`), stored images and files links that work for a week.
 */
export async function toMarkdown(
  blocks: Block[],
  pages: Map<string, TreePage>,
  origin: string,
  fileLink: (path: string) => Promise<string | null>,
): Promise<string> {
  const stored: Block[] = [];
  const out = mapBlocks(blocks, (b) => {
    const block: Block = {
      ...b,
      content: mapInline(b.content, (n) => {
        if (n.type !== "pageLink") return n;
        const id = String((n.props as { pageId?: string } | undefined)?.pageId ?? "");
        const target = pages.get(id);
        return { type: "link", href: `${origin}/p/${id}`, content: [text(target ? displayTitle(target.title) : "Missing page")] };
      }) as Block["content"],
    };
    if (typeof block.props?.url === "string" && block.props.url.startsWith(MEDIA_PREFIX)) stored.push(block);
    return block;
  });
  for (const b of stored) {
    const link = await fileLink(String(b.props!.url).slice(MEDIA_PREFIX.length));
    b.props = { ...b.props, url: link ?? "" };
  }
  return (await editor().blocksToMarkdownLossy(out as never)).trim();
}

/** A week-long link to a stored file, back to the file it points at. */
function storedFile(url: string): string | null {
  const prefix = signedPrefix();
  if (!SUPABASE_URL || !url.startsWith(prefix)) return null;
  return MEDIA_PREFIX + decodeURIComponent(url.slice(prefix.length).split(/[?#]/)[0]);
}

/**
 * Markdown from an agent as page content. `[[Title]]` (or `[[Title|words]]`) and links to
 * Margin pages become page links when the page exists; other `[[...]]` stay as their words.
 * Week-long links from toMarkdown go back to the stored image or file.
 */
export async function fromMarkdown(md: string, pages: Map<string, TreePage>, trashed: (id: string) => boolean): Promise<Block[]> {
  const prepared = md.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_, target: string, words?: string) =>
    `[${(words ?? target).trim()}](${PAGE_REF}${encodeURIComponent(target.trim())})`,
  );
  const parsed = (await editor().tryParseMarkdownToBlocks(prepared)) as unknown as Block[];

  // By title: the page edited most recently wins when titles repeat.
  const byTitle = new Map<string, TreePage>();
  for (const p of pages.values()) {
    if (trashed(p.id)) continue;
    const key = displayTitle(p.title).toLowerCase();
    const seen = byTitle.get(key);
    if (!seen || p.updated_at > seen.updated_at) byTitle.set(key, p);
  }

  return mapBlocks(parsed, (b) => {
    // A stored file comes back from toMarkdown as a paragraph that is just a link to it.
    const only = Array.isArray(b.content) && b.content.length === 1 ? (b.content[0] as Record<string, unknown>) : null;
    const file = b.type === "paragraph" && only?.type === "link" && typeof only.href === "string" ? storedFile(only.href) : null;
    if (file) {
      const name = (only!.content as { text?: string }[] | undefined)?.map((t) => t.text ?? "").join("") ?? "";
      return { ...b, type: "file", props: { name, url: file }, content: undefined };
    }
    const block: Block = {
      ...b,
      content: mapInline(b.content, (n) => {
        if (n.type !== "link" || typeof n.href !== "string") return n;
        if (n.href.startsWith(PAGE_REF)) {
          const target = byTitle.get(decodeURIComponent(n.href.slice(PAGE_REF.length)).trim().toLowerCase());
          return target ? { type: "pageLink", props: { pageId: target.id } } : n.content;
        }
        const id = PAGE_URL.exec(n.href)?.[1]?.toLowerCase();
        return id && pages.has(id) && !trashed(id) ? { type: "pageLink", props: { pageId: id } } : n;
      }) as Block["content"],
    };
    const url = block.props?.url;
    const original = typeof url === "string" ? storedFile(url) : null;
    if (original) block.props = { ...block.props, url: original };
    return block;
  });
}
