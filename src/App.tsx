import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { useAuth } from "./store/auth";
import { usePages } from "./store/pages";
import { AppShell } from "./components/AppShell";
import { Login } from "./pages/Login";
import { Home } from "./pages/Home";
import { PageView } from "./pages/PageView";

let reopenedLastPage = false;

/** On app launch, reopen the page you were on last time — like Notion does. */
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

export default function App() {
  const session = useAuth((s) => s.session);
  const ready = useAuth((s) => s.ready);
  const start = useAuth((s) => s.start);

  useEffect(() => start(), [start]);

  if (!ready) return null;

  return (
    <BrowserRouter>
      {session ? (
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<HomeRoute />} />
            <Route path="p/:pageId" element={<PageView />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      ) : (
        <Routes>
          <Route path="*" element={<Login />} />
        </Routes>
      )}
    </BrowserRouter>
  );
}
