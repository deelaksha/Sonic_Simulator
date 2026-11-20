"use client";
import { useEffect, useState } from "react";
import { useLabStore } from "@/lib/store/lab-store";
import { DeviceToolbox } from "@/components/toolbox/DeviceToolbox";
import { TopologyCanvas } from "@/components/topology/TopologyCanvas";
import { Inspector } from "@/components/inspector/Inspector";
import { Terminal } from "@/components/terminal/Terminal";
import { PacketTimeline } from "@/components/timeline/PacketTimeline";
import { SessionManagerModal } from "@/components/cloud/SessionManagerModal";
import { DeviceView } from "@/components/switch3d/DeviceView";
import { RealisticScene } from "@/components/switch3d/RealisticScene";
import { PacketClock } from "@/components/switch3d/packetPlayer";
import { isFirebaseConfigured } from "@/lib/firebase/config";

type Panel = "devices" | "inspector" | "packets";
const PANELS_KEY = "lab-panels";
const PANEL_DEFAULTS: Record<Panel, boolean> = { devices: false, inspector: true, packets: true };

/** Which side panels are open (navbar toggles); remembered per browser. */
function usePanels() {
  const [open, setOpen] = useState(PANEL_DEFAULTS);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PANELS_KEY) ?? "{}");
      setOpen((o) => ({ ...o, ...saved }));
    } catch {}
  }, []);
  const toggle = (p: Panel) =>
    setOpen((o) => {
      const next = { ...o, [p]: !o[p] };
      try {
        localStorage.setItem(PANELS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  return { open, toggle };
}

function PanelToggle({ on, onClick, label, title }: { on: boolean; onClick(): void; label: string; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`rounded border px-2.5 py-1 text-[11px] font-medium transition-colors ${
        on ? "border-accent-2/60 bg-accent-2/15 text-accent-2" : "border-edge bg-panel-2 text-[#8b98a5] hover:text-[#e6edf3]"
      }`}
    >
      {label}
    </button>
  );
}

function PanelHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-edge bg-panel px-3 py-1.5">
      <span className="text-xs font-semibold uppercase tracking-wider text-[#8b98a5]">{title}</span>
      {hint && <span className="text-[11px] text-[#5f6b7a]">{hint}</span>}
    </div>
  );
}

export default function LabPage() {
  const canvasMode = useLabStore((s) => s.canvasMode);
  const setCanvasMode = useLabStore((s) => s.setCanvasMode);
  const mainMaximized = useLabStore((s) => s.mainMaximized);
  const setMainMaximized = useLabStore((s) => s.setMainMaximized);

  // Esc leaves the full-screen main area (like the terminal's restore).
  useEffect(() => {
    if (!mainMaximized) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMainMaximized(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mainMaximized, setMainMaximized]);
  const labName = useLabStore((s) => s.labName);
  const currentSessionId = useLabStore((s) => s.currentSessionId);
  const cloudSyncStatus = useLabStore((s) => s.cloudSyncStatus);
  const autoSave = useLabStore((s) => s.autoSave);
  const saveToCloud = useLabStore((s) => s.saveToCloud);
  const selectedDevice = useLabStore((s) =>
    s.selectedDeviceId ? s.network.devices[s.selectedDeviceId] : undefined,
  );

  const [sessionModalOpen, setSessionModalOpen] = useState(false);
  const panels = usePanels();
  const [firebaseActive, setFirebaseActive] = useState(false);

  useEffect(() => {
    setFirebaseActive(isFirebaseConfigured());
  }, [sessionModalOpen]);

  // Session persistence: automatically restore last active session when opening or returning to the page.
  // If no saved session exists and the canvas is empty, load the sample lab.
  useEffect(() => {
    const init = async () => {
      const s = useLabStore.getState();
      const restored = await s.restoreLastSession();
      if (!restored && Object.keys(s.network.devices).length === 0) {
        s.loadSample();
      }
    };
    init();
  }, []);

  // Periodic cloud auto-save when enabled and session is active
  useEffect(() => {
    const t = setInterval(() => {
      const s = useLabStore.getState();
      if (s.autoSave && s.currentSessionId && Object.keys(s.network.devices).length > 0) {
        s.saveToCloud();
      }
    }, 25000);
    return () => clearInterval(t);
  }, []);

  // Save on beforeunload if session is active
  useEffect(() => {
    const handleBeforeUnload = () => {
      const s = useLabStore.getState();
      if (s.autoSave && s.currentSessionId && Object.keys(s.network.devices).length > 0) {
        s.saveToCloud();
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  // hsflowd runs on wall time: poll counters / flush samples once per second.
  useEffect(() => {
    const t = setInterval(() => {
      useLabStore.getState().sflowTick();
      useLabStore.getState().missionTick(); // lab mission objectives (lib/missions)
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Control-plane daemons (LLDP, BFD, OSPF, BGP, ARP aging, SNMP) run on wall time.
  useEffect(() => {
    const t = setInterval(() => useLabStore.getState().controlTick(), 100);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex h-screen min-w-[900px] flex-col bg-[#0b0e14] text-[#e6edf3]">
      {/* top bar */}
      <header className="flex items-center gap-3 border-b border-edge bg-panel px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">🛰️</span>
          <span className="text-sm font-semibold">Networking Lab</span>
        </div>
        <div className="flex items-center gap-1.5">
          <PanelToggle on={panels.open.devices} onClick={() => panels.toggle("devices")} label="＋ Devices" title="Show / hide the device palette (drag a device onto the canvas)" />
          <PanelToggle on={panels.open.inspector} onClick={() => panels.toggle("inspector")} label="Inspector" title="Show / hide the device editing panel" />
          <PanelToggle on={panels.open.packets} onClick={() => panels.toggle("packets")} label="Packets" title="Show / hide the packet timeline" />
        </div>
        <span className="text-[11px] text-[#5f6b7a]">
          build · configure · generate traffic · watch packets · inspect · troubleshoot
        </span>

        {/* Cloud Session & DB controls */}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setSessionModalOpen(true)}
            className="flex items-center gap-1.5 rounded border border-edge bg-panel-2 px-2.5 py-1 text-[11px] font-medium text-[#e6edf3] hover:border-accent-2 transition-colors"
          >
            <span className="text-accent-2">☁</span>
            <span>Cloud Sessions</span>
            <span
              title={
                cloudSyncStatus === "saving"
                  ? "Saving to database..."
                  : cloudSyncStatus === "synced"
                  ? "Synced to database"
                  : firebaseActive
                  ? "Connected to Firebase"
                  : "Using local database"
              }
              className={`h-2 w-2 rounded-full ${
                cloudSyncStatus === "saving"
                  ? "bg-amber-400 animate-pulse"
                  : cloudSyncStatus === "synced"
                  ? "bg-green-400"
                  : firebaseActive
                  ? "bg-green-400"
                  : "bg-blue-400"
              }`}
            />
          </button>

          <button
            onClick={() => saveToCloud()}
            disabled={cloudSyncStatus === "saving"}
            title={currentSessionId ? "Save current switches to database" : "Save as new database session"}
            className="rounded border border-accent/50 bg-accent/15 px-2.5 py-1 text-[11px] font-semibold text-accent-2 hover:bg-accent/25 transition-colors"
          >
            {cloudSyncStatus === "saving" ? "Saving..." : "💾 Save"}
          </button>

          <span
            title={currentSessionId ? `Active Session ID: ${currentSessionId}` : "Unsaved session"}
            className="rounded border border-edge bg-panel-2 px-2 py-0.5 text-[11px] text-[#8b98a5] max-w-[200px] truncate"
          >
            {labName}
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* left: device toolbox */}
        <aside
          className={`shrink-0 overflow-hidden bg-panel transition-[width] duration-300 ease-out ${panels.open.devices ? "w-56 border-r border-edge" : "w-0"}`}
          aria-hidden={!panels.open.devices}
        >
          <div className="h-full w-56">
            <DeviceToolbox />
          </div>
        </aside>

        {/* center + right + bottom */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className={mainMaximized ? "fixed inset-0 z-[60] flex bg-[#0b0d11]" : "relative flex min-h-0 flex-1"}>
            <section className="relative min-w-0 flex-1">
              {canvasMode === "realistic" ? <RealisticScene /> : <TopologyCanvas />}
              <div className="absolute left-3 top-3 z-30 flex overflow-hidden rounded border border-edge bg-panel/90 text-[11px] shadow">
                {(["topology", "realistic"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setCanvasMode(m)}
                    className={`px-2.5 py-1 ${canvasMode === m ? "bg-accent-2/20 text-accent-2" : "text-[#8b98a5] hover:text-[#e6edf3]"}`}
                    title={m === "realistic" ? "See the lab as real hardware: rack, desk and patch cables" : "Edit the topology"}
                  >
                    {m === "topology" ? "Topology" : "View realistic"}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setMainMaximized(!mainMaximized)}
                title={mainMaximized ? "Restore (Esc)" : "Full screen"}
                className="absolute right-3 top-3 z-30 rounded border border-edge bg-panel/90 px-2 py-1 text-[11px] text-[#8b98a5] shadow hover:border-accent-2 hover:text-accent-2"
              >
                {mainMaximized ? "⤡ Restore (Esc)" : "⤢ Full screen"}
              </button>
            </section>
            <aside
              className={`shrink-0 overflow-hidden bg-panel transition-[max-width] duration-300 ease-out ${panels.open.inspector ? "max-w-[30rem] border-l border-edge" : "max-w-0"}`}
              aria-hidden={!panels.open.inspector}
            >
              <Inspector />
            </aside>
            {/* 3D hardware view: covers canvas + inspector, keeps the terminal usable below */}
            <DeviceView />
            {/* one clock for the packet animation shown in every view */}
            <PacketClock />
          </div>

          {/* bottom: terminal + packet timeline */}
          <div className="flex h-[32%] min-h-[210px] border-t border-edge">
            <section className="flex min-w-0 flex-1 flex-col bg-[#0a0d12]">
              <PanelHeader
                title="Terminal"
                hint={selectedDevice ? selectedDevice.config.hostname : "no device selected"}
              />
              <div className="min-h-0 flex-1">
                <Terminal />
              </div>
            </section>
            <section
              className={`shrink-0 overflow-hidden bg-panel transition-[width] duration-300 ease-out ${panels.open.packets ? "w-[40%] border-l border-edge" : "w-0"}`}
              aria-hidden={!panels.open.packets}
            >
              <div className="flex h-full min-w-[360px] flex-col">
                <PanelHeader title="Packet timeline" />
                <div className="min-h-0 flex-1">
                  <PacketTimeline />
                </div>
              </div>
            </section>
          </div>
        </main>
      </div>

      {/* Cloud Sessions & Switch Configurations Modal */}
      <SessionManagerModal
        open={sessionModalOpen}
        onClose={() => setSessionModalOpen(false)}
      />
    </div>
  );
}
