"use client";
import { useEffect } from "react";
import { useLabStore } from "@/lib/store/lab-store";
import { DeviceToolbox } from "@/components/toolbox/DeviceToolbox";
import { TopologyCanvas } from "@/components/topology/TopologyCanvas";
import { Inspector } from "@/components/inspector/Inspector";
import { Terminal } from "@/components/terminal/Terminal";
import { PacketTimeline } from "@/components/timeline/PacketTimeline";

function PanelHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-edge bg-panel px-3 py-1.5">
      <span className="text-xs font-semibold uppercase tracking-wider text-[#8b98a5]">{title}</span>
      {hint && <span className="text-[11px] text-[#5f6b7a]">{hint}</span>}
    </div>
  );
}

export default function LabPage() {
  const labName = useLabStore((s) => s.labName);
  const selectedDevice = useLabStore((s) =>
    s.selectedDeviceId ? s.network.devices[s.selectedDeviceId] : undefined,
  );

  // Start with the default lab (PC1 — SW1 — PC2, pre-addressed) instead of an
  // empty canvas. Only auto-loads when the canvas is empty, so it never clobbers
  // an in-progress lab; "New / clear" still empties it on demand.
  useEffect(() => {
    const s = useLabStore.getState();
    if (Object.keys(s.network.devices).length === 0) s.loadSample();
  }, []);

  return (
    <div className="flex h-screen min-w-[900px] flex-col bg-[#0b0e14] text-[#e6edf3]">
      {/* top bar */}
      <header className="flex items-center gap-3 border-b border-edge bg-panel px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">🛰️</span>
          <span className="text-sm font-semibold">Networking Lab</span>
        </div>
        <span className="text-[11px] text-[#5f6b7a]">
          build · configure · generate traffic · watch packets · inspect · troubleshoot
        </span>
        <span className="ml-auto rounded border border-edge bg-panel-2 px-2 py-0.5 text-[11px] text-[#8b98a5]">
          {labName}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* left: device toolbox */}
        <aside className="w-56 shrink-0 border-r border-edge bg-panel">
          <DeviceToolbox />
        </aside>

        {/* center + right + bottom */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <section className="min-w-0 flex-1">
              <TopologyCanvas />
            </section>
            <aside className="w-80 shrink-0 border-l border-edge bg-panel">
              <Inspector />
            </aside>
          </div>

          {/* bottom: terminal + packet timeline */}
          <div className="flex h-[32%] min-h-[210px] border-t border-edge">
            <section className="flex min-w-0 flex-1 flex-col border-r border-edge bg-[#0a0d12]">
              <PanelHeader
                title="Terminal"
                hint={selectedDevice ? selectedDevice.config.hostname : "no device selected"}
              />
              <div className="min-h-0 flex-1">
                <Terminal />
              </div>
            </section>
            <section className="flex w-[40%] shrink-0 flex-col bg-panel">
              <PanelHeader title="Packet timeline" />
              <div className="min-h-0 flex-1">
                <PacketTimeline />
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
