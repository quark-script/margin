import { create } from "zustand";
import type { Session } from "@supabase/supabase-js";
import { emailLink, recoveryInUrl, supabase } from "../lib/supabase";
import { deleteAllLocalFiles, LOCAL_ID, localModeSaved, saveLocalMode } from "../lib/local";
import { dropSignedOutCopies, hasPending, usePages } from "./pages";
import { useShares } from "./shares";
import { useUi } from "./ui";

type AuthState = {
  session: Session | null;
  ready: boolean;
  /** Signed in through a password-reset link; must set a new password before using the app. */
  recovering: boolean;
  /** True when the password screen was opened from Settings, so it can be cancelled. */
  changingPassword: boolean;
  /** An email link (confirm, reset, ...) was expired or already used. */
  linkFailed: boolean;
  /** Signed out in this tab: show the sign-in form, not the landing page. */
  signedOut: boolean;
  /** Just deleted the account here. */
  deleted: boolean;
  /** Using Margin without an account: pages stay on this device. */
  local: boolean;
  /** Start using Margin without an account. */
  startWithoutAccount: () => void;
  /** Without an account: delete everything on this device and go back to the start. */
  deleteLocal: () => Promise<void>;
  changePassword: () => void;
  finishRecovery: () => void;
  start: () => () => void;
  /** Resolves false if the user cancelled because unsynced edits would be lost. */
  signOut: () => Promise<boolean>;
  /** After the server deleted the account: wipe this device's copy and sign out here. */
  finishDeletion: () => Promise<void>;
};

let adopting: Promise<void> | null = null;

/**
 * Signed in after using Margin without an account: the pages on this device go into the
 * account. Waits for the account's own pages to load first.
 */
function adoptLocalPages(uid: string) {
  // Startup reports the session twice, and another tab (the one an email link opened) may be
  // doing it too: move the pages once.
  if (!localModeSaved() || adopting) return adopting;
  const run = () => (localModeSaved() ? adopt(uid) : Promise.resolve());
  adopting = (navigator.locks ? navigator.locks.request("margin:adopt-local", run) : run()).finally(() => (adopting = null));
  return adopting;
}

async function adopt(uid: string) {
  await usePages.getState().init(uid);
  const { pages, failedImages } = await usePages.getState().adoptLocal(uid);
  saveLocalMode(false);
  useAuth.setState({ local: false });
  if (!pages) return;
  const stayed = failedImages ? ` ${failedImages} image${failedImages === 1 ? "" : "s"} couldn't be added and stay on this device only.` : "";
  useUi.getState().notify(`Moved ${pages} page${pages === 1 ? "" : "s"} from this device into your account.${stayed}`);
}

export const useAuth = create<AuthState>((set, get) => ({
  session: null,
  ready: false,
  recovering: recoveryInUrl,
  changingPassword: false,
  linkFailed: false,
  signedOut: false,
  deleted: false,
  local: localModeSaved(),
  changePassword: () => set({ recovering: true, changingPassword: true }),

  startWithoutAccount() {
    saveLocalMode(true);
    set({ local: true, signedOut: false });
    void usePages.getState().init(LOCAL_ID);
  },

  async deleteLocal() {
    if (usePages.getState().userId === LOCAL_ID) await usePages.getState().reset();
    await deleteAllLocalFiles();
    saveLocalMode(false);
    set({ local: false });
  },
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
        void adoptLocalPages(data.session.user.id);
        void useShares.getState().load();
      } else if (get().local) {
        void usePages.getState().init(LOCAL_ID);
      }
    });
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      set({ session, ready: true, ...(event === "PASSWORD_RECOVERY" ? { recovering: true } : {}) });
      if (session) {
        void usePages.getState().init(session.user.id);
        void adoptLocalPages(session.user.id);
        if (event === "SIGNED_IN") void useShares.getState().load();
      } else if (event === "SIGNED_OUT" || event === "INITIAL_SESSION") {
        dropSignedOutCopies().catch(() => {}); // storage can be unavailable (some private windows)
        useShares.getState().reset();
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

  async finishDeletion() {
    // Leave the app first, so nothing on screen reacts to the pages disappearing.
    set({ deleted: true });
    await usePages.getState().reset();
    useShares.getState().reset();
    // The server ended every session with the sign-in; this only clears the one stored here.
    await supabase.auth.signOut({ scope: "local" });
    set({ session: null });
  },
}));
