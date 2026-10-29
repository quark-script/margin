import { useEffect, useRef } from "react";
import {
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  useCreateBlockNote,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { BlockNoteSchema, defaultInlineContentSpecs, type BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { en } from "@blocknote/core/locales";
import { FilePlus, FileText, Link2 } from "lucide-react";
import "@blocknote/mantine/style.css";
import { supabase } from "../lib/supabase";
import { FILE_TYPES, formatBytes, MAX_FILE_BYTES, resolveFileUrl, STORAGE_LIMIT_BYTES, storageUsed, uploadToStorage } from "../lib/media";
import { LOCAL_ID, saveLocalFile } from "../lib/local";
import type { Block } from "../lib/types";
import { isTrashed, sharedWithOthers, usePages } from "../store/pages";
import { useUi } from "../store/ui";
import { displayTitle } from "../lib/text";
import { pageLinkSpec } from "./PageLink";

const schema = BlockNoteSchema.create({
  inlineContentSpecs: { ...defaultInlineContentSpecs, pageLink: pageLinkSpec },
});
type Ed = typeof schema.BlockNoteEditor;

/**
 * Content written by a newer version of the app can contain block or inline types this
 * version doesn't know, and the editor refuses to open such a document. Show unknown blocks
 * as paragraphs and unknown inline content as text instead.
 */
function toKnownContent(blocks: Block[]): Block[] {
  const blockTypes = new Set(Object.keys(schema.blockSchema));
  const inlineTypes = new Set([...Object.keys(schema.inlineContentSchema), "text", "link"]);
  const inline = (c: unknown): unknown => {
    if (!Array.isArray(c)) return c;
    return c.map((n) => {
      const node = n as { type?: string; text?: string; content?: unknown };
      if (!node || typeof node !== "object" || inlineTypes.has(node.type ?? "")) return n;
      return { type: "text", text: typeof node.text === "string" ? node.text : "", styles: {} };
    });
  };
  return blocks.map((b) => {
    const known = blockTypes.has(b.type ?? "paragraph");
    const content = Array.isArray(b.content) ? inline(b.content) : known ? b.content : undefined;
    return {
      ...b,
      ...(known ? {} : { type: "paragraph", props: {} }),
      content,
      children: b.children ? toKnownContent(b.children) : b.children,
    } as Block;
  });
}

const LINK_TRIGGER = "[[";

function insertPageLink(editor: Ed, pageId: string) {
  editor.insertInlineContent([{ type: "pageLink", props: { pageId } }, " "]);
}

export type LinkCandidate = { id: string; title: string; icon: string | null; updated_at: string };

function ownPages(): LinkCandidate[] {
  const { pages } = usePages.getState();
  return Object.values(pages).filter((p) => !isTrashed(pages, p.id));
}

/**
 * Items for the `[[` menu: matching pages, plus "create" when nothing has that exact title.
 * Shared pages pass their own candidates and can't create pages.
 */
function pageLinkItems(
  editor: Ed,
  currentPageId: string,
  query: string,
  candidates?: () => LinkCandidate[],
): DefaultReactSuggestionItem[] {
  const q = query.trim().toLowerCase();
  const matches = (candidates ?? ownPages)()
    .filter((p) => p.id !== currentPageId)
    .filter((p) => !q || displayTitle(p.title).toLowerCase().includes(q))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 12)
    .map<DefaultReactSuggestionItem>((p) => ({
      title: displayTitle(p.title),
      icon: p.icon ? <span>{p.icon}</span> : <FileText size={18} />,
      onItemClick: () => insertPageLink(editor, p.id),
    }));
  const exact = matches.some((m) => m.title.toLowerCase() === q);
  if (q && !exact && !candidates) {
    const title = query.trim();
    matches.push({
      title: `Create “${title}”`,
      subtext: "New page at the top level",
      icon: <FilePlus size={18} />,
      onItemClick: () => insertPageLink(editor, usePages.getState().createPage(null, { title })),
    });
  }
  return matches;
}

function slashItems(editor: Ed, query: string): DefaultReactSuggestionItem[] {
  const linkItem: DefaultReactSuggestionItem = {
    title: "Link to page",
    subtext: "Insert a link to another page",
    aliases: ["link", "page", "mention", "[["],
    group: "Basic blocks",
    icon: <Link2 size={18} />,
    // Runs after the slash menu has removed "/query", so the [[ menu opens in a clean spot.
    onItemClick: () =>
      (editor.extensions.get("suggestionMenu") as { openSuggestionMenu?: (t: string) => void } | undefined)
        ?.openSuggestionMenu?.(LINK_TRIGGER),
  };
  return filterSuggestionItems([...getDefaultReactSlashMenuItems(editor), linkItem], query);
}

const dictionary = {
  ...en,
  placeholders: {
    ...en.placeholders,
    default: "Press '/' for blocks",
    emptyDocument: "Write something, or press '/' for blocks",
  },
};


/** The editor only says "Upload failed", so say why where it can be read. */
function refuse(message: string): never {
  useUi.getState().notify(message);
  throw new Error(message);
}

// Blocks whose upload failed. BlockNote leaves such a block saying "Loading..." for good, so
// the editor swaps it for a fresh empty one that can be clicked to try again.
const failedUploads = new Set<string>();

async function uploadFile(file: File, pageId: string, blockId?: string) {
  try {
    return await upload(file, pageId);
  } catch (err) {
    if (blockId) failedUploads.add(blockId);
    throw err;
  }
}

async function upload(file: File, pageId: string) {
  // Same limits for files kept on this device, so they still fit once their page syncs.
  if (file.size > MAX_FILE_BYTES) refuse(`This file is ${formatBytes(file.size)}. Files can be up to 10 MB.`);
  if (file.type && !FILE_TYPES.includes(file.type)) refuse("Margin can store images (PNG, JPEG, WebP, GIF, SVG) and PDFs.");
  // Kept on this device without an account, offline, or on a page that doesn't sync ("Sync all
  // pages" off and not shared). It goes up when its page syncs.
  const { userId, syncOn, pages } = usePages.getState();
  if (userId === LOCAL_ID || !navigator.onLine || (!syncOn && !sharedWithOthers(pages, pageId))) return saveLocalFile(file, file.name);
  const { data } = await supabase.auth.getSession();
  const uid = data.session?.user.id;
  if (!uid) refuse("Sign in again to add files.");
  try {
    return await uploadToStorage(uid, file, file.name);
  } catch {
    const full = await storageUsed().then((used) => used >= STORAGE_LIMIT_BYTES, () => false);
    refuse(full ? "Your storage is full (100 MB). Settings > Storage can free up space." : "Couldn't upload this file. Try again.");
  }
}


type Props = {
  pageId: string;
  rev: number;
  initialContent: Block[];
  isDark: boolean;
  editable: boolean;
  onChange: (blocks: Block[]) => void;
  onReady?: (editor: BlockNoteEditor<any, any, any>) => void;
  /** Shared pages: how to show images (and no uploads), and which pages `[[` can link to. */
  files?: { resolve: (url: string) => Promise<string>; upload?: (file: File) => Promise<string> };
  linkCandidates?: () => LinkCandidate[];
  onFocusChange?: (focused: boolean) => void;
};

/**
 * The editor is recreated only when the page changes or another device changed this page's
 * content (`rev`). Local typing never recreates it, so the cursor never jumps.
 */
export function Editor({
  pageId,
  rev,
  initialContent,
  isDark,
  editable,
  onChange,
  onReady,
  files,
  linkCandidates,
  onFocusChange,
}: Props) {
  const editor = useCreateBlockNote(
    {
      schema,
      initialContent: initialContent.length ? (toKnownContent(initialContent) as unknown as PartialBlock<typeof schema.blockSchema, typeof schema.inlineContentSchema, typeof schema.styleSchema>[]) : undefined,
      uploadFile: files ? files.upload : (file: File, blockId?: string) => uploadFile(file, pageId, blockId),
      resolveFileUrl: files ? files.resolve : resolveFileUrl,
      animations: false,
      dictionary,
    },
    [pageId, rev],
  );

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    onReady?.(editor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  useEffect(
    () =>
      editor.onUploadEnd((blockId) => {
        if (!blockId || !failedUploads.delete(blockId)) return;
        const block = editor.getBlock(blockId);
        if (!block || (block.props as { url?: string }).url) return;
        // A new block next to it, then the old one goes: replacing it in place would keep its view.
        editor.insertBlocks([{ type: block.type, props: block.props } as unknown as Parameters<Ed["insertBlocks"]>[0][number]], block, "after");
        editor.removeBlocks([block]);
      }),
    [editor],
  );

  const focusRef = useRef(onFocusChange);
  focusRef.current = onFocusChange;

  return (
    <div
      onFocus={() => focusRef.current?.(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focusRef.current?.(false);
      }}
    >
    <BlockNoteView
      editor={editor}
      editable={editable}
      theme={isDark ? "dark" : "light"}
      onChange={() => onChangeRef.current(editor.document as unknown as Block[])}
      data-color-scheme={isDark ? "dark" : "light"}
      slashMenu={false}
    >
      <SuggestionMenuController triggerCharacter="/" getItems={async (q) => slashItems(editor, q)} />
      <SuggestionMenuController
        triggerCharacter={LINK_TRIGGER}
        getItems={async (q) => pageLinkItems(editor, pageId, q, linkCandidates)}
      />
    </BlockNoteView>
    </div>
  );
}
