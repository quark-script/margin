import { Component, type ReactNode } from "react";

type Props = { fallbackText: string; children: ReactNode };

/**
 * Keeps one unreadable page from blanking the whole app. Shows the page's plain text
 * read-only instead; reloading also picks up a newer app version if one is waiting.
 */
export class EditorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[editor]", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="sm:px-[54px]">
        <div className="rounded-md border border-line px-4 py-3 text-[14px]">
          <p className="text-ink">This page can't be shown in this version of the app.</p>
          <p className="mt-1 text-muted">Reload to update Margin. Nothing on this page has been changed.</p>
          <button
            onClick={() => location.reload()}
            className="mt-3 rounded-md bg-ink px-3 py-1.5 text-[14px] font-medium text-paper hover:opacity-90"
          >
            Reload
          </button>
        </div>
        {this.props.fallbackText && (
          <p className="mt-6 whitespace-pre-wrap text-[16px] leading-[1.65] text-ink">{this.props.fallbackText}</p>
        )}
      </div>
    );
  }
}
