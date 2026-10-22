import { useEffect, useRef } from "react";

/** Cloudflare Turnstile site key. Unset = no CAPTCHA (and Supabase must not require one). */
export const CAPTCHA_SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) || "";

type Turnstile = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let scriptLoad: Promise<void> | null = null;
function loadScript() {
  scriptLoad ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptLoad = null;
      reject(new Error("captcha script failed"));
    };
    document.head.appendChild(s);
  });
  return scriptLoad;
}

/**
 * Bot check for sign-up, sign-in and password reset. Tokens are single use, so the parent
 * bumps `resetKey` after each submit to get a fresh one.
 */
export function Captcha({ onToken, resetKey, dark }: { onToken: (t: string | null) => void; resetKey: number; dark: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const id = useRef<string | null>(null);
  const cb = useRef(onToken);
  cb.current = onToken;

  useEffect(() => {
    if (!CAPTCHA_SITE_KEY) return;
    let cancelled = false;
    void loadScript().then(() => {
      if (cancelled || !el.current || !window.turnstile) return;
      id.current = window.turnstile.render(el.current, {
        sitekey: CAPTCHA_SITE_KEY,
        theme: dark ? "dark" : "light",
        appearance: "interaction-only",
        callback: (t: string) => cb.current(t),
        "expired-callback": () => cb.current(null),
        "error-callback": () => cb.current(null),
      });
    });
    return () => {
      cancelled = true;
      if (id.current && window.turnstile) window.turnstile.remove(id.current);
      id.current = null;
    };
  }, [dark]);

  useEffect(() => {
    if (resetKey && id.current && window.turnstile) {
      cb.current(null);
      window.turnstile.reset(id.current);
    }
  }, [resetKey]);

  if (!CAPTCHA_SITE_KEY) return null;
  return <div ref={el} className="min-h-0" />;
}
