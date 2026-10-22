import { Link } from "react-router-dom";
import { CalendarDays, FileText, Globe, Link2, Search, Upload, WifiOff } from "lucide-react";

const features = [
  { icon: WifiOff, title: "Works offline", text: "Write anywhere. Changes sync when you're back online." },
  { icon: Link2, title: "Linked pages", text: "Type [[ to link a page. Backlinks show what points here." },
  { icon: Globe, title: "Share with a link", text: "View-only or editable, sub-pages included." },
  { icon: CalendarDays, title: "Daily notes", text: "One tap opens today's page." },
  { icon: Upload, title: "Bring your notes", text: "Import from Obsidian. Export to Markdown anytime." },
  { icon: Search, title: "Find anything", text: "Search every title and line in an instant." },
];

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
          <Link to="/login" className="inline-flex h-9 items-center rounded-md px-3 text-[14px] text-muted hover:bg-hover hover:text-ink">
            Sign in
          </Link>
          <Link to="/signup" className="inline-flex h-9 items-center rounded-md bg-ink px-3 text-[14px] font-medium text-paper hover:opacity-90">
            Get started
          </Link>
        </nav>
      </header>

      <main className="mx-auto max-w-[1040px] px-5">
        <section className="mx-auto max-w-[640px] pt-14 pb-12 text-center sm:pt-24">
          <h1 className="text-[40px] leading-[1.08] font-bold tracking-[-0.035em] text-ink sm:text-[56px]">
            A quiet place
            <br />
            for your notes.
          </h1>
          <p className="mx-auto mt-5 max-w-[480px] text-[17px] leading-relaxed text-muted">
            Margin keeps your pages, links and daily notes in one calm space. It works offline and syncs across
            your phone and computer.
          </p>
          <div className="mt-8 flex justify-center gap-2">
            <Link to="/signup" className={primary}>
              Create a free account
            </Link>
            <Link to="/login" className={secondary}>
              Sign in
            </Link>
          </div>
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

        <section className="border-t border-line py-16 text-center">
          <h2 className="text-[24px] font-bold tracking-[-0.02em] text-ink">Start writing in seconds.</h2>
          <p className="mt-2 text-[15px] text-muted">Free. Install it on your phone from the browser.</p>
          <div className="mt-6">
            <Link to="/signup" className={primary}>
              Create a free account
            </Link>
          </div>
        </section>
      </main>

      <footer className="safe-bottom border-t border-line">
        <div className="mx-auto flex max-w-[1040px] items-center justify-between px-5 py-5 text-[13px] text-faint">
          <span>Margin</span>
          <span>© {new Date().getFullYear()}</span>
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
              Call with Riya about the launch. Notes in{" "}
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
