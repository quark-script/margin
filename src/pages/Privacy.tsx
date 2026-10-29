import { Link } from "react-router-dom";

const CONTACT = "margin@dhanpulse.in";
const UPDATED = "28 October 2026";

/** /privacy, for everyone. Plain and specific about what Margin does with data. */
export function Privacy() {
  return (
    <div className="safe-top min-h-full">
      <header className="mx-auto flex max-w-[720px] items-center justify-between px-5 py-4">
        <Link to="/" className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-ink text-[15px] font-bold text-paper">M</span>
          <span className="text-[16px] font-semibold tracking-[-0.01em]">Margin</span>
        </Link>
      </header>

      <main className="mx-auto max-w-[720px] px-5 pt-8 pb-20 text-[15px] leading-relaxed text-ink/85">
        <h1 className="text-[32px] font-bold tracking-[-0.02em] text-ink">Privacy</h1>
        <p className="mt-2 text-[14px] text-muted">Last updated {UPDATED}</p>

        <p className="mt-6">
          Margin is a notes app made by Vipul Chaudhary. This page explains what it collects, why, and what you can do about
          it. In short: your notes are yours. Without an account they never leave your device; signed in, only what you
          share or choose to sync does. Nothing is sold or used for ads.
        </p>

        <Section title="Without an account">
          <p>
            You can use Margin without an account. Your pages and images are then saved only in your browser, on that
            device: none of it is sent to Margin's servers, and nobody else can see it. Clearing your browser's data
            deletes it, and Settings can delete it all. If you create an account or sign in later, your pages join your
            account, and the rest of this policy applies to what syncs.
          </p>
        </Section>

        <Section title="What Margin collects">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <b>Your account:</b> your email address and password (stored hashed, never readable). If you sign in with Google,
              Margin receives your name, email address and profile photo from Google.
            </li>
            <li>
              <b>Your notes:</b> the pages you write, images you add, and earlier versions of your pages (version history).
            </li>
            <li>
              <b>Sharing:</b> the email addresses you invite to a page, and who edited a shared page and when.
            </li>
            <li>
              <b>Visit counts:</b> Margin counts visits with Vercel Web Analytics: which kind of screen was opened (such as
              the home page, or "a page" without saying which), with the browser, device type and country. It uses no cookies,
              doesn't identify you or follow you to other sites, and never sees page names, page links or your notes. There are
              no advertising trackers.
            </li>
            <li>
              <b>Technical data:</b> the services Margin runs on keep standard logs (such as IP address and browser) for
              security and to keep things running.
            </li>
          </ul>
        </Section>

        <Section title="How it's used">
          <p>Only to run Margin:</p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5">
            <li>signing you in and keeping your notes in sync across your devices;</li>
            <li>showing your name, or the start of your email address, to people you share pages with;</li>
            <li>sending account emails (confirming your address, resetting your password) and invitation emails when someone shares a page with you;</li>
            <li>counting visits, to see which parts of Margin get used.</li>
          </ul>
          <p className="mt-2">Your data is not sold, rented or used for advertising.</p>
        </Section>

        <Section title="Who can see your notes">
          <p>
            Only you, unless you share a page. You can invite people by email, or open a page to anyone with its link. Either
            way the sub-pages inside it are included. You can change or remove sharing at any time from the page's Share menu.
          </p>
        </Section>

        <Section title="Services Margin uses">
          <ul className="list-disc space-y-1.5 pl-5">
            <li><b>Supabase:</b> database, sign-in and file storage.</li>
            <li><b>Vercel:</b> hosting the app and counting visits (Web Analytics).</li>
            <li><b>Resend:</b> sending emails.</li>
            <li><b>Google:</b> only if you choose Sign in with Google.</li>
          </ul>
          <p className="mt-2">
            They process data on Margin's behalf, in the United States and other countries where they operate.
          </p>
        </Section>

        <Section title="On your device">
          <p>
            So that it works offline, Margin keeps a copy of your notes in your browser's storage. Signing out or deleting your
            account removes it from that device. Your other devices remove their copy within about an hour of being online,
            unless they hold edits that never synced. With Sync all pages off for a device (the default when you sign in
            on a new device), only pages you share leave it, plus any page they sit inside, which is stored in your account
            but not shared. Your other pages and their images stay on that device until you turn it on.
          </p>
        </Section>

        <Section title="Keeping and deleting your data">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>Your data is kept while you have an account.</li>
            <li>Version history keeps every version for 30 days, then one version per day.</li>
            <li>You can delete pages at any time (Trash, then Delete forever) and export everything as Markdown from Settings.</li>
            <li>
              You can delete your account in Settings (Delete account). Your pages, images, version history and
              sharing are deleted right away, and this can't be undone. Edits you made to pages other people own stay on their
              pages, without your name.
            </li>
            <li>
              If you can't sign in to do that, email{" "}
              <a href={`mailto:${CONTACT}`} className="text-accent hover:underline">{CONTACT}</a> from the address you signed up
              with. It's done within 30 days.
            </li>
          </ul>
        </Section>

        <Section title="Children">
          <p>Margin is not meant for children under 13.</p>
        </Section>

        <Section title="Changes">
          <p>If this policy changes, this page will be updated and the date at the top will change.</p>
        </Section>

        <Section title="Contact">
          <p>
            Questions or requests:{" "}
            <a href={`mailto:${CONTACT}`} className="text-accent hover:underline">{CONTACT}</a>
          </p>
        </Section>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-[18px] font-semibold text-ink">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}
