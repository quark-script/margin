import { create } from "zustand";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { usePages } from "./pages";

type AuthState = {
  session: Session | null;
  ready: boolean;
  start: () => () => void;
  signOut: () => Promise<void>;
};

export const useAuth = create<AuthState>((set) => ({
  session: null,
  ready: false,

  start() {
    // getSession reads from local storage, so this works offline too.
    void supabase.auth.getSession().then(({ data }) => {
      set({ session: data.session, ready: true });
      if (data.session) void usePages.getState().init(data.session.user.id);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      set({ session, ready: true });
      if (session) void usePages.getState().init(session.user.id);
    });
    return () => data.subscription.unsubscribe();
  },

  async signOut() {
    await usePages.getState().sync();
    await usePages.getState().reset();
    await supabase.auth.signOut();
    set({ session: null });
  },
}));
