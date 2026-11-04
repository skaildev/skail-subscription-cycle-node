import type { TimelineEntry } from "@skail-subscription-cycle/contracts";

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol aria-label="Timeline" className="timeline">
      {entries.map((e, i) => (
        <li key={i} className={e.kind}>
          {new Date(e.at).toLocaleTimeString()} {e.text}
        </li>
      ))}
    </ol>
  );
}
