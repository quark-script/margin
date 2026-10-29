import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check, Copy } from "lucide-react";

/** The address agents connect to: this site's /mcp. */
export const mcpUrl = () => `${window.location.origin}/mcp`;

/** Copy text, with a short "Copied" in place of the label. */
export function CopyButton({ text, label = "Copy", className = "" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked: the text is on screen to select */
    }
  };
  return (
    <button
      onClick={() => void copy()}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-ink ring-1 ring-line ring-inset hover:bg-hover ${className}`}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "Copied" : label}
    </button>
  );
}

function Code({ children }: { children: string }) {
  return (
    <div className="mt-2 flex items-start gap-2 rounded-md bg-hover px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[13px] leading-relaxed text-ink">{children}</code>
      <CopyButton text={children} className="bg-paper" />
    </div>
  );
}

const Steps = ({ children }: { children: ReactNode }) => <ol className="mt-2 list-decimal space-y-1.5 pl-5">{children}</ol>;
const Note = ({ children }: { children: ReactNode }) => <p className="mt-3 text-[13px] text-muted">{children}</p>;
const B = ({ children }: { children: ReactNode }) => <b className="font-medium text-ink">{children}</b>;

type App = { id: string; name: string; body: (url: string) => ReactNode };

const APPS: App[] = [
  {
    id: "claude",
    name: "Claude",
    body: (url) => (
      <>
        <p>On claude.ai, and in the Claude desktop and mobile apps:</p>
        <Steps>
          <li>
            Open <B>Settings</B>, then <B>Connectors</B>.
          </li>
          <li>
            Choose <B>Add custom connector</B>, name it Margin and paste <span className="break-all">{url}</span>.
          </li>
          <li>
            Choose <B>Connect</B>, sign in to Margin if asked, and choose <B>Allow</B>.
          </li>
          <li>In a chat, make sure Margin is turned on in the tools menu, then ask away.</li>
        </Steps>
        <Note>Custom connectors may need a paid Claude plan. On Team and Enterprise plans, an owner adds them for everyone.</Note>
      </>
    ),
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    body: (url) => (
      <>
        <Steps>
          <li>
            In ChatGPT, open <B>Settings</B>, then <B>Apps &amp; Connectors</B>, and turn on <B>Developer mode</B> under
            Advanced settings.
          </li>
          <li>
            Choose <B>Create</B>, name it Margin, paste <span className="break-all">{url}</span> and pick <B>OAuth</B> for
            authentication.
          </li>
          <li>
            Sign in to Margin if asked and choose <B>Allow</B>. In a chat, add Margin from the tools menu.
          </li>
        </Steps>
        <Note>ChatGPT moves these menus around from time to time; look for Connectors or Apps in Settings.</Note>
      </>
    ),
  },
  {
    id: "claude-code",
    name: "Claude Code",
    body: (url) => (
      <>
        <p>In a terminal:</p>
        <Code>{`claude mcp add --transport http margin ${url}`}</Code>
        <p className="mt-3">
          Then in Claude Code run <code className="font-mono text-[13px]">/mcp</code>, pick <B>margin</B> and choose{" "}
          <B>Authenticate</B>. Your browser opens Margin; choose <B>Allow</B>.
        </p>
      </>
    ),
  },
  {
    id: "cursor",
    name: "Cursor",
    body: (url) => (
      <>
        <a
          href={`cursor://anysphere.cursor-deeplink/mcp/install?name=margin&config=${btoa(JSON.stringify({ url }))}`}
          className="mt-1 inline-flex h-9 items-center rounded-md bg-ink px-3.5 text-[14px] font-medium text-paper hover:opacity-90"
        >
          Add to Cursor
        </a>
        <p className="mt-3">
          Or add this to <code className="font-mono text-[13px]">~/.cursor/mcp.json</code>:
        </p>
        <Code>{JSON.stringify({ mcpServers: { margin: { url } } }, null, 2)}</Code>
        <Note>Cursor then shows Margin under Settings, MCP. Choose Login (or Connect) there and allow it in Margin.</Note>
      </>
    ),
  },
  {
    id: "vscode",
    name: "VS Code",
    body: (url) => (
      <>
        <a
          href={`vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "margin", type: "http", url }))}`}
          className="mt-1 inline-flex h-9 items-center rounded-md bg-ink px-3.5 text-[14px] font-medium text-paper hover:opacity-90"
        >
          Install in VS Code
        </a>
        <p className="mt-3">
          Or add this to <code className="font-mono text-[13px]">.vscode/mcp.json</code> in a project:
        </p>
        <Code>{JSON.stringify({ servers: { margin: { type: "http", url } } }, null, 2)}</Code>
        <Note>VS Code asks you to sign in the first time Copilot uses Margin. Choose Allow in Margin.</Note>
      </>
    ),
  },
  {
    id: "other",
    name: "Other apps",
    body: (url) => (
      <>
        <p>
          Any app that supports remote MCP servers works. Give it <span className="break-all">{url}</span>. Margin signs you in
          with OAuth, and the app registers itself, so there is no key to copy: when it asks, sign in to Margin and choose{" "}
          <B>Allow</B>.
        </p>
      </>
    ),
  },
];

/** /agents, for everyone: how to use Margin from an AI agent, and what that means. */
export function Agents() {
  const url = mcpUrl();
  const [tab, setTab] = useState(APPS[0].id);
  const app = APPS.find((a) => a.id === tab) ?? APPS[0];

  return (
    <div className="safe-top min-h-full">
      <header className="mx-auto flex max-w-[720px] items-center justify-between px-5 py-4">
        <Link to="/" className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-ink text-[15px] font-bold text-paper">M</span>
          <span className="text-[16px] font-semibold tracking-[-0.01em]">Margin</span>
        </Link>
      </header>

      <main className="mx-auto max-w-[720px] px-5 pt-8 pb-20 text-[15px] leading-relaxed text-ink/85">
        <h1 className="text-[32px] font-bold tracking-[-0.02em] text-ink">Use Margin with AI agents</h1>
        <p className="mt-3">
          Connect Claude, ChatGPT, Cursor or any app that supports MCP (Model Context Protocol), and ask it to find, read and
          write your notes.
        </p>

        <section className="mt-6 rounded-lg px-4 py-3 ring-1 ring-line ring-inset" aria-label="Server address">
          <p className="text-[13px] font-medium text-muted">Margin's address for AI apps</p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[15px] text-ink">{url}</code>
            <CopyButton text={url} />
          </div>
          <p className="mt-2 text-[13px] text-muted">When your app asks, sign in to Margin and choose Allow. There's no key to copy.</p>
        </section>

        <Section title="Connect your app">
          <div role="tablist" aria-label="Apps" className="-mx-1 flex flex-wrap gap-1">
            {APPS.map((a) => (
              <button
                key={a.id}
                role="tab"
                aria-selected={a.id === tab}
                onClick={() => setTab(a.id)}
                className={`h-8 rounded-md px-3 text-[14px] ${a.id === tab ? "bg-ink font-medium text-paper" : "text-ink hover:bg-hover"}`}
              >
                {a.name}
              </button>
            ))}
          </div>
          <div role="tabpanel" aria-label={app.name} className="mt-4">
            {app.body(url)}
          </div>
        </Section>

        <Section title="What you can ask">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>"Find my notes about the launch and sum them up."</li>
            <li>"Add 'call the bank' to today's daily note."</li>
            <li>"Create a page called Trip plan inside Travel, with a packing list."</li>
            <li>"Turn yesterday's meeting notes into a to-do list on the same page."</li>
          </ul>
        </Section>

        <Section title="What it can do">
          <p>
            Search your pages, see what you edited recently, browse pages inside pages, read a page, create pages, add to a page,
            change a page's title, icon or content, and read or add to a daily note. It can't delete pages or change sharing.
          </p>
          <p className="mt-2">
            Every change it makes shows in that page's version history, marked with the app's name, so you can see exactly what
            changed and restore an earlier version.
          </p>
        </Section>

        <Section title="What it can see">
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              The pages in your Margin account. On a device with <B>Sync all pages</B> off, pages that exist only there stay
              out of reach. To give an agent all your pages, turn Sync all pages on in Settings, on the device that has them.
            </li>
            <li>Not pages other people shared with you.</li>
            <li>
              What an agent reads goes to the company that runs it (such as Anthropic for Claude or OpenAI for ChatGPT), under
              their terms. Connect only apps you trust.
            </li>
          </ul>
        </Section>

        <Section title="Limits">
          <p>
            Agents can make up to 30 changes a minute and 500 a day, and read up to 120 times a minute and 3,000 times a day,
            for each account. That's plenty for normal use, and it stops a runaway agent from flooding your notes.
          </p>
        </Section>

        <Section title="Disconnect">
          <p>
            In Margin, open <B>Settings</B> and choose <B>Disconnect</B> next to the app under AI agents. Or remove the
            connector in the app itself.
          </p>
        </Section>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-[18px] font-semibold text-ink">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}
