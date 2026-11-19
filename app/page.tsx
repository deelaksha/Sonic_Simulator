"use client";
import { useEffect, useState } from "react";
import { useLabStore } from "@/lib/store/lab-store";
import { DeviceToolbox } from "@/components/toolbox/DeviceToolbox";
import { TopologyCanvas } from "@/components/topology/TopologyCanvas";
import { Inspector } from "@/components/inspector/Inspector";
import { Terminal } from "@/components/terminal/Terminal";
import { PacketTimeline } from "@/components/timeline/PacketTimeline";
import { SessionManagerModal } from "@/components/cloud/SessionManagerModal";
import { SwitchView } from "@/components/switch3d/SwitchView";
import { isFirebaseConfigured } from "@/lib/firebase/config";

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
  const currentSessionId = useLabStore((s) => s.currentSessionId);
  const cloudSyncStatus = useLabStore((s) => s.cloudSyncStatus);
  const autoSave = useLabStore((s) => s.autoSave);
  const saveToCloud = useLabStore((s) => s.saveToCloud);
  const selectedDevice = useLabStore((s) =>
    s.selectedDeviceId ? s.network.devices[s.selectedDeviceId] : undefined,
  );

  const [sessionModalOpen, setSessionModalOpen] = useState(false);
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
        <aside className="w-56 shrink-0 border-r border-edge bg-panel">
          <DeviceToolbox />
        </aside>

        {/* center + right + bottom */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1">
            <section className="min-w-0 flex-1">
              <TopologyCanvas />
            </section>
            <aside className="shrink-0 border-l border-edge bg-panel">
              <Inspector />
            </aside>
            {/* 3D switch view: covers canvas + inspector, keeps the terminal usable below */}
            <SwitchView />
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

      {/* Cloud Sessions & Switch Configurations Modal */}
      <SessionManagerModal
        open={sessionModalOpen}
        onClose={() => setSessionModalOpen(false)}
      />
    </div>
  );
}
