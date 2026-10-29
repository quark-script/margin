import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Download, Monitor, Moon, Sun, Upload } from "lucide-react";
import { TopBar } from "../components/TopBar";
import { DeleteAccountDialog } from "../components/DeleteAccountDialog";
import { useAuth } from "../store/auth";
import { useIsLocal, usePages } from "../store/pages";
import { useUi } from "../store/ui";
import { useTheme, type ThemePref } from "../lib/theme";
import { supabase } from "../lib/supabase";
import { download } from "../lib/download";
import { deleteFiles, formatBytes, STORAGE_LIMIT_BYTES, storageUsed, unusedFiles } from "../lib/media";

/** Everything as Markdown in a .zip, images included. Also offered before deleting the account. */
export async function exportEverything() {
  const { exportPages } = await import("../lib/markdown");
  const res = await exportPages();
  download(res.blob, res.filename);
  const missing = res.missingImages ? ` ${res.missingImages} image(s) couldn't be downloaded.` : "";
  return `Exported ${res.pages} page${res.pages === 1 ? "" : "s"}.${missing}`;
}

/** /settings: your account, how Margin looks, your data. */
export function Settings() {
  const local = useIsLocal();
  return (
    <div className="flex h-full flex-col">
      <TopBar crumbs={null} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-5 pb-24 pt-10 sm:px-14 sm:pt-16">
          <h1 className="page-title text-ink">Settings</h1>
          {local ? <ThisDevice /> : <Account />}
          {!local && <Sync />}
          <Appearance />
          {!local && <Storage />}
          <Data />
          {local ? <DeleteLocal /> : <Danger />}
        </div>
      </div>
    </div>
  );
}

/** Without an account: where the pages are, and how to get them into one. */
function ThisDevice() {
  const navigate = useNavigate();
  return (
    <Section title="Account">
      <Row
        label="On this device"
        hint="You're using Margin without an account. Your pages are saved in this browser only: other devices can't see them, and clearing this browser's data deletes them."
      />
      <Row label="Sync across devices" hint="Create an account or sign in: the pages on this device move into it.">
        <button className={button} onClick={() => navigate("/login")}>
          Sign in
        </button>
        <button className={`${button} bg-ink text-paper ring-0 hover:bg-ink hover:opacity-90`} onClick={() => navigate("/signup")}>
          Create an account
        </button>
      </Row>
    </Section>
  );
}

function Sync() {
  const syncOn = usePages((s) => s.syncOn);
  const waiting = usePages((s) => Object.keys(s.dirty).length + Object.keys(s.deletions).length);
  const setSyncOn = usePages((s) => s.setSyncOn);
  return (
    <Section title="Sync">
      <Row
        label="Sync this device"
        hint={
          syncOn
            ? "Your pages stay up to date with your account and your other devices."
            : `Off: changes stay on this device until you turn it back on, and changes from your other devices don't arrive.${waiting ? ` ${waiting} change${waiting === 1 ? "" : "s"} waiting.` : ""}`
        }
      >
        <button
          role="switch"
          aria-checked={syncOn}
          aria-label="Sync this device"
          onClick={() => setSyncOn(!syncOn)}
          className="flex items-center rounded-md p-1 hover:bg-hover"
        >
          <span className={`switch ${syncOn ? "on" : ""}`} aria-hidden="true" />
        </button>
      </Row>
    </Section>
  );
}

function DeleteLocal() {
  const navigate = useNavigate();
  const remove = async () => {
    if (!window.confirm("Delete all pages and images on this device? This can't be undone.")) return;
    await useAuth.getState().deleteLocal();
    navigate("/");
  };
  return (
    <Section title="Delete">
      <Row label="Delete everything on this device" hint="Deletes all your pages and images from this browser. This can't be undone.">
        <button
          onClick={() => void remove()}
          className="h-8 rounded-md px-3 text-[13px] font-medium text-danger ring-1 ring-danger/40 ring-inset hover:bg-danger/10"
        >
          Delete everything
        </button>
      </Row>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10" aria-label={title}>
      <h2 className="border-b border-line pb-2 text-[15px] font-semibold text-ink">{title}</h2>
      <div className="divide-y divide-line">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3.5">
      <div className="min-w-0 flex-1 basis-[260px]">
        <div className="text-[14px] text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-[13px] text-muted">{hint}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

const button = "h-8 rounded-md px-3 text-[13px] font-medium text-ink ring-1 ring-line ring-inset hover:bg-hover disabled:opacity-40";

function Account() {
  const user = useAuth((s) => s.session?.user);
  const signOut = useAuth((s) => s.signOut);
  const changePassword = useAuth((s) => s.changePassword);
  const meta = user?.user_metadata as { full_name?: string; name?: string; avatar_url?: string } | undefined;
  const providers = new Set(user?.identities?.map((i) => i.provider));
  const hasPassword = user?.identities ? providers.has("email") : true;
  const [photoFailed, setPhotoFailed] = useState(false);
  const email = user?.email ?? "";

  return (
    <Section title="Account">
      <div className="flex items-center gap-3 py-4">
        {meta?.avatar_url && !photoFailed ? (
          <img
            src={meta.avatar_url}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setPhotoFailed(true)}
            className="h-11 w-11 shrink-0 rounded-[10px] object-cover"
          />
        ) : (
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-ink text-[18px] font-semibold text-paper">
            {(email[0] ?? "M").toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium text-ink">
            {meta?.full_name?.trim() || meta?.name?.trim() || email.split("@")[0]}
          </div>
          <div className="truncate text-[13px] text-muted">{email}</div>
        </div>
      </div>
      <NameRow />
      <Row
        label="Password"
        hint={hasPassword ? "Sign in with your email and password." : "You sign in with Google. Set a password to also sign in with your email."}
      >
        <button className={button} onClick={changePassword}>
          {hasPassword ? "Change password" : "Set a password"}
        </button>
      </Row>
      <Row label="Google" hint={providers.has("google") ? "Connected. You can sign in with Google." : "Not connected."} />
      <Row label="Sign out" hint="Signs you out on this device. Your pages stay in your account.">
        <button className={button} onClick={() => void signOut()}>
          Sign out
        </button>
      </Row>
    </Section>
  );
}

/** The name people you share pages with see (and invitation emails use). */
function NameRow() {
  const current = useAuth((s) => (s.session?.user.user_metadata?.full_name as string | undefined) ?? "");
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const changed = name.trim() !== current.trim();

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!changed || busy) return;
    if (!navigator.onLine) return setNote("You're offline. Try again when you're back online.");
    setBusy(true);
    setNote(null);
    // An empty name falls back to the start of your email address.
    const { error } = await supabase.auth.updateUser({ data: { full_name: name.trim().slice(0, 60) } });
    setBusy(false);
    setNote(error ? "Couldn't save your name. Try again." : "Saved.");
  };

  return (
    <Row label="Name" hint={note ?? "Shown to people you share pages with."}>
      <form onSubmit={save} className="flex items-center gap-2">
        <input
          type="text"
          autoComplete="name"
          maxLength={60}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNote(null);
          }}
          aria-label="Your name"
          placeholder="Your name"
          className="h-8 w-[200px] rounded-md bg-transparent px-2.5 text-[14px] text-ink outline-none ring-1 ring-line ring-inset placeholder:text-faint focus:ring-2 focus:ring-accent"
        />
        <button type="submit" disabled={!changed || busy} className={button}>
          Save
        </button>
      </form>
    </Row>
  );
}

function Appearance() {
  const { pref, setPref } = useTheme();
  const options: [ThemePref, string, React.ReactNode][] = [
    ["system", "System", <Monitor key="s" size={14} />],
    ["light", "Light", <Sun key="l" size={14} />],
    ["dark", "Dark", <Moon key="d" size={14} />],
  ];
  return (
    <Section title="Appearance">
      <Row label="Theme" hint="System follows your device's light or dark setting.">
        <div role="radiogroup" aria-label="Theme" className="flex rounded-md p-0.5 ring-1 ring-line ring-inset">
          {options.map(([value, label, icon]) => (
            <button
              key={value}
              role="radio"
              aria-checked={pref === value}
              onClick={() => setPref(value)}
              className={`flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-[13px] ${
                pref === value ? "bg-press font-medium text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
      </Row>
    </Section>
  );
}

function Storage() {
  const notify = useUi((s) => s.notify);
  const [used, setUsed] = useState<number | null>(null);
  const [unused, setUnused] = useState<{ name: string; size: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!navigator.onLine) return setError("Storage details need a connection.");
    setError(null);
    Promise.all([storageUsed(), unusedFiles()]).then(
      ([u, f]) => {
        setUsed(u);
        setUnused(f);
      },
      () => setError("Couldn't load your storage details."),
    );
  }, []);
  useEffect(load, [load]);

  const unusedBytes = unused?.reduce((n, f) => n + f.size, 0) ?? 0;
  const free = async () => {
    if (!unused?.length || busy) return;
    const what = `${unused.length} unused file${unused.length === 1 ? "" : "s"} (${formatBytes(unusedBytes)})`;
    if (!window.confirm(`Delete ${what}? A version in version history that shows one will show it as missing. This can't be undone.`)) return;
    setBusy(true);
    try {
      await deleteFiles(unused.map((f) => f.name));
      notify(`Deleted ${what}.`);
      load();
    } catch {
      notify("Couldn't delete the files. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const share = used == null ? 0 : Math.min(100, (used / STORAGE_LIMIT_BYTES) * 100);
  return (
    <Section title="Storage">
      <Row
        label="Images and files"
        hint={error ?? (used == null ? "Loading…" : `${formatBytes(used)} of 100 MB used. Each file can be up to 10 MB.`)}
      >
        {used != null && (
          <div
            role="progressbar"
            aria-label="Storage used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(share)}
            className="h-1.5 w-40 overflow-hidden rounded-full bg-press"
          >
            <div className={`h-full rounded-full ${share >= 90 ? "bg-danger" : "bg-accent"}`} style={{ width: `${Math.max(share, 2)}%` }} />
          </div>
        )}
      </Row>
      {unused && (
        <Row
          label="Unused files"
          hint={
            unused.length
              ? `${unused.length} file${unused.length === 1 ? "" : "s"} (${formatBytes(unusedBytes)}) no longer in any page, or in the Trash.`
              : "Every file you've added is in a page."
          }
        >
          {unused.length > 0 && (
            <button className={button} disabled={busy} onClick={() => void free()}>
              Delete unused files
            </button>
          )}
        </Row>
      )}
    </Section>
  );
}

function Data() {
  const notify = useUi((s) => s.notify);
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const run = async (label: string, task: () => Promise<string>) => {
    setBusy(true);
    notify(label);
    try {
      notify(await task());
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const importPicked = (files: File[]) =>
    run("Importing…", async () => {
      const { importFiles } = await import("../lib/markdown");
      const res = await importFiles(files);
      if (res.rootId) navigate(`/p/${res.rootId}`);
      const missing = res.missingImages.length
        ? ` Missing images: ${res.missingImages.slice(0, 3).join(", ")}${res.missingImages.length > 3 ? "…" : ""}.`
        : "";
      return `Imported ${res.pages} page${res.pages === 1 ? "" : "s"}.${missing}`;
    });

  return (
    <Section title="Data">
      <Row label="Import" hint="Markdown files, or a .zip of a folder from Obsidian, Notion or another app.">
        <button className={`${button} flex items-center gap-1.5`} disabled={busy} onClick={() => fileInput.current?.click()}>
          <Upload size={14} /> Import Markdown
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".md,.markdown,.txt,.zip,image/*"
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) void importPicked(files);
          }}
        />
      </Row>
      <Row label="Export" hint="Every page as Markdown in a .zip file, with its images.">
        <button
          className={`${button} flex items-center gap-1.5`}
          disabled={busy}
          onClick={() => void run("Preparing your export…", exportEverything)}
        >
          <Download size={14} /> Export all pages
        </button>
      </Row>
    </Section>
  );
}

function Danger() {
  const [deleting, setDeleting] = useState(false);
  return (
    <Section title="Delete account">
      <Row
        label="Delete your account"
        hint="Deletes your account with all your pages, images and version history, right away. This can't be undone."
      >
        <button
          onClick={() => setDeleting(true)}
          className="h-8 rounded-md px-3 text-[13px] font-medium text-danger ring-1 ring-danger/40 ring-inset hover:bg-danger/10"
        >
          Delete account
        </button>
      </Row>
      {deleting && <DeleteAccountDialog onClose={() => setDeleting(false)} onExport={exportEverything} />}
    </Section>
  );
}
