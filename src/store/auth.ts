import { create } from "zustand";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { hasPending, usePages } from "./pages";

type AuthState = {
  session: Session | null;
  ready: boolean;
  start: () => () => void;
  /** Resolves false if the user cancelled because unsynced edits would be lost. */
  signOut: () => Promise<boolean>;
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
    // reset() wipes this device's copy, so anything not yet on the server would be gone for good.
    if (
      hasPending() &&
      !window.confirm("Some changes haven't synced yet and will be lost if you sign out now. Sign out anyway?")
    ) {
      return false;
    }
    await usePages.getState().reset();
    await supabase.auth.signOut();
    set({ session: null });
    return true;
  },
}));
