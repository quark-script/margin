import { create } from "zustand";

export type ThemePref = "light" | "dark" | "system";

const media = () => window.matchMedia("(prefers-color-scheme: dark)");

function apply(pref: ThemePref) {
  const dark = pref === "dark" || (pref === "system" && media().matches);
  document.documentElement.classList.toggle("dark", dark);
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((m) => m.setAttribute("content", dark ? "#191919" : "#FBFBFA"));
  return dark;
}

function readPref(): ThemePref {
  try {
    const t = localStorage.getItem("theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

type ThemeState = { pref: ThemePref; isDark: boolean; setPref: (p: ThemePref) => void };

export const useTheme = create<ThemeState>((set, get) => {
  const initial = readPref();
  media().addEventListener("change", () => {
    if (get().pref === "system") set({ isDark: apply("system") });
  });
  return {
    pref: initial,
    isDark: apply(initial),
    setPref(p) {
      try {
        if (p === "system") localStorage.removeItem("theme");
        else localStorage.setItem("theme", p);
      } catch {
        /* storage blocked: the theme still applies for this session */
      }
      set({ pref: p, isDark: apply(p) });
    },
  };
});
