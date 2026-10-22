import { create } from "zustand";
import type { Session } from "@supabase/supabase-js";
import { emailLink, recoveryInUrl, supabase } from "../lib/supabase";
import { hasPending, usePages } from "./pages";
import { useShares } from "./shares";

type AuthState = {
  session: Session | null;
  ready: boolean;
  /** Signed in through a password-reset link; must set a new password before using the app. */
  recovering: boolean;
  /** True when the password screen was opened from the account menu, so it can be cancelled. */
  changingPassword: boolean;
  /** An email link (confirm, reset, ...) was expired or already used. */
  linkFailed: boolean;
  /** Signed out in this tab: show the sign-in form, not the landing page. */
  signedOut: boolean;
  changePassword: () => void;
  finishRecovery: () => void;
  start: () => () => void;
  /** Resolves false if the user cancelled because unsynced edits would be lost. */
  signOut: () => Promise<boolean>;
};

export const useAuth = create<AuthState>((set) => ({
  session: null,
  ready: false,
  recovering: recoveryInUrl,
  changingPassword: false,
  linkFailed: false,
  signedOut: false,
  changePassword: () => set({ recovering: true, changingPassword: true }),
  finishRecovery: () => set({ recovering: false, changingPassword: false }),

  start() {
    // Verify an email link first, so the sign-in screen doesn't flash before it signs us in.
    const verified = emailLink
      ? supabase.auth.verifyOtp(emailLink).then(({ error }) => {
          if (error) set({ linkFailed: true, recovering: false });
        })
      : Promise.resolve();
    // getSession reads from local storage, so this works offline too.
    void verified.then(() => supabase.auth.getSession()).then(({ data }) => {
      set({ session: data.session, ready: true });
      if (data.session) {
        void usePages.getState().init(data.session.user.id);
        void useShares.getState().load();
      }
    });
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      set({ session, ready: true, ...(event === "PASSWORD_RECOVERY" ? { recovering: true } : {}) });
      if (session) {
        void usePages.getState().init(session.user.id);
        if (event === "SIGNED_IN") void useShares.getState().load();
      }
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
    useShares.getState().reset();
    await supabase.auth.signOut();
    set({ session: null, signedOut: true });
    return true;
  },
}));
