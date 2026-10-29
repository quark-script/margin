import { useEffect, useRef } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "./store/auth";
import { usePages } from "./store/pages";
import { AppShell } from "./components/AppShell";
import { AccountDeleted, Login, SetPassword } from "./pages/Login";
import { Home } from "./pages/Home";
import { PageView } from "./pages/PageView";
import { PublicPage, TokenRedirect } from "./pages/SharedView";
import { Landing } from "./pages/Landing";
import { Privacy } from "./pages/Privacy";
import { Agents } from "./pages/Agents";
import { OAuthConsent } from "./pages/OAuthConsent";
import { Settings } from "./pages/Settings";
import { authLinkErrorCode } from "./lib/supabase";
import { takeNext } from "./lib/next";
import { reloadIfUpdateReady } from "./lib/update";

let reopenedLastPage = false;

/** On app launch, reopen the page you were on last time, like Notion does. */
function HomeRoute() {
  const loaded = usePages((s) => s.loaded);
  const navigate = useNavigate();
  useEffect(() => {
    if (!loaded || reopenedLastPage) return;
    reopenedLastPage = true;
    try {
      const last = localStorage.getItem("lastPage");
      const p = last ? usePages.getState().pages[last] : undefined;
      if (p && !p.is_archived) navigate(`/p/${p.id}`, { replace: true });
    } catch {
      /* ignore */
    }
  }, [loaded, navigate]);
  return <Home />;
}

/** Moving to another page is a safe moment to switch to a newly installed version. */
function UpdateOnNavigate() {
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else reloadIfUpdateReady();
  }, [pathname]);
  return null;
}

/** Invited pages briefly lived under /shared/; they use the page's own link now. */
function SharedRedirect() {
  const { rootId = "", pageId } = useParams();
  return <Navigate to={`/p/${pageId ?? rootId}`} replace />;
}

const isInstalled = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

export default function App() {
  const session = useAuth((s) => s.session);
  const ready = useAuth((s) => s.ready);
  const recovering = useAuth((s) => s.recovering);
  const start = useAuth((s) => s.start);
  const linkFailed = useAuth((s) => s.linkFailed);
  const signedOut = useAuth((s) => s.signedOut);
  const deleted = useAuth((s) => s.deleted);
  const local = useAuth((s) => s.local);

  useEffect(() => start(), [start]);

  // Signed in from "Sign in to edit" or a page link: back to that page. Not in the middle of a
  // password reset: the reload would skip setting the new password.
  useEffect(() => {
    const next = session && !recovering && !location.pathname.startsWith("/s/") ? takeNext() : null;
    if (next && next !== location.pathname) location.replace(next);
  }, [session, recovering]);

  if (!ready) return null;
  if (deleted) return <AccountDeleted />;
  if (session && recovering) return <SetPassword />;

  // Links from before every page had one link (/s/<token>): on to the page, signed in or not.
  if (location.pathname.startsWith("/s/")) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="s/:token/:pageId?" element={<TokenRedirect />} />
        </Routes>
      </BrowserRouter>
    );
  }

  return (
    <BrowserRouter>
      <UpdateOnNavigate />
      {session || local ? (
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<HomeRoute />} />
            <Route path="p/:pageId" element={<PageView />} />
            <Route path="settings" element={<Settings />} />
            <Route path="shared/:rootId/:pageId?" element={<SharedRedirect />} />
          </Route>
          <Route path="privacy" element={<Privacy />} />
          {/* AI agents: the guide, and an app asking to connect. */}
          <Route path="agents" element={<Agents />} />
          <Route path="mcp" element={<Navigate to="/agents" replace />} />
          <Route path="oauth/consent" element={<OAuthConsent />} />
          {/* Without an account: signing in or up moves this device's pages into the account. */}
          {!session && <Route path="login" element={<Login />} />}
          {!session && <Route path="signup" element={<Login key="signup" initialMode="signup" />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      ) : (
        <Routes>
          {/* The installed app, a failed email link and signing out go straight to sign-in. */}
          <Route index element={isInstalled() || authLinkErrorCode || linkFailed || signedOut ? <Login /> : <Landing />} />
          <Route path="signup" element={<Login key="signup" initialMode="signup" />} />
          <Route path="privacy" element={<Privacy />} />
          <Route path="agents" element={<Agents />} />
          <Route path="mcp" element={<Navigate to="/agents" replace />} />
          <Route path="oauth/consent" element={<OAuthConsent />} />
          {/* A page link: the page itself if it's open to anyone with the link, else sign-in. */}
          <Route path="p/:pageId" element={<PublicPage />} />
          <Route path="*" element={<Login />} />
        </Routes>
      )}
    </BrowserRouter>
  );
}
