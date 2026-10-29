import { del as idbDel, delMany, get as idbGet, keys as idbKeys, set as idbSet } from "idb-keyval";

/**
 * Using Margin without an account: the page store runs as user "local", and images are kept in
 * IndexedDB too. Nothing is sent anywhere. Signing in later moves it all into the account.
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

type Stored = { blob: Blob; name: string };
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

export const deleteLocalFile = (url: string) => idbDel(FILE_KEY + idOf(url));

export async function deleteAllLocalFiles() {
  const all = (await idbKeys()).filter((k) => String(k).startsWith(FILE_KEY));
  await delMany(all);
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls.clear();
}
