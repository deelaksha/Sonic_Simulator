"use client";
import { useEffect } from "react";
import { useLabStore } from "@/lib/store/lab-store";
import { SimEventType } from "@/lib/engine";

const TYPE_COLOR: Partial<Record<SimEventType, string>> = {
  FRAME_SENT: "#64748b",
  FRAME_RECEIVED: "#94a3b8",
  FRAME_FORWARDED: "#22d3ee",
  FRAME_FLOODED: "#f59e0b",
  FRAME_DROPPED: "#ef4444",
  MAC_LEARNED: "#22d3ee",
  ARP_REQUEST: "#a78bfa",
  ARP_REPLY: "#a78bfa",
  ARP_RESOLVED: "#a78bfa",
  IP_PACKET_CREATED: "#3b82f6",
  ROUTE_LOOKUP: "#3b82f6",
  ROUTE_MATCH: "#3b82f6",
  TTL_DECREMENT: "#f59e0b",
  ICMP_ECHO_REQUEST: "#22c55e",
  ICMP_ECHO_REPLY: "#22c55e",
  ICMP_TIME_EXCEEDED: "#ef4444",
  ICMP_UNREACHABLE: "#ef4444",
  NDP_SOLICITATION: "#a78bfa",
  NDP_ADVERTISEMENT: "#a78bfa",
  NDP_RESOLVED: "#a78bfa",
  ICMP6_ECHO_REQUEST: "#22c55e",
  ICMP6_ECHO_REPLY: "#22c55e",
  OSPF_HELLO: "#e879f9",
  OSPF_NEIGHBOR: "#e879f9",
  OSPF_ROUTE: "#3b82f6",
  BGP_OPEN: "#fb923c",
  BGP_ESTABLISHED: "#fb923c",
  BGP_UPDATE: "#fb923c",
  BGP_ROUTE: "#3b82f6",
  UDP_DATAGRAM: "#38bdf8",
  NTP_REQUEST: "#f59e0b",
  NTP_RESPONSE: "#f59e0b",
  DHCP_DISCOVER: "#a78bfa",
  DHCP_OFFER: "#a78bfa",
  DHCP_REQUEST: "#a78bfa",
  DHCP_ACK: "#22c55e",
  DHCP_RELAY: "#f97316",
  DNS_QUERY: "#14b8a6",
  DNS_RESPONSE: "#14b8a6",
  VRRP_MASTER: "#eab308",
  VRRP_FAILOVER: "#ef4444",
  PING_RESULT: "#e6edf3",
};

function Ctrl({ onClick, label, disabled }: { onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded border border-edge bg-panel-2 px-2 py-1 text-xs hover:border-accent-2 disabled:opacity-40"
    >
      {label}
    </button>
  );
}

export function PacketTimeline() {
  const events = useLabStore((s) => s.events);
  const { index, playing } = useLabStore((s) => s.playback);
  const selectedEventId = useLabStore((s) => s.selectedEventId);
  const setPlaybackIndex = useLabStore((s) => s.setPlaybackIndex);
  const play = useLabStore((s) => s.play);
  const pause = useLabStore((s) => s.pause);
  const stepNext = useLabStore((s) => s.stepNext);
  const stepPrev = useLabStore((s) => s.stepPrev);
  const clearTimeline = useLabStore((s) => s.clearTimeline);
  const selectEvent = useLabStore((s) => s.selectEvent);

  // auto-advance while playing
  useEffect(() => {
    if (!playing) return;
    if (index >= events.length) {
      pause();
      return;
    }
    const t = setTimeout(() => stepNext(), 550);
    return () => clearTimeout(t);
  }, [playing, index, events.length, stepNext, pause]);

  if (events.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[#6b7789]">
        Run a command that generates traffic (e.g. <code className="mx-1 text-accent-2">ping</code>) to
        populate the packet timeline.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-edge px-3 py-1.5">
        <Ctrl onClick={stepPrev} label="⏮ Prev" disabled={index <= 0} />
        {playing ? (
          <Ctrl onClick={pause} label="⏸ Pause" />
        ) : (
          <Ctrl onClick={play} label="▶ Play" disabled={index >= events.length} />
        )}
        <Ctrl onClick={stepNext} label="⏭ Next" disabled={index >= events.length} />
        <div className="ml-2 text-xs text-[#8b98a5]">
          {index}/{events.length}
        </div>
        <button
          onClick={clearTimeline}
          className="ml-auto rounded border border-edge px-2 py-1 text-xs text-[#8b98a5] hover:border-danger hover:text-red-300"
        >
          Clear
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-1">
        {events.map((e, i) => {
          const current = i === index - 1;
          const selected = e.id === selectedEventId;
          return (
            <button
              key={e.id}
              onClick={() => {
                setPlaybackIndex(i + 1);
                selectEvent(e.id);
              }}
              className={`flex w-full items-start gap-2 rounded px-2 py-1 text-left text-[11.5px] leading-snug ${
                current ? "bg-accent-2/10" : selected ? "bg-panel-3" : "hover:bg-panel-2"
              }`}
            >
              <span className="w-12 shrink-0 tabular-nums text-[#5f6b7a]">{e.timeMs}ms</span>
              <span
                className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: TYPE_COLOR[e.type] ?? "#64748b" }}
              />
              <span className="text-[#c9d3de]">{e.message}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
