// A new version of the app has been installed (the service worker takes over straight away),
// but this page still runs the old code. Reload at a moment that can't interrupt typing: while
// the app is in the background, or on the next move to another page.

let ready = false;
let hiddenTimer: ReturnType<typeof setTimeout> | null = null;

function reloadIfHidden() {
  if (!ready || document.visibilityState !== "hidden") return;
  if (hiddenTimer) clearTimeout(hiddenTimer);
  // The page saves pending edits as it's hidden; give that a moment to finish.
  hiddenTimer = setTimeout(() => document.visibilityState === "hidden" && location.reload(), 2000);
}
document.addEventListener("visibilitychange", reloadIfHidden);

export function markUpdateReady() {
  ready = true;
  reloadIfHidden();
}

/** On in-app navigation: switch to the new version now that nobody is mid-sentence. */
export function reloadIfUpdateReady() {
  if (ready) setTimeout(() => location.reload(), 600); // after the 250 ms local save
}

// An old page asking for a file the new version removed (opening the editor for the first time,
// say): reload into the new version instead of failing. At most once a minute, so a real outage
// can't cause a reload loop.
window.addEventListener("vite:preloadError", (event) => {
  try {
    const last = Number(sessionStorage.getItem("margin:reloadedAt") ?? 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem("margin:reloadedAt", String(Date.now()));
  } catch {
    /* storage blocked: reload anyway */
  }
  event.preventDefault();
  location.reload();
});
