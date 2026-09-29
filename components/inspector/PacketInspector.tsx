"use client";
import { useMemo } from "react";
import { useLabStore } from "@/lib/store/lab-store";
import { describeFrame } from "@/lib/models/packet";
import { OsiPanel } from "./OsiPanel";
import { MacLookupView, RouteLookupView, ArpLookupView, EncapsulationView } from "./LookupViews";

export function PacketInspector() {
  const events = useLabStore((s) => s.events);
  const selectedEventId = useLabStore((s) => s.selectedEventId);

  const event = useMemo(
    () => events.find((e) => e.id === selectedEventId),
    [events, selectedEventId],
  );

  if (!event) {
    return (
      <div className="p-4 text-sm text-[#6b7789]">
        Click any packet or event in the timeline below to inspect it here — frames, MAC lookups,
        routing decisions, and ARP resolution.
      </div>
    );
  }

  const layers = event.frame ? describeFrame(event.frame) : [];
  const active = event.frame ? Array.from(new Set(layers.map((l) => l.osiLayer))) : event.osiLayers;
  const detail = event.detail;

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* event header (unchanged) */}
      <div className="rounded-md border border-edge bg-panel-2 p-2.5">
        <div className="text-xs font-semibold text-accent-2">{event.type}</div>
        <div className="mt-0.5 text-[11px] text-[#8b98a5]">
          {event.timeMs}ms · {event.deviceName}
          {event.interfaceName ? ` (${event.interfaceName})` : ""}
        </div>
        <div className="mt-1 text-[11px] text-[#c9d3de]">{event.message}</div>
      </div>

      {/* structured lookup explanation (engine-computed) */}
      {detail?.kind === "mac-learn" && <MacLookupView detail={detail} deviceName={event.deviceName} />}
      {detail?.kind === "mac-lookup" && <MacLookupView detail={detail} deviceName={event.deviceName} />}
      {detail?.kind === "route-lookup" && <RouteLookupView detail={detail} deviceName={event.deviceName} />}
      {detail?.kind === "arp-lookup" && <ArpLookupView detail={detail} deviceName={event.deviceName} />}

      {/* the actual frame on the wire */}
      {event.frame ? (
        <>
          <EncapsulationView frame={event.frame} />
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-[11px] text-[#8b98a5]">
              <span>Frame #{event.frame.id}</span>
              <span>{event.frame.meta.sizeBytes} bytes on the wire</span>
            </div>
            {layers.map((layer, i) => (
              <details key={i} open className="rounded-md border border-edge bg-panel-2">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-[12px] font-semibold text-[#e6edf3]">
                  <span className="text-[10px] text-accent-2">L{layer.osiLayer}</span>
                  <span>{layer.title}</span>
                  {layer.unit && (
                    <span className="ml-auto rounded border border-edge px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-[#8b98a5]">
                      {layer.unit}
                    </span>
                  )}
                </summary>
                <div className="border-t border-edge px-2.5 py-1.5">
                  {layer.fields.map((f, j) => (
                    <div key={j} className="flex justify-between gap-3 py-0.5 text-[11.5px]">
                      <span className="text-[#8b98a5]">{f.label}</span>
                      <span className="text-right font-mono text-[#e6edf3]">{f.value}</span>
                    </div>
                  ))}
                </div>
              </details>
            ))}

            {/* raw / details view */}
            <details className="rounded-md border border-edge bg-panel">
              <summary className="cursor-pointer list-none px-2.5 py-1.5 text-[11px] text-[#8b98a5]">
                Raw / details
              </summary>
              <pre className="overflow-x-auto border-t border-edge px-2.5 py-1.5 text-[10.5px] leading-relaxed text-[#c9d3de]">
{layers
  .map(
    (l) =>
      `${l.title}${l.unit ? ` [${l.unit}]` : ""}\n` +
      l.fields.map((f) => `  ${f.label}: ${f.value}`).join("\n"),
  )
  .join("\n\n")}
              </pre>
            </details>
          </div>
        </>
      ) : (
        !detail && (
          <div className="rounded-md border border-dashed border-edge p-3 text-[11px] text-[#6b7789]">
            This event records a decision, not a packet on the wire.
          </div>
        )
      )}

      <div>
        <h3 className="panel-title mb-1">OSI layers</h3>
        <OsiPanel active={active} />
      </div>
    </div>
  );
}
