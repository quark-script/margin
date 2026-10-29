import { Link } from "react-router-dom";
import { useAuth } from "../store/auth";
import { ArrowRight, Bot, CalendarDays, FileText, Link2, Lock, RefreshCw, Upload, WifiOff } from "lucide-react";

const GITHUB = "https://github.com/quark-script/margin";

const features = [
  { icon: Lock, title: "Private by default", text: "Your notes stay on your device. Nothing leaves it unless you sync or share it." },
  { icon: RefreshCw, title: "Sync if you want", text: "A free account syncs your phone and computer, and lets you share pages." },
  { icon: WifiOff, title: "Works offline", text: "Write anywhere, with or without a connection." },
  { icon: Link2, title: "Linked pages", text: "Type [[ to link a page. Backlinks show what points here." },
  { icon: CalendarDays, title: "Daily notes", text: "One tap opens today's page." },
  { icon: Upload, title: "Bring your notes", text: "Import from Obsidian. Export to Markdown anytime." },
];

/** Privacy first: writing starts on this device, with no account and no sync. */
const startWriting = () => useAuth.getState().startWithoutAccount();

const primary =
  "inline-flex h-10 items-center rounded-md bg-ink px-4 text-[15px] font-medium text-paper hover:opacity-90";
const secondary = "inline-flex h-10 items-center rounded-md px-4 text-[15px] font-medium text-ink hover:bg-hover";

/** The public front page for signed-out visitors. */
export function Landing() {
  return (
    <div className="safe-top min-h-full">
      <header className="mx-auto flex max-w-[1040px] items-center justify-between px-5 py-4">
        <Link to="/" className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-ink text-[15px] font-bold text-paper">
            M
          </span>
          <span className="text-[16px] font-semibold tracking-[-0.01em]">Margin</span>
        </Link>
        <nav className="flex items-center gap-1">
          <a
            href={GITHUB}
            aria-label="Margin on GitHub"
            title="Margin on GitHub"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink"
          >
            <GitHubMark size={18} />
          </a>
          <Link to="/login" className="inline-flex h-9 items-center rounded-md px-3 text-[14px] text-muted hover:bg-hover hover:text-ink">
            Sign in
          </Link>
          <button onClick={startWriting} className="inline-flex h-9 items-center rounded-md bg-ink px-3 text-[14px] font-medium text-paper hover:opacity-90">
            Start writing
          </button>
        </nav>
      </header>

      <main className="mx-auto max-w-[1040px] px-5">
        <section className="mx-auto max-w-[640px] pt-14 pb-12 text-center sm:pt-24">
          <a
            href={GITHUB}
            className="mb-6 inline-flex h-7 items-center gap-1.5 rounded-full border border-line px-3 text-[13px] text-muted hover:bg-hover hover:text-ink"
          >
            <GitHubMark size={13} />
            Open source on GitHub
            <ArrowRight size={13} strokeWidth={1.75} />
          </a>
          <h1 className="text-[40px] leading-[1.08] font-bold tracking-[-0.035em] text-ink sm:text-[56px]">
            A quiet place
            <br />
            for your notes.
          </h1>
          <p className="mx-auto mt-5 max-w-[480px] text-[17px] leading-relaxed text-muted">
            Private by default. Your notes stay on your device and sync only if you want them to.
          </p>
          <div className="mt-8 flex justify-center gap-2">
            <button onClick={startWriting} className={primary}>
              Start writing
            </button>
            <Link to="/login" className={secondary}>
              Sign in
            </Link>
          </div>
          <p className="mt-3 text-[13px] text-faint">Free and open source. No account needed.</p>
        </section>

        <Preview />

        <section className="grid gap-x-10 gap-y-9 py-20 sm:grid-cols-2 lg:grid-cols-3" aria-label="Features">
          {features.map(({ icon: Icon, title, text }) => (
            <div key={title}>
              <Icon size={18} strokeWidth={1.75} className="text-muted" />
              <h2 className="mt-3 text-[15px] font-semibold text-ink">{title}</h2>
              <p className="mt-1 text-[14px] leading-relaxed text-muted">{text}</p>
            </div>
          ))}
        </section>

        <section className="flex flex-col items-center border-t border-line py-14 text-center sm:flex-row sm:gap-5 sm:text-left">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-hover text-muted">
            <Bot size={20} strokeWidth={1.75} />
          </span>
          <div className="mt-3 sm:mt-0">
            <h2 className="text-[15px] font-semibold text-ink">Works with your AI agent</h2>
            <p className="mt-1 text-[14px] text-muted">
              Connect Claude, ChatGPT, Cursor and other apps to find, read and write your notes.{" "}
              <Link to="/agents" className="text-ink underline decoration-faint underline-offset-2 hover:decoration-ink">
                How to connect
              </Link>
            </p>
          </div>
        </section>

        <section className="border-t border-line py-16 text-center">
          <h2 className="text-[24px] font-bold tracking-[-0.02em] text-ink">Start writing in seconds.</h2>
          <p className="mt-2 text-[15px] text-muted">Free and private. Install it on your phone from the browser.</p>
          <div className="mt-6">
            <button onClick={startWriting} className={primary}>
              Start writing
            </button>
          </div>
        </section>
      </main>

      <footer className="safe-bottom border-t border-line">
        <div className="mx-auto flex max-w-[1040px] items-center justify-between px-5 py-5 text-[13px] text-faint">
          <span>Margin</span>
          <span className="flex items-center gap-4">
            <a href={GITHUB} className="hover:text-muted">
              GitHub
            </a>
            <Link to="/privacy" className="hover:text-muted">
              Privacy
            </Link>
            <span>© {new Date().getFullYear()}</span>
          </span>
        </div>
      </footer>
    </div>
  );
}

/** A drawn miniature of the app, so the page needs no screenshot and follows the theme. */
function Preview() {
  const tree = [
    { icon: "🌱", title: "Life", depth: 0 },
    { icon: "📅", title: "Daily notes", depth: 0 },
    { icon: null, title: "2026-10-22", depth: 1, active: true },
    { icon: "🎯", title: "Goals", depth: 0 },
    { icon: "💡", title: "Ideas", depth: 0 },
  ];
  return (
    <div aria-hidden className="mx-auto max-w-[880px] overflow-hidden rounded-xl bg-paper shadow-pop select-none">
      <div className="flex h-9 items-center gap-1.5 border-b border-line px-3.5">
        <span className="h-2.5 w-2.5 rounded-full bg-line" />
        <span className="h-2.5 w-2.5 rounded-full bg-line" />
        <span className="h-2.5 w-2.5 rounded-full bg-line" />
      </div>
      <div className="flex h-[290px] sm:h-[320px]">
        <div className="hidden w-[210px] shrink-0 border-r border-line bg-side p-2 sm:block">
          <div className="flex h-8 items-center gap-2 px-1.5 text-[13px] font-medium text-ink">
            <span className="flex h-5 w-5 items-center justify-center rounded-[5px] bg-ink text-[11px] font-semibold text-paper">
              M
            </span>
            Margin
          </div>
          <div className="mt-2 px-2 pb-1 text-[11px] font-medium text-muted">Pages</div>
          {tree.map((t) => (
            <div
              key={t.title}
              className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] ${t.active ? "bg-press font-medium text-ink" : "text-ink/75"}`}
              style={{ paddingLeft: 8 + t.depth * 14 }}
            >
              <span className="flex w-4 justify-center text-[13px]">
                {t.icon ?? <FileText size={13} strokeWidth={1.75} className="text-faint" />}
              </span>
              {t.title}
            </div>
          ))}
        </div>
        <div className="min-w-0 flex-1 px-6 py-7 text-left sm:px-12 sm:py-9">
          <div className="text-[26px] font-bold tracking-[-0.02em] text-ink">2026-10-22</div>
          <div className="mt-4 space-y-2.5 text-[14px] text-ink/85">
            <p>
              Call with the team about the launch. Notes in{" "}
              <span className="page-link">
                <span className="page-link-icon">💡</span>Ideas
              </span>
              .
            </p>
            <Todo done>Morning run</Todo>
            <Todo done>Review pull requests</Todo>
            <Todo>Plan next week</Todo>
            <p className="text-muted">Felt focused today. Less noise, more writing.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Todo({ done, children }: { done?: boolean; children: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={`flex h-[15px] w-[15px] items-center justify-center rounded-[4px] border ${done ? "border-accent bg-accent text-[10px] text-white" : "border-faint"}`}
      >
        {done ? "✓" : ""}
      </span>
      <span className={done ? "text-muted line-through" : ""}>{children}</span>
    </div>
  );
}

/** GitHub's mark, from Octicons (lucide has no brand icons). */
function GitHubMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}
