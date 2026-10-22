import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./index.css";

// An installed PWA can stay open for days; without these checks it only learns about a new
// version on a cold start. autoUpdate reloads the page once the new version is ready.
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    const check = () => navigator.onLine && void registration.update().catch(() => {});
    setInterval(check, 60 * 60 * 1000);
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && check());
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
