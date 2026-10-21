import { childrenOf, isTrashed, usePages } from "../store/pages";

export const DAILY_PARENT_TITLE = "Daily notes";

/** Local date as YYYY-MM-DD: sorts correctly and matches Obsidian's default daily-note names. */
export function todayTitle(d = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Id of today's daily note, creating it (and the "Daily notes" parent) if needed. */
export function openToday(): string {
  const s = usePages.getState();
  const oldestFirst = (a: { created_at: string }, b: { created_at: string }) => a.created_at.localeCompare(b.created_at);

  let parent = childrenOf(s.pages, null)
    .filter((p) => p.title.trim() === DAILY_PARENT_TITLE)
    .sort(oldestFirst)[0]?.id;
  parent ??= s.createPage(null, { title: DAILY_PARENT_TITLE, icon: "📅" });

  const title = todayTitle();
  const pages = usePages.getState().pages;
  const existing = Object.values(pages)
    .filter((p) => p.parent_id === parent && p.title.trim() === title && !isTrashed(pages, p.id))
    .sort(oldestFirst)[0];
  return existing?.id ?? s.createPage(parent, { title });
}
