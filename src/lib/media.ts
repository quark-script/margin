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
