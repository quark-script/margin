// Markdown export and import. Loaded on demand: it pulls in the editor core and a zip library.

import { BlockNoteEditor } from "@blocknote/core";
import { strToU8, strFromU8, unzipSync, zipSync } from "fflate";
import { MEDIA_BUCKET, MEDIA_PREFIX, SITE_URL, supabase } from "./supabase";
import { displayTitle } from "./text";
import type { Block } from "./types";
import { childrenOf, isTrashed, usePages } from "../store/pages";

// Placeholder URLs that survive the Markdown parser; replaced after parsing.
const PAGE_URL = "https://page.margin.invalid/";
const FILE_URL = "https://file.margin.invalid/";
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

let converter: BlockNoteEditor | null = null;
const editor = () => (converter ??= BlockNoteEditor.create());

/** Safe file or folder name, unique among its siblings. */
function nameFor(title: string, used: Set<string>) {
  const base = displayTitle(title).replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Untitled";
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} ${i}`;
  used.add(name.toLowerCase());
  return name;
}

function mapInline(c: unknown, fn: (node: Record<string, unknown>) => unknown): unknown {
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

function mapBlocks(blocks: Block[], fn: (b: Block) => Block): Block[] {
  return blocks.map((b) => fn({ ...b, children: b.children ? mapBlocks(b.children, fn) : b.children }));
}

const today = () => new Date().toISOString().slice(0, 10);

/* ---------------- Export ---------------- */

export type ExportResult = { blob: Blob; filename: string; pages: number; missingImages: number };

const link = (text: string, href: string) => ({ type: "link", href, content: [{ type: "text", text, styles: {} }] });

/**
 * Pages outside the trash as Markdown, nested like the sidebar (a page with sub-pages becomes
 * `Title.md` next to a `Title/` folder, as in Obsidian). Links become `[[Title]]`, images are
 * saved under `attachments/`. `rootId` exports that page and its sub-pages, null everything.
 * A single page without sub-pages or images comes back as a plain .md file.
 */
export async function exportPages(rootId: string | null): Promise<ExportResult> {
  const { pages } = usePages.getState();
  const files: Record<string, Uint8Array> = {};
  const paths = new Map<string, { dir: string; name: string }>();

  const place = (parentId: string | null, dir: string) => {
    const used = new Set<string>();
    for (const p of childrenOf(pages, parentId).filter((p) => !isTrashed(pages, p.id))) {
      const name = nameFor(p.title, used);
      paths.set(p.id, { dir, name });
      place(p.id, `${dir}${name}/`);
    }
  };
  if (rootId) {
    const name = nameFor(pages[rootId].title, new Set());
    paths.set(rootId, { dir: "", name });
    place(rootId, `${name}/`);
  } else place(null, "");

  let missingImages = 0;
  const attachments = new Map<string, string>();
  const saveImage = async (url: string): Promise<string | null> => {
    if (!url.startsWith(MEDIA_PREFIX)) return url;
    const path = url.slice(MEDIA_PREFIX.length);
    if (attachments.has(path)) return attachments.get(path)!;
    const { data, error } = await supabase.storage.from(MEDIA_BUCKET).download(path);
    if (error || !data) return null;
    const file = `attachments/${path.split("/").pop()}`;
    files[file] = new Uint8Array(await data.arrayBuffer());
    attachments.set(path, file);
    return file;
  };

  for (const [id, { dir, name }] of paths) {
    const page = pages[id];
    const up = "../".repeat(dir.split("/").length - 1);
    const images: Block[] = [];
    let blocks = mapBlocks(page.content ?? [], (b) => {
      const out: Block = {
        ...b,
        content: mapInline(b.content, (n) => {
          if (n.type !== "pageLink") return n;
          const targetId = (n.props as { pageId?: string })?.pageId ?? "";
          const target = paths.get(targetId);
          // A page outside the export keeps its title as plain text.
          const text = target ? `[[${target.name}]]` : pages[targetId] ? displayTitle(pages[targetId].title) : "";
          return { type: "text", text, styles: {} };
        }) as Block["content"],
      };
      if (b.type === "image") images.push(out);
      return out;
    });
    for (const img of images) {
      const url = String(img.props?.url ?? "");
      const saved = url ? await saveImage(url) : url;
      if (saved === null) missingImages++;
      img.props = { ...img.props, url: saved === null ? "" : saved.startsWith("attachments/") ? up + saved : saved };
    }
    blocks = blocks.filter((b) => b.type !== "image" || b.props?.url);
    let md = editor().blocksToMarkdownLossy(blocks as never);
    // The serializer escapes the brackets of our [[links]].
    md = md.replace(/\\\[\\\[([^\]\n]*?)\\\]\\\]/g, "[[$1]]");
    files[`${dir}${name}.md`] = strToU8(md);
  }

  const names = Object.keys(files);
  if (rootId && names.length === 1) {
    return { blob: new Blob([files[names[0]] as BlobPart], { type: "text/markdown" }), filename: names[0], pages: 1, missingImages };
  }
  const zipped = zipSync(files, { level: 6 });
  const label = rootId ? paths.get(rootId)!.name : `margin-export-${today()}`;
  return {
    blob: new Blob([zipped as BlobPart], { type: "application/zip" }),
    filename: `${label}.zip`,
    pages: paths.size,
    missingImages,
  };
}

/**
 * One page as Markdown for pasting elsewhere. Page links point at the page in Margin and
 * images at a link that works for 7 days (the files themselves are private).
 */
export async function pageMarkdown(id: string): Promise<string> {
  const { pages } = usePages.getState();
  const images: Block[] = [];
  const blocks = mapBlocks(pages[id]?.content ?? [], (b) => {
    const out: Block = {
      ...b,
      content: mapInline(b.content, (n) => {
        if (n.type !== "pageLink") return n;
        const targetId = (n.props as { pageId?: string })?.pageId ?? "";
        const target = pages[targetId];
        return target ? link(displayTitle(target.title), `${SITE_URL}/p/${targetId}`) : [];
      }) as Block["content"],
    };
    if (b.type === "image") images.push(out);
    return out;
  });
  for (const img of images) {
    const url = String(img.props?.url ?? "");
    if (!url.startsWith(MEDIA_PREFIX)) continue;
    const { data } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrl(url.slice(MEDIA_PREFIX.length), 60 * 60 * 24 * 7);
    img.props = { ...img.props, url: data?.signedUrl ?? "" };
  }
  return editor().blocksToMarkdownLossy(blocks.filter((b) => b.type !== "image" || b.props?.url) as never).trim() + "\n";
}

/* ---------------- Import ---------------- */

export type ImportResult = { rootId: string | null; pages: number; images: number; missingImages: string[] };

type Note = { path: string; title: string; md: string; id?: string };

const ignored = (path: string) =>
  path.split("/").some((part) => part.startsWith(".") || part === "__MACOSX") || path.endsWith("/");

const baseName = (p: string) => p.split("/").pop() ?? p;
const stripExt = (p: string) => p.replace(/\.(md|markdown|txt)$/i, "");

/** Read the picked files: a zip (an Obsidian vault, or our export) or loose .md files and images. */
async function collect(files: File[]) {
  const entries: Record<string, Uint8Array> = {};
  let label: string | null = null;
  for (const f of files) {
    const data = new Uint8Array(await f.arrayBuffer());
    if (/\.zip$/i.test(f.name)) {
      label ??= f.name.replace(/\.zip$/i, "");
      for (const [path, bytes] of Object.entries(unzipSync(data))) if (!ignored(path)) entries[path] = bytes;
    } else {
      const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      if (!ignored(path)) entries[path] = data;
    }
  }
  // A zip of a folder has everything under one top folder: use it as the label, not a page.
  const tops = new Set(Object.keys(entries).map((p) => p.split("/")[0]));
  if (tops.size === 1 && Object.keys(entries).every((p) => p.includes("/"))) {
    const top = [...tops][0];
    label = top;
    for (const p of Object.keys(entries)) {
      entries[p.slice(top.length + 1)] = entries[p];
      delete entries[p];
    }
  }
  return { entries, label };
}

/** Obsidian syntax the Markdown parser doesn't know, rewritten to plain links and images. */
function preprocess(md: string, dir: string) {
  md = md.replace(/^\uFEFF/, "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""); // front matter
  // ![[image.png|300]] and ![[Other note]]
  md = md.replace(/!\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g, (_, target: string) =>
    IMAGE_EXT.test(target.trim())
      ? `![](${FILE_URL}${encodeURIComponent(target.trim())})`
      : `[${target.trim()}](${PAGE_URL}${encodeURIComponent(target.trim())})`,
  );
  // [[Note]], [[Note|alias]], [[Note#heading]]
  md = md.replace(/\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g, (_, target: string, _h, alias?: string) =>
    `[${(alias ?? target).trim()}](${PAGE_URL}${encodeURIComponent(target.trim())})`,
  );
  // ![alt](relative/image.png): resolve against the note's folder
  md = md.replace(/!\[([^\]\n]*)\]\((?!https?:|data:)([^)\s]+)(?:\s+"[^"]*")?\)/g, (all, alt: string, src: string) => {
    if (!IMAGE_EXT.test(src)) return all;
    let path = decodeURIComponent(src);
    if (!path.startsWith("/")) path = dir + path;
    const parts: string[] = [];
    for (const seg of path.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg && seg !== ".") parts.push(seg);
    }
    return `![${alt}](${FILE_URL}${encodeURIComponent(parts.join("/"))})`;
  });
  // The parser drops images that sit inside a paragraph, so give each its own line (not in tables).
  md = md
    .split("\n")
    .map((line) => (/^\s*\|/.test(line) ? line : line.replace(/[ \t]*(!\[[^\]\n]*\]\([^)\s]+\))[ \t]*/g, "\n\n$1\n\n")))
    .join("\n");
  return md;
}

/**
 * Create pages from Markdown. Folders become pages with their notes inside; `Folder.md` next
 * to `Folder/` is that folder's own page. Links between imported notes become page links, and
 * images are uploaded. Everything lands under one page when there's more than one top item.
 */
export async function importFiles(files: File[]): Promise<ImportResult> {
  const { entries, label } = await collect(files);
  const notes: Note[] = [];
  const images = new Map<string, Uint8Array>(); // by full path
  for (const [path, bytes] of Object.entries(entries)) {
    if (/\.(md|markdown|txt)$/i.test(path)) notes.push({ path, title: stripExt(baseName(path)), md: strFromU8(bytes) });
    else if (IMAGE_EXT.test(path)) images.set(path, bytes);
  }
  if (!notes.length) throw new Error("No Markdown files found. Pick .md files or a .zip of your notes.");

  const usesImages = notes.some((n) => /!\[/.test(n.md));
  if (usesImages && images.size && !navigator.onLine) throw new Error("You're offline. Connect to import notes with images.");

  const store = usePages.getState();
  const folderIds = new Map<string, string>(); // folder path -> page id
  const noteByPath = new Map(notes.map((n) => [stripExt(n.path), n]));
  const sorted = [...notes].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  const topItems = new Set(notes.map((n) => stripExt(n.path).split("/")[0]));
  const rootId = topItems.size > 1 ? store.createPage(null, { title: label || `Imported ${today()}`, icon: "📥" }) : null;

  const folderPage = (folder: string): string | null => {
    if (!folder) return rootId;
    if (folderIds.has(folder)) return folderIds.get(folder)!;
    const parent = folderPage(folder.split("/").slice(0, -1).join("/"));
    const own = noteByPath.get(folder); // Folder.md beside Folder/
    const id = own?.id ?? usePages.getState().createPage(parent, { title: baseName(folder) });
    if (own) own.id = id;
    folderIds.set(folder, id);
    return id;
  };

  // Pages first, so links can point at any of them.
  for (const n of sorted) {
    const key = stripExt(n.path);
    if (n.id) continue;
    const dir = key.split("/").slice(0, -1).join("/");
    const parent = folderPage(dir);
    n.id = folderIds.get(key) ?? usePages.getState().createPage(parent, { title: n.title });
  }

  const byTitle = new Map<string, string>();
  for (const n of notes) {
    byTitle.set(stripExt(n.path).toLowerCase(), n.id!);
    if (!byTitle.has(n.title.toLowerCase())) byTitle.set(n.title.toLowerCase(), n.id!);
  }
  const imageByName = new Map<string, string>();
  for (const p of images.keys()) if (!imageByName.has(baseName(p).toLowerCase())) imageByName.set(baseName(p).toLowerCase(), p);

  const { data } = await supabase.auth.getSession();
  const uid = data.session?.user.id;
  const uploaded = new Map<string, string>();
  const missingImages: string[] = [];
  const upload = async (ref: string): Promise<string | null> => {
    const path = images.has(ref) ? ref : imageByName.get(baseName(ref).toLowerCase());
    if (!path || !uid) return null;
    if (uploaded.has(path)) return uploaded.get(path)!;
    const ext = path.split(".").pop()!.toLowerCase();
    const dest = `${uid}/${crypto.randomUUID()}.${ext}`;
    const type = ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
    const { error } = await supabase.storage
      .from(MEDIA_BUCKET)
      .upload(dest, new Blob([images.get(path)! as BlobPart], { type }), { contentType: type, cacheControl: "31536000" });
    if (error) return null;
    uploaded.set(path, MEDIA_PREFIX + dest);
    return MEDIA_PREFIX + dest;
  };

  for (const n of notes) {
    const dir = stripExt(n.path).split("/").slice(0, -1).join("/");
    let blocks = editor().tryParseMarkdownToBlocks(preprocess(n.md, dir ? `${dir}/` : "")) as unknown as Block[];
    const pending: Block[] = [];
    blocks = mapBlocks(blocks, (b) => {
      const out: Block = {
        ...b,
        content: mapInline(b.content, (node) => {
          const href = typeof node.href === "string" ? node.href : "";
          if (node.type !== "link" || !href.startsWith(PAGE_URL)) return node;
          const target = decodeURIComponent(href.slice(PAGE_URL.length)).toLowerCase();
          const id = byTitle.get(target) ?? byTitle.get(baseName(target));
          return id ? { type: "pageLink", props: { pageId: id } } : node.content;
        }) as Block["content"],
      };
      if (b.type === "image" && String(b.props?.url ?? "").startsWith(FILE_URL)) pending.push(out);
      return out;
    });
    for (const img of pending) {
      const ref = decodeURIComponent(String(img.props!.url).slice(FILE_URL.length));
      const url = await upload(ref);
      if (url) img.props = { ...img.props, url };
      else {
        missingImages.push(baseName(ref));
        Object.assign(img, { type: "paragraph", props: {}, content: [{ type: "text", text: `Missing image: ${baseName(ref)}`, styles: { italic: true } }] });
      }
    }
    usePages.getState().setContent(n.id!, blocks);
  }

  const made = new Set([...notes.map((n) => n.id!), ...folderIds.values(), ...(rootId ? [rootId] : [])]);
  const top = [...topItems][0];
  return {
    rootId: rootId ?? folderIds.get(top) ?? noteByPath.get(top)?.id ?? null,
    pages: made.size,
    images: uploaded.size,
    missingImages,
  };
}
