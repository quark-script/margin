import { MEDIA_BUCKET, MEDIA_PREFIX, supabase } from "./supabase";

const signedUrlCache = new Map<string, { url: string; expires: number }>();
const SIGN_SECONDS = 60 * 60 * 24 * 7;

/**
 * Images live in a private bucket; content stores them as `notes-media:<path>`. Turn that into
 * a signed URL. Works for the owner and for people the page was shared with by invite.
 */
export async function resolveFileUrl(url: string) {
  if (!url.startsWith(MEDIA_PREFIX)) return url;
  const path = url.slice(MEDIA_PREFIX.length);
  const hit = signedUrlCache.get(path);
  if (hit && hit.expires > Date.now() + 60_000) return hit.url;
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrl(path, SIGN_SECONDS);
  if (error || !data) return url;
  signedUrlCache.set(path, { url: data.signedUrl, expires: Date.now() + SIGN_SECONDS * 1000 });
  return data.signedUrl;
}

/** Each file can be up to 10 MB (the bucket refuses bigger ones too). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Uploads stop once an account stores this much (notes_media_quota on the server). */
export const STORAGE_LIMIT_BYTES = 100 * 1024 * 1024;
/** What the bucket accepts. */
export const FILE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "application/pdf"];

export function formatBytes(n: number) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  const mb = n / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Bytes the signed-in account has stored. */
export async function storageUsed() {
  const { data, error } = await supabase.rpc("my_media_bytes");
  if (error) throw error;
  return Number(data ?? 0);
}

/** Files of yours no page uses any more (see notes.unused_files). */
export async function unusedFiles(): Promise<{ name: string; size: number }[]> {
  const { data, error } = await supabase.rpc("unused_files");
  if (error) throw error;
  return ((data ?? []) as { name: string; size: number }[]).map((f) => ({ name: f.name, size: Number(f.size) }));
}

export async function deleteFiles(names: string[]) {
  for (let i = 0; i < names.length; i += 100) {
    const { error } = await supabase.storage.from(MEDIA_BUCKET).remove(names.slice(i, i + 100));
    if (error) throw error;
  }
}
