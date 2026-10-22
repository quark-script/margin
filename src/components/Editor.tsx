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
import { MEDIA_BUCKET, MEDIA_PREFIX, supabase } from "../lib/supabase";
import type { Block } from "../lib/types";
import { isTrashed, usePages } from "../store/pages";
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

/** Items for the `[[` menu: matching pages, plus "create" when nothing has that exact title. */
function pageLinkItems(editor: Ed, currentPageId: string, query: string): DefaultReactSuggestionItem[] {
  const { pages } = usePages.getState();
  const q = query.trim().toLowerCase();
  const matches = Object.values(pages)
    .filter((p) => p.id !== currentPageId && !isTrashed(pages, p.id))
    .filter((p) => !q || displayTitle(p.title).toLowerCase().includes(q))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 12)
    .map<DefaultReactSuggestionItem>((p) => ({
      title: displayTitle(p.title),
      icon: p.icon ? <span>{p.icon}</span> : <FileText size={18} />,
      onItemClick: () => insertPageLink(editor, p.id),
    }));
  const exact = matches.some((m) => m.title.toLowerCase() === q);
  if (q && !exact) {
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

const signedUrlCache = new Map<string, { url: string; expires: number }>();
const SIGN_SECONDS = 60 * 60 * 24 * 7;

async function uploadFile(file: File) {
  if (!navigator.onLine) throw new Error("You're offline. Images can be added once you're back online.");
  const { data } = await supabase.auth.getSession();
  const uid = data.session?.user.id;
  if (!uid) throw new Error("Not signed in");
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "bin";
  const path = `${uid}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(path, file, {
    contentType: file.type || undefined,
    cacheControl: "31536000",
  });
  if (error) throw error;
  return MEDIA_PREFIX + path;
}

async function resolveFileUrl(url: string) {
  if (!url.startsWith(MEDIA_PREFIX)) return url;
  const path = url.slice(MEDIA_PREFIX.length);
  const hit = signedUrlCache.get(path);
  if (hit && hit.expires > Date.now() + 60_000) return hit.url;
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrl(path, SIGN_SECONDS);
  if (error || !data) return url;
  signedUrlCache.set(path, { url: data.signedUrl, expires: Date.now() + SIGN_SECONDS * 1000 });
  return data.signedUrl;
}

type Props = {
  pageId: string;
  rev: number;
  initialContent: Block[];
  isDark: boolean;
  editable: boolean;
  onChange: (blocks: Block[]) => void;
  onReady?: (editor: BlockNoteEditor<any, any, any>) => void;
};

/**
 * The editor is recreated only when the page changes or another device changed this page's
 * content (`rev`). Local typing never recreates it, so the cursor never jumps.
 */
export function Editor({ pageId, rev, initialContent, isDark, editable, onChange, onReady }: Props) {
  const editor = useCreateBlockNote(
    {
      schema,
      initialContent: initialContent.length ? (toKnownContent(initialContent) as unknown as PartialBlock<typeof schema.blockSchema, typeof schema.inlineContentSchema, typeof schema.styleSchema>[]) : undefined,
      uploadFile,
      resolveFileUrl,
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

  return (
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
        getItems={async (q) => pageLinkItems(editor, pageId, q)}
      />
    </BlockNoteView>
  );
}
