import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Props = {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  align?: "start" | "end";
  width?: number;
  children: ReactNode;
};

// Open popovers, innermost last. A menu opened from inside a popover (a role picker in the
// share panel) is a separate portal, so only the innermost one reacts to outside clicks and
// Escape; otherwise picking an item would also close the panel behind it.
const openStack: symbol[] = [];

/** A small floating panel anchored to a button. Closes on outside click and Escape. */
export function Popover({ anchor, open, onClose, align = "start", width = 220, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [id] = useState(() => Symbol("popover"));

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(width, vw - 16); // never wider than a phone screen
    let left = align === "end" ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    let top = r.bottom + 4;
    const h = ref.current?.offsetHeight ?? 240;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 4);
    setPos({ top, left });
  }, [open, anchor, align, width]);

  useEffect(() => {
    if (!open) return;
    openStack.push(id);
    const innermost = () => openStack[openStack.length - 1] === id;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!innermost() || ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !innermost()) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      openStack.splice(openStack.indexOf(id), 1);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, anchor, onClose, id]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: `min(${width}px, calc(100vw - 16px))` }}
      className="fixed z-50 rounded-lg bg-pop p-1 shadow-pop"
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  hint,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  hint?: string;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[14px] hover:bg-hover ${
        danger ? "text-danger" : "text-ink"
      }`}
    >
      {icon && <span className={`flex w-4 justify-center ${danger ? "" : "text-muted"}`}>{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {hint && <span className="text-[12px] text-faint">{hint}</span>}
    </button>
  );
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-line" />;
}

export function IconButton({
  label,
  onClick,
  children,
  className = "",
  buttonRef,
}: {
  label: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  className?: string;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink active:bg-press ${className}`}
    >
      {children}
    </button>
  );
}
