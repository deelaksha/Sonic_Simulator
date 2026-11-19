"use client";
import { useState } from "react";
import { useLabStore } from "@/lib/store/lab-store";
import { allMissions, getMission, Mission } from "@/lib/missions";
import { SONIC_FEATURES } from "@/lib/sonic/feature-registry";

/**
 * Lab missions and troubleshooting labs (lib/missions): pick one, work in the
 * terminals, and watch the objectives tick off as the live network changes.
 */
export function MissionsPanel() {
  const mission = useLabStore((s) => s.mission);
  return mission ? <ActiveMission /> : <MissionList />;
}

const labLabel = (labId: string) => SONIC_FEATURES.find((f) => f.id === labId)?.label ?? labId;

function KindBadge({ m }: { m: Mission }) {
  const trouble = m.kind === "troubleshoot";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${trouble ? "bg-amber-500/15 text-amber-300" : "bg-accent-2/15 text-accent-2"}`}>
      {trouble ? "Troubleshoot" : "Mission"}
    </span>
  );
}

function MissionList() {
  const progress = useLabStore((s) => s.missionProgress);
  const start = useLabStore((s) => s.startMission);
  const [filter, setFilter] = useState<"all" | "mission" | "troubleshoot">("all");
  const missions = allMissions().filter((m) => filter === "all" || m.kind === filter);
  const byLab = new Map<string, Mission[]>();
  for (const m of missions) byLab.set(m.labId, [...(byLab.get(m.labId) ?? []), m]);
  const solved = allMissions().filter((m) => progress[m.id]).length;

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-[#8b98a5]">
          {solved}/{allMissions().length} solved
        </div>
        <div className="flex overflow-hidden rounded border border-edge text-[11px]">
          {(["all", "mission", "troubleshoot"] as const).map((v) => (
            <button key={v} onClick={() => setFilter(v)} className={`px-2 py-0.5 ${filter === v ? "bg-accent-2/20 text-accent-2" : "text-[#8b98a5] hover:text-[#e6edf3]"}`}>
              {v === "all" ? "All" : v === "mission" ? "Missions" : "Troubleshoot"}
            </button>
          ))}
        </div>
      </div>
      {[...byLab.entries()].map(([labId, ms]) => (
        <div key={labId}>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#5f6b7a]">{labLabel(labId)}</div>
          <div className="space-y-1.5">
            {ms.map((m) => (
              <div key={m.id} className="rounded-md border border-edge bg-panel-2 p-2">
                <div className="flex items-center gap-1.5">
                  <KindBadge m={m} />
                  <span className="text-[10px] text-[#6b7789]">{m.level}</span>
                  {progress[m.id] && <span className="ml-auto text-[11px] text-emerald-400">✓ solved</span>}
                </div>
                <div className="mt-1 text-[12px] font-medium text-[#e6edf3]">{m.title}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-[#8b98a5]">{m.summary}</div>
                <button
                  onClick={() => start(m.id)}
                  className="mt-1.5 rounded border border-edge px-2 py-0.5 text-[11px] text-[#c9d3de] hover:border-accent-2 hover:text-accent-2"
                >
                  {progress[m.id] ? "Play again" : "Start"}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ActiveMission() {
  const active = useLabStore((s) => s.mission)!;
  const revealHint = useLabStore((s) => s.revealHint);
  const showSolution = useLabStore((s) => s.showSolution);
  const stop = useLabStore((s) => s.stopMission);
  const m = getMission(active.id);
  if (!m) return null;
  const met = m.objectives.filter((o) => active.done[o.id]).length;
  const mins = active.solvedAtMs ? Math.max(1, Math.round((active.solvedAtMs - active.startedAtMs) / 60000)) : 0;

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center gap-1.5">
        <KindBadge m={m} />
        <span className="text-[10px] text-[#6b7789]">{labLabel(m.labId)}</span>
        <button onClick={stop} className="ml-auto rounded border border-edge px-2 py-0.5 text-[11px] text-[#8b98a5] hover:border-danger hover:text-red-300">
          Leave
        </button>
      </div>
      <div className="text-[13px] font-semibold text-[#e6edf3]">{m.title}</div>
      <div className={`rounded-md border p-2 text-[11.5px] leading-relaxed ${m.kind === "troubleshoot" ? "border-amber-500/30 bg-amber-500/5 text-amber-100" : "border-edge bg-panel-2 text-[#c9d3de]"}`}>
        {m.kind === "troubleshoot" && <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-300">Ticket</div>}
        {m.summary}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-[#5f6b7a]">
          <span>{m.kind === "troubleshoot" ? "Fixed when" : "Objectives"}</span>
          <span>
            {met}/{m.objectives.length}
          </span>
        </div>
        <div className="space-y-1.5">
          {m.objectives.map((o) => {
            const ok = !!active.done[o.id];
            const shown = active.hints[o.id] ?? 0;
            const hints = o.hints ?? [];
            return (
              <div key={o.id} className="rounded border border-edge bg-panel-2 p-2">
                <div className="flex items-start gap-2 text-[11.5px]">
                  <span className={ok ? "text-emerald-400" : "text-[#5f6b7a]"}>{ok ? "✓" : "○"}</span>
                  <span className={ok ? "text-[#8b98a5] line-through decoration-emerald-700" : "text-[#e6edf3]"}>{o.title}</span>
                </div>
                {hints.slice(0, shown).map((h, i) => (
                  <div key={i} className="ml-5 mt-1 text-[11px] leading-snug text-[#8b98a5]">
                    💡 {h}
                  </div>
                ))}
                {!ok && shown < hints.length && !active.solvedAtMs && (
                  <button onClick={() => revealHint(o.id)} className="ml-5 mt-1 text-[10.5px] text-accent-2 hover:underline">
                    {shown ? "Another hint" : "Hint"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {active.solvedAtMs ? (
        <div className="rounded-md border border-emerald-600/40 bg-emerald-500/5 p-2">
          <div className="text-[12px] font-semibold text-emerald-300">
            {m.kind === "troubleshoot" ? "Fixed" : "Mission complete"} · {mins} min
          </div>
          <div className="mt-1 whitespace-pre-line text-[11.5px] leading-relaxed text-[#c9d3de]">{m.explanation}</div>
        </div>
      ) : null}

      <div>
        {active.solutionShown ? (
          <div className="rounded-md border border-edge bg-panel-2 p-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#5f6b7a]">Reference solution</div>
            {m.solution.map((s, i) => (
              <div key={i} className="mb-1.5">
                <div className="text-[11px] font-semibold text-[#c9d3de]">{s.device}</div>
                <pre className="whitespace-pre-wrap font-mono text-[10.5px] leading-snug text-[#8b98a5]">
                  {[...(s.klish ? ["sonic-cli", ...s.klish] : []), ...(s.shell ?? [])].join("\n")}
                </pre>
              </div>
            ))}
          </div>
        ) : (
          <button onClick={showSolution} className="text-[11px] text-[#6b7789] hover:text-[#c9d3de] hover:underline">
            Stuck? Show the reference solution
          </button>
        )}
      </div>
    </div>
  );
}
