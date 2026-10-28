import { useEffect, useRef, useState } from "react";
import { Check, Paperclip } from "lucide-react";
import type { Comparison, DiffLine, Line, Run, Word } from "../lib/versionDiff";
import type { Version } from "../lib/history";
import { resolveFileUrl } from "../lib/media";
import { displayTitle } from "../lib/text";

/** A version with what changed since the version before it highlighted. */
export function VersionDiff({ version, comparison, lines }: { version: Version; comparison: Comparison; lines: DiffLine[] }) {
  const ref = useRef<HTMLDivElement>(null);

  // Bring the first change into view when it's further down the page.
  useEffect(() => {
    const first = ref.current?.querySelector("[data-change]");
    const pane = ref.current?.closest("section");
    if (!first || !pane) return;
    const r = first.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    if (r.top < p.top || r.bottom > p.bottom) first.scrollIntoView({ block: "center" });
  }, [lines]);

  const { icon, title } = comparison;
  return (
    <div ref={ref} className="version-diff">
      {icon ? (
        <div className="mb-2 flex items-center gap-2 text-[44px] leading-none" data-change>
          {icon.before && <del aria-label={`Icon removed: ${icon.before}`}>{icon.before}</del>}
          {icon.after && <ins aria-label={`Icon added: ${icon.after}`}>{icon.after}</ins>}
        </div>
      ) : (
        version.icon && <div className="mb-2 text-[44px] leading-none">{version.icon}</div>
      )}
      <h1 className="page-title text-ink" data-change={title ? true : undefined}>
        {title ? <Words words={title} /> : displayTitle(version.title)}
      </h1>
      <div className="mt-4">
        {lines.map((d, i) => (
          <Row key={i} d={d} />
        ))}
      </div>
    </div>
  );
}

function Words({ words }: { words: Word[] }) {
  return words.map((w, i) => (w.added ? <ins key={i}>{w.value}</ins> : w.removed ? <del key={i}>{w.value}</del> : <span key={i}>{w.value}</span>));
}

/** The part of some styled text between two offsets, still in its styled pieces. */
function slice(runs: Run[], from: number, to: number) {
  const out: { run: Run; text: string }[] = [];
  let pos = 0;
  for (const run of runs) {
    const end = pos + run.text.length;
    if (end > from && pos < to) out.push({ run, text: run.text.slice(Math.max(from - pos, 0), Math.min(to, end) - pos) });
    pos = end;
    if (pos >= to) break;
  }
  return out;
}

function Piece({ run, text }: { run: Run; text: string }) {
  const s = run.styles;
  let el: React.ReactNode = text;
  if (s.code) el = <code>{el}</code>;
  if (s.bold) el = <strong>{el}</strong>;
  if (s.italic) el = <em>{el}</em>;
  if (s.underline) el = <u>{el}</u>;
  if (s.strike) el = <s>{el}</s>;
  if (run.page) return <span className="diff-page">{el}</span>;
  if (run.href && /^(https?:|mailto:)/i.test(run.href))
    return (
      <a href={run.href} target="_blank" rel="noreferrer" className="diff-link">
        {el}
      </a>
    );
  return el;
}

const Styled = ({ runs }: { runs: Run[] }) => runs.map((run, i) => <Piece key={i} run={run} text={run.text} />);

/**
 * Word changes on styled text. Kept and added words come straight from the new text; removed
 * words are found in the old one, so each keeps its own styling.
 */
function StyledWords({ words, before, after }: { words: Word[]; before: Run[]; after: Run[] }) {
  const oldText = before.map((r) => r.text).join("");
  let oldPos = 0;
  let newPos = 0;
  return words.map((w, i) => {
    if (w.removed) {
      const at = oldText.indexOf(w.value, oldPos);
      if (at >= 0) oldPos = at + w.value.length;
      const pieces = at >= 0 ? slice(before, at, at + w.value.length) : [{ run: { text: w.value, styles: {} }, text: w.value }];
      return <del key={i}>{pieces.map((p, k) => <Piece key={k} {...p} />)}</del>;
    }
    const pieces = slice(after, newPos, newPos + w.value.length);
    newPos += w.value.length;
    if (!w.added) {
      const at = oldText.indexOf(w.value.trim(), oldPos);
      if (at >= 0) oldPos = at + w.value.trim().length;
    }
    const content = pieces.map((p, k) => <Piece key={k} {...p} />);
    return w.added ? <ins key={i}>{content}</ins> : <span key={i}>{content}</span>;
  });
}

const LABELS = { added: "Added", removed: "Removed", changed: "Changed" } as const;

function Row({ d }: { d: DiffLine }) {
  const { line } = d;
  let body: React.ReactNode = <Styled runs={line.runs} />;
  if (d.op === "added") body = <ins>{body}</ins>;
  else if (d.op === "removed") body = <del>{body}</del>;
  else if (d.op === "changed" && d.words) body = <StyledWords words={d.words} before={d.was.runs} after={line.runs} />;
  if (line.kind === "row") body = <Cells line={line} op={d.op} />;
  if (line.kind === "divider") body = <hr className="diff-rule" />;
  if (line.media) body = <Media line={line} op={d.op} words={d.op === "changed" ? d.words : null} />;

  return (
    <div
      className={`diff-line diff-${d.op} kind-${line.kind}${line.level ? ` level-${line.level}` : ""}`}
      style={{ paddingLeft: `calc(${line.depth} * 1.5em + 10px)` }}
      data-change={d.op === "same" ? undefined : true}
    >
      {d.op !== "same" && <span className="sr-only">{LABELS[d.op]}: </span>}
      <Marker line={line} />
      <div className="min-w-0 flex-1">
        {body}
        {d.op === "changed" && d.note && <span className="diff-note">{d.note}</span>}
      </div>
    </div>
  );
}

function Marker({ line }: { line: Line }) {
  if (line.kind === "bullet") return <span className="diff-marker">{line.depth % 2 ? "◦" : "•"}</span>;
  if (line.kind === "number") return <span className="diff-marker">{line.number}.</span>;
  if (line.kind === "toggle") return <span className="diff-marker">▸</span>;
  if (line.kind === "check")
    return (
      <span className="diff-marker">
        <span className={`diff-box ${line.checked ? "checked" : ""}`} role="img" aria-label={line.checked ? "Done" : "Not done"}>
          {line.checked && <Check size={11} strokeWidth={3} />}
        </span>
      </span>
    );
  return null;
}

function Cells({ line, op }: { line: Line; op: DiffLine["op"] }) {
  const Tag = op === "added" ? "ins" : op === "removed" ? "del" : "span";
  return (
    <div className="diff-cells">
      {(line.cells ?? []).map((c, i) => (
        <Tag key={i}>{c || " "}</Tag>
      ))}
    </div>
  );
}

function Media({ line, op, words }: { line: Line; op: DiffLine["op"]; words: Word[] | null }) {
  const [src, setSrc] = useState<string | null>(null);
  const url = line.media?.url ?? "";
  useEffect(() => {
    if (line.kind !== "image" || !url) return;
    let alive = true;
    void resolveFileUrl(url).then((u) => alive && setSrc(u));
    return () => {
      alive = false;
    };
  }, [line.kind, url]);
  const caption = words ? <Words words={words} /> : op === "added" ? <ins>{line.text}</ins> : op === "removed" ? <del>{line.text}</del> : line.text;
  if (line.kind === "file")
    return (
      <span className="inline-flex items-center gap-1.5">
        <Paperclip size={14} className="text-muted" />
        {caption || "File"}
      </span>
    );
  return (
    <figure className="diff-media">
      {src ? <img src={src} alt={line.text} loading="lazy" /> : <div className="diff-media-placeholder" />}
      {line.text && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
