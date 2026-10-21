import { useEffect, useRef } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";
import { en } from "@blocknote/core/locales";
import "@blocknote/mantine/style.css";
import { MEDIA_BUCKET, MEDIA_PREFIX, supabase } from "../lib/supabase";
import type { Block } from "../lib/types";

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
  onReady?: (editor: BlockNoteEditor) => void;
};

/**
 * The editor is recreated only when the page changes or another device changed this page's
 * content (`rev`). Local typing never recreates it, so the cursor never jumps.
 */
export function Editor({ pageId, rev, initialContent, isDark, editable, onChange, onReady }: Props) {
  const editor = useCreateBlockNote(
    {
      initialContent: initialContent.length ? (initialContent as PartialBlock[]) : undefined,
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
    />
  );
}
