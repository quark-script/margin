import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "./store/auth";
import { usePages } from "./store/pages";
import { AppShell } from "./components/AppShell";
import { Login, SetPassword } from "./pages/Login";
import { Home } from "./pages/Home";
import { PageView } from "./pages/PageView";
import { PublicPage, TokenRedirect } from "./pages/SharedView";
import { Landing } from "./pages/Landing";
import { authLinkErrorCode } from "./lib/supabase";
import { takeNext } from "./lib/next";

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

  useEffect(() => start(), [start]);

  // Signed in from "Sign in to edit" or a page link: back to that page. Not in the middle of a
  // password reset: the reload would skip setting the new password.
  useEffect(() => {
    const next = session && !recovering && !location.pathname.startsWith("/s/") ? takeNext() : null;
    if (next && next !== location.pathname) location.replace(next);
  }, [session, recovering]);

  if (!ready) return null;
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
      {session ? (
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<HomeRoute />} />
            <Route path="p/:pageId" element={<PageView />} />
            <Route path="shared/:rootId/:pageId?" element={<SharedRedirect />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      ) : (
        <Routes>
          {/* The installed app, a failed email link and signing out go straight to sign-in. */}
          <Route index element={isInstalled() || authLinkErrorCode || linkFailed || signedOut ? <Login /> : <Landing />} />
          <Route path="signup" element={<Login key="signup" initialMode="signup" />} />
          {/* A page link: the page itself if it's open to anyone with the link, else sign-in. */}
          <Route path="p/:pageId" element={<PublicPage />} />
          <Route path="*" element={<Login />} />
        </Routes>
      )}
    </BrowserRouter>
  );
}
