import type { Step } from "@aipagego/shared/types";

export function StepList(props: { steps: Step[] }) {
  return (
    <ol className="text-xs space-y-1">
      {props.steps.map((s, i) => (
        <li key={i} className="bg-zinc-900 rounded p-2">
          <div className="text-zinc-400">
            #{i} · {s.kind === "tool" ? `tool:${s.tool}` : "js"}
            {s.bindResultTo && <span> → ${s.bindResultTo}</span>}
          </div>
          <pre className="mt-1 text-[10px] text-zinc-300 overflow-auto">
            {JSON.stringify(s.kind === "tool" ? s.args : s.source, null, 2)}
          </pre>
        </li>
      ))}
    </ol>
  );
}
