import { createContext } from "react";

export type LinkTarget = { title: string; icon: string | null; href: string } | null;

/**
 * Where page links point. The signed-in app resolves them from the local store (the default);
 * a shared page supplies its own resolver so links stay inside the share and links to pages
 * outside it don't reveal their titles. Kept apart from PageLink so importing it doesn't pull
 * the editor into the main bundle.
 */
export const PageLinkContext = createContext<((pageId: string) => LinkTarget) | null>(null);
