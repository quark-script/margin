import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { Analytics } from "@vercel/analytics/react";
import App from "./App";
import { markUpdateReady } from "./lib/update";
import { redactUrl } from "./lib/analytics";
import "./index.css";

// An installed PWA can stay open for days; without these checks it only learns about a new
// version on a cold start. When one is ready, lib/update picks a safe moment to reload.
registerSW({
  immediate: true,
  onNeedReload: markUpdateReady,
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    let lastCheck = 0;
    const check = () => {
      if (!navigator.onLine || Date.now() - lastCheck < 30_000) return;
      lastCheck = Date.now();
      void registration.update().catch(() => {});
    };
    setInterval(check, 10 * 60 * 1000);
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && check());
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <Analytics beforeSend={redactUrl} />
  </StrictMode>,
);
