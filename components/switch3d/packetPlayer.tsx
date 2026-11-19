"use client";
/**
 * Packet animation shared by the topology canvas and the realistic scene: when a
 * command (ping, traceroute…) runs, its FRAME_SENT events are replayed hop by hop
 * (lib/switch3d/model.ts packetHops), one cable at a time, in the order sent.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLabStore } from "@/lib/store/lab-store";
import { PacketHop, packetHops } from "@/lib/switch3d/model";

export interface PacketPlayer {
  hops: PacketHop[];
  hop?: PacketHop;
  index: number;
  hopMs: number;
  speed: number;
  setSpeed(v: number): void;
  replay(): void;
  /** Changes on every (re)play — key for restarting SVG animations. */
  run: number;
}

export function usePacketPlayer(): PacketPlayer {
  const events = useLabStore((s) => s.events);
  const firstEvents = useRef(events);
  const hops = useMemo(() => packetHops(events), [events]);
  const [index, setIndex] = useState(-1);
  const [speed, setSpeed] = useState(1);
  const [run, setRun] = useState(0);
  // Auto-play new commands; what ran before this view opened plays on "Replay".
  useEffect(() => setIndex(hops.length && (run > 0 || events !== firstEvents.current) ? 0 : -1), [hops, run, events]);
  const hopMs = 650 / speed;
  useEffect(() => {
    if (index < 0 || index >= hops.length) return;
    const t = setTimeout(() => setIndex((i) => i + 1), hopMs);
    return () => clearTimeout(t);
  }, [index, hops.length, hopMs]);
  return { hops, hop: index >= 0 ? hops[index] : undefined, index, hopMs, speed, setSpeed, replay: () => setRun((n) => n + 1), run };
}

/** "ping request · hop 6/12 · S1 Ethernet1 → S3 Ethernet0: …" with speed and replay controls. */
export function PacketCaption({ p, idleHint }: { p: PacketPlayer; idleHint: string }) {
  return (
    <div className="flex min-h-[30px] items-center gap-2 rounded-md border border-edge bg-panel/90 px-3 py-1 text-[11px] shadow">
      {p.hop ? (
        <>
          <span className="rounded px-1.5 py-0.5 font-semibold text-black" style={{ background: p.hop.color }}>
            {p.hop.label}
          </span>
          <span className="font-mono text-[#c9d3de]">
            hop {p.index + 1}/{p.hops.length} · {p.hop.text}
          </span>
        </>
      ) : (
        <span className="text-[#6b7789]">{p.hops.length ? `Last command: ${p.hops.length} hops — press Replay to watch them.` : idleHint}</span>
      )}
      <span className="ml-2 flex overflow-hidden rounded border border-edge">
        {[0.5, 1, 2].map((v) => (
          <button key={v} onClick={() => p.setSpeed(v)} className={`px-1.5 ${p.speed === v ? "bg-accent-2/20 text-accent-2" : "text-[#8b98a5]"}`}>
            {v}×
          </button>
        ))}
      </span>
      {p.hops.length > 0 && (
        <button onClick={p.replay} className="rounded border border-edge px-1.5 text-[#8b98a5] hover:text-accent-2">
          ↻ Replay
        </button>
      )}
    </div>
  );
}

/** The moving labelled packet on an SVG path (forward = from the path's start). */
export function PacketOnPath({ hop, path, forward, ms, animKey }: { hop: PacketHop; path: string; forward: boolean; ms: number; animKey: string }) {
  return (
    <g key={animKey} style={{ filter: `drop-shadow(0 0 5px ${hop.color})` }} pointerEvents="none">
      <animateMotion dur={`${ms}ms`} fill="freeze" path={path} keyPoints={forward ? "0;1" : "1;0"} keyTimes="0;1" calcMode="linear" />
      <rect x={-34} y={-10} width={68} height={20} rx={5} fill={hop.color} stroke="#fff" strokeOpacity={0.7} />
      <text textAnchor="middle" y={4} fontSize="9.5" fontFamily="ui-monospace, monospace" fontWeight={700} fill="#06090d">
        {hop.label}
      </text>
    </g>
  );
}
