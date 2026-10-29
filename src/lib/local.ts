import { delMany, get as idbGet, keys as idbKeys, set as idbSet } from "idb-keyval";

/**
 * Using Margin without an account: the page store runs as user "local", and images are kept in
 * IndexedDB too. Nothing is sent anywhere. Signed in, images of pages that don't sync stay here
 * the same way, and go up to the account's storage once their page syncs.
 */
export const LOCAL_ID = "local";
export const LOCAL_PREFIX = "local-media:";
const FLAG = "margin:local";
const FILE_KEY = "media:local:";

export function localModeSaved() {
  try {
    return localStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

export function saveLocalMode(on: boolean) {
  try {
    if (on) localStorage.setItem(FLAG, "1");
    else localStorage.removeItem(FLAG);
  } catch {
    /* storage blocked: local mode then lasts until the tab closes */
  }
}

/** `remote`: where it was uploaded, once its page synced. */
type Stored = { blob: Blob; name: string; remote?: string };
const idOf = (url: string) => url.slice(LOCAL_PREFIX.length);

/** Keep a file on this device; returns the address pages store for it. */
export async function saveLocalFile(blob: Blob, name: string) {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "bin";
  const id = `${crypto.randomUUID()}.${ext}`;
  await idbSet(FILE_KEY + id, { blob, name } satisfies Stored);
  return LOCAL_PREFIX + id;
}

export const localFile = (url: string) => idbGet<Stored>(FILE_KEY + idOf(url)).then((f) => f ?? null);

const objectUrls = new Map<string, string>();
/** An address the browser can show for a file kept on this device ("" if it's gone). */
export async function localFileUrl(url: string) {
  const id = idOf(url);
  const hit = objectUrls.get(id);
  if (hit) return hit;
  const file = await localFile(url);
  if (!file) return "";
  const objectUrl = URL.createObjectURL(file.blob);
  objectUrls.set(id, objectUrl);
  return objectUrl;
}

/** After uploading: later syncs of pages showing this file use the uploaded copy. */
export async function rememberUpload(url: string, remote: string) {
  const file = await localFile(url);
  if (file) await idbSet(FILE_KEY + idOf(url), { ...file, remote } satisfies Stored);
}

/** Delete the files kept on this device, except these addresses. */
export async function deleteLocalFilesExcept(keep: Set<string>) {
  const ids = (await idbKeys())
    .map((k) => String(k))
    .filter((k) => k.startsWith(FILE_KEY))
    .map((k) => k.slice(FILE_KEY.length))
    .filter((id) => !keep.has(LOCAL_PREFIX + id));
  await delMany(ids.map((id) => FILE_KEY + id));
  for (const id of ids) {
    const objectUrl = objectUrls.get(id);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrls.delete(id);
  }
}
