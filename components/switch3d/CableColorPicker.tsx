"use client";
/** Choose a cable's colour (saved on the connection, shown in every view). */
import { useLabStore } from "@/lib/store/lab-store";

/** Common patch-cable colours (Cat6 jackets, OM3/OM4 aqua fibre). */
export const CABLE_COLORS: [string, string][] = [
  ["#2563eb", "Blue"],
  ["#eab308", "Yellow"],
  ["#dc2626", "Red"],
  ["#16a34a", "Green"],
  ["#f97316", "Orange"],
  ["#9333ea", "Purple"],
  ["#ec4899", "Pink"],
  ["#22d3ee", "Aqua (fibre)"],
  ["#e5e7eb", "White"],
  ["#64748b", "Grey"],
  ["#18181b", "Black"],
];

/** A row of swatches + "Auto" for one connection. */
export function CableSwatches({ connectionId }: { connectionId: string }) {
  const color = useLabStore((s) => s.network.connections.find((c) => c.id === connectionId)?.color);
  const setCableColor = useLabStore((s) => s.setCableColor);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {CABLE_COLORS.map(([hex, name]) => (
        <button
          key={hex}
          title={name}
          onClick={() => setCableColor(connectionId, hex)}
          className={`h-5 w-5 rounded-full border transition hover:scale-110 ${color === hex ? "ring-2 ring-white ring-offset-1 ring-offset-[#0b0e13]" : ""}`}
          style={{ background: hex, borderColor: "rgba(255,255,255,.35)" }}
        />
      ))}
      <button
        onClick={() => setCableColor(connectionId, undefined)}
        title="Automatic colour by what the cable connects"
        className={`rounded border border-edge px-1.5 py-0.5 text-[10px] ${color ? "text-[#8b98a5] hover:text-accent-2" : "bg-accent-2/20 text-accent-2"}`}
      >
        Auto
      </button>
    </div>
  );
}

/** Floating palette shown where the learner clicked a cable. */
export function CableColorPicker({ connectionId, x, y, title, onClose }: { connectionId: string; x: number; y: number; title: string; onClose(): void }) {
  return (
    <div
      data-overlay
      className="absolute z-40 w-[260px] rounded-md border border-edge bg-panel/95 p-2 shadow-2xl"
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="truncate text-[11px] font-semibold text-[#e6edf3]">Cable colour · {title}</span>
        <button onClick={onClose} className="text-[11px] text-[#8b98a5] hover:text-accent-2" title="Close">
          ✕
        </button>
      </div>
      <CableSwatches connectionId={connectionId} />
    </div>
  );
}
