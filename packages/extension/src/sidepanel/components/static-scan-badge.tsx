import type { ScanFinding } from "@aipagego/shared/types";

export function StaticScanBadge(props: { findings: ScanFinding[] }) {
  if (props.findings.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {props.findings.map((f) => (
        <span
          key={f.rule}
          className={
            "px-1.5 py-0.5 rounded text-[10px] " +
            (f.severity === "dangerous"
              ? "bg-red-700 text-red-100"
              : f.severity === "caution"
              ? "bg-amber-700 text-amber-100"
              : "bg-zinc-700 text-zinc-200")
          }
          title={f.message}
        >
          {f.rule}
        </span>
      ))}
    </div>
  );
}
