import { useCallback, useEffect, useRef, useState } from "react";
import { editorId, lockPage, unlockPage, unlockPageOnExit } from "./share";

const RENEW_MS = 10_000; // server expires a lock 30s after the last renewal
const IDLE_MS = 90_000; // stop holding the page this long after the last keystroke
const BLUR_GRACE_MS = 15_000; // toolbar clicks and menus blur the editor briefly

/**
 * One editor per page. Take the lock when the editor gets focus, keep renewing it while
 * typing, give it up when idle or after leaving the editor. `holder` is who the server
 * says holds the lock (polled by the caller); null = free.
 */
export function useEditLock(pageId: string, token: string | null, enabled: boolean, holder: string | null) {
  const [mine, setMine] = useState(false);
  const [denied, setDenied] = useState(false);
  const lastActivity = useRef(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mineRef = useRef(false);
  mineRef.current = mine;

  const release = useCallback(() => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    if (!mineRef.current) return;
    setMine(false);
    void unlockPage(pageId);
  }, [pageId]);

  const acquire = useCallback(async () => {
    if (!enabled) return true;
    if (blurTimer.current) clearTimeout(blurTimer.current);
    lastActivity.current = Date.now();
    if (mineRef.current) return true;
    try {
      const { ok } = await lockPage(pageId, token);
      setMine(ok);
      setDenied(!ok);
      return ok;
    } catch {
      return true; // offline or server hiccup: don't block the owner's own editing
    }
  }, [enabled, pageId, token]);

  const activity = useCallback(() => {
    lastActivity.current = Date.now();
  }, []);

  const blurred = useCallback(() => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(release, BLUR_GRACE_MS);
  }, [release]);

  // Renew while active; let go when idle.
  useEffect(() => {
    if (!enabled || !mine) return;
    const t = setInterval(() => {
      if (Date.now() - lastActivity.current > IDLE_MS) release();
      else void lockPage(pageId, token).then((r) => !r.ok && (setMine(false), setDenied(true))).catch(() => {});
    }, RENEW_MS);
    return () => clearInterval(t);
  }, [enabled, mine, pageId, token, release]);

  // Leaving the page or closing the tab frees it for others.
  useEffect(() => {
    const onHide = () => mineRef.current && unlockPageOnExit(pageId);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      release();
    };
  }, [pageId, release]);

  const heldByOther = enabled && !mine && ((holder !== null && holder !== editorId) || denied);
  // A stale "denied" clears once the server reports the page free again.
  useEffect(() => {
    if (holder === null && denied) setDenied(false);
  }, [holder, denied]);

  return { heldByOther, holding: mine, acquire, activity, blurred, release };
}
