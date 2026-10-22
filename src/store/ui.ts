import { create } from "zustand";

type UiState = {
  sidebarOpen: boolean; // mobile drawer
  sidebarCollapsed: boolean; // desktop
  switcherOpen: boolean;
  trashOpen: boolean;
  moveId: string | null;
  notice: string | null;
  historyId: string | null; // page whose version history is open
  setHistoryId: (id: string | null) => void;
  notify: (msg: string | null) => void;
  expanded: Record<string, boolean>;
  setExpanded: (id: string, v: boolean) => void;
  expandMany: (ids: string[]) => void;
  setSidebarOpen: (v: boolean) => void;
  toggleCollapsed: () => void;
  setSwitcherOpen: (v: boolean) => void;
  setTrashOpen: (v: boolean) => void;
  setMoveId: (id: string | null) => void;
};

const readCollapsed = () => {
  try {
    return localStorage.getItem("sidebarCollapsed") === "1";
  } catch {
    return false;
  }
};

export const useUi = create<UiState>((set, get) => ({
  sidebarOpen: false,
  sidebarCollapsed: readCollapsed(),
  switcherOpen: false,
  trashOpen: false,
  moveId: null,
  notice: null,
  historyId: null,
  setHistoryId: (id) => set({ historyId: id }),
  notify: (msg) => set({ notice: msg }),
  expanded: readExpanded(),
  setExpanded: (id, v) => {
    const expanded = { ...get().expanded };
    if (v) expanded[id] = true;
    else delete expanded[id];
    writeExpanded(expanded);
    set({ expanded });
  },
  expandMany: (ids) => {
    if (ids.every((id) => get().expanded[id])) return;
    const expanded = { ...get().expanded };
    ids.forEach((id) => (expanded[id] = true));
    writeExpanded(expanded);
    set({ expanded });
  },
  setSidebarOpen: (v) => set({ sidebarOpen: v }),
  toggleCollapsed: () => {
    const v = !get().sidebarCollapsed;
    try {
      localStorage.setItem("sidebarCollapsed", v ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ sidebarCollapsed: v });
  },
  setSwitcherOpen: (v) => set({ switcherOpen: v }),
  setTrashOpen: (v) => set({ trashOpen: v }),
  setMoveId: (id) => set({ moveId: id }),
}));


export function readExpanded(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem("expandedPages") || "{}");
  } catch {
    return {};
  }
}
export function writeExpanded(v: Record<string, boolean>) {
  try {
    localStorage.setItem("expandedPages", JSON.stringify(v));
  } catch {
    /* ignore */
  }
}
