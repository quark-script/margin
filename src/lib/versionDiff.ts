import { diffArrays, diffWords } from "diff";
import type { Block } from "./types";
import type { Version } from "./history";

type Kind = "paragraph" | "heading" | "bullet" | "number" | "check" | "toggle" | "quote" | "code" | "image" | "file" | "divider" | "row";

/** One line of a version as the history shows it: a block, or a row of a table. */
export type Line = {
  /** The block's id. It stays the same while the block is edited, so it pairs old and new. */
  key: string | null;
  depth: number;
  kind: Kind;
  text: string;
  /** Everything visible about the line. Equal looks: nothing to see changed. */
  look: string;
  level?: number;
  checked?: boolean;
  number?: number;
  cells?: string[];
  media?: { url: string; name: string };
  /** The text in pieces of the same styling. */
  runs: Run[];
};

/** A piece of text and its styling: bold, italic, underline, strike, code, a link or a page link. */
export type Run = { text: string; styles: Record<string, unknown>; href?: string; page?: boolean };

export type Word = { value: string; added?: boolean; removed?: boolean };

export type DiffLine =
  | { op: "same" | "added" | "removed"; line: Line }
  | { op: "changed"; line: Line; was: Line; words: Word[] | null; note: string | null };

export type Comparison = {
  /** null when the versions are too far apart to compare line by line. */
  lines: DiffLine[] | null;
  title: Word[] | null;
  icon: { before: string | null; after: string | null } | null;
  added: number;
  removed: number;
  changed: number;
};

const KINDS: Record<string, Kind> = {
  paragraph: "paragraph",
  heading: "heading",
  bulletListItem: "bullet",
  numberedListItem: "number",
  checkListItem: "check",
  toggleListItem: "toggle",
  quote: "quote",
  codeBlock: "code",
  image: "image",
  video: "file",
  audio: "file",
  file: "file",
  divider: "divider",
};

// Styling that looks the same as none, as in notes.content_signature on the server.
const DEFAULTS: Record<string, unknown> = {
  textColor: "default",
  backgroundColor: "default",
  textAlignment: "left",
  isToggleable: false,
  checked: false,
};

const visibleProps = (props: Record<string, unknown> = {}) =>
  Object.keys(props)
    .filter((k) => props[k] !== DEFAULTS[k] && props[k] !== undefined)
    .sort()
    .map((k) => [k, props[k]]);

function runs(content: unknown, pageTitle: (id: string) => string): Run[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((n): Run[] => {
    if (!n || typeof n !== "object") return typeof n === "string" ? [{ text: n, styles: {} }] : [];
    const node = n as { type?: string; text?: unknown; href?: string; content?: unknown; styles?: Record<string, unknown>; props?: { pageId?: string } };
    if (node.type === "link") return runs(node.content, pageTitle).map((r) => ({ ...r, href: node.href }));
    if (node.type === "pageLink") return [{ text: pageTitle(node.props?.pageId ?? ""), styles: {}, page: true, href: node.props?.pageId }];
    return typeof node.text === "string" ? [{ text: node.text, styles: node.styles ?? {} }] : [];
  });
}

const runLook = (r: Run[]) => r.map((x) => [x.text, visibleProps(x.styles), x.href ?? null]);

/** A version's content as lines. Empty lines are left out: they don't count as a change. */
export function versionLines(blocks: Block[], pageTitle: (id: string) => string): Line[] {
  const lines: Line[] = [];
  const walk = (bs: Block[], depth: number) => {
    let number = 0;
    for (const b of bs) {
      const kind = KINDS[b.type ?? ""] ?? "paragraph";
      const props = b.props ?? {};
      number = kind === "number" ? (typeof props.start === "number" && !number ? props.start : number + 1) : 0;
      if (b.type === "table") {
        const rows = (b.content as { rows?: { cells?: unknown[] }[] } | undefined)?.rows ?? [];
        for (const row of rows) {
          const cells = (row.cells ?? []).map((c) => runs(Array.isArray(c) ? c : (c as { content?: unknown })?.content, pageTitle));
          const texts = cells.map((r) => r.map((x) => x.text).join(""));
          // Rows have no id of their own, so they pair up by what they say.
          lines.push({ key: null, depth, kind: "row", text: texts.join(" | "), look: JSON.stringify(cells.map(runLook)), cells: texts, runs: [] });
        }
      } else if (kind === "divider") {
        lines.push({ key: b.id ?? null, depth, kind, text: "", look: "divider", runs: [] });
      } else if (kind === "image" || kind === "file") {
        const media = { url: String(props.url ?? ""), name: String(props.name ?? "") };
        const text = String(props.caption ?? "") || media.name;
        lines.push({ key: b.id ?? null, depth, kind, text, look: JSON.stringify([b.type, visibleProps(props)]), media, runs: [{ text, styles: {} }] });
      } else {
        const r = runs(b.content, pageTitle);
        const text = r.map((x) => x.text).join("");
        if (text || b.children?.length) {
          lines.push({
            key: b.id ?? null,
            depth,
            kind,
            text,
            look: JSON.stringify([b.type, visibleProps(props), runLook(r)]),
            runs: r,
            level: kind === "heading" ? Number(props.level ?? 1) : undefined,
            checked: kind === "check" ? props.checked === true : undefined,
            number: kind === "number" ? number : undefined,
          });
        }
      }
      if (b.children?.length) walk(b.children, depth + 1);
    }
  };
  walk(blocks, 0);
  return lines;
}

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "word" }) : undefined;

/** Word by word, in any script. null if the texts are too different to compare quickly. */
function words(before: string, after: string): Word[] | null {
  return diffWords(before, after, { intlSegmenter: segmenter, timeout: 200 }) ?? null;
}

const KIND_NAMES: Record<Kind, string> = {
  paragraph: "text",
  heading: "a heading",
  bullet: "a bulleted list",
  number: "a numbered list",
  check: "a to-do",
  toggle: "a toggle list",
  quote: "a quote",
  code: "code",
  image: "an image",
  file: "a file",
  divider: "a divider",
  row: "a table row",
};

/** What changed about a line besides its words, in a few words. */
function describe(before: Line, after: Line): string | null {
  if (before.kind !== after.kind) return `Now ${KIND_NAMES[after.kind]}`;
  if (before.checked !== after.checked) return after.checked ? "Checked" : "Unchecked";
  if (before.level !== after.level) return `Now heading ${after.level}`;
  if (before.media && before.media.url !== after.media?.url) return "Replaced";
  if (before.text === after.text) return "Formatting changed";
  return null;
}

/** How a version differs from the one before it. */
export function compareVersions(before: Version, after: Version, pageTitle: (id: string) => string): Comparison {
  const old = versionLines(before.content ?? [], pageTitle);
  const now = versionLines(after.content ?? [], pageTitle);
  const result: Comparison = {
    lines: null,
    title: before.title.trim() === after.title.trim() ? null : words(before.title.trim(), after.title.trim()),
    icon: (before.icon ?? null) === (after.icon ?? null) ? null : { before: before.icon ?? null, after: after.icon ?? null },
    added: 0,
    removed: 0,
    changed: 0,
  };
  const pairs = diffArrays(old, now, {
    comparator: (a, b) => (a.key !== null && a.key === b.key) || (a.kind === b.kind && a.text === b.text),
    timeout: 1500,
  });
  if (!pairs) return result;

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  for (const part of pairs) {
    for (let k = 0; k < part.count; k++) {
      if (part.removed) {
        lines.push({ op: "removed", line: old[i++] });
        result.removed++;
      } else if (part.added) {
        lines.push({ op: "added", line: now[j++] });
        result.added++;
      } else {
        const a = old[i++];
        const b = now[j++];
        if (a.look === b.look) {
          lines.push({ op: "same", line: b });
        } else {
          lines.push({ op: "changed", line: b, was: a, words: a.text === b.text ? null : words(a.text, b.text), note: describe(a, b) });
          result.changed++;
        }
      }
    }
  }
  result.lines = lines;
  return result;
}
