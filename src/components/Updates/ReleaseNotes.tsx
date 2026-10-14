import type { ReactNode } from "react";

/** `**bold**` and `[text](url)` (shown as text) inside a line. */
function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|\[([^\]]+)\]\([^)]*\)|`([^`]+)`/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[1] !== undefined)
      parts.push(
        <strong key={match.index} className="font-semibold">
          {match[1]}
        </strong>,
      );
    else parts.push(match[2] ?? match[3]);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/**
 * A release's notes as GitHub writes them, reduced to headings, list
 * items, and paragraphs; links show their text only.
 */
export function ReleaseNotes({ notes }: { notes: string }) {
  const blocks: ReactNode[] = [];
  let items: string[] = [];
  const flush = () => {
    if (!items.length) return;
    const list = items;
    items = [];
    blocks.push(
      <ul key={`list-${blocks.length}`} className="space-y-1 pl-4 list-disc marker:text-outline">
        {list.map((item, index) => (
          <li key={index}>{inline(item)}</li>
        ))}
      </ul>,
    );
  };
  for (const raw of notes.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("- ")) {
      items.push(line.slice(2));
      continue;
    }
    flush();
    if (!line) continue;
    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading)
      blocks.push(
        <p
          key={blocks.length}
          className={
            heading[1] === "##"
              ? "text-xs font-semibold text-on-surface pt-1"
              : "text-xs font-medium text-secondary pt-1"
          }
        >
          {heading[2]}
        </p>,
      );
    else blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="space-y-1.5 text-xs leading-relaxed text-on-surface">{blocks}</div>;
}
