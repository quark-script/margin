import type { BeforeSendEvent } from "@vercel/analytics/react";

/**
 * Vercel Web Analytics only learns which kind of screen was opened. Page and share links are
 * reduced to their route, so no page id or link token is sent, and query strings and fragments
 * (sign-in tokens, the email address in invitation links) never leave the browser.
 */
export function redactUrl(event: BeforeSendEvent): BeforeSendEvent {
  const url = new URL(event.url);
  const path = url.pathname
    .replace(/^\/p\/[^/]+\/?$/, "/p/[page]")
    .replace(/^\/s\/.+$/, "/s/[link]")
    .replace(/^\/shared\/.+$/, "/shared/[page]");
  return { ...event, url: `${url.origin}${path}` };
}
