import { useEffect, useState } from "react";
import { useAuth } from "../store/auth";
import { leavePageOnExit, pagePresence, type Viewer } from "./share";

const CHECK_IN_MS = 10_000; // the server counts you as here for 25 seconds after a check-in

/**
 * Who else has a page shared by invite open: checked in every few seconds while this tab shows
 * it, checked out when it's hidden or left. Its owner also gets who opened it before.
 */
export function usePresence(pageId: string, enabled: boolean) {
  const [people, setPeople] = useState<Viewer[]>([]);
  const [ownerView, setOwnerView] = useState(false);

  useEffect(() => {
    setPeople([]);
    if (!enabled || !pageId) return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const checkIn = () =>
      pagePresence(pageId)
        .then((p) => {
          if (!alive) return;
          setPeople(p?.people ?? []);
          setOwnerView(Boolean(p?.owner_view));
        })
        .catch(() => {});
    const start = () => {
      if (timer) return;
      void checkIn();
      timer = setInterval(checkIn, CHECK_IN_MS);
    };
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      void pagePresence(pageId, false).catch(() => {});
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());
    const onExit = () => {
      const token = useAuth.getState().session?.access_token;
      if (token) leavePageOnExit(pageId, token);
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onExit);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onExit);
      stop();
    };
  }, [pageId, enabled]);

  return { people, ownerView };
}
