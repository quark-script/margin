import { CloudOff, RefreshCw, Check, AlertCircle } from "lucide-react";
import { usePages } from "../store/pages";

export function SyncStatus({ compact = false }: { compact?: boolean }) {
  const status = usePages((s) => s.status);
  const pending = usePages((s) => Object.keys(s.dirty).length + Object.keys(s.deletions).length);
  const lastError = usePages((s) => s.lastError);
  const sync = usePages((s) => s.sync);

  let icon = <Check size={13} />;
  let text = "Saved";
  let tone = "text-faint";
  let title = "All changes are synced";

  if (status === "offline") {
    icon = <CloudOff size={13} />;
    text = compact ? "Offline" : pending ? `Offline · ${pending} unsynced` : "Offline";
    title = "Changes are kept on this device and sync when you're back online";
    tone = "text-muted";
  } else if (status === "error") {
    icon = <AlertCircle size={13} />;
    text = "Sync failed";
    title = `${lastError ?? "Unknown error"}. Click to retry.`;
    tone = "text-danger";
  } else if (status === "syncing" || pending) {
    icon = <RefreshCw size={13} className="animate-spin [animation-duration:1.4s]" />;
    text = "Saving";
    title = "Saving changes";
  }

  return (
    <button
      onClick={() => void sync()}
      title={title}
      className={`flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] hover:bg-hover ${tone}`}
    >
      {icon}
      <span>{text}</span>
    </button>
  );
}
