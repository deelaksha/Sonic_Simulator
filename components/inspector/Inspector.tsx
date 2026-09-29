"use client";
import { useEffect, useState } from "react";
import { useLabStore } from "@/lib/store/lab-store";
import { DeviceConfigPanel } from "./DeviceConfigPanel";
import { PacketInspector } from "./PacketInspector";

type Tab = "device" | "packet";

export function Inspector() {
  const selectedDeviceId = useLabStore((s) => s.selectedDeviceId);
  const selectedEventId = useLabStore((s) => s.selectedEventId);
  const [tab, setTab] = useState<Tab>("device");

  // Follow the user's focus: selecting a packet shows the packet tab, etc.
  useEffect(() => {
    if (selectedEventId) setTab("packet");
  }, [selectedEventId]);
  useEffect(() => {
    if (selectedDeviceId) setTab("device");
  }, [selectedDeviceId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-edge">
        {(["device", "packet"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 px-3 py-2 text-xs font-semibold uppercase tracking-wide ${
              tab === t ? "border-b-2 border-accent-2 text-accent-2" : "text-[#6b7789] hover:text-[#c9d3de]"
            }`}
          >
            {t === "device" ? "Device" : "Packet"}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === "device" ? <DeviceConfigPanel /> : <PacketInspector />}
      </div>
    </div>
  );
}
