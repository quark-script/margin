import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Check } from "lucide-react";
import type { OAuthAuthorizationDetails } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { rememberNext } from "../lib/next";
import { useAuth } from "../store/auth";
import { hasPending, usePages } from "../store/pages";
import { Shell } from "./Login";

const primary = "h-10 w-full rounded-md bg-ink text-[15px] font-medium text-paper hover:opacity-90 disabled:opacity-50";
const secondary = "h-10 w-full rounded-md text-[15px] text-ink ring-1 ring-line ring-inset hover:bg-hover disabled:opacity-50";
const EXPIRED = "This request has expired or was already used. Start connecting again from your AI app.";

/**
 * /oauth/consent: an AI app (an MCP client) asks to use your Margin account. Supabase Auth's
 * OAuth server sends people here with an authorization_id; they sign in if needed, then allow
 * or cancel, and go back to the app.
 */
export function OAuthConsent() {
  const session = useAuth((s) => s.session);
  const local = useAuth((s) => s.local);
  const id = new URLSearchParams(window.location.search).get("authorization_id") ?? "";

  if (!/^[\w-]+$/.test(id)) {
    return (
      <Shell title="This link isn't complete" subtitle="Start connecting again from your AI app.">
        <HomeLink />
      </Shell>
    );
  }
  if (!session) return <SignInFirst here={`/oauth/consent?authorization_id=${id}`} local={local} />;
  return <Decide key={session.user.id} id={id} email={session.user.email ?? ""} />;
}

function SignInFirst({ here, local }: { here: string; local: boolean }) {
  const navigate = useNavigate();
  const go = (path: string) => {
    rememberNext(here);
    navigate(`${path}?next=${encodeURIComponent(here)}`);
  };
  return (
    <Shell
      title="Connect an AI app to Margin"
      subtitle={
        local
          ? "Connecting an app needs a free Margin account, so it can reach your pages."
          : "Sign in to choose whether it can use your Margin account."
      }
    >
      {local && (
        <p className="mt-4 rounded-md bg-hover px-3 py-2 text-[13px] text-ink">
          The pages on this device go into your account and sync, so the app can read them.
        </p>
      )}
      <div className="mt-6 flex flex-col gap-2">
        <button className={primary} onClick={() => go(local ? "/signup" : "/login")}>
          {local ? "Create an account" : "Sign in"}
        </button>
        <button className={secondary} onClick={() => go(local ? "/login" : "/signup")}>
          {local ? "Sign in" : "Create an account"}
        </button>
      </div>
    </Shell>
  );
}

function Decide({ id, email }: { id: string; email: string }) {
  const [details, setDetails] = useState<OAuthAuthorizationDetails | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "syncing" | "working" | "leaving" | "failed">("loading");
  const [error, setError] = useState(EXPIRED);
  const [logoFailed, setLogoFailed] = useState(false);
  // "Sync all pages" off on this device: the app would reach only shared pages, and pages it writes
  // wouldn't show here. Offer to turn it on; asked once, so the choice stays put while it syncs.
  const syncOff = usePages((s) => s.loaded && !s.syncOn);
  const [askSync, setAskSync] = useState(false);
  const [syncAll, setSyncAll] = useState(true);
  useEffect(() => {
    if (syncOff) setAskSync(true);
  }, [syncOff]);

  useEffect(() => {
    let alive = true;
    void supabase.auth.oauth.getAuthorizationDetails(id).then(({ data, error }) => {
      if (!alive) return;
      if (error || !data) return setState("failed");
      if ("authorization_id" in data) {
        setDetails(data);
        setState("ready");
      } else {
        // Allowed before: straight back to the app.
        setState("leaving");
        window.location.assign(data.redirect_url);
      }
    });
    return () => {
      alive = false;
    };
  }, [id]);

  const decide = async (allow: boolean) => {
    if (allow && askSync && syncAll && !usePages.getState().syncOn) {
      setState("syncing");
      usePages.getState().setSyncOn(true);
      // This device's pages go into the account before the app looks for them. Whatever is still
      // uploading after half a minute (big images, a slow connection) finishes when Margin next opens here.
      // A sync already running when it was switched on doesn't take them, so allow another round.
      const until = Date.now() + 30_000;
      for (let round = 0; round < 3 && Date.now() < until; round++) {
        await Promise.race([usePages.getState().sync(), new Promise((r) => setTimeout(r, until - Date.now()))]);
        if (!hasPending() || ["error", "offline"].includes(usePages.getState().status)) break;
      }
    }
    setState("working");
    const opts = { skipBrowserRedirect: true };
    const { data, error } = allow
      ? await supabase.auth.oauth.approveAuthorization(id, opts)
      : await supabase.auth.oauth.denyAuthorization(id, opts);
    if (error || !data?.redirect_url) {
      setError(navigator.onLine ? "Couldn't finish connecting. Start again from your AI app." : "You're offline. Connect again when you're back online.");
      return setState("failed");
    }
    setState("leaving");
    window.location.assign(data.redirect_url);
  };

  const switchAccount = async () => {
    await useAuth.getState().signOut();
  };

  if (state === "loading") return <Shell title="Connecting an AI app" subtitle="Checking the request…" />;
  if (state === "failed") {
    return (
      <Shell title="That didn't work" subtitle={error}>
        <HomeLink />
      </Shell>
    );
  }
  const name = details?.client.name?.trim() || "An AI app";
  if (state === "leaving") return <Shell title={`Returning to ${name}`} subtitle="You can close this tab if it doesn't go back by itself." />;

  const back = returnTo(details!.redirect_uri);
  const logo = details!.client.logo_uri && !logoFailed ? details!.client.logo_uri : null;
  const busy = state === "syncing" || state === "working";
  return (
    <Shell title={`Connect ${name} to Margin`} subtitle={`${name} wants to use your Margin account, ${email}.`}>
      <div className="mt-6 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-[10px] bg-hover text-[18px] font-semibold text-ink">
          {logo ? (
            <img src={logo} alt="" referrerPolicy="no-referrer" onError={() => setLogoFailed(true)} className="h-full w-full object-cover" />
          ) : (
            name.charAt(0).toUpperCase()
          )}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[15px] font-medium text-ink">{name}</p>
          {details!.client.uri && <p className="truncate text-[12px] text-muted">{hostOf(details!.client.uri)}</p>}
        </div>
      </div>

      <div className="mt-5 rounded-lg px-4 py-3 ring-1 ring-line ring-inset">
        <p className="text-[13px] font-medium text-ink">It will be able to:</p>
        <ul className="mt-2 space-y-1.5 text-[14px] text-ink">
          <li className="flex gap-2">
            <Check size={16} className="mt-0.5 shrink-0 text-muted" /> Search and read your pages
          </li>
          <li className="flex gap-2">
            <Check size={16} className="mt-0.5 shrink-0 text-muted" /> Create pages, and add to or change them
          </li>
        </ul>
        <p className="mt-3 text-[12px] leading-relaxed text-muted">
          It reaches the pages in your Margin account. Its changes show in each page's version history, marked with its name.
          What it reads goes to the company behind it.
        </p>
      </div>

      {askSync && (
        <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-lg px-4 py-3 ring-1 ring-line ring-inset">
          <input
            type="checkbox"
            checked={syncAll}
            disabled={busy}
            onChange={(e) => setSyncAll(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-ink"
          />
          <span className="min-w-0">
            <span className="block text-[14px] text-ink">Also sync all pages on this device</span>
            <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">
              Sync all pages is off here, so {name} would only reach pages you share, and pages it writes wouldn't show up
              here.
            </span>
          </span>
        </label>
      )}

      <div className="mt-6 flex flex-col gap-2">
        <button className={primary} disabled={busy} onClick={() => void decide(true)}>
          {state === "syncing" ? "Syncing your pages…" : state === "working" ? "Connecting…" : "Allow"}
        </button>
        <button className={secondary} disabled={busy} onClick={() => void decide(false)}>
          Cancel
        </button>
      </div>
      <p className="mt-4 text-[12px] leading-relaxed text-muted">
        Afterwards you go back to {back}. You can disconnect {name} any time in Settings.{" "}
        <button onClick={() => void switchAccount()} className="text-ink underline decoration-faint underline-offset-2 hover:decoration-ink">
          Use another account
        </button>
      </p>
    </Shell>
  );
}

function HomeLink() {
  return (
    <Link to="/" className="mt-6 inline-block text-[14px] text-accent hover:underline">
      Go to Margin
    </Link>
  );
}

const hostOf = (uri: string) => {
  try {
    return new URL(uri).host || uri;
  } catch {
    return uri;
  }
};

/** Where the app takes people back to: its website, or "the app" for desktop and editor apps. */
function returnTo(uri: string) {
  try {
    const u = new URL(uri);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return u.hostname === "localhost" || u.hostname === "127.0.0.1" ? "the app on this computer" : u.host;
    }
  } catch {
    /* not a URL */
  }
  return "the app";
}
