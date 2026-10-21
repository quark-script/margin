export type Block = {
  id?: string;
  type?: string;
  content?: unknown;
  children?: Block[];
  props?: Record<string, unknown>;
};

export type Page = {
  id: string;
  owner_id: string;
  parent_id: string | null;
  title: string;
  icon: string | null;
  content: Block[];
  search_text: string;
  position: number;
  is_favorite: boolean;
  is_archived: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Columns we send to the server. `fts` is generated server-side. */
export const PAGE_COLUMNS =
  "id,owner_id,parent_id,title,icon,content,search_text,position,is_favorite,is_archived,archived_at,created_at,updated_at";
